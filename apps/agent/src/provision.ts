import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { VmConfig } from './vm.js';

export interface CleanImage {
  id: string;
  bytes: number;
  sha256: string;
  rawBytes: number;
  rawSha256: string;
}
const clean38: CleanImage = {
  id: 'daban-38-0b2c13631d754382',
  bytes: 1243539382,
  sha256: '0b2c13631d75438214b32ebe5f016b625e27c993d602019b83eee47e044ebde9',
  rawBytes: 17179869184,
  rawSha256: 'e74a74239cb93d057b17d9a7c72f4dfd2fcab051a1be052766ed350f6bb62df7',
};
interface RunOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}
type Run = (
  program: string,
  args: string[],
  options: RunOptions,
) => Promise<{ code: number; stdout: string }>;
interface ProvisionDependencies {
  run?: Run;
  progress?: (stage: string, percent?: number) => unknown;
  port?: () => Promise<number>;
  image?: CleanImage;
}
interface Journal {
  version: 1;
  id: string;
  root: string;
  dev: number;
  ino: number;
  image: string;
  archive: string;
  vm: string;
  limaHome?: string;
  port: number;
  phase: 'assets' | 'creating' | 'created' | 'starting' | 'bootstrapping' | 'ready';
  disk?: { dev: number; ino: number };
  sshIdentity?: { dev: number; ino: number };
}
const execute: Run = (program, args, options) =>
  new Promise((resolve, reject) => {
    execFile(program, args, { ...options, encoding: 'utf8' }, (error, stdout) => {
      if (error && typeof error.code !== 'number') reject(new Error('PROVISION_COMMAND'));
      else resolve({ code: error ? Number(error.code) : 0, stdout });
    });
  });
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function parseJson(text: string, error: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(error);
  }
}
const present = async (file: string) =>
  lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
