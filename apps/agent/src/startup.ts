import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { syncDirectory } from '@daban/engine/host';
import { privateMetadata, secureDirectory } from '@daban/engine/local-computer';
import { type ExecutionSnapshot, isExecutionSnapshot, isRebootOperation } from '@daban/protocol';

interface CachedExecution {
  snapshot: ExecutionSnapshot;
  workspaceRoot: string;
}
export interface StartupPolicy {
  attachOnly: boolean;
  initialSnapshot?: ExecutionSnapshot;
  workspaceRoot?: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const targetHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function isWorkspaceRoot(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    value.startsWith('/') &&
    !/[\r\n]/.test(value) &&
    !value.includes('\0') &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}
async function privateJson(file: string, code: string): Promise<unknown> {
  try {
    const identity = await lstat(file);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1)
      throw new Error(code);
    if (process.platform === 'win32') await secureDirectory(path.dirname(file));
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.dev !== identity.dev ||
        info.ino !== identity.ino ||
        !(await privateMetadata(file, info, 0o600)) ||
        info.size > 8 * 1024 * 1024
      )
        throw new Error(code);
      return JSON.parse(await handle.readFile('utf8'));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (object(error) && error.code === 'ENOENT') return undefined;
    throw new Error(code);
  }
}
export async function assertSetupRunning(dataRoot: string) {
  const marker = await privateJson(path.join(dataRoot, 'cancel.json'), 'AGENT_SETUP_STORE');
  if (marker === undefined) return;
  if (
    !object(marker) ||
    Object.keys(marker).some((key) => key !== 'cancelled') ||
    typeof marker.cancelled !== 'boolean'
  )
    throw new Error('AGENT_SETUP_STORE');
  if (marker.cancelled) throw new Error('AGENT_SETUP_PAUSED');
}
async function cached(file: string, target: string): Promise<CachedExecution | undefined> {
  const value = await privateJson(file, 'AGENT_EXECUTION_CACHE_INVALID');
  if (value === undefined) return undefined;
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !['version', 'target', 'snapshot', 'workspaceRoot'].includes(key),
    ) ||
    value.version !== 1 ||
    value.target !== target ||
    !isExecutionSnapshot(value.snapshot) ||
    !isWorkspaceRoot(value.workspaceRoot)
  )
    throw new Error('AGENT_EXECUTION_CACHE_INVALID');
  return { snapshot: value.snapshot, workspaceRoot: value.workspaceRoot };
}
export async function readStartupPolicy(options: {
  target: string;
  cacheFile: string;
  powerFile: string;
}): Promise<StartupPolicy> {
  if (!targetHash(options.target)) throw new Error('AGENT_EXECUTION_CACHE_INVALID');
  const power = await privateJson(options.powerFile, 'RECOVERY_HOST_STORE_UNAVAILABLE');
  let attachOnly = false;
  if (power !== undefined) {
    if (
      !object(power) ||
      Object.keys(power).some(
        (key) => !['version', 'revision', 'target', 'operation'].includes(key),
      ) ||
      power.version !== 1 ||
      !Number.isSafeInteger(power.revision) ||
      Number(power.revision) < 1 ||
      !isRebootOperation(power.operation)
    )
      throw new Error('RECOVERY_HOST_STORE_UNAVAILABLE');
    if (power.target !== options.target) throw new Error('RECOVERY_TARGET_CHANGED');
    attachOnly = !['complete', 'cancelled', 'rejected'].includes(power.operation.stage);
  }
  const execution = await cached(options.cacheFile, options.target);
  return {
    attachOnly,
    ...(execution
      ? {
          initialSnapshot: structuredClone(execution.snapshot),
          workspaceRoot: execution.workspaceRoot,
        }
      : {}),
  };
}
export async function saveExecutionSnapshot(options: {
  file: string;
  target: string;
  snapshot: ExecutionSnapshot;
  workspaceRoot: string;
}) {
  if (
    !path.isAbsolute(options.file) ||
    !targetHash(options.target) ||
    !isExecutionSnapshot(options.snapshot) ||
    !isWorkspaceRoot(options.workspaceRoot)
  )
    throw new Error('AGENT_EXECUTION_CACHE_INVALID');
  const parent = path.dirname(options.file);
  await secureDirectory(parent);
  const temporary = `${options.file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(
      JSON.stringify({
        version: 1,
        target: options.target,
        workspaceRoot: options.workspaceRoot,
        snapshot: options.snapshot,
      }),
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, options.file);
  const entry = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await syncDirectory(entry);
  } finally {
    await entry.close();
  }
}
