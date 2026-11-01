import { validAgentId } from './id.js';

export interface LocalComputerSession {
  id: string;
  bot: string;
  revision: number;
  owner: 'agent' | 'human';
  model: string;
  modelRevision: number;
}
export interface LocalComputerStatus {
  platform: 'darwin' | 'win32' | 'unsupported';
  available: boolean;
  permissions: { screen: boolean; accessibility: boolean };
  shortcut: boolean;
  session?: LocalComputerSession;
  error?: string;
}
export interface LocalComputerFrame {
  session: string;
  observation: string;
  bot: string;
  runId: string;
  width: number;
  height: number;
  image: string;
}
export type LocalComputerInput =
  | { type: 'click'; x: number; y: number; button?: number }
  | { type: 'pointer'; x: number; y: number; phase: 'down' | 'move' | 'up'; button?: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string }
  | { type: 'scroll'; deltaY: number; x?: number; y?: number };
export type LocalComputerCommand =
  | { type: 'local.status' }
  | { type: 'local.permissions' }
  | { type: 'local.connect'; id: string; bot: string; model: string; modelRevision: number }
  | {
      type: 'local.pause' | 'local.resume' | 'local.disconnect' | 'local.preview';
      session: string;
      revision: number;
    };

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const revision = (value: unknown, minimum = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum;
const model = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32);
export function isLocalComputerSession(value: unknown): value is LocalComputerSession {
  return (
    record(value) &&
    exact(value, ['id', 'bot', 'revision', 'owner', 'model', 'modelRevision']) &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    revision(value.revision, 1) &&
    ['agent', 'human'].includes(String(value.owner)) &&
    model(value.model) &&
    revision(value.modelRevision)
  );
}
export function isLocalComputerStatus(value: unknown): value is LocalComputerStatus {
  return (
    record(value) &&
    exact(value, ['available', 'permissions', 'shortcut', 'session', 'error', 'platform']) &&
    ['darwin', 'win32', 'unsupported'].includes(String(value.platform)) &&
    typeof value.available === 'boolean' &&
    typeof value.shortcut === 'boolean' &&
    record(value.permissions) &&
    exact(value.permissions, ['screen', 'accessibility']) &&
    typeof value.permissions.screen === 'boolean' &&
    typeof value.permissions.accessibility === 'boolean' &&
    (value.session === undefined || isLocalComputerSession(value.session)) &&
    (value.error === undefined ||
      (typeof value.error === 'string' && /^[A-Z_]{1,80}$/.test(value.error)))
  );
}
export function isLocalComputerCommand(value: unknown): value is LocalComputerCommand {
  if (!record(value)) return false;
  if (value.type === 'local.status' || value.type === 'local.permissions')
    return exact(value, ['type']);
  if (value.type === 'local.connect')
    return (
      exact(value, ['type', 'id', 'bot', 'model', 'modelRevision']) &&
      validAgentId(value.id) &&
      validAgentId(value.bot) &&
      model(value.model) &&
      revision(value.modelRevision)
    );
  return (
    ['local.pause', 'local.resume', 'local.disconnect', 'local.preview'].includes(
      String(value.type),
    ) &&
    exact(value, ['type', 'session', 'revision']) &&
    validAgentId(value.session) &&
    revision(value.revision, 1)
  );
}
export function isLocalComputerFrame(value: unknown): value is LocalComputerFrame {
  return (
    record(value) &&
    exact(value, ['session', 'observation', 'bot', 'runId', 'width', 'height', 'image']) &&
    validAgentId(value.session) &&
    validAgentId(value.observation) &&
    validAgentId(value.bot) &&
    validAgentId(value.runId) &&
    revision(value.width, 1) &&
    Number(value.width) <= 8192 &&
    revision(value.height, 1) &&
    Number(value.height) <= 8192 &&
    typeof value.image === 'string' &&
    value.image.length <= 4 * 1024 * 1024 &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image)
  );
}
export function isLocalComputerInput(value: unknown): value is LocalComputerInput {
  if (!record(value)) return false;
  const point = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 8192;
  const button =
    value.button === undefined ||
    (Number.isInteger(value.button) && [0, 1, 2].includes(Number(value.button)));
  switch (value.type) {
    case 'click':
      return (
        exact(value, ['type', 'x', 'y', 'button']) && point(value.x) && point(value.y) && button
      );
    case 'pointer':
      return (
        exact(value, ['type', 'x', 'y', 'phase', 'button']) &&
        point(value.x) &&
        point(value.y) &&
        button &&
        ['down', 'move', 'up'].includes(String(value.phase))
      );
    case 'key':
      return (
        exact(value, ['type', 'key']) &&
        typeof value.key === 'string' &&
        /^[A-Za-z0-9_+ -]{1,128}$/.test(value.key)
      );
    case 'text':
      return (
        exact(value, ['type', 'text']) &&
        typeof value.text === 'string' &&
        value.text.length <= 4000 &&
        !value.text.includes('\0')
      );
    case 'scroll':
      return (
        exact(value, ['type', 'deltaY', 'x', 'y']) &&
        typeof value.deltaY === 'number' &&
        Number.isFinite(value.deltaY) &&
        Math.abs(value.deltaY) <= 4000 &&
        (value.x === undefined || point(value.x)) &&
        (value.y === undefined || point(value.y))
      );
    default:
      return false;
  }
}
export const unavailableLocalComputer = (
  error = 'LOCAL_CLIENT_UNAVAILABLE',
): LocalComputerStatus => ({
  platform: 'unsupported',
  available: false,
  permissions: { screen: false, accessibility: false },
  shortcut: false,
  error,
});
