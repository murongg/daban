import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SetupStatus } from '@daban/protocol';
import {
  cleanupPreparation,
  directory,
  freeSpace,
  isPreparation,
  json,
  type Manifest,
  manifest,
  type Preparation,
  type ProcessIdentity,
  present,
  type Run,
  resourcesReady,
  run,
  save,
  unpack,
} from './environment';
import { type HostConfig, ManagedHost } from './host';
import { availablePort } from './ports';

type Stage = 'assets' | 'creating' | 'created' | 'starting' | 'started' | 'ready';
interface Journal {
  version: 1;
  id: string;
  scope: string;
  artifact: string;
  stage: Stage;
  port: number;
  process?: ProcessIdentity;
  preparation?: Preparation;
}
export interface SetupOptions {
  userData: string;
  resources: string;
  base?: string;
  platform?: string;
  arch?: string;
  run?: Run;
  freeSpace?: () => Promise<number>;
  check?: (config: HostConfig) => Promise<unknown>;
  onChange?: (state: SetupStatus) => unknown;
}
const stages: Stage[] = ['assets', 'creating', 'created', 'starting', 'started', 'ready'];
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function journal(value: unknown): value is Journal {
  return (
    object(value) &&
    value.version === 1 &&
    typeof value.id === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(value.id) &&
    typeof value.scope === 'string' &&
    /^[a-f0-9]{64}$/.test(value.scope) &&
    typeof value.artifact === 'string' &&
    // Supported versions come from the verified manifest; a journal must match its exact artifact.
    /^daban-[1-9][0-9]{0,2}-[a-f0-9]{16}$/.test(value.artifact) &&
    stages.includes(value.stage as Stage) &&
    Number.isInteger(value.port) &&
    Number(value.port) >= 1024 &&
    Number(value.port) <= 65535 &&
    (value.preparation === undefined || isPreparation(value.preparation)) &&
    (value.process === undefined ||
      (object(value.process) &&
        Number.isSafeInteger(value.process.pid) &&
        Number(value.process.pid) > 1 &&
        typeof value.process.started === 'string' &&
        value.process.started.length > 0 &&
        value.process.started.length < 100))
  );
}
export class Setup {
  private value: SetupStatus = { required: false, phase: 'existing' };
  private document?: Journal;
  private payload?: Manifest;
  private userData = '';
  private scope = '';
  private closed = false;
  private active = false;
  private cancellation = new AbortController();
  private readonly ready: Promise<unknown>;
  settled: Promise<unknown> = Promise.resolve();
  private readonly execute: Run;
  constructor(readonly options: SetupOptions) {
    this.execute = options.run ?? run;
    // Electron's per-userData single-instance lock owns this controller and its journal.
    this.ready = this.initialize().catch((error) => this.failure(error, 'SETUP_STORE'));
  }
  private publish(value: SetupStatus) {
    this.value = value;
    if (!this.closed) this.options.onChange?.(value);
    return value;
  }
  private failure(error: unknown, fallback = 'SETUP_COMMAND') {
    const code =
      error instanceof Error && /^SETUP_[A-Z_]+$/.test(error.message) ? error.message : fallback;
    return this.publish({
      required: true,
      phase: this.cancellation.signal.aborted ? 'cancelled' : 'failed',
      error: this.cancellation.signal.aborted ? undefined : code,
    });
  }
  private async initialize() {
    if (await present(path.join(this.options.userData, 'runtime.json'))) return;
    this.value = { required: true, phase: 'available' };
    if (
      (this.options.platform ?? process.platform) !== 'darwin' ||
      (this.options.arch ?? process.arch) !== 'arm64'
    ) {
      this.publish({ required: true, phase: 'unavailable', error: 'SETUP_PLATFORM' });
      return;
    }
    this.userData = await realpath(this.options.userData);
    this.scope = createHash('sha256').update(this.userData).digest('hex');
    if (await present(path.join(this.userData, 'setup.json'))) {
      const value = await json(path.join(this.userData, 'setup.json'));
      if (!journal(value) || value.scope !== this.scope) throw new Error('SETUP_STORE');
      this.document = value;
    }
    try {
      this.payload = await manifest(this.options.resources);
    } catch (error) {
      const missing =
        error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
      this.publish({
        required: true,
        phase: 'unavailable',
        error: missing ? 'SETUP_MISSING' : 'SETUP_PAYLOAD',
      });
      return;
    }
    if (this.document && this.document.artifact !== this.payload.id)
      throw new Error('SETUP_CHANGED');
    this.publish({ required: true, phase: this.document ? 'cancelled' : 'available' });
  }
  async status() {
    await this.ready;
    return { ...this.value };
  }
  async start() {
    await this.ready;
    if (this.closed) throw new Error('SETUP_CLOSED');
    if (
      this.active ||
      !this.value.required ||
      this.value.phase === 'unavailable' ||
      ['SETUP_STORE', 'SETUP_CHANGED'].includes(this.value.error ?? '') ||
      !this.payload
    )
      return this.status();
    this.active = true;
    this.cancellation = new AbortController();
    this.publish({ required: true, phase: 'verifying' });
    this.settled = this.install()
      .catch((error) => this.failure(error))
      .finally(() => {
        this.active = false;
      });
    return this.status();
  }
  async cancel() {
    await this.ready;
    if (this.active) {
      this.cancellation.abort();
      this.publish({ required: true, phase: 'cancelling' });
    }
    return this.status();
  }
  async close() {
    this.closed = true;
    this.cancellation.abort();
    // Local preparation must finish cleanup; an admitted VM command may outlive Electron.
    if (!this.document?.process || !['creating', 'starting'].includes(this.document.stage))
      await this.settled;
  }
  private gate() {
    if (this.closed || this.cancellation.signal.aborted) throw new Error('SETUP_CANCELLED');
  }
  private async persist() {
    await save(path.join(this.userData, 'setup.json'), this.document);
  }
  private async install() {
    this.gate();
    if (await present(path.join(this.userData, 'runtime.json'))) throw new Error('SETUP_EXISTS');
    if (await present(path.join(this.userData, 'runtime-recovery.json')))
      throw new Error('SETUP_RECOVERY');
    const payload = this.payload!;
    if (!this.document) {
      this.document = {
        version: 1,
        id: randomUUID(),
        scope: this.scope,
        artifact: payload.id,
        stage: 'assets',
        port: await availablePort(),
      };
      await this.persist();
    }
    const document = this.document;
    if (document.process) {
      const check = await this.execute(
        '/bin/ps',
        ['-p', String(document.process.pid), '-o', 'lstart='],
        { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
      );
      if (check.code === 0 && check.stdout.trim() === document.process.started)
        throw new Error('SETUP_BUSY');
      delete document.process;
      await this.persist();
    }
    const base = await realpath(this.options.base ?? '/Users/Shared');
    const root = path.join(
      base,
      `.daban-${process.getuid?.()}-${this.scope.slice(0, 12)}-${document.id.slice(0, 8)}`,
    );
    // Production uses short persistent storage: /tmp is only for transport sockets, never user VMs.
    if (!this.options.base && Buffer.byteLength(path.join(root, 'lima/daban/ssh.sock')) > 90)
      throw new Error('SETUP_STORE');
    const existed = await present(root);
    await directory(root, true);
    const ownerFile = path.join(root, 'owner.json');
    const owner = { version: 1, id: document.id, scope: this.scope, artifact: document.artifact };
    if (await present(ownerFile)) {
      if (JSON.stringify(await json(ownerFile)) !== JSON.stringify(owner))
        throw new Error('SETUP_STORE');
    } else {
      if (existed && (await readdir(root)).length) throw new Error('SETUP_STORE');
      await save(ownerFile, owner, true);
    }
    this.gate();
    if (document.preparation) {
      // The recorded process was proven gone above; reclaim only the exact object it owned.
      await cleanupPreparation(root, document.preparation);
      delete document.preparation;
      await this.persist();
    }
    const own = async (value?: Preparation) => {
      if (value) this.gate();
      document.preparation = value;
      try {
        await this.persist();
      } catch {
        throw new Error('SETUP_STORE');
      }
    };
    const prepare: Run = async (program, args, options) => {
      const result = await this.execute(program, args, {
        ...options,
        permit: async (process) => {
          this.gate();
          document.process = process;
          await this.persist();
          this.gate();
        },
      });
      delete document.process;
      await this.persist();
      return result;
    };
    const binary = await resourcesReady(
      this.options.resources,
      root,
      payload,
      this.cancellation.signal,
      prepare,
      own,
    );
    const home = path.join(root, 'lima');
    await directory(home, true);
    const env = { ...process.env, LIMA_HOME: home, LIMA_INTERACTIVE: '0' };
    const list = async (signal?: AbortSignal) => {
      const result = await this.execute(binary, ['list', '--json'], { env, signal });
      if (result.code) throw new Error('SETUP_UNCERTAIN');
      const rows: unknown[] = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (rows.length > 1) throw new Error('SETUP_STORE');
      if (!rows.length) {
        if (await present(path.join(home, 'daban'))) throw new Error('SETUP_UNCERTAIN');
        return undefined;
      }
      const value = rows[0];
      if (
        !object(value) ||
        value.name !== 'daban' ||
        typeof value.dir !== 'string' ||
        (await realpath(value.dir)) !== path.join(home, 'daban') ||
        !object(value.config)
      )
        throw new Error('SETUP_STORE');
      const config = value.config;
      if (
        config.vmType !== 'vz' ||
        config.arch !== 'aarch64' ||
        config.cpus !== 2 ||
        config.memory !== '3GiB' ||
        config.disk !== '16GiB' ||
        (config.mounts !== undefined &&
          (!Array.isArray(config.mounts) || config.mounts.length !== 0)) ||
        !object(config.containerd) ||
        config.containerd.system !== false ||
        config.containerd.user !== false ||
        !Array.isArray(config.images) ||
        config.images.length !== 1 ||
        !object(config.images[0]) ||
        config.images[0].location !== pathToFileURL(path.join(root, 'system.raw')).href ||
        config.images[0].digest !== `sha256:${payload.image.rawSha256}`
      )
        throw new Error('SETUP_STORE');
      if (!['Running', 'Stopped'].includes(String(value.status)))
        throw new Error('SETUP_UNCERTAIN');
      return value;
    };
    let vm = await list(this.cancellation.signal);
    const effect = async (stage: Stage, args: string[]) => {
      this.gate();
      document.stage = stage;
      delete document.process;
      await this.persist();
      const result = await this.execute(binary, args, {
        env,
        permit: async (process) => {
          this.gate();
          document.process = process;
          await this.persist();
          this.gate();
        },
      });
      if (result.code) throw new Error('SETUP_COMMAND');
      delete document.process;
    };
    if (!vm) {
      if (!['assets', 'creating'].includes(document.stage)) throw new Error('SETUP_UNCERTAIN');
      const available = await (this.options.freeSpace?.() ?? freeSpace(root));
      const cached = await present(path.join(root, 'system.raw'));
      if (available < payload.image.rawBytes * (cached ? 1 : 2) + 1024 ** 3)
        throw new Error('SETUP_SPACE');

      this.publish({ required: true, phase: 'extracting', progress: 0 });
      await unpack(
        this.options.resources,
        root,
        payload,
        this.cancellation.signal,
        (progress) => this.publish({ required: true, phase: 'extracting', progress }),
        own,
      );
      const template = {
        minimumLimaVersion: payload.versions.lima,
        vmType: 'vz',
        arch: 'aarch64',
        cpus: 2,
        memory: '3GiB',
        disk: '16GiB',
        images: [
          {
            location: pathToFileURL(path.join(root, 'system.raw')).href,
            arch: 'aarch64',
            digest: `sha256:${payload.image.rawSha256}`,
          },
        ],
        user: { name: 'daban', uid: 2000, home: '/home/daban', shell: '/bin/bash' },
        mounts: [],
        containerd: { system: false, user: false },
        portForwards: [{ guestPort: 0, ignore: true }],
        hostResolver: { enabled: true },
        upgradePackages: false,
        propagateProxyEnv: false,
      };
      const templateFile = path.join(root, 'vm.yaml');
      await save(templateFile, template);
      this.publish({ required: true, phase: 'creating' });
      await effect('creating', ['create', '--tty=false', '--name=daban', templateFile]);
      // A completed creation must be reconciled even after the user requests cancellation.
      vm = await list();
      if (!vm) throw new Error('SETUP_UNCERTAIN');
      document.stage = 'created';
      await this.persist();
    }
    this.gate();
    if (vm.status === 'Stopped') {
      this.publish({ required: true, phase: 'starting' });
      await effect('starting', ['start', '--tty=false', 'daban']);
      document.stage = 'started';
      await this.persist();
    }
    this.gate();
    this.publish({ required: true, phase: 'connecting' });
    const config: HostConfig = {
      limactl: binary,
      limaHome: home,
      vm: 'daban',
      port: document.port,
    };
    for (let attempt = 0; ; attempt++) {
      this.gate();
      try {
        await this.verifyConnection(config);
        break;
      } catch (error) {
        this.gate();
        if (!(error instanceof Error) || error.message !== 'SETUP_PORT_BUSY') throw error;
        if (await present(path.join(this.userData, 'runtime.json')))
          throw new Error('SETUP_EXISTS');
        // Recovery targets include the old address; an installer cannot silently rebind that authority.
        if (await present(path.join(this.userData, 'runtime-recovery.json')))
          throw new Error('SETUP_RECOVERY');
        if (attempt >= 2) throw new Error('SETUP_PORT');
        document.port = await availablePort();
        this.gate();
        try {
          await this.persist();
        } catch {
          throw new Error('SETUP_STORE');
        }
        // The chosen address is durable before another owner may try to use it.
        config.port = document.port;
      }
    }
    this.gate();
    const cache = path.join(root, 'system.raw');
    if (await present(cache)) {
      const info = await lstat(cache);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        info.size !== payload.image.rawBytes
      )
        throw new Error('SETUP_STORE');
      await unlink(cache);
    }
    this.gate();
    document.stage = 'ready';
    // The exclusive runtime.json commit is authoritative; the journal records readiness first.
    await this.persist();
    this.gate();
    try {
      await save(path.join(this.userData, 'runtime.json'), config, true);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
        throw new Error('SETUP_EXISTS');
      throw error;
    }
    this.publish({ required: false, phase: 'complete' });
  }
  private async verifyConnection(config: HostConfig) {
    if (this.options.check) return this.options.check(config);
    const host = new ManagedHost(config, path.join(this.userData, 'runtime-setup.sock'));
    try {
      const client = await host.connectExisting();
      const snapshot = await client.status();
      if (
        snapshot.phase !== 'ready' ||
        snapshot.protocolVersion !== this.payload!.versions.protocol ||
        !snapshot.model.available
      )
        throw new Error('SETUP_CONNECT');
      const report = await host.inspect();
      if (report.checks.some((row) => row.id !== 'model' && row.state !== 'ready'))
        throw new Error('SETUP_CONNECT');
    } catch (error) {
      if (await host.portConflict().catch(() => false)) throw new Error('SETUP_PORT_BUSY');
      throw error;
    } finally {
      await host.close();
    }
  }
}
