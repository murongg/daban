import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ControlDataPort, MigrationIdentity } from './migration.js';
import type { PreparedSource, SourceScope } from './source-reader.js';
import { isPreparedSource, isSourceIdentity, isSourceManifest } from './source-reader.js';
import type { VmConfig } from './vm.js';

interface TransportOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBytes: number;
}
interface SourceDependencies {
  launch?: (program: string, args: string[], options: TransportOptions) => Promise<unknown>;
  probe?: (program: string, args: string[], options: TransportOptions) => Promise<MasterProbe>;
  absent?: (socketPath: string) => Promise<boolean>;
  run?: (
    program: string,
    args: string[],
    options: TransportOptions,
    input?: Uint8Array,
  ) => Promise<Uint8Array>;
  stream?: (
    program: string,
    args: string[],
    options: TransportOptions,
    input: Uint8Array,
  ) => AsyncIterable<Uint8Array>;
}
interface MasterProbe {
  code: number;
  pid?: number;
}
interface MasterState {
  version: 1;
  scope: string;
  pid: number;
  dev: number;
  ino: number;
}
interface SourceState {
  version: 1;
  source: MigrationIdentity;
  target: string;
  helper: string;
  id: string;
  phase: 'new' | 'uploaded' | 'preparing' | 'prepared' | 'stop-issued' | 'stopped' | 'rolled-back';
  reader?: string;
  prepared?: PreparedSource;
}
const fault = (code: string) => Object.assign(new Error(code), { code });
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const parse = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw fault('SOURCE_METADATA_INVALID');
  }
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function child(program: string, args: string[], options: TransportOptions, input?: Uint8Array) {
  const process = spawn(program, args, {
    env: options.env,
    timeout: options.timeout,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const done = new Promise<number>((resolve) => {
    process.once('error', () => resolve(-1));
    process.once('close', (code) => resolve(code ?? -1));
  });
  process.stdin.on('error', () => {});
  process.stdin.end(input);
  return { process, done };
}
async function collect(
  program: string,
  args: string[],
  options: TransportOptions,
  input?: Uint8Array,
) {
  const { process, done } = child(program, args, options, input);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of process.stdout) {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        process.kill('SIGKILL');
        throw fault('SOURCE_TRANSPORT_FAILED');
      }
      chunks.push(Buffer.from(chunk));
    }
    if ((await done) !== 0) throw fault('SOURCE_TRANSPORT_FAILED');
    return Buffer.concat(chunks);
  } catch {
    throw fault('SOURCE_TRANSPORT_FAILED');
  }
}
async function* stream(
  program: string,
  args: string[],
  options: TransportOptions,
  input: Uint8Array,
) {
  const { process, done } = child(program, args, options, input);
  try {
    for await (const chunk of process.stdout) yield Buffer.from(chunk);
    const exit = await done;
    // SSH transport failures are distinct from the guest reader's terminal validation exit.
    if (exit !== 0)
      throw fault(exit === 255 || exit === -1 ? 'SOURCE_TRANSPORT_FAILED' : 'SOURCE_READ_FAILED');
  } catch (error) {
    if (
      object(error) &&
      (error.code === 'SOURCE_TRANSPORT_FAILED' || error.code === 'SOURCE_READ_FAILED')
    )
      throw error;
    throw fault('SOURCE_TRANSPORT_FAILED');
  } finally {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
    await done;
  }
}
function launch(program: string, args: string[], options: TransportOptions) {
  return new Promise<unknown>((resolve, reject) => {
    // A background master must not inherit pipes that keep its launcher pending.
    const child = spawn(program, args, {
      env: options.env,
      timeout: options.timeout,
      stdio: 'ignore',
    });
    child.once('error', () => reject(fault('SOURCE_TRANSPORT_FAILED')));
    child.once('close', (code) =>
      code === 0 ? resolve(undefined) : reject(fault('SOURCE_TRANSPORT_FAILED')),
    );
  });
}
function probe(program: string, args: string[], options: TransportOptions) {
  return new Promise<MasterProbe>((resolve, reject) => {
    const child = spawn(program, args, {
      env: options.env,
      timeout: 8000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '',
      bytes = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024) child.kill('SIGKILL');
      else stderr += chunk.toString('utf8');
    });
    child.once('error', () => reject(fault('SOURCE_TRANSPORT_FAILED')));
    child.once('close', (code) => {
      const match = /^Master running \(pid=([1-9][0-9]*)\)\r?\n?$/.exec(stderr);
      resolve({ code: code ?? 255, ...(match && bytes <= 1024 ? { pid: Number(match[1]) } : {}) });
    });
  });
}
function socketAbsent(socketPath: string) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (absent: boolean) => {
      socket.destroy();
      resolve(absent);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'),
    );
    socket.setTimeout(1000, () => finish(false));
  });
}
async function metadata(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (object(error) && error.code === 'ENOENT') return undefined;
    throw fault('SOURCE_CACHE_UNSAFE');
  }
}
async function readJson(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 16 * 1024 * 1024
    )
      throw fault('SOURCE_CACHE_UNSAFE');
    return parse(await handle.readFile());
  } finally {
    await handle.close();
  }
}
async function save(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
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
async function helperCode(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 8 * 1024 * 1024)
      throw fault('SOURCE_HELPER_INVALID');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      info.size !== after.size ||
      info.mtimeMs !== after.mtimeMs ||
      info.ctimeMs !== after.ctimeMs
    )
      throw fault('SOURCE_HELPER_INVALID');
    return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await handle.close();
  }
}
export class LegacySource {
  readonly config: VmConfig;
  readonly identity: MigrationIdentity;
  readonly control: ControlDataPort;
  readonly browser: ControlDataPort;
  readonly shared: ControlDataPort;
  private readonly target: string;
  private loading?: Promise<SourceState>;
  private preparing?: Promise<PreparedSource>;
  private masterStarting?: Promise<string>;
  private closing?: Promise<unknown>;
  private closed = false;
  private root = '';
  constructor(
    config: VmConfig,
    readonly helperEntry: string,
    readonly privateHostCache: string,
    identity: MigrationIdentity,
    readonly dependencies: SourceDependencies = {},
  ) {
    if (
      !isSourceIdentity(identity) ||
      identity.vm !== config.vm ||
      !/^[a-z0-9][a-z0-9-]{0,31}$/.test(config.vm) ||
      ![config.limactl, config.limaHome, helperEntry, privateHostCache].every(
        (value) => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value),
      ) ||
      path.basename(config.limactl) !== 'limactl' ||
      !helperEntry.endsWith('.mjs')
    )
      throw fault('SOURCE_INVALID_CONFIG');
    this.config = Object.freeze({
      limactl: path.resolve(config.limactl),
      limaHome: path.resolve(config.limaHome),
      vm: config.vm,
      port: config.port,
    });
    this.identity = Object.freeze({ ...identity });
    this.target = digest(
      JSON.stringify([this.config.limactl, this.config.limaHome, this.config.vm, this.config.port]),
    );
    this.control = this.port('control');
    this.browser = this.port('browser');
    this.shared = this.port('shared');
  }
  private settings(maxBytes = 16 * 1024 * 1024): TransportOptions {
    return {
      env: {
        PATH: `${path.dirname(this.config.limactl)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: homedir(),
        LANG: 'C',
        LIMA_HOME: this.config.limaHome,
      },
      timeout: 180000,
      maxBytes,
    };
  }
  private async run(program: string, args: string[], input?: Uint8Array, maxBytes?: number) {
    try {
      return Buffer.from(
        await (this.dependencies.run || collect)(program, args, this.settings(maxBytes), input),
      );
    } catch {
      throw fault('SOURCE_TRANSPORT_FAILED');
    }
  }
  private sshOptions(socketPath = 'none') {
    return [
      '-F',
      path.join(this.config.limaHome, this.config.vm, 'ssh.config'),
      '-S',
      socketPath,
      '-T',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
    ];
  }
  private ssh(reader: string, socketPath?: string) {
    return [
      ...this.sshOptions(socketPath),
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPersist=no',
      // A slave whose owned master expired must fail instead of silently opening another TCP connection.
      ...(socketPath ? ['-o', 'ProxyCommand=/usr/bin/false', '-o', 'ClearAllForwardings=yes'] : []),
      `lima-${this.config.vm}`,
      'sudo',
      '-n',
      '/opt/bot-prototype/node/bin/node',
      reader,
      '--source-reader',
    ];
  }
  private masterScope(state: SourceState) {
    return digest(
      JSON.stringify([
        this.target,
        this.identity.vm,
        this.identity.imageFingerprint,
        state.id,
        state.helper,
        state.reader,
      ]),
    );
  }
  private async socketInfo(socketPath: string) {
    const folder = await metadata(this.root),
      file = await metadata(socketPath);
    if (
      !folder?.isDirectory() ||
      folder.isSymbolicLink() ||
      folder.uid !== process.getuid?.() ||
      (folder.mode & 0o777) !== 0o700 ||
      (file &&
        (!file.isSocket() ||
          file.uid !== process.getuid?.() ||
          file.nlink !== 1 ||
          (file.mode & 0o777) !== 0o600))
    )
      throw fault('SOURCE_SOCKET_UNSAFE');
    return file;
  }
  private async savedMaster(state: SourceState): Promise<MasterState | undefined> {
    const file = path.join(this.root, 'ssh.json');
    if (!(await metadata(file))) return undefined;
    const value = await readJson(file);
    if (
      !object(value) ||
      Object.keys(value).length !== 5 ||
      value.version !== 1 ||
      value.scope !== this.masterScope(state) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) < 1 ||
      !Number.isSafeInteger(value.dev) ||
      !Number.isSafeInteger(value.ino)
    )
      throw fault('SOURCE_SOCKET_UNVERIFIED');
    return value as unknown as MasterState;
  }
  private controlMaster(socketPath: string, action: 'check' | 'exit') {
    return (this.dependencies.probe || probe)(
      '/usr/bin/ssh',
      [
        ...this.sshOptions(socketPath),
        '-o',
        'ControlMaster=no',
        '-O',
        action,
        `lima-${this.config.vm}`,
      ],
      this.settings(1024),
    );
  }
  private async openMaster(state: SourceState) {
    const socketPath = path.join(this.root, 's');
    // OpenSSH appends a temporary suffix; keep that pathname below macOS's 104-byte limit too.
    if (Buffer.byteLength(socketPath) > 80) throw fault('SOURCE_SOCKET_UNSAFE');
    const saved = await this.savedMaster(state);
    const existing = await this.socketInfo(socketPath);
    if (existing) {
      if (!saved || saved.dev !== existing.dev || saved.ino !== existing.ino)
        throw fault('SOURCE_SOCKET_UNVERIFIED');
      const checked = await this.controlMaster(socketPath, 'check');
      if (checked.code === 0 && checked.pid === saved.pid) {
        const current = await this.socketInfo(socketPath);
        if (!current || current.dev !== saved.dev || current.ino !== saved.ino)
          throw fault('SOURCE_SOCKET_UNVERIFIED');
        return socketPath;
      }
      if (checked.code !== 255 || !(await (this.dependencies.absent || socketAbsent)(socketPath)))
        throw fault('SOURCE_SOCKET_UNVERIFIED');
      const stale = await this.socketInfo(socketPath);
      if (stale && (stale.dev !== saved.dev || stale.ino !== saved.ino))
        throw fault('SOURCE_SOCKET_UNVERIFIED');
      if (stale) await unlink(socketPath);
    }
    await (this.dependencies.launch || launch)(
      '/usr/bin/ssh',
      [
        ...this.sshOptions(socketPath),
        '-M',
        '-o',
        'ControlMaster=yes',
        '-o',
        'ControlPersist=60',
        '-o',
        'ClearAllForwardings=yes',
        '-fN',
        `lima-${this.config.vm}`,
      ],
      this.settings(1024),
    );
    const created = await this.socketInfo(socketPath),
      checked = await this.controlMaster(socketPath, 'check');
    if (
      !created ||
      checked.code !== 0 ||
      !Number.isSafeInteger(checked.pid) ||
      Number(checked.pid) < 1
    )
      throw fault('SOURCE_SOCKET_UNVERIFIED');
    await save(path.join(this.root, 'ssh.json'), {
      version: 1,
      scope: this.masterScope(state),
      pid: checked.pid,
      dev: created.dev,
      ino: created.ino,
    });
    return socketPath;
  }
  private ensureMaster(state: SourceState) {
    if (this.closed) return Promise.reject(fault('SOURCE_CLOSED'));
    this.masterStarting ||= this.openMaster(state).finally(() => {
      this.masterStarting = undefined;
    });
    return this.masterStarting;
  }
  close() {
    this.closed = true;
    this.closing ||= (async () => {
      await this.masterStarting?.catch(() => {});
      if (!this.loading) return;
      const state = await this.load(),
        socketPath = path.join(this.root, 's');
      const saved = await this.savedMaster(state),
        file = await this.socketInfo(socketPath);
      if (!file) return;
      if (!saved || saved.dev !== file.dev || saved.ino !== file.ino)
        throw fault('SOURCE_SOCKET_UNVERIFIED');
      const checked = await this.controlMaster(socketPath, 'check');
      if (checked.code === 255 && (await (this.dependencies.absent || socketAbsent)(socketPath)))
        return;
      if (
        checked.code !== 0 ||
        checked.pid !== saved.pid ||
        (await this.controlMaster(socketPath, 'exit')).code !== 0
      )
        throw fault('SOURCE_SOCKET_UNVERIFIED');
    })();
    return this.closing;
  }
  private async load(): Promise<SourceState> {
    if (this.loading) return this.loading;
    this.loading = this.loadState().catch((error) => {
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }
  private async loadState(): Promise<SourceState> {
    const helper = await helperCode(this.helperEntry);
    await mkdir(this.privateHostCache, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.privateHostCache);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o777) !== 0o700
    )
      throw fault('SOURCE_CACHE_UNSAFE');
    this.root = await realpath(this.privateHostCache);
    const file = path.join(this.root, 'source.json');
    let state: SourceState;
    if (await metadata(file)) {
      const value = await readJson(file);
      if (
        !object(value) ||
        value.version !== 1 ||
        !isSourceIdentity(value.source) ||
        value.source.vm !== this.identity.vm ||
        value.source.imageFingerprint !== this.identity.imageFingerprint ||
        value.target !== this.target ||
        value.helper !== helper.hash ||
        typeof value.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(value.id) ||
        ![
          'new',
          'uploaded',
          'preparing',
          'prepared',
          'stop-issued',
          'stopped',
          'rolled-back',
        ].includes(String(value.phase)) ||
        (value.reader !== undefined &&
          (typeof value.reader !== 'string' ||
            !/^\/tmp\/daban-source\.[A-Za-z0-9]{10,32}\/reader\.mjs$/.test(value.reader))) ||
        (value.prepared !== undefined &&
          (!isPreparedSource(value.prepared) ||
            value.prepared.id !== value.id ||
            value.prepared.source.vm !== this.identity.vm ||
            value.prepared.source.imageFingerprint !== this.identity.imageFingerprint))
      )
        throw fault('SOURCE_CACHE_CHANGED');
      state = value as unknown as SourceState;
    } else {
      if ((await readdir(this.root)).length) throw fault('SOURCE_CACHE_UNSAFE');
      state = {
        version: 1,
        source: this.identity,
        target: this.target,
        helper: helper.hash,
        id: randomUUID(),
        phase: 'new',
      };
      await save(file, state);
    }
    const frozen = path.join(this.root, `reader-${helper.hash}.mjs`);
    if (!(await metadata(frozen))) {
      const handle = await open(
        frozen,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(helper.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    if ((await helperCode(frozen)).hash !== helper.hash) throw fault('SOURCE_CACHE_CHANGED');
    return state;
  }
  private async commit(state: SourceState) {
    await save(path.join(this.root, 'source.json'), state);
  }
  private async vmState() {
    const raw = await this.run(
      this.config.limactl,
      ['list', '--json', this.config.vm],
      undefined,
      65536,
    );
    const value = parse(raw);
    if (
      !object(value) ||
      value.name !== this.config.vm ||
      value.dir !== path.join(this.config.limaHome, this.config.vm) ||
      !['Running', 'Stopped'].includes(String(value.status))
    )
      throw fault('SOURCE_VM_CHANGED');
    return value.status as 'Running' | 'Stopped';
  }
  private async upload(state: SourceState) {
    const directory = (
      await this.run(
        this.config.limactl,
        ['shell', this.config.vm, 'mktemp', '-d', '/tmp/daban-source.XXXXXXXXXXXX'],
        undefined,
        256,
      )
    )
      .toString('utf8')
      .trim();
    if (!/^\/tmp\/daban-source\.[A-Za-z0-9]{10,32}$/.test(directory))
      throw fault('SOURCE_HELPER_INVALID');
    const reader = `${directory}/reader.mjs`;
    await this.run(
      this.config.limactl,
      ['copy', path.join(this.root, `reader-${state.helper}.mjs`), `${this.config.vm}:${reader}`],
      undefined,
      1024,
    );
    await this.run(
      this.config.limactl,
      ['shell', this.config.vm, 'sudo', '-n', 'chown', '-R', 'root:root', directory],
      undefined,
      1024,
    );
    await this.run(
      this.config.limactl,
      ['shell', this.config.vm, 'sudo', '-n', 'chmod', '700', directory],
      undefined,
      1024,
    );
    await this.run(
      this.config.limactl,
      ['shell', this.config.vm, 'sudo', '-n', 'chmod', '600', reader],
      undefined,
      1024,
    );
    const checksum = (
      await this.run(
        this.config.limactl,
        ['shell', this.config.vm, 'sudo', '-n', 'sha256sum', reader],
        undefined,
        1024,
      )
    )
      .toString('utf8')
      .trim()
      .split(/\s+/)[0];
    if (checksum !== state.helper) throw fault('SOURCE_HELPER_CHANGED');
    state.reader = reader;
    if (state.phase === 'new') state.phase = 'uploaded';
    await this.commit(state);
  }
  private async invoke(state: SourceState, method: string, extra: Record<string, unknown> = {}) {
    if (!state.reader) throw fault('SOURCE_HELPER_INVALID');
    return parse(
      await this.run(
        '/usr/bin/ssh',
        this.ssh(state.reader),
        Buffer.from(JSON.stringify({ method, source: this.identity, id: state.id, ...extra })),
      ),
    );
  }
  private async cached(scope: SourceScope, state: SourceState) {
    const value = await readJson(path.join(this.root, `${scope}.json`));
    if (
      !object(value) ||
      value.version !== 1 ||
      value.id !== state.id ||
      !isSourceManifest(value.manifest, this.identity, scope)
    )
      throw fault('SOURCE_CACHE_CHANGED');
    return value.manifest;
  }
  async prepare(): Promise<PreparedSource> {
    this.preparing ||= this.prepareSource().finally(() => {
      this.preparing = undefined;
    });
    return this.preparing;
  }
  private async prepareSource() {
    const state = await this.load();
    if (state.phase === 'rolled-back') throw fault('SOURCE_ROLLED_BACK');
    const power = await this.vmState();
    if (power === 'Stopped') {
      if (!state.prepared || !['prepared', 'stopped', 'stop-issued'].includes(state.phase))
        throw fault('SOURCE_NOT_RUNNING');
      for (const scope of ['control', 'browser', 'shared'] as const)
        await this.cached(scope, state);
      return structuredClone(state.prepared);
    }
    if (state.phase === 'stop-issued' || state.phase === 'stopped')
      throw fault('SOURCE_STOP_UNKNOWN');
    if (!state.reader) await this.upload(state);
    state.phase = 'preparing';
    await this.commit(state);
    const prepared = await this.invoke(state, 'quiesce');
    if (
      !isPreparedSource(prepared) ||
      prepared.id !== state.id ||
      prepared.source.vm !== this.identity.vm ||
      prepared.source.imageFingerprint !== this.identity.imageFingerprint
    )
      throw fault('SOURCE_METADATA_INVALID');
    state.prepared = prepared;
    await this.commit(state);
    for (const scope of ['control', 'browser', 'shared'] as const) {
      const manifest = await this.invoke(state, 'manifest', { scope });
      if (!isSourceManifest(manifest, this.identity, scope)) throw fault('SOURCE_METADATA_INVALID');
      const file = path.join(this.root, `${scope}.json`);
      if (await metadata(file)) {
        if (JSON.stringify(await this.cached(scope, state)) !== JSON.stringify(manifest))
          throw fault('SOURCE_SNAPSHOT_CHANGED');
      } else await save(file, { version: 1, id: state.id, manifest });
    }
    state.phase = 'prepared';
    await this.commit(state);
    return structuredClone(prepared);
  }
  port(scope: SourceScope): ControlDataPort {
    if (!['control', 'browser', 'shared'].includes(scope)) throw fault('SOURCE_INVALID_SCOPE');
    return {
      manifest: async () => {
        const state = await this.load();
        if (!state.prepared || !['prepared', 'stopped', 'stop-issued'].includes(state.phase))
          throw fault('SOURCE_NOT_PREPARED');
        return structuredClone(await this.cached(scope, state));
      },
      read: (file) => this.read(scope, file),
    };
  }
  private async *read(scope: SourceScope, file: string): AsyncIterable<Uint8Array> {
    const state = await this.load();
    if (['stopped', 'stop-issued'].includes(state.phase)) throw fault('SOURCE_VM_STOPPED');
    if (state.phase !== 'prepared' || !state.prepared || !state.reader)
      throw fault('SOURCE_NOT_PREPARED');
    const manifest = await this.cached(scope, state),
      entry = manifest.files.find((value) => value.path === file);
    if (!entry) throw fault('SOURCE_INVALID_PATH');
    const input = Buffer.from(
      JSON.stringify({ method: 'read', source: this.identity, id: state.id, scope, entry }),
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      let bytes = 0;
      const hash = createHash('sha256');
      try {
        const socketPath = await this.ensureMaster(state);
        if (this.closed) throw fault('SOURCE_CLOSED');
        for await (const chunk of (this.dependencies.stream || stream)(
          '/usr/bin/ssh',
          this.ssh(state.reader, socketPath),
          this.settings(),
          input,
        )) {
          if (!(chunk instanceof Uint8Array)) throw fault('SOURCE_READ_FAILED');
          bytes += chunk.byteLength;
          if (bytes > entry.size) throw fault('SOURCE_READ_FAILED');
          hash.update(chunk);
          for (let offset = 0; offset < chunk.byteLength; offset += 65536)
            yield chunk.subarray(offset, offset + 65536);
        }
      } catch (error) {
        // A frozen read may reconnect only before its first payload byte; replaying a yielded prefix would corrupt the receiver.
        if (
          bytes === 0 &&
          attempt < 2 &&
          object(error) &&
          error.code === 'SOURCE_TRANSPORT_FAILED'
        ) {
          await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 100 : 300));
          continue;
        }
        throw fault('SOURCE_READ_FAILED');
      }
      if (bytes !== entry.size || hash.digest('hex') !== entry.sha256)
        throw fault('SOURCE_READ_FAILED');
      return;
    }
  }
  async stopVm() {
    const state = await this.load();
    if (!state.prepared || !['prepared', 'stop-issued', 'stopped'].includes(state.phase))
      throw fault('SOURCE_NOT_PREPARED');
    await this.close();
    if (state.phase === 'stopped') return;
    if (state.phase === 'stop-issued') {
      if ((await this.vmState()) !== 'Stopped') throw fault('SOURCE_STOP_UNKNOWN');
    } else {
      state.phase = 'stop-issued';
      await this.commit(state);
      try {
        await this.run(
          this.config.limactl,
          ['stop', '--tty=false', this.config.vm],
          undefined,
          1024,
        );
      } catch {
        if ((await this.vmState()) !== 'Stopped') throw fault('SOURCE_STOP_UNKNOWN');
      }
    }
    if ((await this.vmState()) !== 'Stopped') throw fault('SOURCE_STOP_UNKNOWN');
    state.phase = 'stopped';
    await this.commit(state);
  }
  async rollback() {
    const state = await this.load();
    if (state.phase === 'rolled-back')
      return { source: this.identity, id: state.id, phase: 'rolled-back' as const };
    if (!['preparing', 'prepared', 'stop-issued', 'stopped'].includes(state.phase))
      throw fault('SOURCE_NOT_PREPARED');
    await this.close();
    if ((await this.vmState()) === 'Stopped') {
      await this.run(
        this.config.limactl,
        ['start', '--tty=false', this.config.vm],
        undefined,
        1024,
      );
      state.reader = undefined;
    }
    if (!state.reader) await this.upload(state);
    const result = await this.invoke(state, 'rollback', {
      ...(state.prepared ? { expected: state.prepared } : {}),
    });
    if (
      !object(result) ||
      result.phase !== 'rolled-back' ||
      result.id !== state.id ||
      !isSourceIdentity(result.source) ||
      result.source.vm !== this.identity.vm ||
      result.source.imageFingerprint !== this.identity.imageFingerprint
    )
      throw fault('SOURCE_ROLLBACK_UNKNOWN');
    state.phase = 'rolled-back';
    await this.commit(state);
    return { source: this.identity, id: state.id, phase: 'rolled-back' as const };
  }
}
