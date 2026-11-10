import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { localComputerPaths, privateServer, secureDirectory } from '@daban/engine/local-computer';
import { validAgentId } from '@daban/protocol';
import type { LocalBinding, LocalComputer } from './local-computer';
import { prepareSocket } from './socket';

export async function localServer(dataRoot: string, computer: LocalComputer) {
  await secureDirectory(dataRoot);
  const locations = localComputerPaths(dataRoot),
    token = randomBytes(32).toString('hex');
  if (process.platform !== 'win32') await prepareSocket(locations.socket);
  const existing = await lstat(locations.socket).catch(() => undefined);
  if (existing && process.platform !== 'win32') {
    const stale = await new Promise<boolean>((resolve, reject) => {
      const probe = createConnection(locations.socket);
      probe.once('connect', () => {
        probe.destroy();
        resolve(false);
      });
      probe.once('error', (error: NodeJS.ErrnoException) => {
        probe.destroy();
        error.code === 'ECONNREFUSED' ? resolve(true) : reject(error);
      });
      probe.setTimeout(500, () => {
        probe.destroy();
        resolve(false);
      });
    });
    if (!stale) throw new Error('LOCAL_BRIDGE_ACTIVE');
    const latest = await lstat(locations.socket);
    if (latest.ino !== existing.ino || latest.dev !== existing.dev)
      throw new Error('LOCAL_UNSAFE_SOCKET');
    await unlink(locations.socket);
  }
  const temporary = path.join(dataRoot, `local-token-${randomBytes(8).toString('hex')}`);
  await writeFile(temporary, token, { flag: 'wx', mode: 0o600 });
  await rename(temporary, locations.token);
  const channel = await privateServer(async (req, res) => {
    const auth = req.headers.authorization;
    if (
      req.method !== 'POST' ||
      req.url !== '/' ||
      typeof auth !== 'string' ||
      !/^Bearer [a-f0-9]{64}$/.test(auth) ||
      !timingSafeEqual(Buffer.from(auth.slice(7)), Buffer.from(token))
    ) {
      res.writeHead(403).end();
      return;
    }
    let runId: string | undefined;
    let sessionId: string | undefined;
    res.once('close', () => {
      if (!res.writableEnded && runId) computer.cancel(runId, sessionId).catch(() => {});
    });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        size += Buffer.byteLength(part);
        if (size > 128 * 1024) throw new Error('LOCAL_INVALID_REQUEST');
        chunks.push(Buffer.from(part));
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('LOCAL_INVALID_REQUEST');
      const data = value as Record<string, unknown>;
      if (typeof data.method !== 'string') throw new Error('LOCAL_INVALID_REQUEST');
      let result: unknown;
      if (
        data.method === 'status' &&
        (Object.keys(data).length === 1 || (data.scope === true && Object.keys(data).length === 2))
      ) {
        const status = computer.status();
        if (status.session?.window) {
          // Old agents require the original status shape, and new agents only need the scope.
          delete status.session.window;
          if (data.scope === true) status.session.window = 'window';
        }
        result = status;
      } else if (
        data.method === 'cancel' &&
        Object.keys(data).length === 3 &&
        validAgentId(data.runId) &&
        validAgentId(data.session)
      ) {
        await computer.cancel(data.runId, data.session as string);
        result = {};
      } else {
        const allowed =
          data.method === 'screenshot'
            ? ['method', 'session', 'bot', 'runId', 'model', 'modelRevision']
            : data.method === 'act'
              ? [
                  'method',
                  'session',
                  'bot',
                  'runId',
                  'model',
                  'modelRevision',
                  'observation',
                  'actions',
                ]
              : data.method === 'open_app'
                ? [
                    'method',
                    'session',
                    'bot',
                    'runId',
                    'model',
                    'modelRevision',
                    'observation',
                    'app',
                  ]
                : [];
        if (
          !allowed.length ||
          Object.keys(data).some((key) => !allowed.includes(key)) ||
          !validAgentId(data.session) ||
          !validAgentId(data.bot) ||
          !validAgentId(data.runId) ||
          typeof data.model !== 'string' ||
          !data.model ||
          data.model.length > 256 ||
          !Number.isSafeInteger(data.modelRevision) ||
          Number(data.modelRevision) < 0
        )
          throw new Error('LOCAL_INVALID_REQUEST');
        runId = data.runId;
        sessionId = data.session as string;
        const binding: LocalBinding = {
          session: data.session as string,
          bot: data.bot,
          runId,
          model: data.model,
          modelRevision: Number(data.modelRevision),
        };
        if (data.method === 'screenshot') result = await computer.capture(binding);
        else if (typeof data.observation !== 'string') throw new Error('LOCAL_INVALID_REQUEST');
        else if (data.method === 'act')
          result = await computer.act({
            ...binding,
            observation: data.observation,
            actions: data.actions as unknown[],
          });
        else if (typeof data.app === 'string')
          result = await computer.openApp({
            ...binding,
            observation: data.observation,
            app: data.app,
          });
        else throw new Error('LOCAL_INVALID_REQUEST');
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, value: result }));
    } catch (error) {
      const code =
        error instanceof Error && /^LOCAL_[A-Z_]{1,70}$/.test(error.message)
          ? error.message
          : 'LOCAL_DRIVER_FAILED';
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: code }));
    }
  }, locations.certificate);
  const server = channel.server;
  await new Promise<unknown>((resolve, reject) => {
    server.once('error', reject);
    server.listen(locations.socket, () => resolve(undefined));
  });
  await channel.publish();
  if (process.platform !== 'win32') await chmod(locations.socket, 0o600);
  const ownedSocket = process.platform !== 'win32' ? await lstat(locations.socket) : undefined;
  return async () => {
    await computer.close();
    await new Promise<unknown>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
    if ((await readFile(locations.token, 'utf8').catch(() => '')) === token)
      await unlink(locations.token).catch(() => {});
    if (ownedSocket) {
      const currentSocket = await lstat(locations.socket).catch(() => undefined);
      if (currentSocket?.ino === ownedSocket.ino && currentSocket.dev === ownedSocket.dev)
        await unlink(locations.socket).catch(() => {});
      await rmdir(path.dirname(locations.socket)).catch(() => {});
    }
  };
}
