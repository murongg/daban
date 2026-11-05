import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { validAgentId } from '@daban/protocol';
import { errorCode, Fault } from './control.js';
import { privateMetadata } from './private-files.js';

export class Authority {
  readonly token = randomBytes(32).toString('hex');
  constructor(readonly file: string) {}
  accepts(value: unknown) {
    if (typeof value !== 'string') return false;
    const supplied = Buffer.from(value);
    const expected = Buffer.from(this.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  async publish() {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const parent = await lstat(directory);
    if (!parent.isDirectory() || !(await privateMetadata(directory, parent, 0o700)))
      throw new Fault('CONTROL_AUTH_UNSAFE', 503);
    const previous = await lstat(this.file, { bigint: true }).catch((error) => {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1n))
      throw new Fault('CONTROL_AUTH_UNSAFE', 503);
    const file = await open(
      this.file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (previous ? 0 : constants.O_EXCL),
      0o600,
    );
    try {
      const metadata = await file.stat();
      const identity = await file.stat({ bigint: true });
      const named = await lstat(this.file, { bigint: true });
      // Windows lacks O_NOFOLLOW: verify the named and opened identities before any destructive write.
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        !(await privateMetadata(this.file, metadata, 0o600)) ||
        named.isSymbolicLink() ||
        identity.nlink !== 1n ||
        named.dev !== identity.dev ||
        named.ino !== identity.ino ||
        (previous && (previous.dev !== identity.dev || previous.ino !== identity.ino))
      )
        throw new Fault('CONTROL_AUTH_UNSAFE', 503);
      // Validate the opened inode before truncation; a hard link must never destroy another file.
      await file.truncate(0);
      await file.writeFile(`${this.token}\n`, 'utf8');
    } finally {
      await file.close();
    }
  }
}
export class ViewerGrants {
  private readonly grants = new Map<string, { bot: string; instance: string }>();
  issue(bot: string, instance: string) {
    if (!validAgentId(bot) || !validAgentId(instance)) throw new Fault('INVALID_COMPUTER_ID', 400);
    const token = randomBytes(32).toString('hex');
    this.grants.set(token, { bot, instance });
    return token;
  }
  instance(token: unknown, bot: string) {
    const grant = typeof token === 'string' ? this.grants.get(token) : undefined;
    return grant?.bot === bot ? grant.instance : undefined;
  }
  retire(bot: string, instance: string) {
    for (const [token, grant] of this.grants)
      if (grant.bot === bot && grant.instance === instance) this.grants.delete(token);
  }
}
