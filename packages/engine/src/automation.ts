import { createHash } from 'node:crypto';
import {
  type FileTrigger,
  isAutomationDigest,
  isAutomationPath,
  type ProjectScope,
} from '@daban/protocol';
import { Fault } from './control.js';

export interface FileObserver {
  available?(): boolean;
  authorize(bot: string, scope: ProjectScope): unknown;
  read(
    bot: string,
    scope: ProjectScope,
    path: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<Uint8Array | null>;
}
export const automationHash = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export interface AutomationOutput {
  path: string;
  size: number;
  sha256: string;
}
export function isAutomationOutput(value: unknown): value is AutomationOutput {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => ['path', 'size', 'sha256'].includes(key)) &&
    'path' in value &&
    isAutomationPath(value.path) &&
    'size' in value &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0 &&
    Number(value.size) <= 64 * 1024 &&
    'sha256' in value &&
    isAutomationDigest(value.sha256)
  );
}
export async function sampleFiles(
  observer: FileObserver,
  bot: string,
  rule: FileTrigger,
  signal: AbortSignal,
) {
  const files: [string, string | null][] = [];
  let total = 0;
  for (const file of [...rule.paths].sort()) {
    signal.throwIfAborted();
    observer.authorize(bot, rule.scope);
    const bytes = await observer.read(bot, rule.scope, file, 1024 * 1024, signal);
    signal.throwIfAborted();
    observer.authorize(bot, rule.scope);
    if (bytes !== null) {
      total += bytes.byteLength;
      if (bytes.byteLength > 1024 * 1024 || total > 4 * 1024 * 1024)
        throw new Fault('AUTOMATION_FILES_TOO_LARGE');
    }
    files.push([file, bytes === null ? null : automationHash(bytes)]);
  }
  return automationHash(JSON.stringify(files));
}
export function signalDigest(bytes: Uint8Array) {
  if (bytes.byteLength > 64 * 1024) throw new Fault('AUTOMATION_SIGNAL_UNAVAILABLE');
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('not text');
    return automationHash(text.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
  } catch {
    throw new Fault('AUTOMATION_SIGNAL_UNAVAILABLE');
  }
}
