import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSoftwareName,
  isSoftwarePackage,
  isSoftwarePackages,
  isSoftwarePlan,
  isSoftwareReceipt,
  type SoftwarePackage,
  type SoftwarePlan,
  type SoftwareReceipt,
  type SoftwareState,
  validAgentId,
} from '@daban/protocol';

export const installerPaths = {
  directory: '/var/lib/daban-software',
  socket: '/run/daban-software/installer.sock',
  sources: '/etc/daban-software/debian.sources',
  lists: '/var/lib/daban-software-apt/lists',
  archives: '/var/cache/daban-software/archives',
  check: '/usr/local/bin/daban-software-check',
} as const;
interface CommandResult {
  stdout: string;
  stderr: string;
}
export interface InstallerOptions {
  directory?: string;
  socket?: string;
  sources?: string;
  lists?: string;
  archives?: string;
  check?: string;
  run?: (program: string, args: readonly string[]) => Promise<CommandResult>;
  now?: () => Date;
}
type Configuration = Required<InstallerOptions>;
class SoftwareFault extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const sortPackages = (items: SoftwarePackage[]) =>
  [...items].sort((left, right) => left.name.localeCompare(right.name, 'en'));
function digest(plan: Pick<SoftwarePlan, 'requested' | 'targets' | 'packages' | 'source'>) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        requested: [...plan.requested].sort(),
        targets: sortPackages(plan.targets),
        packages: sortPackages(plan.packages),
        source: plan.source,
      }),
    )
    .digest('hex');
}
async function run(program: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], {
      env: {
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        DEBIAN_FRONTEND: 'noninteractive',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      failure: Error | undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2 * 1024 * 1024) stderr += chunk.toString();
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new SoftwareFault('SOFTWARE_COMMAND_FAILED'));
      else resolve({ stdout, stderr });
    });
  });
}
function configuration(options: InstallerOptions): Configuration {
  return { ...installerPaths, run, now: () => new Date(), ...options };
}
async function privateJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 256 * 1024
    )
      throw new SoftwareFault('SOFTWARE_STORE_UNAVAILABLE', 503);
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}
async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function trustedDirectory(directory: string) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  )
    throw new SoftwareFault('SOFTWARE_DIRECTORY_UNSAFE', 503);
}
async function aptDirectories(config: Configuration) {
  for (const directory of [config.lists, config.archives]) {
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await trustedDirectory(path.dirname(directory));
    await trustedDirectory(directory);
  }
}
function validReceipt(value: unknown): value is SoftwareReceipt {
  return isSoftwareReceipt(value) && value.plan.digest === digest(value.plan);
}
function aptOptions(config: Configuration) {
  return [
    '-o',
    `Dir::Etc::sourcelist=${config.sources}`,
    '-o',
    'Dir::Etc::sourceparts=-',
    '-o',
    'Dir::Etc::trusted=/usr/share/keyrings/debian-archive-keyring.gpg',
    '-o',
    'Dir::Etc::trustedparts=-',
    '-o',
    `Dir::State::lists=${config.lists}`,
    '-o',
    `Dir::Cache::archives=${config.archives}`,
    '-o',
    'Dir::Cache::pkgcache=',
    '-o',
    'Dir::Cache::srcpkgcache=',
    '-o',
    'Acquire::http::Timeout=30',
    '-o',
    'Acquire::https::Timeout=30',
    '-o',
    'Acquire::Retries=0',
    '-o',
    'Acquire::AllowInsecureRepositories=false',
    '-o',
    'Acquire::AllowDowngradeToInsecureRepositories=false',
    '-o',
    'APT::Get::AllowUnauthenticated=false',
    '-o',
    'APT::Get::AutomaticRemove=false',
    '-o',
    'APT::Install-Recommends=false',
    '-o',
    'APT::Install-Suggests=false',
  ];
}
async function installed(config: Configuration, name: string) {
  try {
    const result = await config.run('/usr/bin/dpkg-query', [
      '-W',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query expands these fields itself.
      '-f=${Status}\t${Version}\n',
      '--',
      name,
    ]);
    const match = /^install ok installed\t([^\n]+)\n?$/.exec(result.stdout);
    if (!match || !isSoftwarePackage({ name, version: match[1] })) return undefined;
    return match[1];
  } catch {
    return undefined;
  }
}
async function verified(config: Configuration, plan: SoftwarePlan) {
  const wanted = new Map(
    [...plan.targets, ...plan.packages].map((item) => [item.name, item.version]),
  );
  for (const [name, version] of wanted)
    if ((await installed(config, name)) !== version) return false;
  return true;
}
async function sources(config: Configuration) {
  await trustedDirectory(path.dirname(config.sources));
  const handle = await open(config.sources, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0 ||
      info.size > 8192
    )
      throw new SoftwareFault('SOFTWARE_SOURCE_UNAVAILABLE', 503);
    const text = await handle.readFile('utf8');
    const stanzas = text.trim().split(/\n\s*\n/);
    if (!stanzas.length || stanzas.length > 3)
      throw new SoftwareFault('SOFTWARE_SOURCE_UNAVAILABLE', 503);
    for (const stanza of stanzas) {
      const fields = new Map<string, string>();
      for (const line of stanza
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('#'))) {
        const match = /^([A-Za-z-]+): ([^\r\n]+)$/.exec(line);
        if (!match || fields.has(match[1]))
          throw new SoftwareFault('SOFTWARE_SOURCE_UNAVAILABLE', 503);
        fields.set(match[1], match[2]);
      }
      if (
        [...fields.keys()].some(
          (key) =>
            !['Types', 'URIs', 'Suites', 'Components', 'Signed-By', 'Architectures'].includes(key),
        ) ||
        fields.get('Types') !== 'deb' ||
        fields.get('Components') !== 'main' ||
        fields.get('Signed-By') !== '/usr/share/keyrings/debian-archive-keyring.gpg' ||
        (fields.has('Architectures') && fields.get('Architectures') !== 'arm64') ||
        (fields.get('URIs') === 'https://deb.debian.org/debian'
          ? !/^(trixie|trixie-updates)( (trixie|trixie-updates))?$/.test(fields.get('Suites') ?? '')
          : fields.get('URIs') !== 'https://security.debian.org/debian-security' ||
            fields.get('Suites') !== 'trixie-security')
      )
        throw new SoftwareFault('SOFTWARE_SOURCE_UNAVAILABLE', 503);
    }
  } finally {
    await handle.close();
  }
}
async function simulation(config: Configuration, targets: SoftwarePackage[]) {
  const result = await config.run('/usr/bin/apt-get', [
    ...aptOptions(config),
    '--simulate',
    '--no-install-recommends',
    '--no-remove',
    '--no-upgrade',
    'install',
    '--',
    ...targets.map((item) => `${item.name}=${item.version}`),
  ]);
  const packages: SoftwarePackage[] = [];
  const configurations: SoftwarePackage[] = [];
  for (const line of result.stdout.split('\n')) {
    if (/^(Remv|Purg)(?:\s|$)/.test(line)) throw new SoftwareFault('SOFTWARE_UNSAFE_PLAN');
    if (!/^(Inst|Conf)(?:\s|$)/.test(line)) {
      if (/^[A-Z][A-Za-z]* [a-z0-9][a-z0-9+.:~-]* (?:\[|\()/.test(line))
        throw new SoftwareFault('SOFTWARE_UNSAFE_PLAN');
      continue;
    }
    const match = /^(Inst|Conf) ([^\s]+) \(([^\s]+) [^\n]+\)$/.exec(line);
    if (!match) throw new SoftwareFault('SOFTWARE_UNSAFE_PLAN');
    const item = { name: match[2], version: match[3] };
    if (match[1] === 'Conf') {
      if (
        !isSoftwarePackage(item) ||
        configurations.length >= 200 ||
        configurations.some((entry) => entry.name === item.name)
      )
        throw new SoftwareFault('SOFTWARE_UNSAFE_PLAN');
      configurations.push(item);
      continue;
    }
    if (
      !isSoftwarePackage(item) ||
      packages.some((entry) => entry.name === item.name) ||
      packages.length >= 200 ||
      (await installed(config, item.name))
    )
      throw new SoftwareFault('SOFTWARE_UNSAFE_PLAN');
    packages.push(item);
  }
  // Configuring a previously unpacked package also runs root scripts, even when no .deb is downloaded.
  for (const item of configurations)
    if (!packages.some((entry) => entry.name === item.name && entry.version === item.version))
      throw new SoftwareFault('SOFTWARE_UNSAFE_PLAN');
  for (const item of targets)
    if (
      !packages.some((entry) => entry.name === item.name && entry.version === item.version) &&
      (await installed(config, item.name)) !== item.version
    )
      throw new SoftwareFault('SOFTWARE_UNSAFE_PLAN');
  return sortPackages(packages);
}

export class Installer {
  readonly ready: Promise<unknown>;
  private readonly config: Configuration;
  private readonly records = new Map<string, SoftwareReceipt>();
  private tail: Promise<unknown> = Promise.resolve();
  private server?: Server;
  private listening = false;
  private canonical = '';
  private closed = false;
  private installation?: { id: string; accepted: Promise<SoftwareReceipt> };
  private failure?: string;
  constructor(options: InstallerOptions = {}) {
    this.config = configuration(options);
    this.ready = this.load();
  }
  private async load() {
    await mkdir(this.config.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.config.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new SoftwareFault('SOFTWARE_STORE_UNAVAILABLE', 503);
    this.canonical = await realpath(this.config.directory);
    const directory = path.join(this.config.directory, 'receipts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const receipts = await lstat(directory);
    if (
      !receipts.isDirectory() ||
      receipts.isSymbolicLink() ||
      receipts.uid !== process.getuid?.() ||
      (receipts.mode & 0o077) !== 0
    )
      throw new SoftwareFault('SOFTWARE_STORE_UNAVAILABLE', 503);
    for (const name of await readdir(directory)) {
      if (name.endsWith('.tmp')) continue;
      if (!name.endsWith('.json') || !validAgentId(name.slice(0, -5)))
        throw new SoftwareFault('SOFTWARE_STORE_UNAVAILABLE', 503);
      const value = await privateJson(path.join(directory, name));
      if (!validReceipt(value) || value.plan.id !== name.slice(0, -5))
        throw new SoftwareFault('SOFTWARE_STORE_UNAVAILABLE', 503);
      this.records.set(value.plan.id, value);
    }
    for (const receipt of this.records.values())
      if (receipt.phase === 'installing') {
        const complete = await verified(this.config, receipt.plan);
        await this.commit({
          ...receipt,
          phase: complete ? 'installed' : 'unknown',
          updatedAt: this.config.now().toISOString(),
          ...(complete ? {} : { error: 'SOFTWARE_OUTCOME_UNKNOWN' }),
        });
      }
  }
  private async commit(value: SoftwareReceipt) {
    if (!validReceipt(value) || (await realpath(this.config.directory)) !== this.canonical)
      throw new SoftwareFault('SOFTWARE_STORE_UNAVAILABLE', 503);
    await atomicJson(path.join(this.config.directory, 'receipts', `${value.plan.id}.json`), value);
    this.records.set(value.plan.id, structuredClone(value));
    return structuredClone(value);
  }
  private serialize<T>(action: () => Promise<T>) {
    if (this.closed || this.failure)
      return Promise.reject(new SoftwareFault(this.failure ?? 'SOFTWARE_CLOSED', 503));
    const pending = this.tail.then(async () => {
      await this.ready;
      return action();
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
  plan(input: unknown): Promise<SoftwareReceipt> {
    if (!object(input) || !exact(input, ['packages']) || !isSoftwarePackages(input.packages))
      return Promise.reject(new SoftwareFault('INVALID_SOFTWARE_REQUEST', 400));
    if (this.installation) return Promise.reject(new SoftwareFault('SOFTWARE_BUSY'));
    const requested = [...input.packages].sort();
    return this.serialize(async () => {
      if (this.records.size >= 10000) throw new SoftwareFault('SOFTWARE_STORAGE_LIMIT');
      await sources(this.config);
      await aptDirectories(this.config);
      await this.config.run('/usr/bin/apt-get', [...aptOptions(this.config), 'update']);
      const targets: SoftwarePackage[] = [];
      for (const name of requested) {
        const current = await installed(this.config, name);
        const policy = await this.config.run('/usr/bin/apt-cache', [
          ...aptOptions(this.config),
          'policy',
          '--',
          name,
        ]);
        if (policy.stdout.split('\n')[0] !== `${name}:`)
          throw new SoftwareFault('SOFTWARE_PACKAGE_UNAVAILABLE', 404);
        const candidates = [...policy.stdout.matchAll(/^ {2}Candidate: (\S+)$/gm)];
        const version = current ?? (candidates.length === 1 ? candidates[0][1] : undefined);
        if (!isSoftwarePackage({ name, version }))
          throw new SoftwareFault('SOFTWARE_PACKAGE_UNAVAILABLE', 404);
        targets.push({ name, version: version! });
      }
      const packages = await simulation(this.config, targets);
      const created = this.config.now();
      const content = { requested, targets, packages, source: 'debian' as const };
      const plan: SoftwarePlan = {
        id: randomUUID(),
        ...content,
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + 10 * 60 * 1000).toISOString(),
        digest: digest(content),
      };
      if (!isSoftwarePlan(plan)) throw new SoftwareFault('SOFTWARE_UNSAFE_PLAN');
      return this.commit({
        plan,
        phase: packages.length ? 'planned' : 'installed',
        updatedAt: created.toISOString(),
      });
    });
  }
  async install(input: unknown): Promise<SoftwareReceipt> {
    if (
      !object(input) ||
      !exact(input, ['id', 'digest']) ||
      !validAgentId(input.id) ||
      typeof input.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.digest)
    )
      throw new SoftwareFault('INVALID_SOFTWARE_REQUEST', 400);
    const { id, digest: approvedDigest } = input as { id: string; digest: string };
    await this.ready;
    if (this.closed || this.failure)
      throw new SoftwareFault(this.failure ?? 'SOFTWARE_CLOSED', 503);
    const original = this.receipt(id);
    if (original.plan.digest !== approvedDigest) throw new SoftwareFault('SOFTWARE_PLAN_CONFLICT');
    if (original.phase !== 'planned') return original;
    if (this.installation) {
      if (this.installation.id === id) return this.installation.accepted;
      throw new SoftwareFault('SOFTWARE_BUSY');
    }
    let accept: (receipt: SoftwareReceipt) => unknown = () => undefined;
    let refuse: (error: unknown) => unknown = () => undefined;
    const accepted = new Promise<SoftwareReceipt>((resolve, reject) => {
      accept = resolve;
      refuse = reject;
    });
    this.installation = { id, accepted };
    const operation = this.serialize(async () => {
      const receipt = this.receipt(id);
      if (receipt.plan.digest !== approvedDigest) throw new SoftwareFault('SOFTWARE_PLAN_CONFLICT');
      if (receipt.phase !== 'planned') {
        accept(receipt);
        return receipt;
      }
      try {
        if (Date.parse(receipt.plan.expiresAt) <= this.config.now().getTime())
          throw new SoftwareFault('SOFTWARE_PLAN_EXPIRED');
        await sources(this.config);
        await aptDirectories(this.config);
        await this.config.run('/usr/bin/apt-get', [...aptOptions(this.config), 'update']);
        const packages = await simulation(this.config, receipt.plan.targets);
        if (JSON.stringify(packages) !== JSON.stringify(receipt.plan.packages))
          throw new SoftwareFault('SOFTWARE_PLAN_CHANGED');
        // Refreshing package metadata may outlast the reviewed plan's validity.
        if (Date.parse(receipt.plan.expiresAt) <= this.config.now().getTime())
          throw new SoftwareFault('SOFTWARE_PLAN_EXPIRED');
      } catch (error) {
        const failure =
          error instanceof SoftwareFault
            ? error
            : new SoftwareFault('SOFTWARE_PREFLIGHT_FAILED', 503);
        try {
          // Refused dispatches are terminal receipts too; a later poll must not mistake them for queued work.
          await this.commit({
            ...receipt,
            phase: 'failed',
            error: failure.message,
            updatedAt: this.config.now().toISOString(),
          });
        } catch {
          this.failure = 'SOFTWARE_STORE_UNAVAILABLE';
          throw new SoftwareFault('SOFTWARE_STORE_UNAVAILABLE', 503);
        }
        throw failure;
      }
      const active: SoftwareReceipt = {
        ...receipt,
        phase: 'installing',
        updatedAt: this.config.now().toISOString(),
      };
      // The effect receipt and root-only hook plan commit before apt can begin modifying the VM.
      await this.commit(active);
      await atomicJson(path.join(this.config.directory, 'active.json'), active);
      accept(structuredClone(active));
      let error: string | undefined;
      try {
        await this.config.run('/usr/bin/apt-get', [
          ...aptOptions(this.config),
          '-o',
          `DPkg::Pre-Install-Pkgs::=${this.config.check}`,
          '-o',
          `DPkg::Tools::Options::${this.config.check}::Version=1`,
          '--assume-yes',
          '--no-install-recommends',
          '--no-remove',
          '--no-upgrade',
          'install',
          '--',
          ...receipt.plan.packages.map((item) => `${item.name}=${item.version}`),
        ]);
      } catch {
        error = 'SOFTWARE_INSTALL_FAILED';
      }
      const complete = await verified(this.config, receipt.plan);
      return this.commit({
        ...active,
        phase: complete ? 'installed' : error ? 'failed' : 'unknown',
        updatedAt: this.config.now().toISOString(),
        ...(complete ? {} : { error: error ?? 'SOFTWARE_VERIFY_FAILED' }),
      });
    });
    operation.then(
      () => {
        this.installation = undefined;
      },
      (error: unknown) => {
        if (this.records.get(id)?.phase === 'installing')
          this.failure = 'SOFTWARE_STORE_UNAVAILABLE';
        this.installation = undefined;
        refuse(error);
      },
    );
    return accepted;
  }
  receipt(id: string) {
    if (!validAgentId(id)) throw new SoftwareFault('INVALID_SOFTWARE_REQUEST', 400);
    const value = this.records.get(id);
    if (!value) throw new SoftwareFault('SOFTWARE_REQUEST_NOT_FOUND', 404);
    return structuredClone(value);
  }
  status(): SoftwareState {
    return {
      available: !this.failure,
      items: [...this.records.values()]
        .sort(
          (left, right) =>
            Number(right.phase === 'installing') - Number(left.phase === 'installing') ||
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.plan.createdAt.localeCompare(left.plan.createdAt) ||
            left.plan.id.localeCompare(right.plan.id),
        )
        .slice(0, 50)
        .map((value) => structuredClone(value)),
      ...(this.failure ? { error: this.failure } : {}),
    };
  }
  async listen() {
    await this.ready;
    if (this.server || this.closed) throw new SoftwareFault('SOFTWARE_CLOSED', 503);
    await mkdir(path.dirname(this.config.socket), { recursive: true, mode: 0o750 });
    await trustedDirectory(path.dirname(this.config.socket));
    this.server = createServer((req, res) => {
      this.handle(req)
        .then((value) => {
          if (!res.destroyed) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(value));
          }
        })
        .catch((error: unknown) => {
          if (!res.destroyed) {
            res.writeHead(error instanceof SoftwareFault ? error.status : 503, {
              'content-type': 'application/json',
            });
            res.end(
              JSON.stringify({
                error: error instanceof SoftwareFault ? error.message : 'SOFTWARE_UNAVAILABLE',
              }),
            );
          }
        });
    });
    await new Promise<unknown>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.socket, () => resolve(undefined));
    });
    this.listening = true;
    await chmod(this.config.socket, 0o660);
  }
  private async handle(req: IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/status' && !url.search) return this.status();
    if (
      req.method === 'GET' &&
      url.pathname === '/receipt' &&
      url.searchParams.size === 1 &&
      url.searchParams.has('id')
    )
      return this.receipt(url.searchParams.get('id')!);
    if (req.method !== 'POST' || url.search || !['/plan', '/install'].includes(url.pathname))
      throw new SoftwareFault('SOFTWARE_ROUTE_NOT_FOUND', 404);
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > 8192) throw new SoftwareFault('INVALID_SOFTWARE_REQUEST', 400);
      chunks.push(buffer);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new SoftwareFault('INVALID_SOFTWARE_REQUEST', 400);
    }
    return url.pathname === '/plan' ? this.plan(value) : this.install(value);
  }
  async close() {
    this.closed = true;
    // Client disconnects and shutdown never attach an AbortSignal to a running package manager.
    await this.tail;
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      if (!this.listening) return;
      this.listening = false;
      await new Promise<unknown>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve(undefined))),
      );
      await unlink(this.config.socket).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}

