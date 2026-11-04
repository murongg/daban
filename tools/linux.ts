import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const product = '/opt/daban-executor';
const data = '/var/lib/daban-executor';
const unitFile = '/etc/systemd/system/daban-executor.service';
const sudoersFile = '/etc/sudoers.d/daban-executor';
const packages = [
  'ca-certificates',
  'sudo',
  'openssh-server',
  'dbus-x11',
  'xvfb',
  'openbox',
  'xterm',
  'thunar',
  'mousepad',
  'tint2',
  'xdotool',
  'xclip',
  'xauth',
  'wmctrl',
  'x11-utils',
  'x11-xserver-utils',
  'python3',
  'python3-gi',
  'python3-gi-cairo',
  'python3-pil',
  'gir1.2-gtk-3.0',
  'fonts-dejavu-core',
  'fonts-noto-cjk',
  'fontconfig',
  'bubblewrap',
  'procps',
  'util-linux',
];

export function guestSudoers(user: string) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || ['root', 'bot-prototype'].includes(user))
    throw new Error('LINUX_LOGIN_INVALID');
  return `Defaults:bot-prototype umask=0022,umask_override\nbot-prototype ALL=(ALL) NOPASSWD: ALL\n${user} ALL=(root) NOPASSWD: /bin/sh\n`;
}

export function executorUnit(node: string) {
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(node)) throw new Error('LINUX_NODE_PATH');
  return `[Unit]
Description=Daban Linux execution service
After=network.target
[Service]
Type=simple
User=bot-prototype
Group=bot-prototype
WorkingDirectory=${product}
Environment=PATH=${path.posix.dirname(node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
Environment=PLAYWRIGHT_BROWSERS_PATH=${product}/browsers
Environment=DABAN_EXECUTION_DIR=${data}
Environment=DABAN_WORKSPACE_DIR=${data}/desktops/shared
Environment=PROFILE_DIR=${data}/profile
Environment=DABAN_DESKTOP_DIR=${data}/desktops
Environment=PORT=8766
Environment=COMPUTER_SLOTS=2
ExecStart=${node} ${product}/main.js
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=20
UMask=0077
[Install]
WantedBy=multi-user.target
`;
}

async function present(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}

async function regularTree(directory: string) {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new Error('LINUX_BUNDLE_UNSAFE');
  if (info.isDirectory()) {
    for (const entry of await readdir(directory)) await regularTree(path.join(directory, entry));
  } else if (!info.isFile() || info.nlink !== 1) throw new Error('LINUX_BUNDLE_UNSAFE');
}

