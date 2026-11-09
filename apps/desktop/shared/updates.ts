import { isLocale, type Locale } from './locale';

export const updateNotesLimit = 100_000;
export const updatePhases = [
  'unsupported',
  'idle',
  'checking',
  'current',
  'unpublished',
  'available',
  'downloading',
  'downloaded',
  'preparing',
  'installing',
  'error',
] as const;
export type UpdatePhase = (typeof updatePhases)[number];
export const updateErrors = [
  'UPDATE_CHECK_FAILED',
  'UPDATE_DOWNLOAD_FAILED',
  'UPDATE_SAVE_FAILED',
  'UPDATE_NOT_READY',
  'UPDATE_UNSUPPORTED',
  'UPDATE_INSTALL_FAILED',
  'AGENT_UPDATE_BUSY',
  'AGENT_UPDATE_UNAVAILABLE',
  'AGENT_LEGACY_RESTART_REQUIRED',
] as const;
export type UpdateError = (typeof updateErrors)[number];
export interface UpdateStatus {
  phase: UpdatePhase;
  version: string;
  nextVersion?: string;
  notes?: string;
  changelogs?: Partial<Record<Locale, string>>;
  percent?: number;
  error?: UpdateError;
}
export type UpdateCommand =
  | { type: 'status' | 'check' | 'download' | 'cancel' | 'install' }
  | { type: 'saved'; id: string; success: boolean };
export type UpdateMessage =
  | { type: 'status'; status: UpdateStatus }
  | { type: 'prepare'; id: string };
export interface UpdateBridge {
  invoke(
    command: UpdateCommand,
  ): Promise<{ ok: true; value: UpdateStatus } | { ok: false; error: string }>;
  subscribe(callback: (message: UpdateMessage) => unknown): () => unknown;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function parseUpdateCommand(value: unknown): UpdateCommand {
  if (!record(value)) throw Error('INVALID_UPDATE_COMMAND');
  if (
    Object.keys(value).length === 1 &&
    ['status', 'check', 'download', 'cancel', 'install'].includes(String(value.type))
  )
    return value as UpdateCommand;
  if (
    Object.keys(value).length === 3 &&
    value.type === 'saved' &&
    typeof value.id === 'string' &&
    /^[a-f0-9]{48}$/.test(value.id) &&
    typeof value.success === 'boolean'
  )
    return value as UpdateCommand;
  throw Error('INVALID_UPDATE_COMMAND');
}
export function isUpdateMessage(value: unknown): value is UpdateMessage {
  if (!record(value)) return false;
  if (value.type === 'prepare')
    return (
      Object.keys(value).length === 2 &&
      typeof value.id === 'string' &&
      /^[a-f0-9]{48}$/.test(value.id)
    );
  if (value.type !== 'status' || !record(value.status)) return false;
  const status = value.status;
  return (
    Object.keys(value).length === 2 &&
    Object.keys(status).every((key) =>
      ['phase', 'version', 'nextVersion', 'notes', 'changelogs', 'percent', 'error'].includes(key),
    ) &&
    updatePhases.includes(status.phase as UpdatePhase) &&
    typeof status.version === 'string' &&
    status.version.length <= 100 &&
    (status.nextVersion === undefined ||
      (typeof status.nextVersion === 'string' && status.nextVersion.length <= 100)) &&
    (status.notes === undefined ||
      (typeof status.notes === 'string' && status.notes.length <= updateNotesLimit)) &&
    (status.changelogs === undefined ||
      (record(status.changelogs) &&
        Object.entries(status.changelogs).every(
          ([locale, notes]) =>
            isLocale(locale) && typeof notes === 'string' && notes.length <= updateNotesLimit,
        ))) &&
    (status.percent === undefined ||
      (typeof status.percent === 'number' &&
        Number.isFinite(status.percent) &&
        status.percent >= 0 &&
        status.percent <= 100)) &&
    (status.error === undefined || updateErrors.includes(status.error as UpdateError))
  );
}