async function regular(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = await handle.stat();
  if (!info.isFile() || info.nlink !== 1) {
    await handle.close();
    throw new Error('PROVISION_ASSET');
  }
  return handle;
}
async function hash(file: string) {
  const handle = await regular(file);
  try {
    const before = await handle.stat();
    const value = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) value.update(chunk);
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('PROVISION_INTEGRITY');
    return { bytes: before.size, sha256: value.digest('hex') };
  } finally {
    await handle.close();
  }
}
async function save(file: string, value: unknown, exclusive = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (exclusive) await link(temporary, file);
    else await rename(temporary, file);
    const parent = await open(
      path.dirname(file),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
async function json(file: string, privateFile = false): Promise<unknown> {
  const handle = await regular(file);
  try {
    const info = await handle.stat();
    if (
      info.size > 65536 ||
      (privateFile && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600))
    )
      throw new Error('PROVISION_STORE');
    return parseJson(await handle.readFile('utf8'), 'PROVISION_STORE');
  } finally {
    await handle.close();
  }
}
export async function materializeImage(
  source: string,
  target: string,
  image: CleanImage,
  progress: (percent: number) => unknown = () => {},
) {
  const compressed = await hash(source);
  if (compressed.bytes !== image.bytes || compressed.sha256 !== image.sha256)
    throw new Error('PROVISION_IMAGE_INTEGRITY');
  const output = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const input = await regular(source);
  const zero = Buffer.alloc(65536);
  const raw = createHash('sha256');
  let bytes = 0,
    last = -1;
  try {
    await pipeline(
      input.createReadStream({ autoClose: false }),
      createGunzip({ chunkSize: zero.length }),
      async (chunks: AsyncIterable<Buffer>) => {
        for await (const chunk of chunks) {
          if (bytes + chunk.length > image.rawBytes) throw new Error('PROVISION_IMAGE_INTEGRITY');
          raw.update(chunk);
          // Skip zero blocks without allocating disk space; the hash still covers every byte.
          if (!chunk.equals(zero.subarray(0, chunk.length))) {
            let first = 0,
              end = chunk.length;
            while (first < end && chunk[first] === 0) first++;
            while (end > first && chunk[end - 1] === 0) end--;
            let written = first;
            while (written < end) {
              const part = await output.write(chunk, written, end - written, bytes + written);
              if (!part.bytesWritten) throw new Error('PROVISION_IMAGE_WRITE');
              written += part.bytesWritten;
            }
          }
          bytes += chunk.length;
          const percent = Math.floor((bytes / image.rawBytes) * 100);
          if (percent !== last) {
            progress(percent);
            last = percent;
          }
        }
      },
    );
    if (bytes !== image.rawBytes || raw.digest('hex') !== image.rawSha256)
      throw new Error('PROVISION_IMAGE_INTEGRITY');
    await output.truncate(bytes);
    await output.sync();
  } finally {
    await input.close();
    await output.close();
  }
}
async function archiveSnapshot(
  source: string,
  target: string,
  expected: { bytes: number; sha256: string },
) {
  if (await present(target)) {
    const saved = await hash(target);
    if (saved.bytes !== expected.bytes || saved.sha256 !== expected.sha256)
      throw new Error('PROVISION_ARCHIVE');
    return;
  }
  const input = await regular(source);
  const output = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > expected.bytes) throw new Error('PROVISION_ARCHIVE');
      digest.update(chunk);
      await output.writeFile(chunk);
    }
    if (bytes !== expected.bytes || digest.digest('hex') !== expected.sha256)
      throw new Error('PROVISION_ARCHIVE');
    await output.sync();
  } finally {
    await input.close();
    await output.close();
  }
}
export async function verifyExecutorArchive(file: string) {
  try {
    const digest = await hash(file);
    if (digest.bytes < 18 || digest.bytes > 1024 ** 3) throw new Error('PROVISION_ARCHIVE');
    const handle = await regular(file);
    const names = new Set<string>();
    const required = [
      'main.js',
      'package.json',
      'node_modules/@daban/engine/package.json',
      'node_modules/@daban/engine/dist/executor.js',
      'node_modules/@daban/protocol/package.json',
      'node_modules/@daban/protocol/dist/index.js',
    ];
    let pending = Buffer.alloc(0),
      skip = 0,
      total = 0,
      zeros = 0;
    try {
      await pipeline(
        handle.createReadStream({ autoClose: false }),
        createGunzip(),
        async (chunks: AsyncIterable<Buffer>) => {
          for await (const chunk of chunks) {
            total += chunk.length;
            if (total > 4 * 1024 ** 3) throw new Error('PROVISION_ARCHIVE');
            pending = Buffer.concat([pending, chunk]);
            for (;;) {
              if (skip) {
                const count = Math.min(skip, pending.length);
                skip -= count;
                pending = pending.subarray(count);
                if (skip) break;
              }
              if (pending.length < 512) break;
              const header = pending.subarray(0, 512);
              pending = pending.subarray(512);
              if (header.equals(Buffer.alloc(512))) {
                zeros++;
                continue;
              }
              if (zeros || header.subarray(257, 262).toString() !== 'ustar')
                throw new Error('PROVISION_ARCHIVE');
              const field = (from: number, to: number) =>
                header.subarray(from, to).toString('utf8').split('\0')[0];
              const size = field(124, 136).trim();
              const checksum = field(148, 156).trim();
              const mode = field(100, 108).trim();
              if (!/^[0-7]+$/.test(size) || !/^[0-7]+$/.test(checksum) || !/^[0-7]+$/.test(mode))
                throw new Error('PROVISION_ARCHIVE');
              let sum = 0;
              for (let index = 0; index < 512; index++)
                sum += index >= 148 && index < 156 ? 32 : header[index];
              if (sum !== Number.parseInt(checksum, 8) || Number.parseInt(mode, 8) & 0o7000)
                throw new Error('PROVISION_ARCHIVE');
              const type = field(156, 157);
              if (!['', '0', '5'].includes(type)) throw new Error('PROVISION_ARCHIVE');
              const prefix = field(345, 500);
              let name = `${prefix ? `${prefix}/` : ''}${field(0, 100)}`;
              while (name.startsWith('./')) name = name.slice(2);
              name = name.replace(/\/$/, '');
              if (name === '.' || name === '') {
                if (type !== '5') throw new Error('PROVISION_ARCHIVE');
              } else {
                if (
                  name.startsWith('/') ||
                  name.includes('\\') ||
                  name.split('/').some((part) => !part || part === '.' || part === '..') ||
                  names.has(name) ||
                  name
                    .split('/')
                    .some((part) =>
                      [
                        '.ssh',
                        '.dsh',
                        '.env',
                        '.npmrc',
                        '.git',
                        '@deepseek-ai',
                        'credentials.json',
                        'control-token',
                        'id_rsa',
                        'id_ed25519',
                      ].includes(part),
                    ) ||
                  /\.(test|acceptance|integration)\.[cm]?js$/.test(name)
                )
                  throw new Error('PROVISION_ARCHIVE');
                names.add(name);
              }
              const bytes = Number.parseInt(size, 8);
              if (
                !Number.isSafeInteger(bytes) ||
                bytes > 1024 ** 3 ||
                (type === '5' && bytes !== 0) ||
                names.size > 150000
              )
                throw new Error('PROVISION_ARCHIVE');
              skip = Math.ceil(bytes / 512) * 512;
            }
          }
        },
      );
      if (skip || pending.length || zeros < 2 || !required.every((name) => names.has(name)))
        throw new Error('PROVISION_ARCHIVE');
    } finally {
      await handle.close();
    }
    const after = await hash(file);
    if (after.bytes !== digest.bytes || after.sha256 !== digest.sha256)
      throw new Error('PROVISION_ARCHIVE');
    return digest;
  } catch {
    throw new Error('PROVISION_ARCHIVE');
  }
}