export async function bundleLinuxExecutor(source: string, output: string) {
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@daban/runtime', 'LINUX_EXECUTOR_BUILD_REQUIRED');
  assert.deepEqual(
    manifest.dependencies,
    { '@daban/engine': 'file:./vendor/engine', '@daban/protocol': 'file:./vendor/protocol' },
    'LINUX_EXECUTOR_DEPENDENCIES',
  );
  await mkdir(output, { recursive: false });
  const stage = await mkdtemp(path.join(output, '.bundle-'));
  try {
    const runtime = path.join(stage, 'runtime');
    await mkdir(runtime);
    // Copy only the executor build, never a host profile, VM disk or arbitrary adjacent files.
    for (const name of ['main.js', 'package.json', 'package-lock.json', 'LICENSE', 'vendor']) {
      await regularTree(path.join(source, name));
      await cp(path.join(source, name), path.join(runtime, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    await cp(fileURLToPath(import.meta.url), path.join(runtime, 'install.ts'));
    const filename = 'daban-executor-linux-x64.tar.gz';
    const archive = path.resolve(output, filename);
    execFileSync('tar', ['-czf', archive, '-C', path.resolve(stage), 'runtime'], {
      windowsHide: true,
    });
    const digest = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    await writeFile(`${archive}.sha256`, `${digest}  ${filename}\n`);
    return archive;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function installExecutor(source: string, login: string) {
  assert.equal(process.platform, 'linux', 'LINUX_REQUIRED');
  assert.equal(process.arch, 'x64', 'LINUX_X64_REQUIRED');
  assert.equal(process.getuid?.(), 0, 'LINUX_ROOT_REQUIRED');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'LINUX_NODE_24_REQUIRED');
  assert.match(
    await readFile('/etc/os-release', 'utf8'),
    /^ID="?debian"?$/m,
    'LINUX_DEBIAN_REQUIRED',
  );
  assert.match(
    await readFile('/etc/os-release', 'utf8'),
    /^VERSION_ID="?13"?$/m,
    'LINUX_DEBIAN_13_REQUIRED',
  );
  const sudoers = guestSudoers(login),
    service = executorUnit(process.execPath);
  for (const entry of [product, data, unitFile, sudoersFile, '/home/bot-prototype'])
    assert.equal(await present(entry), false, `LINUX_EXISTING_INSTALL: ${entry}`);
  const canonicalNode = '/opt/bot-prototype/node';
  assert.equal(await present(canonicalNode), false, 'LINUX_EXISTING_NODE');
  await mkdir(path.dirname(canonicalNode), { recursive: true, mode: 0o755 });
  await symlink(path.dirname(path.dirname(process.execPath)), canonicalNode);
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: '/root',
    LANG: 'C.UTF-8',
    DEBIAN_FRONTEND: 'noninteractive',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    PLAYWRIGHT_BROWSERS_PATH: `${product}/browsers`,
  };
  const run = (program: string, args: string[]) =>
    execFileSync(program, args, { env, stdio: 'inherit', timeout: 1800000 });
  run('/usr/bin/id', [login]);
  await mkdir(product, { mode: 0o755 });
  for (const name of ['main.js', 'package.json', 'package-lock.json', 'LICENSE', 'vendor']) {
    await regularTree(path.join(source, name));
    await cp(path.join(source, name), path.join(product, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  run('/usr/bin/apt-get', ['update']);
  run('/usr/bin/apt-get', ['install', '-y', '--no-install-recommends', ...packages]);
  execFileSync(
    'npm',
    ['ci', '--omit=dev', '--ignore-scripts', '--workspaces=false', '--no-audit', '--no-fund'],
    { cwd: product, env, stdio: 'inherit', timeout: 1800000 },
  );
  run(process.execPath, [
    `${product}/node_modules/playwright/cli.js`,
    'install',
    '--with-deps',
    'chromium',
  ]);
  run('/usr/sbin/useradd', [
    '--system',
    '--create-home',
    '--home-dir',
    '/home/bot-prototype',
    '--shell',
    '/bin/bash',
    'bot-prototype',
  ]);
  run('/usr/bin/chmod', ['-R', 'u=rwX,go=rX', product]);
  await mkdir(data, { mode: 0o700 });
  run('/usr/bin/chown', ['bot-prototype:bot-prototype', data]);
  await writeFile(sudoersFile, sudoers, { flag: 'wx', mode: 0o440 });
  run('/usr/sbin/visudo', ['-cf', sudoersFile]);
  await writeFile(unitFile, service, { flag: 'wx', mode: 0o644 });
  run('/usr/bin/systemctl', ['daemon-reload']);
  run('/usr/bin/systemctl', ['enable', '--now', 'daban-executor.service', 'ssh.service']);
  console.log(
    'Daban executor installed. Verify SSH access and copy the Ed25519 host public key from the VM console.',
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [action, input] = process.argv.slice(2);
  if (action === 'bundle' && input) {
    const root = fileURLToPath(new URL('..', import.meta.url));
    console.log(
      await bundleLinuxExecutor(path.join(root, 'dist-runtime/runtime'), path.resolve(input)),
    );
  } else if (action === 'install' && input) {
    await installExecutor(path.dirname(fileURLToPath(import.meta.url)), input);
  } else
    throw new Error(
      'Usage: linux.ts bundle <new-output-directory> | install.ts install <existing-ssh-user>',
    );
}
