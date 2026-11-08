import { validAgentId } from './id.js';

export interface LocalFolder {
  id: string;
  bot: string;
  name: string;
  path: string;
}
export interface LocalOperation {
  id: string;
  folder: string;
  bot: string;
  kind: 'write' | 'edit' | 'mkdir' | 'move' | 'trash';
  path: string;
  destination?: string;
  state: 'unknown' | 'complete' | 'restored';
  at: string;
  before?: string;
  after?: string;
}
export interface FolderStatus {
  bot: string;
  folders: LocalFolder[];
  operations: LocalOperation[];
}
export type FolderCommand =
  | { type: 'folders.pick'; bot: string; suggestedPath?: string }
  | { type: 'folders.status'; bot: string }
  | { type: 'folders.disconnect'; bot: string; id: string }
  | { type: 'folders.restore'; bot: string; id: string };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 4096): value is string =>
  typeof value === 'string' && value.length <= limit && !value.includes('\0');
export function isFolderCommand(value: unknown): value is FolderCommand {
  if (!object(value) || !validAgentId(value.bot)) return false;
  const pick = value.type === 'folders.pick';
  const simple = value.type === 'folders.pick' || value.type === 'folders.status';
  return (
    (simple ||
      ((value.type === 'folders.disconnect' || value.type === 'folders.restore') &&
        validAgentId(value.id))) &&
    Object.keys(value).every((key) =>
      (pick
        ? ['type', 'bot', 'suggestedPath']
        : simple
          ? ['type', 'bot']
          : ['type', 'bot', 'id']
      ).includes(key),
    ) &&
    (value.suggestedPath === undefined ||
      (pick && text(value.suggestedPath) && value.suggestedPath.length > 0))
  );
}
export function isFolderStatus(value: unknown): value is FolderStatus {
  if (
    !object(value) ||
    !validAgentId(value.bot) ||
    !Array.isArray(value.folders) ||
    !Array.isArray(value.operations)
  )
    return false;
  return (
    Object.keys(value).every((key) => ['bot', 'folders', 'operations'].includes(key)) &&
    value.folders.length <= 32 &&
    value.operations.length <= 100 &&
    value.folders.every(
      (item) =>
        object(item) &&
        item.bot === value.bot &&
        validAgentId(item.id) &&
        text(item.name, 255) &&
        text(item.path) &&
        Object.keys(item).every((key) => ['id', 'bot', 'name', 'path'].includes(key)),
    ) &&
    new Set(value.folders.map((item) => item.id)).size === value.folders.length &&
    value.operations.every(
      (item) =>
        object(item) &&
        item.bot === value.bot &&
        validAgentId(item.id) &&
        validAgentId(item.folder) &&
        ['write', 'edit', 'mkdir', 'move', 'trash'].includes(String(item.kind)) &&
        ['unknown', 'complete', 'restored'].includes(String(item.state)) &&
        text(item.path) &&
        (item.destination === undefined || text(item.destination)) &&
        text(item.at, 40) &&
        Number.isFinite(Date.parse(item.at)) &&
        (item.before === undefined || text(item.before, 16000)) &&
        (item.after === undefined || text(item.after, 16000)) &&
        Object.keys(item).every((key) =>
          [
            'id',
            'folder',
            'bot',
            'kind',
            'path',
            'destination',
            'state',
            'at',
            'before',
            'after',
          ].includes(key),
        ),
    )
  );
}
