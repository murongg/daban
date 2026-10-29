import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertCleanImage, environmentVersions, verifyAsset } from './environment.ts';

// Build-time entry only: a clean isolated image, never an existing user runtime.
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.equal(process.getuid?.(), 0);
const [action, nonce] = process.argv.slice(2);
assert.ok(['install', 'audit', 'sanitize'].includes(action));
assert.ok(nonce && /^[a-f0-9-]{36}$/.test(nonce));
const ownerFile = '/etc/daban-image-build.json';
const product = '/opt/bot-prototype';
const inputs = '/tmp/daban-image-inputs';
const data = '/var/lib/bot-prototype';
const exists = async (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
const run = (program: string, args: string[], timeout = 600000) =>
  execFileSync(program, args, {
    stdio: 'inherit',
    timeout,
    env: {
      ...process.env,
      PATH: `${product}/node/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      DEBIAN_FRONTEND: 'noninteractive',
      NPM_CONFIG_USERCONFIG: '/dev/null',
    },
  });

if (action === 'install') {
  assert.match(await readFile('/etc/os-release', 'utf8'), /VERSION_ID="13"/);
  if (!(await exists(ownerFile))) {
    assert.deepEqual(await readdir(product), ['node']);
    assert.equal(await exists(data), false);
    await writeFile(ownerFile, JSON.stringify({ nonce }), { flag: 'wx', mode: 0o600 });
  }
}
assert.equal(JSON.parse(await readFile(ownerFile, 'utf8')).nonce, nonce);

if (action === 'install') {
  const manifest: unknown = JSON.parse(await readFile(`${inputs}/manifest.json`, 'utf8'));
  assert.ok(
    manifest &&
      typeof manifest === 'object' &&
      'runtimeSha256' in manifest &&
      typeof manifest.runtimeSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(manifest.runtimeSha256),
  );
  await verifyAsset(`${inputs}/runtime.tar`, 'sha256', manifest.runtimeSha256);
  run('/usr/bin/apt-get', ['update']);
  run('/usr/bin/apt-get', [
    'install',
    '-y',
    '--no-install-recommends',
    'ca-certificates',
    'curl',
    'xz-utils',
    'sudo',
    'openssh-server',
    'cloud-init',
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
  ]);
  await mkdir(`${product}/app`, { recursive: true });
  run('/usr/bin/tar', [
    '--extract',
    '--file',
    `${inputs}/runtime.tar`,
    '--directory',
    `${product}/app`,
    '--no-same-owner',
  ]);
  const node = `${product}/node/bin/node`,
    npm = `${product}/node/lib/node_modules/npm/bin/npm-cli.js`;
  run(node, [
    npm,
    'ci',
    '--prefix',
    `${product}/app/runtime`,
    '--omit=dev',
    '--workspaces=false',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--registry=https://registry.npmjs.org',
  ]);
  await mkdir(`${product}/dsh`, { recursive: true });
  await writeFile(
    `${product}/dsh/package.json`,
    JSON.stringify({
      private: true,
      dependencies: {
        '@deepseek-ai/dsh': environmentVersions.dsh,
        '@deepseek-ai/dsh-sdk-client': environmentVersions.dsh,
      },
    }),
  );
  run(node, [
    npm,
    'install',
    '--prefix',
    `${product}/dsh`,
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--registry=https://registry.npmjs.org',
  ]);
  process.env.PLAYWRIGHT_BROWSERS_PATH = `${product}/browsers`;
  run(
    node,
    [`${product}/app/runtime/node_modules/playwright/cli.js`, 'install', '--with-deps', 'chromium'],
    1800000,
  );
  try {
    run('/usr/bin/id', ['bot-prototype']);
  } catch {
    run('/usr/sbin/useradd', [
      '--system',
      '--create-home',
      '--home-dir',
      '/home/bot-prototype',
      '--shell',
      '/bin/bash',
      'bot-prototype',
    ]);
  }
  await mkdir(data, { recursive: true, mode: 0o700 });
  run('/usr/bin/chown', ['bot-prototype:bot-prototype', data]);
  await writeFile(
    '/etc/systemd/resolved.conf.d/99-daban-no-multicast.conf',
    '[Resolve]\nLLMNR=no\nMulticastDNS=no\n',
  );
  await writeFile(
    '/etc/systemd/system/bot-browser.service',
    await readFile(`${product}/app/runtime/vm.service`, 'utf8'),
  );
  await writeFile(
    '/etc/daban-image.json',
    JSON.stringify(
      { version: 1, architecture: 'aarch64', versions: environmentVersions },
      null,
      2,
    ) + '\n',
  );
  run('/usr/bin/systemctl', ['daemon-reload']);
  run('/usr/bin/systemctl', ['enable', '--now', 'bot-browser.service']);
  console.log('DABAN_IMAGE_INSTALLED');
}

const homes = (await readFile('/etc/passwd', 'utf8'))
  .trim()
  .split('\n')
  .map((line) => line.split(':'))
  .filter((row) => Number(row[2]) === 0 || Number(row[2]) >= 1000 || row[0] === 'bot-prototype')
  .map((row) => row[5])
  .filter((home) => home?.startsWith('/') && home !== '/' && home !== '/nonexistent');
if (action === 'sanitize') {
  // A configured provider is never considered a disposable build artifact.
  assert.equal(await exists(`${data}/model/credentials.json`), false);
  run('/usr/bin/systemctl', ['stop', 'bot-browser.service']);
  await rm(data, { recursive: true, force: true });
  await mkdir(data, { mode: 0o700 });
  run('/usr/bin/chown', ['bot-prototype:bot-prototype', data]);
  for (const home of homes) {
    await rm(path.join(home, '.ssh'), { recursive: true, force: true });
    await rm(path.join(home, '.dsh'), { recursive: true, force: true });
    await rm(path.join(home, '.bash_history'), { force: true });
  }
  for (const file of await readdir('/etc/ssh'))
    if (file.startsWith('ssh_host_')) await rm(`/etc/ssh/${file}`);
  await rm('/var/lib/cloud', { recursive: true, force: true });
  await mkdir('/var/lib/cloud');
  await writeFile('/etc/machine-id', '');
  await rm('/var/lib/dbus/machine-id', { force: true });
  await symlink('/etc/machine-id', '/var/lib/dbus/machine-id');
  run('/usr/bin/systemctl', ['stop', 'systemd-random-seed.service']);
  await rm('/var/lib/systemd/random-seed', { force: true });
  await rm('/var/lib/dhcp', { recursive: true, force: true });
  await mkdir('/var/lib/dhcp');
  // These files are recreated from the consuming Lima instance's seed, not the builder's proxy settings.
  await writeFile('/etc/environment', '');
  for (const file of await readdir('/etc/apt/apt.conf.d'))
    if (/lima|proxy/i.test(file)) await rm(`/etc/apt/apt.conf.d/${file}`);
  run('/usr/bin/apt-get', ['clean']);
  await rm('/root/.npm', { recursive: true, force: true });
  await rm('/tmp/daban-node.tar.xz', { force: true });
  await rm('/var/log/cloud-init.log', { force: true });
  await rm('/var/log/cloud-init-output.log', { force: true });
  await writeFile('/etc/hostname', 'daban\n');
  await rm(ownerFile);
  await rm(inputs, { recursive: true, force: true });
}
if (action === 'audit' || action === 'sanitize') {
  let authorizedKeyBytes = 0,
    homePrivateKeys = 0;
  for (const home of homes) {
    for (const name of await readdir(path.join(home, '.ssh')).catch(() => [])) {
      if (name.startsWith('authorized_keys'))
        authorizedKeyBytes += (await readFile(path.join(home, '.ssh', name))).length;
      if (name.startsWith('id_') && !name.endsWith('.pub')) homePrivateKeys++;
    }
  }
  const report = {
    runtimeEntries: (await readdir(data)).length,
    providerCredentials: Number(await exists(`${data}/model/credentials.json`)),
    authorizedKeyBytes,
    homePrivateKeys,
    sshHostKeys: (await readdir('/etc/ssh')).filter((name) => name.startsWith('ssh_host_')).length,
    machineIdBytes: (await readFile('/etc/machine-id')).length,
    cloudInitEntries: (await readdir('/var/lib/cloud')).length,
    randomSeedBytes: (await readFile('/var/lib/systemd/random-seed').catch(() => Buffer.alloc(0)))
      .length,
  };
  if (action === 'sanitize') assertCleanImage(report);
  await new Promise<undefined>((resolve, reject) =>
    process.stdout.write(JSON.stringify(report) + '\n', (error) =>
      error ? reject(error) : resolve(undefined),
    ),
  );
}
if (action === 'sanitize') {
  run('/usr/bin/sync', []);
  // Any later builder boot invalidates this audit; sanitize again before exporting its disk.
  run('/usr/bin/systemctl', ['poweroff']);
}
