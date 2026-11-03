import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Image-build tooling only. A normal installed VM has no builder receipt and cannot enter this path.
const [action, vmId] = process.argv.slice(2);
assert.equal(action, 'seal');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(process.getuid?.(), 0);
assert.match(vmId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
assert.equal((await readFile('/sys/class/dmi/id/product_uuid', 'utf8')).trim().toLowerCase(), vmId);
const builder = JSON.parse(await readFile('/etc/daban-image-builder.json', 'utf8')) as {
  version: number;
  vmId: string;
  protocol: number;
};
assert.equal(builder.version, 1);
assert.equal(builder.vmId, vmId);
assert.equal(builder.protocol, 44);
const protocol = (await import(
  pathToFileURL('/opt/daban-executor/vendor/protocol/dist/index.js').href
)) as { managedProtocol: number };
assert.equal(protocol.managedProtocol, builder.protocol);
const node = '/opt/node-v24.22.1-linux-x64/bin/node';
assert.equal(await realpath(process.execPath), node);
const run = (program: string, args: string[]) =>
  execFileSync(program, args, {
    stdio: 'inherit',
    timeout: 120000,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8' },
  });
run('/usr/bin/systemctl', ['stop', 'daban-executor.service']);
const data = '/var/lib/daban-executor';
assert.equal(await realpath(data), data);
assert.equal(await realpath('/home/daban'), '/home/daban');
assert.equal(await realpath('/home/bot-prototype'), '/home/bot-prototype');
await mkdir('/opt/bot-prototype', { recursive: true });
const canonical = '/opt/bot-prototype/node';
const existing = await lstat(canonical).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
});
if (existing) assert.equal(await realpath(canonical), path.dirname(path.dirname(node)));
else await symlink(path.dirname(path.dirname(node)), canonical);

// Remove synthetic runs, browser cookies, executor tokens and builder-only SSH material before distribution.
for (const directory of [data, '/home/daban', '/home/bot-prototype']) {
  for (const entry of await readdir(directory))
    await rm(path.join(directory, entry), { recursive: true, force: false });
}
for (const entry of await readdir('/etc/ssh'))
  if (/^ssh_host_.*_key(?:\.pub)?$/.test(entry)) await rm(path.join('/etc/ssh', entry));
await rm('/etc/sudoers.d/90-cloud-init-users', { force: true });
await rm('/root/.ssh', { recursive: true, force: true });
run('/usr/bin/cloud-init', ['clean', '--logs', '--seed', '--machine-id']);
run('/usr/bin/apt-get', ['clean']);
run('/usr/bin/journalctl', ['--rotate']);
run('/usr/bin/journalctl', ['--vacuum-time=1s']);
for (const file of ['/var/log/wtmp', '/var/log/btmp', '/var/log/lastlog', '/root/.bash_history'])
  await rm(file, { force: true });
await rm('/etc/daban-image-builder.json');
await writeFile(
  '/etc/daban-image.json',
  JSON.stringify({
    version: 1,
    protocol: builder.protocol,
    system: 'debian-13-amd64',
    node: process.versions.node,
    sealed: true,
  }) + '\n',
  { mode: 0o644 },
);
assert.deepEqual(await readdir(data), []);
assert.deepEqual(await readdir('/home/daban'), []);
assert.deepEqual(await readdir('/home/bot-prototype'), []);
run('/usr/bin/sync', []);
// The host restarts the builder with discard=unmap before sealing, then converts only allocated qcow2 clusters.
run('/usr/sbin/fstrim', ['--verbose', '/']);
run('/usr/bin/sync', []);
console.log(
  JSON.stringify({
    sealed: true,
    protocol: builder.protocol,
    privateStateRemoved: true,
    hostKeysRemoved: true,
  }),
);
