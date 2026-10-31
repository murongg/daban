import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  chown,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function stopInstaller(
  command: (args: readonly string[]) => string = (args) =>
    execFileSync('/usr/bin/systemctl', [...args], { encoding: 'utf8' }),
) {
  const state = command([
    'show',
    'daban-software.service',
    '--property=LoadState',
    '--value',
  ]).trim();
  if (state === 'not-found') return;
  assert.equal(state, 'loaded', 'Unexpected installer service state');
  command(['stop', 'daban-software.service']);
}

// Provisioning runs as the VM administrator; Bots never receive this entry point.
export async function installSoftware(runtime: string) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid?.(), 0);
  assert.ok(path.isAbsolute(runtime));
  const library = '/usr/local/lib/daban-software';
  const node = '/opt/bot-prototype/node/bin/node';
  const command = (program: string, args: string[]) =>
    execFileSync(program, args, { stdio: 'inherit' });
  const rootDirectory = async (directory: string, mode: number) => {
    await mkdir(directory, { recursive: true, mode });
    const info = await lstat(directory);
    assert.ok(
      info.isDirectory() &&
        !info.isSymbolicLink() &&
        info.uid === 0 &&
        !(info.mode & 0o022) &&
        (await realpath(directory)) === directory,
      `Unsafe software directory: ${directory}`,
    );
    await chmod(directory, mode);
  };
  // The privileged interpreter and all of its parents must be immutable to runtime/Bot accounts.
  command('/usr/bin/chown', ['-R', '-P', 'root:root', '/opt/bot-prototype/node']);
  command('/usr/bin/chmod', ['-R', 'go-w', '/opt/bot-prototype/node']);
  for (const file of [
    '/opt',
    '/opt/bot-prototype',
    '/opt/bot-prototype/node',
    '/opt/bot-prototype/node/bin',
    node,
  ]) {
    const info = await lstat(file);
    assert.ok(
      info.uid === 0 && !(info.mode & 0o022) && !info.isSymbolicLink(),
      `Unsafe privileged interpreter: ${file}`,
    );
  }
  stopInstaller();
  await rootDirectory(library, 0o755);
  await rootDirectory('/etc/daban-software', 0o755);
  await rootDirectory('/var/lib/daban-software', 0o700);
  await rootDirectory('/var/lib/daban-software-apt', 0o755);
  await rootDirectory('/var/cache/daban-software', 0o755);
  const rootFile = async (file: string, content: string | Buffer, mode: number) => {
    const directory = path.dirname(file);
    await rootDirectory(directory, 0o755);
    // Replace managed files with a root-owned inode; never follow or preserve a pre-existing owner/symlink.
    const temporary = path.join(directory, `.daban-${randomUUID()}`),
      handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  };
  const secureTree = async (directory: string) => {
    const info = await lstat(directory);
    assert.ok(!info.isSymbolicLink(), `Unsafe software module: ${directory}`);
    await chown(directory, 0, 0);
    await chmod(directory, info.isDirectory() ? 0o755 : 0o644);
    if (info.isDirectory())
      for (const name of await readdir(directory)) await secureTree(path.join(directory, name));
  };
  await secureTree(library);
  await rootFile(path.join(library, 'package.json'), '{"type":"module","private":true}\n', 0o644);
  await rootFile(
    path.join(library, 'installer.js'),
    await readFile(path.join(runtime, 'installer.js')),
    0o644,
  );
  await cp(
    path.join(runtime, 'vendor/protocol'),
    path.join(library, 'node_modules/@daban/protocol'),
    { recursive: true, dereference: false },
  );
  await secureTree(library);
  await rootFile(
    '/usr/local/bin/daban-software-check',
    `#!/bin/sh\nexec ${node} ${library}/installer.js --check\n`,
    0o755,
  );
  await rootFile(
    '/etc/daban-software/debian.sources',
    `Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie trixie-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: https://security.debian.org/debian-security\nSuites: trixie-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n`,
    0o644,
  );
  await rootFile(
    '/etc/systemd/system/daban-software.service',
    `[Unit]\nDescription=daban confirmed shared software installer\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=root\nGroup=bot-prototype\nRuntimeDirectory=daban-software\nRuntimeDirectoryMode=0750\nUMask=0077\nExecStart=/usr/bin/flock --nonblock --no-fork /run/daban-software/daemon.lock ${node} ${library}/installer.js\nRestart=on-failure\nRestartSec=2\nKillMode=process\nTimeoutStopSec=infinity\n\n[Install]\nWantedBy=multi-user.target\n`,
    0o644,
  );
  command('/usr/bin/systemctl', ['daemon-reload']);
  command('/usr/bin/systemctl', ['enable', '--now', 'daban-software.service']);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtime, ...extra] = process.argv.slice(2);
  assert.ok(runtime && !extra.length);
  await installSoftware(runtime);
}