const bootstrap = `set -eu
archive="$1"
expected="$2"
owner="$3"
image="$4"
marker=/var/lib/daban-executor/provision.json
if [ -e "$marker" ]; then
  /opt/bot-prototype/node/bin/node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(m.id!==process.argv[2]||m.archive!==process.argv[3]||m.image!==process.argv[4])process.exit(65)' "$marker" "$owner" "$expected" "$image"
  systemctl start daban-executor.service
  exit 0
fi
if find /var/lib/bot-prototype /home/bot-prototype /home/daban /root -type f -name credentials.json -print -quit 2>/dev/null | grep -q .; then
  echo PROVISION_GUEST_NOT_CLEAN >&2
  exit 65
fi
if findmnt -rn -t virtiofs,9p,fuse.sshfs | grep -q .; then exit 65; fi
if [ -n "$(find /run/host-services -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then exit 65; fi
printf '%s  %s\\n' "$expected" "$archive" | sha256sum --check --status
for unit in bot-browser.service daban-software.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then systemctl disable --now "$unit"; fi
done
if find /var/lib/bot-prototype /home/bot-prototype /home/daban /root -type f -name credentials.json -print -quit 2>/dev/null | grep -q .; then
  echo PROVISION_GUEST_NOT_CLEAN >&2
  exit 65
fi
target=/opt/daban-executor
stage=/opt/.daban-executor-$owner
if [ -e "$target" ]; then
  test -f "$target/.archive-sha256"
  test "$(cat "$target/.archive-sha256")" = "$expected"
else
  if [ ! -e "$stage" ]; then mkdir -m 755 "$stage"; printf '%s\\n' "$expected" > "$stage/.archive-sha256"; fi
  test "$(cat "$stage/.archive-sha256")" = "$expected"
  tar xzf "$archive" -C "$stage" --no-same-owner
  mv "$stage" "$target"
fi
source=/opt/bot-prototype/app/runtime/node_modules
test ! -e "$source/@deepseek-ai"
test ! -e "$target/node_modules/@deepseek-ai"
/opt/bot-prototype/node/bin/node - "$source" <<'NODE'
const fs=require('node:fs');const path=require('node:path');const root=process.argv[2];
for(const [name,version] of [['@modelcontextprotocol/client','2.2.0'],['officeparser','8.2.0'],['playwright','1.62.1'],['yaml','2.9.1']]){const item=JSON.parse(fs.readFileSync(path.join(root,name,'package.json'),'utf8'));if(item.name!==name||item.version!==version)process.exit(65);}
NODE
for dependency in @modelcontextprotocol officeparser playwright yaml; do
  if [ ! -e "$target/node_modules/$dependency" ]; then ln -s "$source/$dependency" "$target/node_modules/$dependency"; fi
done
/opt/bot-prototype/node/bin/node - "$target/node_modules" <<'NODE'
const fs=require('node:fs');const path=require('node:path');const root=process.argv[2];
for(const [name,version] of [['@modelcontextprotocol/client','2.2.0'],['officeparser','8.2.0'],['playwright','1.62.1'],['yaml','2.9.1']]){const item=JSON.parse(fs.readFileSync(path.join(root,name,'package.json'),'utf8'));if(item.name!==name||item.version!==version)process.exit(65);}
NODE
chown -R root:root "$target"
chmod -R a+rX,go-w "$target"
rm -rf /opt/bot-prototype/dsh
rm -f /etc/systemd/system/bot-browser.service /etc/systemd/system/daban-software.service
rm -rf /var/lib/bot-prototype
install -d -m 700 -o bot-prototype -g bot-prototype /var/lib/bot-prototype /var/lib/bot-prototype/profile /var/lib/bot-prototype/desktops /var/lib/bot-prototype/desktops/shared /var/lib/daban-executor
for binary in node npm npx; do ln -sfn /opt/bot-prototype/node/bin/$binary /usr/local/bin/$binary; done
cat > /etc/systemd/system/daban-executor.service <<'UNIT'
[Unit]
Description=daban isolated Linux execution service
After=network.target
[Service]
Type=simple
User=bot-prototype
Group=bot-prototype
WorkingDirectory=/opt/daban-executor
Environment=PATH=/opt/bot-prototype/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/bot-prototype/browsers
Environment=PLAYWRIGHT_MODULE=/opt/daban-executor/node_modules/playwright/index.mjs
Environment=DABAN_EXECUTION_DIR=/var/lib/daban-executor
Environment=DABAN_WORKSPACE_DIR=/var/lib/bot-prototype/desktops/shared
Environment=PROFILE_DIR=/var/lib/bot-prototype/profile
Environment=DABAN_DESKTOP_DIR=/var/lib/bot-prototype/desktops
Environment=PORT=8766
Environment=COMPUTER_SLOTS=2
ExecStart=/opt/bot-prototype/node/bin/node /opt/daban-executor/main.js
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=20
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
# Shared root installs require 022 despite an inherited 0077.
printf 'Defaults:bot-prototype umask=0022,umask_override\\nbot-prototype ALL=(ALL) NOPASSWD: ALL\\n' > /etc/sudoers.d/.daban-executor-new
chmod 440 /etc/sudoers.d/.daban-executor-new
visudo -cf /etc/sudoers.d/.daban-executor-new >/dev/null
mv /etc/sudoers.d/.daban-executor-new /etc/sudoers.d/daban-executor
test "$(sudo -n -u bot-prototype sudo -n /usr/bin/id -u)" = 0
systemctl daemon-reload
systemctl enable --now daban-executor.service
/opt/bot-prototype/node/bin/node - "$marker" "$owner" "$expected" "$image" <<'NODE'
const fs=require('node:fs');const file=process.argv[2];fs.writeFileSync(file,JSON.stringify({version:1,id:process.argv[3],archive:process.argv[4],image:process.argv[5]})+'\\n',{mode:0o600});
NODE
rm -f "$archive"
`;

