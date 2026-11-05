import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomInt,
  randomUUID,
  X509Certificate,
} from 'node:crypto';
import { request } from 'node:https';
import { isRemoteInvitation, type RemoteInvitation, remoteServer } from '@daban/protocol';
import { SRP, SrpClient, SrpServer } from 'fast-srp-hap';
import { validRemoteIdentity } from './remote-crypto.js';
import { pinnedAgent } from './remote-signal.js';

export type PairingEndpoint = Pick<
  RemoteInvitation,
  'host' | 'server' | 'certificate' | 'alternatives'
>;
type Exchange = (route: 'start' | 'finish', body: unknown) => Promise<unknown>;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function hex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/.test(value);
}
function binding(endpoint: Pick<PairingEndpoint, 'host' | 'certificate'>) {
  const certificate = new X509Certificate(endpoint.certificate);
  if (!validRemoteIdentity(endpoint.host) || certificate.subject !== `CN=${endpoint.host.id}`)
    throw Error('REMOTE_CERTIFICATE_CHANGED');
  // Bind the PAKE to the certificate so an untrusted discovery peer cannot relay proofs onto another TLS leaf.
  return Buffer.from(
    JSON.stringify(['daban-code-v1', endpoint.host.id, certificate.fingerprint256]),
  );
}
function key(secret: Buffer, context: Buffer) {
  return Buffer.from(hkdfSync('sha256', secret, context, 'daban-pairing-offer-v1', 32));
}
export class PairingHost {
  private active?: { code: string; offer: RemoteInvitation };
  private attempts = 0;
  private readonly sessions = new Map<string, { srp: SrpServer; expiresAt: number }>();
  private readonly context: Buffer;
  constructor(private readonly endpoint: Pick<PairingEndpoint, 'host' | 'certificate'>) {
    this.context = binding(endpoint);
  }
  activate(offer: RemoteInvitation) {
    if (
      !isRemoteInvitation(offer) ||
      offer.host.id !== this.endpoint.host.id ||
      offer.certificate !== this.endpoint.certificate ||
      offer.expiresAt <= Date.now() ||
      offer.expiresAt > Date.now() + 300000 ||
      Buffer.byteLength(JSON.stringify(offer)) > 16384
    )
      throw Error('REMOTE_INVALID_INVITATION');
    this.stop();
    this.active = { code: randomInt(1000000).toString().padStart(6, '0'), offer };
    return this.state()!;
  }
  state() {
    if (!this.active || this.active.offer.expiresAt <= Date.now()) {
      this.stop();
      return undefined;
    }
    return { code: this.active.code, expiresAt: this.active.offer.expiresAt };
  }
  stop() {
    this.active = undefined;
    this.attempts = 0;
    this.sessions.clear();
  }
  begin() {
    if (!this.state() || !this.active) throw Error('REMOTE_CODE_EXPIRED');
    for (const [id, session] of this.sessions)
      if (session.expiresAt <= Date.now()) this.sessions.delete(id);
    // The budget belongs to this code, so changing an unauthenticated device identity cannot reset it.
    if (this.attempts >= 8 || this.sessions.size >= 8) throw Error('REMOTE_CODE_ATTEMPTS');
    this.attempts++;
    const salt = randomBytes(32);
    const srp = new SrpServer(
      SRP.params.hap,
      salt,
      this.context,
      Buffer.from(this.active.code),
      randomBytes(32),
    );
    const id = randomUUID();
    this.sessions.set(id, {
      srp,
      expiresAt: Math.min(Date.now() + 15000, this.active.offer.expiresAt),
    });
    return { id, salt: salt.toString('hex'), publicKey: srp.computeB().toString('hex') };
  }
  finish(value: unknown) {
    if (
      !record(value) ||
      Object.keys(value).length !== 3 ||
      typeof value.id !== 'string' ||
      !hex(value.A, 384) ||
      !hex(value.proof, 64)
    )
      throw Error('REMOTE_CODE_INVALID');
    const session = this.sessions.get(value.id);
    this.sessions.delete(value.id);
    if (!session || session.expiresAt <= Date.now() || !this.state() || !this.active)
      throw Error('REMOTE_CODE_EXPIRED');
    try {
      session.srp.setA(Buffer.from(value.A, 'hex'));
      session.srp.checkM1(Buffer.from(value.proof, 'hex'));
    } catch {
      throw Error('REMOTE_CODE_INVALID');
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(session.srp.computeK(), this.context), nonce);
    cipher.setAAD(Buffer.concat([this.context, Buffer.from(value.id)]));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(this.active.offer), 'utf8'),
      cipher.final(),
    ]);
    return {
      proof: session.srp.computeM2().toString('hex'),
      nonce: nonce.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      data: data.toString('hex'),
    };
  }
}
async function exchange(endpoint: PairingEndpoint, route: 'start' | 'finish', body: unknown) {
  const agent = pinnedAgent(endpoint.certificate);
  const data = JSON.stringify(body);
  return new Promise<unknown>((resolve, reject) => {
    const call = request(
      new URL(`/v1/pair/${route}`, endpoint.server),
      {
        agent,
        method: 'POST',
        timeout: 2000,
        signal: AbortSignal.timeout(2500),
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65536) call.destroy(Error('REMOTE_CODE_INVALID'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode !== 200) {
              const error =
                record(result) &&
                typeof result.error === 'string' &&
                /^REMOTE_CODE_(?:INVALID|EXPIRED|ATTEMPTS)$/.test(result.error)
                  ? result.error
                  : 'REMOTE_CODE_INVALID';
              reject(Error(error));
            } else resolve(result);
          } catch {
            reject(Error('REMOTE_CODE_INVALID'));
          }
        });
      },
    );
    call.on('error', (error: Error) =>
      reject(error.name === 'AbortError' ? Error('REMOTE_CODE_UNREACHABLE') : error),
    );
    call.on('timeout', () => call.destroy(Error('REMOTE_CODE_UNREACHABLE')));
    call.once('close', () => agent.destroy());
    call.end(data);
  });
}
export async function redeemPairing(endpoint: PairingEndpoint, code: string, transport?: Exchange) {
  if (!/^\d{6}$/.test(code)) throw Error('REMOTE_CODE_INVALID');
  remoteServer(endpoint.server);
  const context = binding(endpoint);
  const send: Exchange = transport ?? ((route, body) => exchange(endpoint, route, body));
  const challenge = await send('start', {});
  if (
    !record(challenge) ||
    typeof challenge.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(challenge.id) ||
    !hex(challenge.salt, 32) ||
    !hex(challenge.publicKey, 384)
  )
    throw Error('REMOTE_CODE_INVALID');
  const srp = new SrpClient(
    SRP.params.hap,
    Buffer.from(challenge.salt, 'hex'),
    context,
    Buffer.from(code),
    randomBytes(32),
  );
  srp.setB(Buffer.from(challenge.publicKey, 'hex'));
  const answer = await send('finish', {
    id: challenge.id,
    A: srp.computeA().toString('hex'),
    proof: srp.computeM1().toString('hex'),
  });
  if (
    !record(answer) ||
    !hex(answer.proof, 64) ||
    !hex(answer.nonce, 12) ||
    !hex(answer.tag, 16) ||
    typeof answer.data !== 'string' ||
    answer.data.length > 32768 ||
    !/^(?:[0-9a-f]{2})+$/.test(answer.data)
  )
    throw Error('REMOTE_CODE_INVALID');
  try {
    // Authenticate the server before decrypting or trusting the discovered Host's invitation.
    srp.checkM2(Buffer.from(answer.proof, 'hex'));
    const cipher = createDecipheriv(
      'aes-256-gcm',
      key(srp.computeK(), context),
      Buffer.from(answer.nonce, 'hex'),
    );
    cipher.setAAD(Buffer.concat([context, Buffer.from(challenge.id)]));
    cipher.setAuthTag(Buffer.from(answer.tag, 'hex'));
    const value: unknown = JSON.parse(
      Buffer.concat([cipher.update(Buffer.from(answer.data, 'hex')), cipher.final()]).toString(
        'utf8',
      ),
    );
    if (
      !isRemoteInvitation(value) ||
      value.host.id !== endpoint.host.id ||
      value.certificate !== endpoint.certificate ||
      value.expiresAt <= Date.now() ||
      value.expiresAt > Date.now() + 300000
    )
      throw Error('REMOTE_CODE_INVALID');
    const origins = [...new Set([value.server, ...(value.alternatives ?? [])])];
    if (!origins.includes(endpoint.server)) throw Error('REMOTE_CODE_INVALID');
    return {
      ...value,
      server: endpoint.server,
      alternatives: origins.filter((origin) => origin !== endpoint.server),
    };
  } catch {
    throw Error('REMOTE_CODE_INVALID');
  }
}