export async function checkInstallerPackages(input: string, options: InstallerOptions = {}) {
  const config = configuration(options);
  try {
    if (input.length > 1024 * 1024 || input.includes('\0') || input.includes('\r'))
      throw new Error('invalid paths');
    const receipt = await privateJson(path.join(config.directory, 'active.json'));
    if (!validReceipt(receipt) || receipt.phase !== 'installing')
      throw new Error('invalid active plan');
    const current = await privateJson(
      path.join(config.directory, 'receipts', `${receipt.plan.id}.json`),
    );
    if (
      !validReceipt(current) ||
      current.phase !== 'installing' ||
      JSON.stringify(current.plan) !== JSON.stringify(receipt.plan)
    )
      throw new Error('inactive package operation');
    const paths = input.endsWith('\n') ? input.slice(0, -1).split('\n') : input.split('\n');
    if (paths.length !== receipt.plan.packages.length || new Set(paths).size !== paths.length)
      throw new Error('wrong package set');
    const archives = await realpath(config.archives);
    await trustedDirectory(path.dirname(archives));
    await trustedDirectory(config.archives);
    const actual: SoftwarePackage[] = [];
    for (const file of paths) {
      if (
        !path.isAbsolute(file) ||
        path.normalize(file) !== file ||
        path.dirname(file) !== archives ||
        !file.endsWith('.deb')
      )
        throw new Error('foreign archive');
      const info = await lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (info.mode & 0o022) !== 0 ||
        (await realpath(file)) !== file
      )
        throw new Error('unsafe archive');
      const result = await config.run('/usr/bin/dpkg-deb', ['-f', file, 'Package', 'Version']);
      const names = [...result.stdout.matchAll(/^Package: (\S+)$/gm)];
      const versions = [...result.stdout.matchAll(/^Version: (\S+)$/gm)];
      if (names.length !== 1 || versions.length !== 1)
        throw new Error('ambiguous package metadata');
      const name = names[0][1];
      const version = versions[0][1];
      const item = { name, version };
      if (!isSoftwarePackage(item) || !isSoftwareName(name) || (await installed(config, name)))
        throw new Error('invalid package metadata');
      actual.push(item);
    }
    if (JSON.stringify(sortPackages(actual)) !== JSON.stringify(receipt.plan.packages))
      throw new Error('unapproved archive');
  } catch {
    throw new SoftwareFault('SOFTWARE_HOOK_REJECTED');
  }
}

async function main() {
  if (process.getuid?.() !== 0) throw new SoftwareFault('SOFTWARE_ROOT_REQUIRED', 403);
  if (process.argv.length === 3 && process.argv[2] === '--check') {
    let input = '';
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (input.length > 1024 * 1024) throw new SoftwareFault('SOFTWARE_HOOK_REJECTED');
    }
    await checkInstallerPackages(input);
    return;
  }
  if (process.argv.length !== 2) throw new SoftwareFault('INVALID_SOFTWARE_REQUEST', 400);
  const installer = new Installer();
  await installer.listen();
  const stop = () => {
    installer.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof SoftwareFault ? error.message : 'SOFTWARE_UNAVAILABLE'}\n`,
    );
    process.exitCode = 1;
  });
