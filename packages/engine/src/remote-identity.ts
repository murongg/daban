import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { RemoteIdentity } from '@daban/protocol';
import { privateMetadata, secureDirectory } from './private-files.js';

export class RemoteKeys {
  readonly identity: RemoteIdentity;
  private constructor(
    private readonly key: KeyObject,
    name: string,
  ) {
    const bytes = createPublicKey(key).export({ format: 'der', type: 'spki' });
    this.identity = {
      id: createHash('sha256').update(bytes).digest('hex'),
      publicKey: bytes.toString('base64url'),
      name: name.trim().slice(0, 160) || 'Daban',
    };
  }
  static async open(directory: string, name: string) {
    const root = await secureDirectory(directory);
    const file = path.join(root, 'device-key.pem');
    try {
      const handle = await open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const { privateKey } = generateKeyPairSync('ed25519');
        await handle.writeFile(privateKey.export({ format: 'pem', type: 'pkcs8' }));
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
        throw error;
    }
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 8192 ||
        !(await privateMetadata(file, info, 0o600))
      )
        throw new Error('REMOTE_IDENTITY_UNSAFE');
      const key = createPrivateKey(await handle.readFile());
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('REMOTE_INVALID_KEY');
      return new RemoteKeys(key, name);
    } finally {
      await handle.close();
    }
  }
  sign(text: string) {
    return sign(null, Buffer.from(text), this.key).toString('base64url');
  }
}
