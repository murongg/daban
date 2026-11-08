import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const values = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2)
  values.set(process.argv[index], process.argv[index + 1]);
const dataRoot = values.get('--data')!,
  socketPath = values.get('--socket')!,
  config = values.get('--vm-config')!;
const entry = fileURLToPath(import.meta.url),
  legacy = path.basename(entry) === 'legacy.js',
  native = !legacy && values.get('--mode') === 'native';
const scope = createHash('sha256')
  .update(JSON.stringify([path.resolve(dataRoot), path.resolve(config)]))
  .digest('hex');
const token = 'a'.repeat(64);
await mkdir(path.join(dataRoot, 'model'), { recursive: true, mode: 0o700 });
await writeFile(path.join(dataRoot, 'model/control-token'), token, {
  mode: 0o600,
  flag: 'wx',
}).catch((error) => {
  if (error.code !== 'EEXIST') throw error;
});
process.umask(0o077);
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const reply = (value: unknown, status = 200) => {
    res.writeHead(status);
    res.end(JSON.stringify(value));
  };
  if (req.url === '/agent/identity')
    return reply({
      role: 'agent',
      scope,
      dataRoot,
      socketPath,
      ...(!legacy ? { entry, executable: process.execPath } : {}),
    });
  if (req.headers['x-prototype-token'] !== token) return reply({ error: 'UNAUTHORIZED' }, 403);
  if (req.url === '/api/host/update') {
    if (legacy) return reply({ error: 'NOT_FOUND' }, 404);
    res.once('finish', () => server.close());
    return reply({ scope, pid: process.pid });
  }
  if (!legacy && req.url === '/api/host/environment')
    return reply({ required: false, target: 'linux', phase: 'existing' });
  if (req.url === '/api/model/settings')
    return reply({
      configured: true,
      model: 'deepseek-flash',
      provider: 'deepseek-official',
      revision: 0,
    });
  if (req.url === '/api/host/recovery')
    return reply({ available: true, revision: 0, busy: false, vm: 'running' });
  if (req.url === '/api/state')
    return reply({
      clientProtocol: legacy ? 42 : 43,
      mode: 'agent',
      sharedLogin: false,
      bots: {},
      agent: {
        location: 'host',
        execution: native ? 'local-workspace' : 'linux-vm',
        privilege: native ? 'workspace' : 'sudo',
        approvals: 'host',
      },
      model: { available: true, provider: 'deepseek-official', model: 'deepseek-flash', bots: {} },
      reboot: { available: true, revision: 0, busy: false, vm: 'running' },
      computers: { available: true, revision: 0, limit: 2, items: [] },
      chats: { available: true, revision: 0, items: [] },
      recovery: { available: true, revision: 0 },
      mcp: { available: true, revision: 0 },
      skills: { available: true, revision: 0 },
      schedules: { available: true, items: [] },
      groups: { available: true, revision: 0, items: [] },
    });
  return reply({ error: 'NOT_FOUND' }, 404);
});
server.listen(socketPath, () => {
  chmod(socketPath, 0o600).catch(() => server.close());
});
process.on('SIGTERM', () => server.close());
