import { createHash, createPublicKey, verify } from 'node:crypto';
import { isRemoteIdentity, type RemoteIdentity } from '@daban/protocol';

export function remoteProof(purpose: string, fields: readonly string[]) {
  return JSON.stringify(['daban-remote-v1', purpose, ...fields]);
}
export function remotePublicKey(publicKey: string) {
  if (!/^[A-Za-z0-9_-]{59}$/.test(publicKey)) throw new Error('REMOTE_INVALID_KEY');
  const bytes = Buffer.from(publicKey, 'base64url');
  if (bytes.toString('base64url') !== publicKey) throw new Error('REMOTE_INVALID_KEY');
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('REMOTE_INVALID_KEY');
  return key;
}
export function validRemoteIdentity(value: unknown): value is RemoteIdentity {
  if (!isRemoteIdentity(value)) return false;
  try {
    remotePublicKey(value.publicKey);
    return (
      createHash('sha256').update(Buffer.from(value.publicKey, 'base64url')).digest('hex') ===
      value.id
    );
  } catch {
    return false;
  }
}
export function verifyRemoteProof(identity: RemoteIdentity, text: string, signature: string) {
  if (!validRemoteIdentity(identity) || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    const bytes = Buffer.from(signature, 'base64url');
    return (
      bytes.toString('base64url') === signature &&
      verify(null, Buffer.from(text), remotePublicKey(identity.publicKey), bytes)
    );
  } catch {
    return false;
  }
}
export function remoteDigest(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error('REMOTE_INVALID_VALUE');
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
    .join(',')}}`;
}
