import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { controlSocket, prepareSocket, socketReady } from './socket';

const created = new Set<string>();
function address() {
  const logical = `/tmp/${'字'.repeat(25)}-${randomUUID()}/s`;
  expect(logical.length).toBeLessThan(80);
  expect(Buffer.byteLength(logical)).toBeGreaterThan(80);
  const socket = controlSocket(logical, 'synthetic-target');
  created.add(dirname(socket));
  return socket;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of created) await fs.rm(dir, { recursive: true, force: true });
  created.clear();
});

it('keeps short legacy addresses stable and gives long Unicode scopes bounded deterministic addresses', async () => {
  expect(controlSocket('/tmp/mock.sock', 'synthetic-target')).toBe('/tmp/mock.sock');
  const logical = `/tmp/${'字'.repeat(25)}-${randomUUID()}/s`;
  const a = controlSocket(logical, 'synthetic-target');
  expect(a).toBe(controlSocket(logical, 'synthetic-target'));
  expect(a).not.toBe(controlSocket(logical, 'another-target'));
  expect(a).not.toBe(controlSocket(`${logical}-other`, 'synthetic-target'));
  expect(Buffer.byteLength(a)).toBeLessThanOrEqual(80);
  expect(await socketReady(a)).toBe(false);
  await expect(fs.lstat(dirname(a))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('creates only a private owned directory and preserves an existing private socket', async () => {
  const socket = address();
  await prepareSocket(socket);
  const info = await fs.lstat(dirname(socket));
  expect(info.mode & 0o777).toBe(0o700);
  expect(info.uid).toBe(process.getuid!());
  expect(await socketReady(socket)).toBe(true);
  const server = createServer();
  try {
    server.listen(socket);
    await once(server, 'listening');
    await fs.chmod(socket, 0o600);
    await prepareSocket(socket);
    expect(await socketReady(socket)).toBe(true);
    expect(server.listening).toBe(true);
    await fs.link(socket, `${socket}-linked`);
    await expect(socketReady(socket)).rejects.toThrow('RUNTIME_CONTROL_PATH_UNSAFE');
    await fs.unlink(`${socket}-linked`);
  } finally {
    if (server.listening)
      await new Promise<undefined>((resolve) => server.close(() => resolve(undefined)));
  }
});

it('refuses unsafe directories, foreign ownership, links and non-socket entries without repairing them', async () => {
  const socket = address();
  const folder = dirname(socket);
  await prepareSocket(socket);
  await fs.chmod(folder, 0o755);
  await expect(prepareSocket(socket)).rejects.toThrow('RUNTIME_CONTROL_PATH_UNSAFE');
  expect((await fs.lstat(folder)).mode & 0o777).toBe(0o755);
  await fs.chmod(folder, 0o700);
  const info = await fs.lstat(folder);
  const foreign = Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
    uid: info.uid + 1,
  });
  vi.spyOn(fs, 'lstat').mockResolvedValueOnce(foreign);
  await expect(socketReady(socket)).rejects.toThrow('RUNTIME_CONTROL_PATH_UNSAFE');
  vi.restoreAllMocks();
  await fs.writeFile(socket, 'SYNTHETIC FILE MUST REMAIN', { mode: 0o600 });
  await expect(prepareSocket(socket)).rejects.toThrow('RUNTIME_CONTROL_PATH_UNSAFE');
  expect(await fs.readFile(socket, 'utf8')).toBe('SYNTHETIC FILE MUST REMAIN');
  await fs.unlink(socket);
  await fs.symlink('/tmp/mock-missing-target', socket);
  await expect(socketReady(socket)).rejects.toThrow('RUNTIME_CONTROL_PATH_UNSAFE');
  await fs.unlink(socket);
  await fs.rmdir(folder);
  await fs.symlink('/tmp', folder);
  await expect(prepareSocket(socket)).rejects.toThrow('RUNTIME_CONTROL_PATH_UNSAFE');
  expect(await fs.readlink(folder)).toBe('/tmp');
});
