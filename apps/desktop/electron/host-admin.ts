import { randomUUID } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { isRemoteCommand, type RemoteCommand } from '@daban/protocol';
import { prepareSocket } from './socket.ts';

interface Review {
  kind: 'native' | 'view';
  device: string;
  bot?: string;
  model?: string;
  recipient?: string;
}
interface Approval extends Review {
  id: string;
  expiresAt: number;
}
export class HostAdmin {
  private readonly pending = new Map<
    string,
    { value: Approval; settle(accepted: boolean): unknown }
  >();
  private readonly server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/') throw Error('REMOTE_ADMIN_INVALID');
      let text = '';
      for await (const chunk of req) {
        text += Buffer.from(chunk).toString('utf8');
        if (Buffer.byteLength(text) > 16384) throw Error('REMOTE_ADMIN_INVALID');
      }
      const value: unknown = JSON.parse(text);
      const result = await this.invoke(value);
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, value: result }));
    } catch (error) {
      const code =
        error instanceof Error && /^REMOTE_[A-Z_]{1,80}$/.test(error.message)
          ? error.message
          : 'REMOTE_ADMIN_FAILED';
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: code }));
    }
  });
  constructor(
    private readonly options: {
      socket: string;
      command(command: RemoteCommand): Promise<unknown>;
      status(): unknown;
      pause(): Promise<unknown>;
    },
  ) {
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
  }
  async listen() {
    if (process.platform === 'win32') throw Error('REMOTE_ADMIN_PLATFORM');
    await prepareSocket(this.options.socket);
    const previous = await lstat(this.options.socket).catch(() => undefined);
    if (previous) {
      const stale = await new Promise<boolean>((resolve, reject) => {
        const probe = createConnection(this.options.socket);
        probe.once('connect', () => {
          probe.destroy();
          resolve(false);
        });
        probe.once('error', (error: NodeJS.ErrnoException) => {
          probe.destroy();
          if (error.code === 'ECONNREFUSED') resolve(true);
          else reject(error);
        });
        probe.setTimeout(1000, () => {
          probe.destroy();
          resolve(false);
        });
      });
      if (!stale) throw Error('REMOTE_ADMIN_ACTIVE');
      const current = await lstat(this.options.socket);
      if (current.ino !== previous.ino || current.dev !== previous.dev)
        throw Error('REMOTE_ADMIN_UNSAFE');
      await unlink(this.options.socket);
    }
    await new Promise<undefined>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.socket, () => resolve(undefined));
    });
    await chmod(this.options.socket, 0o600);
  }
  review(value: Review) {
    if (this.pending.size >= 16) return Promise.resolve(false);
    const id = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => settle(false), 25_000);
      timer.unref();
      const settle = (accepted: boolean) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(accepted);
      };
      this.pending.set(id, { value: { ...value, id, expiresAt: Date.now() + 25_000 }, settle });
    });
  }
  private async invoke(input: unknown): Promise<unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw Error('REMOTE_ADMIN_INVALID');
    const value = input as Record<string, unknown>;
    const keys = Object.keys(value);
    if (value.type === 'status' && keys.length === 1)
      return {
        host: this.options.status(),
        approvals: [...this.pending.values()].map((item) => item.value),
      };
    if (value.type === 'pause' && keys.length === 1) {
      for (const item of this.pending.values()) item.settle(false);
      return this.options.pause();
    }
    if (
      ['grant', 'deny'].includes(String(value.type)) &&
      keys.length === 2 &&
      typeof value.id === 'string'
    ) {
      const pending = this.pending.get(value.id);
      if (!pending || pending.value.expiresAt <= Date.now()) throw Error('REMOTE_APPROVAL_EXPIRED');
      pending.settle(value.type === 'grant');
      return { approved: value.type === 'grant' };
    }
    if (value.type === 'remote' && keys.length === 2 && isRemoteCommand(value.command))
      return this.options.command(value.command);
    throw Error('REMOTE_ADMIN_INVALID');
  }
  async close() {
    for (const item of this.pending.values()) item.settle(false);
    this.server.closeAllConnections();
    if (this.server.listening)
      await new Promise<undefined>((resolve) => this.server.close(() => resolve(undefined)));
  }
}

export async function adminRequest(socket: string, value: unknown): Promise<unknown> {
  // The socket's containing directory and mode are checked before sending any administrative command.
  await prepareSocket(socket);
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: socket, path: '/', method: 'POST', timeout: 35000 },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) req.destroy(Error('REMOTE_ADMIN_TOO_LARGE'));
          else chunks.push(chunk);
        });
        res.once('error', reject);
        res.once('end', () => {
          try {
            const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!result || typeof result !== 'object' || !('ok' in result))
              throw Error('REMOTE_ADMIN_INVALID');
            if (!result.ok)
              throw Error(
                'error' in result && typeof result.error === 'string'
                  ? result.error
                  : 'REMOTE_ADMIN_FAILED',
              );
            resolve('value' in result ? result.value : undefined);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.once('timeout', () => req.destroy(Error('REMOTE_ADMIN_TIMEOUT')));
    req.once('error', reject);
    req.end(JSON.stringify(value));
  });
}