function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) =>
        error || !address || typeof address === 'string'
          ? reject(new Error('PROVISION_PORT'))
          : resolve(address.port),
      );
    });
  });
}
export async function ensureExecutionVm(
  options: {
    directory: string;
    packDirectory: string;
    executorArchive: string;
    limactl: string;
    vm?: string;
  },
  dependencies: ProvisionDependencies = {},
): Promise<VmConfig> {
  if (
    ![options.directory, options.packDirectory, options.executorArchive, options.limactl].every(
      (value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value),
    ) ||
    path.basename(options.limactl) !== 'limactl' ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/.test(options.vm || 'execution')
  )
    throw new Error('PROVISION_CONFIG');
  const image = dependencies.image || clean38;
  const manifest = await json(path.join(options.packDirectory, 'manifest.json'));
  if (
    !record(manifest) ||
    manifest.version !== 1 ||
    manifest.id !== image.id ||
    !record(manifest.image) ||
    manifest.image.file !== 'system.raw.gz' ||
    !['bytes', 'sha256', 'rawBytes', 'rawSha256'].every(
      (key) =>
        manifest.image &&
        record(manifest.image) &&
        manifest.image[key] === image[key as keyof CleanImage],
    )
  )
    throw new Error('PROVISION_IMAGE_INTEGRITY');
  const archive = await verifyExecutorArchive(options.executorArchive);
  let created = false;
  try {
    await mkdir(options.directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
      throw error;
  }
  const info = await lstat(options.directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error('PROVISION_STORE_UNOWNED');
  const root = await realpath(options.directory),
    journalFile = path.join(root, 'provision.json'),
    vm = options.vm || 'execution';
  const nestedHome = path.join(root, 'lima');
  // OpenSSH binds a temporary socket with a 17-byte suffix, not only the final ssh.sock path.
  const fits = (home: string) =>
    Buffer.byteLength(path.join(home, vm, 'ssh.sock.1234567890123456')) < 104;
  const limaHome = fits(nestedHome) ? nestedHome : root;
  if (!fits(limaHome)) throw new Error('PROVISION_PATH_TOO_LONG');
  let journal: Journal;
  if (!created) {
    if (!(await present(journalFile))) throw new Error('PROVISION_STORE_UNOWNED');
    const value = await json(journalFile, true);
    if (
      !record(value) ||
      value.version !== 1 ||
      value.root !== root ||
      value.dev !== info.dev ||
      value.ino !== info.ino ||
      value.image !== image.rawSha256 ||
      value.archive !== archive.sha256 ||
      value.vm !== vm ||
      (value.limaHome !== undefined && value.limaHome !== limaHome) ||
      typeof value.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.id) ||
      !['assets', 'creating', 'created', 'starting', 'bootstrapping', 'ready'].includes(
        String(value.phase),
      ) ||
      !Number.isInteger(value.port) ||
      Number(value.port) < 1024 ||
      Number(value.port) > 65535
    )
      throw new Error('PROVISION_STORE_IDENTITY');
    journal = value as unknown as Journal;
    if (journal.limaHome === undefined) {
      if (limaHome !== nestedHome && (await present(path.join(nestedHome, vm))))
        throw new Error('PROVISION_VM_IDENTITY');
      journal.limaHome = limaHome;
      await save(journalFile, journal);
    }
  } else {
    journal = {
      version: 1,
      id: randomUUID(),
      root,
      dev: info.dev,
      ino: info.ino,
      image: image.rawSha256,
      archive: archive.sha256,
      vm,
      limaHome,
      port: await (dependencies.port || availablePort)(),
      phase: 'assets',
    };
    await save(journalFile, journal, true);
    if (limaHome !== root) await mkdir(limaHome, { mode: 0o700 });
  }
  const settings = {
    env: {
      PATH: `${path.dirname(options.limactl)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: homedir(),
      LANG: 'C',
      LIMA_HOME: limaHome,
    },
    timeout: 180000,
    maxBuffer: 65536,
  };
  const run = dependencies.run || execute;
  const invoke = async (args: string[]) => {
    const result = await run(options.limactl, args, settings);
    if (result.code) throw new Error('PROVISION_COMMAND');
    return result;
  };
  const phase = async (value: Journal['phase']) => {
    journal.phase = value;
    await save(journalFile, journal);
    dependencies.progress?.(value);
  };
  const list = async () => {
    // Filtered list exits nonzero before first creation; this home is private to exactly one VM.
    const result = await invoke(['list', '--json']);
    if (!result.stdout.trim()) return undefined;
    const rows = result.stdout
      .trim()
      .split('\n')
      .map((line): unknown => parseJson(line, 'PROVISION_VM_IDENTITY'));
    if (rows.length !== 1 || !record(rows[0])) throw new Error('PROVISION_VM_IDENTITY');
    const value = rows[0];
    if (
      value.name !== vm ||
      value.dir !== path.join(limaHome, vm) ||
      !['Stopped', 'Running'].includes(String(value.status)) ||
      !record(value.config)
    )
      throw new Error('PROVISION_VM_IDENTITY');
    const config = value.config,
      ssh = config.ssh,
      containers = config.containerd;
    if (
      config.vmType !== 'vz' ||
      config.arch !== 'aarch64' ||
      !record(ssh) ||
      ssh.forwardAgent !== false ||
      ssh.loadDotSSHPubKeys !== false ||
      ssh.forwardX11 !== false ||
      ssh.forwardX11Trusted !== false ||
      config.propagateProxyEnv !== false ||
      (config.mounts !== undefined && (!Array.isArray(config.mounts) || config.mounts.length)) ||
      (config.copyToHost !== undefined &&
        (!Array.isArray(config.copyToHost) || config.copyToHost.length)) ||
      !record(containers) ||
      containers.system !== false ||
      containers.user !== false ||
      !Array.isArray(config.images) ||
      config.images.length !== 1 ||
      !record(config.images[0]) ||
      config.images[0].location !== `file://${path.join(root, 'system.raw')}` ||
      config.images[0].digest !== `sha256:${image.rawSha256}` ||
      !Array.isArray(config.portForwards) ||
      !config.portForwards.length ||
      !config.portForwards.every(
        (entry) =>
          record(entry) &&
          entry.ignore === true &&
          !('hostSocket' in entry) &&
          !('guestSocket' in entry),
      )
    )
      throw new Error('PROVISION_VM_IDENTITY');
    const disk = await lstat(path.join(limaHome, vm, 'disk')).catch(
      (error: NodeJS.ErrnoException) => {
        if (
          error.code === 'ENOENT' &&
          !journal.disk &&
          !journal.sshIdentity &&
          ['creating', 'created', 'starting'].includes(journal.phase)
        )
          return undefined;
        throw new Error('PROVISION_VM_IDENTITY');
      },
    );
    // Lima can persist the config before initial image materialization; finish that same instance.
    if (!disk) return value;
    if (
      !disk.isFile() ||
      disk.nlink !== 1 ||
      disk.isSymbolicLink() ||
      (journal.disk && (journal.disk.dev !== disk.dev || journal.disk.ino !== disk.ino))
    )
      throw new Error('PROVISION_VM_IDENTITY');
    if (!journal.disk) {
      journal.disk = { dev: disk.dev, ino: disk.ino };
      await save(journalFile, journal);
    }
    const identity = await lstat(path.join(limaHome, '_config/user'));
    if (
      !identity.isFile() ||
      identity.isSymbolicLink() ||
      identity.nlink !== 1 ||
      identity.uid !== process.getuid?.() ||
      (identity.mode & 0o777) !== 0o600 ||
      (journal.sshIdentity &&
        (identity.dev !== journal.sshIdentity.dev || identity.ino !== journal.sshIdentity.ino))
    )
      throw new Error('PROVISION_VM_IDENTITY');
    if (!journal.sshIdentity) {
      // Store only inode metadata; the provisioner never reads the private SSH key bytes.
      journal.sshIdentity = { dev: identity.dev, ino: identity.ino };
      await save(journalFile, journal);
    }
    return value;
  };
  let state = await list();
  if (state && journal.phase === 'assets') throw new Error('PROVISION_VM_IDENTITY');
  if (!state) {
    // A previous create may still be running. Missing status is never permission to create again.
    if (journal.phase !== 'assets') throw new Error('PROVISION_CREATE_UNCERTAIN');
    const raw = path.join(root, 'system.raw');
    if (!(await present(raw)))
      await materializeImage(
        path.join(options.packDirectory, 'system.raw.gz'),
        raw,
        image,
        (percent) => dependencies.progress?.('image', percent),
      );
    else {
      const actual = await hash(raw);
      if (actual.bytes !== image.rawBytes || actual.sha256 !== image.rawSha256)
        throw new Error('PROVISION_IMAGE_INTEGRITY');
    }
    const template = {
      minimumLimaVersion: '2.2.1',
      vmType: 'vz',
      arch: 'aarch64',
      cpus: 4,
      memory: '4GiB',
      disk: '16GiB',
      images: [
        // Lima 2.2.1 opens local file URIs literally and does not unescape %20.
        { location: `file://${raw}`, arch: 'aarch64', digest: `sha256:${image.rawSha256}` },
      ],
      user: {
        name: 'daban',
        uid: 2000,
        home: '/home/daban',
        shell: '/bin/bash',
        passwordlessSudo: true,
      },
      mounts: [],
      copyToHost: [],
      ssh: {
        localPort: 0,
        loadDotSSHPubKeys: false,
        forwardAgent: false,
        forwardX11: false,
        forwardX11Trusted: false,
      },
      containerd: { system: false, user: false },
      portForwards: [
        {
          guestIP: '0.0.0.0',
          guestIPMustBeZero: false,
          guestPortRange: [1, 65535],
          proto: 'any',
          ignore: true,
        },
      ],
      hostResolver: { enabled: true },
      propagateProxyEnv: false,
      upgradePackages: false,
      nestedVirtualization: false,
    };
    const templateFile = path.join(root, 'vm.json');
    await save(templateFile, template);
    await phase('creating');
    try {
      await invoke(['create', '--tty=false', `--name=${vm}`, templateFile]);
    } catch {
      state = await list();
      if (!state) throw new Error('PROVISION_CREATE_UNCERTAIN');
    }
    state ||= await list();
    if (!state) throw new Error('PROVISION_CREATE_UNCERTAIN');
    await phase('created');
  }
  if (state.status === 'Stopped') {
    await phase('starting');
    await invoke(['start', '--tty=false', vm]);
    state = await list();
    if (state?.status !== 'Running') throw new Error('PROVISION_START_UNCERTAIN');
  }
  const markerPath = '/var/lib/daban-executor/provision.json';
  const probe = await run(
    options.limactl,
    ['shell', vm, 'sudo', '-n', 'cat', markerPath],
    settings,
  );
  let installed = false;
  if (!probe.code) {
    let value: unknown;
    try {
      value = JSON.parse(probe.stdout);
    } catch {
      throw new Error('PROVISION_GUEST_IDENTITY');
    }
    if (
      !record(value) ||
      value.version !== 1 ||
      value.id !== journal.id ||
      value.image !== image.rawSha256 ||
      value.archive !== archive.sha256
    )
      throw new Error('PROVISION_GUEST_IDENTITY');
    installed = true;
  }
  if (!installed) {
    if (journal.phase === 'ready') throw new Error('PROVISION_GUEST_IDENTITY');
    await phase('bootstrapping');
    const script = path.join(root, 'bootstrap.sh');
    if (!(await present(script))) await writeFile(script, bootstrap, { mode: 0o600, flag: 'wx' });
    const scriptInfo = await lstat(script);
    if (
      !scriptInfo.isFile() ||
      scriptInfo.isSymbolicLink() ||
      scriptInfo.nlink !== 1 ||
      scriptInfo.uid !== process.getuid?.()
    )
      throw new Error('PROVISION_SCRIPT');
    if ((await hash(script)).sha256 !== createHash('sha256').update(bootstrap).digest('hex'))
      throw new Error('PROVISION_SCRIPT');
    await chmod(script, 0o600);
    const frozenArchive = path.join(root, `executor-${archive.sha256}.tar.gz`);
    await archiveSnapshot(options.executorArchive, frozenArchive, archive);
    const guestArchive = `/tmp/daban-executor-${journal.id}.tar.gz`,
      guestScript = `/tmp/daban-executor-${journal.id}.sh`;
    await invoke(['copy', frozenArchive, `${vm}:${guestArchive}`]);
    await invoke(['copy', script, `${vm}:${guestScript}`]);
    await invoke([
      'shell',
      vm,
      'sudo',
      '-n',
      '/bin/sh',
      guestScript,
      guestArchive,
      archive.sha256,
      journal.id,
      image.rawSha256,
    ]);
    const verified = await run(
      options.limactl,
      ['shell', vm, 'sudo', '-n', 'cat', markerPath],
      settings,
    );
    if (verified.code) throw new Error('PROVISION_GUEST_IDENTITY');
    const value = parseJson(verified.stdout, 'PROVISION_GUEST_IDENTITY');
    if (
      !record(value) ||
      value.version !== 1 ||
      value.id !== journal.id ||
      value.archive !== archive.sha256 ||
      value.image !== image.rawSha256
    )
      throw new Error('PROVISION_GUEST_IDENTITY');
  }
  await phase('ready');
  return { limactl: options.limactl, limaHome, vm, port: journal.port };
}
