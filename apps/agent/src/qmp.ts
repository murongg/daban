import { connect, type TLSSocket } from 'node:tls';
import { generate } from 'selfsigned';

const leafCertificate: NonNullable<Parameters<typeof generate>[1]> = {
  algorithm: 'sha256',
  keyType: 'rsa',
  keySize: 2048,
  extensions: [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ],
};

export async function createQmpCertificates() {
  const ca = await generate([{ name: 'commonName', value: 'Daban private VM control' }], {
    algorithm: 'sha256',
    keyType: 'rsa',
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
  const options = { ...leafCertificate, ca: { cert: ca.cert, key: ca.private } };
  const [server, client] = await Promise.all([
    generate([{ name: 'commonName', value: 'localhost' }], options),
    generate([{ name: 'commonName', value: 'daban-controller' }], options),
  ]);
  // QEMU requires non-CA endpoint certificates; the signing key is discarded after issuance.
  return {
    ca: ca.cert,
    serverCert: server.cert,
    serverKey: server.private,
    clientCert: client.cert,
    clientKey: client.private,
  };
}

export interface QmpOptions {
  port: number;
  uuid: string;
  cert: string;
  key: string;
  ca: string;
}
type Command = 'query-status' | 'query-uuid' | 'query-version' | 'system_powerdown';
interface Pending {
  resolve(value: unknown): unknown;
  reject(error: Error): unknown;
  timer: ReturnType<typeof setTimeout>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export class Qmp {
  private readonly socket: TLSSocket;
  private readonly pending = new Map<number, Pending>();
  private readonly greeting: Promise<unknown>;
  private sequence = 0;
  private closed = false;
  private buffer = '';
  private greeted = false;
  private greet: (value: unknown) => unknown = () => undefined;
  private rejectGreeting: (error: Error) => unknown = () => undefined;
  private readonly timer: ReturnType<typeof setTimeout>;

  private constructor(options: QmpOptions) {
    this.greeting = new Promise((resolve, reject) => {
      this.greet = resolve;
      this.rejectGreeting = reject;
    });
    // QMP can power off the guest and access its storage. Authenticate both TLS peers even on loopback.
    this.socket = connect({
      host: '127.0.0.1',
      port: options.port,
      cert: options.cert,
      key: options.key,
      ca: options.ca,
      servername: 'localhost',
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    });
    this.timer = setTimeout(() => this.fail(), 8000);
    this.socket.on('error', (error: NodeJS.ErrnoException) =>
      this.fail(error.code === 'ECONNREFUSED' ? 'QEMU_CONTROL_OFFLINE' : undefined),
    );
    this.socket.on('close', () => this.fail());
    this.socket.on('data', (bytes: Buffer) => this.receive(bytes));
  }

  static async open(options: QmpOptions) {
    if (
      !Number.isInteger(options.port) ||
      options.port < 1024 ||
      options.port > 65535 ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(options.uuid)
    )
      throw Error('QEMU_CONTROL_CONFIG');
    const client = new Qmp(options);
    try {
      await client.greeting;
      clearTimeout(client.timer);
      await client.request('qmp_capabilities');
      const identity = await client.request('query-uuid');
      if (!record(identity) || identity.UUID !== options.uuid) throw Error('QEMU_IDENTITY_CHANGED');
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  private fail(code = 'QEMU_CONTROL_UNAVAILABLE') {
    clearTimeout(this.timer);
    this.closed = true;
    const failure = Error(code);
    this.rejectGreeting(failure);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
    this.pending.clear();
    this.socket.destroy();
  }

  private receive(bytes: Buffer) {
    if (this.closed) return;
    this.buffer += bytes.toString('utf8');
    if (this.buffer.length > 262144) return this.fail('QEMU_CONTROL_PROTOCOL');
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return this.fail('QEMU_CONTROL_PROTOCOL');
      }
      if (!record(value)) return this.fail('QEMU_CONTROL_PROTOCOL');
      if (!this.greeted) {
        if (!record(value.QMP)) return this.fail('QEMU_CONTROL_PROTOCOL');
        this.greeted = true;
        this.greet(undefined);
        continue;
      }
      if (typeof value.event === 'string') continue;
      if (typeof value.id !== 'number') return this.fail('QEMU_CONTROL_PROTOCOL');
      const pending = this.pending.get(value.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if ('error' in value) pending.reject(Error('QEMU_CONTROL_REJECTED'));
      else if ('return' in value) pending.resolve(value.return);
      else pending.reject(Error('QEMU_CONTROL_PROTOCOL'));
    }
  }

  private request(command: string) {
    if (this.closed) return Promise.reject(Error('QEMU_CONTROL_UNAVAILABLE'));
    const id = ++this.sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ execute: command, id }) + '\n', (error) => {
        if (error) this.fail();
      });
    });
  }

  execute(command: Command) {
    if (!['query-status', 'query-uuid', 'query-version', 'system_powerdown'].includes(command))
      return Promise.reject(Error('QEMU_CONTROL_CONFIG'));
    return this.request(command);
  }

  async close() {
    if (this.closed) return;
    this.fail();
  }
}
