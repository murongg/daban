import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';
import { windowsEnvironment } from '@daban/engine/component';
import { readVmConnection, saveVmConnection } from '@daban/engine/host';
import { secureDirectory } from '@daban/engine/local-computer';
import type { VmConnection } from '@daban/protocol';
import type { QemuMachine } from '../apps/agent/src/qemu.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
const qemu: typeof import('../apps/agent/src/qemu.ts') = await import(
  pathToFileURL(path.join(repository, 'dist-agent/qemu.js')).href
);
const store: typeof import('../apps/agent/src/qemu-store.ts') = await import(
  pathToFileURL(path.join(repository, 'dist-agent/qemu-store.js')).href
);
const control: typeof import('../apps/agent/src/qmp.ts') = await import(
  pathToFileURL(path.join(repository, 'dist-agent/qmp.js')).href
);
const seed: typeof import('../apps/agent/src/seed.ts') = await import(
  pathToFileURL(path.join(repository, 'dist-agent/seed.js')).href
);

async function freePort() {
  const server = createServer();
  await new Promise<unknown>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function prepare(output: string, toolsSource: string, image: string) {
  assert.equal(process.platform, 'win32', 'QEMU_BUILD_WINDOWS');
  const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  assert.equal(existing, undefined, 'QEMU_BUILD_EXISTS');
  const dataRoot = await secureDirectory(output);
  const root = await secureDirectory(path.join(dataRoot, 'qemu'));
  const tools = await secureDirectory(path.join(root, 'tools'));
  for (const entry of await readdir(toolsSource, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      (/\.dll$/i.test(entry.name) ||
        ['qemu-system-x86_64.exe', 'qemu-img.exe', 'COPYING', 'COPYING.LIB'].includes(entry.name))
    )
      await copyFile(
        path.join(toolsSource, entry.name),
        path.join(tools, entry.name),
        constants.COPYFILE_EXCL,
      );
  }
  await mkdir(path.join(tools, 'share'));
  for (const entry of await readdir(path.join(toolsSource, 'share'), { withFileTypes: true }))
    if (entry.isFile() && /\.(bin|rom|fd|elf|efi)$/i.test(entry.name))
      await copyFile(
        path.join(toolsSource, 'share', entry.name),
        path.join(tools, 'share', entry.name),
        constants.COPYFILE_EXCL,
      );
  const files: Record<string, { bytes: number; sha256: string }> = {};
  async function walk(relative = '') {
    for (const entry of await readdir(path.join(tools, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else files[name] = await qemu.qemuFileHash(path.join(tools, name));
    }
  }
  await walk();
  await store.writeQemuRecord(path.join(tools, 'manifest.json'), { version: 1, files });
  const toolsId = (await qemu.qemuFileHash(path.join(tools, 'manifest.json'))).sha256;
  const binary = path.join(tools, 'qemu-img.exe');
  execFileSync(
    binary,
    ['convert', '-f', 'raw', '-O', 'qcow2', image, path.join(root, 'disk.qcow2')],
    { windowsHide: true, timeout: 120000 },
  );
  execFileSync(binary, ['resize', path.join(root, 'disk.qcow2'), '64G'], {
    windowsHide: true,
    timeout: 30000,
  });
  const keys = await secureDirectory(path.join(root, 'keys'));
  const keygen = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32/OpenSSH/ssh-keygen.exe',
  );
  for (const name of ['id_ed25519', 'host_ed25519'])
    execFileSync(
      keygen,
      ['-q', '-t', 'ed25519', '-N', '', '-C', 'daban-qemu-builder', '-f', path.join(keys, name)],
      { windowsHide: true, timeout: 10000 },
    );
  const hostKey = (await readFile(path.join(keys, 'host_ed25519.pub'), 'utf8'))
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const pems = await control.createQmpCertificates();
  await store.writeQemuRecord(path.join(root, 'control.json'), pems);
  const tls = await secureDirectory(path.join(root, 'tls'));
  for (const [name, value] of [
    ['ca-cert.pem', pems.ca],
    ['server-cert.pem', pems.serverCert],
    ['server-key.pem', pems.serverKey],
  ])
    await writeFile(path.join(tls, name), value, { mode: 0o600, flag: 'wx' });
  const vmId = randomUUID();
  const connection: VmConnection = {
    provider: 'qemu',
    enabled: true,
    vmId,
    host: '127.0.0.1',
    sshPort: await freePort(),
    user: 'daban',
    identityFile: path.join(keys, 'id_ed25519'),
    hostKey,
  };
  const machine: QemuMachine = {
    version: 1,
    connection,
    acceleration: 'tcg',
    qmpPort: await freePort(),
    toolsId,
  };
  const cloud = {
    hostname: 'daban-builder',
    manage_etc_hosts: true,
    users: [
      {
        name: 'daban',
        groups: ['sudo'],
        shell: '/bin/bash',
        lock_passwd: true,
        sudo: ['ALL=(ALL) NOPASSWD:ALL'],
        ssh_authorized_keys: [(await readFile(path.join(keys, 'id_ed25519.pub'), 'utf8')).trim()],
      },
    ],
    ssh_pwauth: false,
    disable_root: true,
    ssh_deletekeys: false,
    ssh_keys: {
      ed25519_private: await readFile(path.join(keys, 'host_ed25519'), 'utf8'),
      ed25519_public: hostKey,
    },
    runcmd: [['systemctl', 'enable', '--now', 'ssh.service']],
  };
  await writeFile(
    path.join(root, 'seed.iso'),
    seed.seedImage(
      `#cloud-config\n${JSON.stringify(cloud, null, 2)}\n`,
      `${JSON.stringify({ 'instance-id': `daban-${vmId}`, 'local-hostname': 'daban-builder' })}\n`,
    ),
    { mode: 0o600, flag: 'wx' },
  );
  await store.writeQemuRecord(path.join(root, 'machine.json'), machine);
  await store.writeQemuRecord(path.join(dataRoot, 'build.json'), {
    version: 1,
    vmId,
    source: await qemu.qemuFileHash(image),
    toolsId,
    preparedAt: new Date().toISOString(),
  });
  await saveVmConnection(path.join(dataRoot, 'runtime.json'), connection);
  await writeFile(
    path.join(root, 'known_hosts'),
    `[127.0.0.1]:${connection.sshPort} ${hostKey}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  const owner = new qemu.QemuLink(connection, dataRoot);
  try {
    const running = await owner.boot();
    console.log(
      JSON.stringify({
        state: 'running',
        mode: running.acceleration,
        pid: running.pid,
        vmId,
        sshPort: connection.sshPort,
        root,
      }),
    );
  } finally {
    await owner.close();
  }
}

async function seal(dataRoot: string, output: string) {
  const build = await store.readQemuRecord(path.join(dataRoot, 'build.json'));
  assert.ok(
    build &&
      typeof build === 'object' &&
      'vmId' in build &&
      typeof build.vmId === 'string' &&
      'source' in build,
  );
  const connection = await readVmConnection(path.join(dataRoot, 'runtime.json'));
  assert.ok(
    connection &&
      connection.provider === 'qemu' &&
      connection.vmId === build.vmId &&
      connection.user === 'daban',
  );
  const root = path.join(dataRoot, 'qemu');
  const machine = qemu.parseQemuMachine(
    await store.readQemuRecord(path.join(root, 'machine.json')),
    root,
  );
  assert.equal(machine.connection.vmId, build.vmId);
  await qemu.verifyQemuTools(machine, root);
  const target = await secureDirectory(output);
  assert.deepEqual(await readdir(target), [], 'QEMU_BUILD_OUTPUT_NOT_EMPTY');
  const known = path.join(root, 'known_hosts');
  assert.equal(
    await readFile(known, 'utf8'),
    `[127.0.0.1]:${connection.sshPort} ${connection.hostKey}\n`,
  );
  const options = [
    '-F',
    'NUL',
    '-i',
    connection.identityFile,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'HostKeyAlgorithms=ssh-ed25519',
    '-o',
    `UserKnownHostsFile=${known}`,
    '-o',
    'GlobalKnownHostsFile=NUL',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'IdentityAgent=none',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ProxyCommand=none',
  ];
  const binaries = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/OpenSSH');
  const ssh = (command: string, input?: string) =>
    execFileSync(
      path.join(binaries, 'ssh.exe'),
      [
        ...options,
        '-T',
        '-p',
        String(connection.sshPort),
        '-l',
        connection.user,
        connection.host,
        command,
      ],
      {
        input,
        stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
        timeout: 240000,
        windowsHide: true,
      },
    );
  const owner = new qemu.QemuLink(connection, dataRoot);
  try {
    await owner.stopVm();
    await owner.ensure();
    const stamp = JSON.stringify({
      version: 1,
      vmId: build.vmId,
      protocol: windowsEnvironment.protocol,
    });
    ssh(
      'sudo /bin/sh',
      `set -eu\ntest "$(cat /sys/class/dmi/id/product_uuid)" = '${build.vmId}'\nprintf '%s\\n' '${stamp}' > /etc/daban-image-builder.json\nchmod 600 /etc/daban-image-builder.json\n`,
    );
    execFileSync(
      path.join(binaries, 'scp.exe'),
      [
        ...options,
        '-P',
        String(connection.sshPort),
        fileURLToPath(new URL('./qemu-guest.ts', import.meta.url)),
        'daban@127.0.0.1:/home/daban/qemu-guest.ts',
      ],
      { stdio: 'inherit', timeout: 60000, windowsHide: true },
    );
    ssh(
      `sudo /opt/node-v24.22.1-linux-x64/bin/node --experimental-strip-types /home/daban/qemu-guest.ts seal ${build.vmId}`,
    );
    await owner.stopVm();
    assert.equal(await owner.state(), 'stopped');
    const binary = path.join(root, 'tools/qemu-img.exe');
    execFileSync(binary, ['check', '-f', 'qcow2', path.join(root, 'disk.qcow2')], {
      stdio: 'inherit',
      windowsHide: true,
      timeout: 120000,
    });
    const image = path.join(target, 'desktop.qcow2');
    execFileSync(
      binary,
      ['convert', '-f', 'qcow2', '-O', 'qcow2', '-S', '4096', path.join(root, 'disk.qcow2'), image],
      { stdio: 'inherit', windowsHide: true, timeout: 300000 },
    );
    const expanded = await qemu.qemuFileHash(image);
    await pipeline(
      createReadStream(image),
      createGzip({ level: 6 }),
      createWriteStream(path.join(target, 'desktop.qcow2.gz'), { flags: 'wx' }),
    );
    const compressed = await qemu.qemuFileHash(path.join(target, 'desktop.qcow2.gz'));
    await cp(path.join(root, 'tools'), path.join(target, 'tools'), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await store.writeQemuRecord(path.join(target, 'qemu.json'), {
      version: 1,
      protocol: windowsEnvironment.protocol,
      toolsId: machine.toolsId,
      image: { ...compressed, expandedBytes: expanded.bytes, expandedSha256: expanded.sha256 },
    });
    await store.writeQemuRecord(path.join(target, 'provenance.json'), {
      version: 1,
      system: 'debian-13-amd64',
      source: build.source,
      protocol: windowsEnvironment.protocol,
      toolsId: machine.toolsId,
      expanded,
      compressed,
      sealedAt: new Date().toISOString(),
    });
    await writeFile(
      path.join(target, 'COMPONENTS.md'),
      `# Daban Windows Linux environment\n\nDebian 13 amd64: https://cloud.debian.org/images/cloud/trixie/latest/\n\nQEMU 11.1.0 (v11.1.0-12130-ge470268ff4), Windows maintainer build 2026-08-11: https://qemu.weilnetz.de/w64/2026/\nSource: https://gitlab.com/qemu-project/qemu/-/tree/e470268ff4\nLicenses: tools/COPYING, tools/COPYING.LIB and /usr/share/doc inside Linux.\n\nNode.js ${'24.22.1'}: https://nodejs.org/dist/v24.22.1/\nLicense: /opt/node-v24.22.1-linux-x64/LICENSE inside Linux.\n\nThe image contains no executor token, SSH host identity, login authorized keys, browser login or task workspace. Each installation injects a fresh SSH identity before connecting.\n`,
    );
    console.log(
      JSON.stringify({
        bundle: target,
        compressedBytes: compressed.bytes,
        expandedBytes: expanded.bytes,
        toolsId: machine.toolsId,
      }),
    );
  } finally {
    await owner.close();
  }
}

const [action, directory, source, image] = process.argv.slice(2);
if (action === 'prepare' && directory && source && image)
  await prepare(path.resolve(directory), path.resolve(source), path.resolve(image));
else if (action === 'seal' && directory && source)
  await seal(path.resolve(directory), path.resolve(source));
else
  throw Error(
    'Usage: qemu-image.ts prepare <new-build-directory> <verified-qemu-directory> <verified-debian-raw> | seal <build-directory> <new-bundle-directory>',
  );
