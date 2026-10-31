import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { migrateBundlePayloads } from '@daban/engine/agent';
import type { SetupStatus } from '@daban/protocol';
import {
  type ControlDataPort,
  type MigrationIdentity,
  type MigrationManifest,
  migrateControlData,
  migratePublicData,
} from './migration.js';
import { ensureExecutionVm } from './provision.js';
import { LegacySource } from './source.js';
import type { VmConfig } from './vm.js';
export interface BootstrapOptions {
  signal?: AbortSignal;
  dataRoot: string;
  vmConfigFile: string;
  packDirectory: string;
  executorArchive: string;
  sourceHelper: string;
  restoreHelper?: string;
  limactl: string;
}
interface Source {
  prepare(): Promise<unknown>;
  stopVm(): Promise<unknown>;
  port(scope: 'control' | 'browser' | 'shared'): ControlDataPort;
}
interface State {
  version: 1;
  dataRoot: string;
  configFile: string;
  source: VmConfig | null;
  target?: VmConfig;
  phase: 'snapshot' | 'provision' | 'restore' | 'ready';
}
interface Dependencies {
  provision?: (options: Parameters<typeof ensureExecutionVm>[0]) => Promise<VmConfig>;
  source?: (config: VmConfig, identity: MigrationIdentity) => Source;
  restore?: (input: {
    config: VmConfig;
    directory: string;
    browser: MigrationManifest;
    shared: MigrationManifest;
    credentialFile?: string;
    helperEntry: string;
    cacheDirectory: string;
  }) => Promise<unknown>;
}
const target: MigrationIdentity = {
  vm: 'exec',
  imageFingerprint: 'e74a74239cb93d057b17d9a7c72f4dfd2fcab051a1be052766ed350f6bb62df7',
};
async function atomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`,
    handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  const parent = await open(path.dirname(file), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
async function json(file: string): Promise<unknown> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077 ||
        info.size > 1024 * 1024
      )
        throw new Error('AGENT_BOOTSTRAP_STORE');
      return JSON.parse(await handle.readFile('utf8'));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw new Error('AGENT_BOOTSTRAP_STORE');
  }
}
function config(value: unknown): VmConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('AGENT_VM_CONFIG');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !['limactl', 'limaHome', 'vm', 'port'].includes(k)) ||
    typeof v.limactl !== 'string' ||
    !path.isAbsolute(v.limactl) ||
    path.basename(v.limactl) !== 'limactl' ||
    typeof v.limaHome !== 'string' ||
    !path.isAbsolute(v.limaHome) ||
    typeof v.vm !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/.test(v.vm) ||
    !Number.isSafeInteger(v.port) ||
    Number(v.port) < 1024 ||
    Number(v.port) > 65535
  )
    throw new Error('AGENT_VM_CONFIG');
  return v as unknown as VmConfig;
}
function sameConfig(left: VmConfig | null, right: VmConfig | null) {
  if (!left || !right) return left === right;
  return ['limactl', 'limaHome', 'vm', 'port'].every(
    (field) => left[field as keyof VmConfig] === right[field as keyof VmConfig],
  );
}
export async function bootstrapAgent(
  options: BootstrapOptions,
  dependencies: Dependencies = {},
): Promise<VmConfig> {
  if (
    ![
      options.dataRoot,
      options.vmConfigFile,
      options.packDirectory,
      options.executorArchive,
      options.sourceHelper,
      options.limactl,
    ].every((p) => path.isAbsolute(p) && !/[\0\r\n]/.test(p))
  )
    throw new Error('AGENT_BOOTSTRAP_CONFIG');
  await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
  const dir = await lstat(options.dataRoot);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    dir.uid !== process.getuid?.() ||
    (dir.mode & 0o777) !== 0o700
  )
    throw new Error('AGENT_BOOTSTRAP_STORE');
  let progressWrites = Promise.resolve();
  const progress = (value: SetupStatus) => {
    // Extraction callbacks are synchronous; serialize their writes so a late callback cannot replace completion.
    progressWrites = progressWrites.then(() =>
      atomic(path.join(options.dataRoot, 'progress.json'), value),
    );
    return progressWrites;
  };
  const pause = async () => {
    options.signal?.throwIfAborted();
    const value = await json(path.join(options.dataRoot, 'cancel.json'));
    options.signal?.throwIfAborted();
    if (value && typeof value === 'object' && 'cancelled' in value && value.cancelled === true) {
      await progress({ required: true, phase: 'cancelled' });
      throw new Error('AGENT_SETUP_PAUSED');
    }
  };
  await pause();
  const journal = path.join(options.dataRoot, 'bootstrap.json'),
    saved = await json(journal);
  let state: State;
  if (saved) {
    if (
      typeof saved !== 'object' ||
      !('version' in saved) ||
      saved.version !== 1 ||
      !('dataRoot' in saved) ||
      saved.dataRoot !== options.dataRoot ||
      !('configFile' in saved) ||
      saved.configFile !== options.vmConfigFile ||
      !('source' in saved) ||
      !('phase' in saved) ||
      !['snapshot', 'provision', 'restore', 'ready'].includes(String(saved.phase))
    )
      throw new Error('AGENT_BOOTSTRAP_STORE');
    state = saved as State;
    if (state.source !== null) config(state.source);
    if (state.target) config(state.target);
    if (['restore', 'ready'].includes(state.phase) && !state.target)
      throw new Error('AGENT_BOOTSTRAP_STORE');
  } else {
    const previous = await json(options.vmConfigFile);
    state = {
      version: 1,
      dataRoot: options.dataRoot,
      configFile: options.vmConfigFile,
      source: previous ? config(previous) : null,
      phase: 'snapshot',
    };
    await atomic(journal, state);
  }
  if (state.phase === 'ready' && state.target) {
    const existing = await json(options.vmConfigFile);
    if (
      existing &&
      !sameConfig(config(existing), state.target) &&
      !sameConfig(config(existing), state.source)
    )
      throw new Error('AGENT_VM_TARGET_CHANGED');
    await pause();
    await atomic(options.vmConfigFile, state.target);
    await progress({ required: false, phase: 'complete' });
    return state.target;
  }
  let manifests:
    | { control: MigrationManifest; browser: MigrationManifest; shared: MigrationManifest }
    | undefined;
  if (state.source) {
    const identity = {
      vm: state.source.vm,
      imageFingerprint: createHash('sha256').update(JSON.stringify(state.source)).digest('hex'),
    };
    const source =
      dependencies.source?.(state.source, identity) ??
      new LegacySource(
        state.source,
        options.sourceHelper,
        path.join(options.dataRoot, 'legacy-source'),
        identity,
      );
    await progress({ required: true, phase: 'verifying' });
    await source.prepare();
    await pause();
    manifests = {
      control: await source.port('control').manifest(),
      browser: await source.port('browser').manifest(),
      shared: await source.port('shared').manifest(),
    };
    const expected = { source: identity, target };
    const receipt = await migrateControlData({
      directory: path.join(options.dataRoot, 'model'),
      journal: path.join(options.dataRoot, 'migration-control.json'),
      expected,
      source: source.port('control'),
    });
    for (const root of ['browser', 'shared'] as const)
      await migratePublicData({
        directory: path.join(options.dataRoot, 'public'),
        journal: path.join(options.dataRoot, `migration-${root}.json`),
        expected,
        source: source.port(root),
        root,
      });
    await migrateBundlePayloads({
      directory: path.join(options.dataRoot, 'model'),
      manifestHash: receipt.manifestHash,
      files: manifests.control.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      journalFile: path.join(options.dataRoot, 'bundle-migration.json'),
    });
    await pause();
    await source.stopVm();
  }
  await pause();
  state.phase = 'provision';
  await atomic(journal, state);
  await progress({ required: true, phase: 'creating' });
  await pause();
  state.target = await (
    dependencies.provision ??
    ((opts) =>
      ensureExecutionVm(opts, {
        progress: (stage, percent) => {
          const phase =
            stage === 'image'
              ? 'extracting'
              : stage === 'creating'
                ? 'creating'
                : stage === 'starting'
                  ? 'starting'
                  : 'verifying';
          progress({
            required: true,
            phase,
            ...(percent === undefined ? {} : { progress: percent }),
          }).catch(() => {});
        },
      }))
  )({
    directory: path.join(options.dataRoot, 'execution'),
    packDirectory: options.packDirectory,
    executorArchive: options.executorArchive,
    limactl: options.limactl,
    vm: target.vm,
  });
  state.phase = 'restore';
  await atomic(journal, state);
  await pause();
  if (manifests) {
    if (!options.restoreHelper && !dependencies.restore) throw new Error('AGENT_RESTORE_REQUIRED');
    const restore = dependencies.restore ?? (await import('./restore.js')).restorePublicData;
    await restore({
      config: state.target,
      directory: path.join(options.dataRoot, 'public'),
      browser: manifests.browser,
      shared: manifests.shared,
      ...(manifests.control.files.some((file) => file.path === 'credentials.json')
        ? { credentialFile: path.join(options.dataRoot, 'model/credentials.json') }
        : {}),
      helperEntry: options.restoreHelper ?? '/mock/injected',
      cacheDirectory: path.join(options.dataRoot, 'public-transfer'),
    });
  }
  const existing = await json(options.vmConfigFile);
  if (
    existing &&
    !sameConfig(config(existing), state.source) &&
    !sameConfig(config(existing), state.target)
  )
    throw new Error('AGENT_VM_TARGET_CHANGED');
  await pause();
  state.phase = 'ready';
  await atomic(journal, state);
  await pause();
  await atomic(options.vmConfigFile, state.target);
  await progress({ required: false, phase: 'complete' });
  return state.target;
}
