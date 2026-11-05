import { isReviewSelection, workspaceReviewCapability } from './file-review.js';
import { fileObservationCapability } from './automation.js';
import { validAgentId } from './id.js';
import type { BrowserState, ComputerStatus, ModelId } from './index.js';
import {
  documentLimit,
  isBrowserState,
  isComputerStatus,
  isDocumentUpload,
  isModelId,
} from './index.js';
import {
  isProjectFileScope,
  isProjectResources,
  isProjectScope,
  type ProjectScope,
  projectCapability,
} from './projects.js';
import { isSkillPackage, skillPackageCapability } from './skills.js';

export const executionVersion = 1;
export const modelExecutionCapability = 'model-capabilities-v1';
export const browserTaskCapability = 'browser-task-v1';
// These peers distinguish task directories from attempt leases and accept captured tool budgets up to 10000.
export const taskRunCapability = 'task-run-v1';
export const legacyExecutionToolLimit = 1000;
export const executionCapabilities = [
  'workspace',
  'tools',
  'computer',
  'processes',
  'documents',
] as const;
export interface ExecutionComputerSnapshot {
  mode?: 'browser' | 'desktop' | 'agent';
  sharedLogin: boolean;
  viewport: { width: number; height: number };
  environment: { platform: string; arch: string; kernel: string; node: string; browser: string };
  events: { at: string; bot: string; message: string }[];
  browsers?: Record<string, BrowserState>;
  bots: Record<
    string,
    {
      instance?: string;
      owner: 'agent' | 'human' | 'handoff';
      epoch: number;
      running: boolean;
      error: string | null;
      count: number;
      identity: string;
      note: string;
      desktop?: {
        display: string;
        steps: number;
        lastAction: string;
        windows: {
          id: string;
          pid: number;
          x: number;
          y: number;
          width: number;
          height: number;
          class: string;
          title: string;
        }[];
      };
    }
  >;
}
export interface ExecutionSnapshot {
  role: 'executor';
  version: 1;
  boot: string;
  nonce: string;
  capabilities: string[];
  computer: ExecutionComputerSnapshot;
  status: ComputerStatus;
}
export interface ExecutionRun {
  /** Accepted task directory owner; id remains the physical attempt lease. */
  taskRunId?: string;
  project?: ProjectScope;
  id: string;
  bot: string;
  workdir: string;
  canonicalRoot: string;
  model?: ModelId;
  vision?: boolean;
  prompt?: string;
  limit: number;
}
export const executionMethods = [
  'projects.sync',
  'projects.bind',
  'computer.snapshot',
  'computer.status',
  'computer.request',
  'workspace.base',
  'workspace.create',
  'workspace.verify',
  'workspace.write',
  'workspace.close',
  'workspace.list',
  'workspace.read',
  'workspace.download',
  'workspace.skill',
  'workspace.review.capture',
  'tools.open',
  'tools.invoke',
  'tools.poll',
  'tools.cancel',
  'tools.drain',
  'tools.write',
  'process.start',
  'process.poll',
  'process.input',
  'process.cancel',
  'documents.extract',
] as const;
export type ExecutionMethod = (typeof executionMethods)[number];
export interface ExecutionRequest {
  role: 'executor';
  version: 1;
  id: string;
  boot?: string;
  nonce?: string;
  method: ExecutionMethod;
  params: Record<string, unknown>;
}
export type ExecutionReply = {
  role: 'executor';
  version: 1;
  id: string;
  boot: string;
} & ({ ok: true; value: unknown } | { ok: false; error: string });
export const executionRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const executionKeys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const text = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0');
const absolute = (value: unknown) => text(value) && value.startsWith('/');
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const scope = (value: Record<string, unknown>) =>
  (value.project === undefined || isProjectFileScope(value.project)) &&
  (value.root === undefined || absolute(value.root)) &&
  (value.canonical === undefined || absolute(value.canonical));
export function isExecutionRun(value: unknown): value is ExecutionRun {
  return (
    executionRecord(value) &&
    executionKeys(value, [
      'id',
      'taskRunId',
      'bot',
      'workdir',
      'canonicalRoot',
      'project',
      'model',
      'vision',
      'prompt',
      'limit',
    ]) &&
    (value.project === undefined || isProjectScope(value.project)) &&
    (value.taskRunId === undefined ||
      (isProjectScope(value.project) && validAgentId(value.taskRunId))) &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    absolute(value.workdir) &&
    absolute(value.canonicalRoot) &&
    (value.model === undefined || isModelId(value.model)) &&
    (value.vision === undefined || typeof value.vision === 'boolean') &&
    (value.prompt === undefined || (text(value.prompt, 12000) && !!value.prompt.trim())) &&
    integer(value.limit) &&
    Number(value.limit) >= 1 &&
    Number(value.limit) <= 10000
  );
}
export function isExecutionParams(
  method: ExecutionMethod,
  value: unknown,
): value is Record<string, unknown> {
  if (!executionRecord(value)) return false;
  if (method === 'projects.sync') return isProjectResources(value);
  if (method === 'projects.bind')
    return (
      executionKeys(value, ['bot', 'scope']) &&
      validAgentId(value.bot) &&
      (value.scope === undefined || isProjectScope(value.scope))
    );
  if (method === 'computer.snapshot' || method === 'computer.status')
    return Object.keys(value).length === 0;
  if (method === 'computer.request')
    return (
      executionKeys(value, ['method', 'path', 'body']) &&
      ['GET', 'POST'].includes(String(value.method)) &&
      text(value.path, 4096) &&
      (value.body === undefined || executionRecord(value.body))
    );
  if (method === 'workspace.base' || method === 'workspace.list')
    return executionKeys(value, ['root', 'canonical', 'project']) && scope(value);
  if (method === 'workspace.review.capture')
    return (
      executionKeys(value, ['root', 'canonical', 'paths']) &&
      scope(value) &&
      (value.paths === undefined ||
        (isReviewSelection({ sharedPaths: value.paths }) &&
          Array.isArray(value.paths) &&
          value.paths.length > 0))
    );
  if (method === 'workspace.skill')
    return (
      executionKeys(value, ['root', 'canonical', 'project', 'package']) &&
      scope(value) &&
      isSkillPackage(value.package)
    );
  if (method === 'workspace.create')
    return (
      executionKeys(value, ['root', 'canonical', 'project', 'parts']) &&
      scope(value) &&
      Array.isArray(value.parts) &&
      value.parts.length > 0 &&
      value.parts.length <= 10 &&
      value.parts.every(validAgentId)
    );
  if (method === 'workspace.read' || method === 'workspace.download')
    return (
      executionKeys(value, ['root', 'canonical', 'project', 'path', 'limit']) &&
      scope(value) &&
      text(value.path, 512) &&
      (value.limit === undefined ||
        (integer(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 1024 * 1024))
    );
  if (method === 'workspace.verify' || method === 'workspace.close')
    return executionKeys(value, ['handleId']) && validAgentId(value.handleId);
  if (method === 'workspace.write')
    return (
      executionKeys(value, ['handleId', 'name', 'data']) &&
      validAgentId(value.handleId) &&
      text(value.name, 255) &&
      text(value.data, 4 * Math.ceil(documentLimit / 3)) &&
      value.data.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(value.data) &&
      (value.data.length / 4) * 3 -
        (value.data.endsWith('==') ? 2 : value.data.endsWith('=') ? 1 : 0) <=
        documentLimit
    );
  if (method === 'tools.open') return isExecutionRun(value);
  if (method === 'tools.cancel' || method === 'tools.drain')
    return executionKeys(value, ['runId']) && validAgentId(value.runId);
  if (method === 'tools.poll')
    return (
      executionKeys(value, ['runId', 'operationId']) &&
      validAgentId(value.runId) &&
      validAgentId(value.operationId)
    );
  if (method === 'tools.invoke')
    return (
      executionKeys(value, ['runId', 'operationId', 'name', 'args', 'wireId']) &&
      validAgentId(value.runId) &&
      validAgentId(value.operationId) &&
      text(value.name, 100) &&
      !!value.name &&
      executionRecord(value.args) &&
      (value.wireId === undefined || validAgentId(value.wireId))
    );
  if (method === 'tools.write')
    return (
      executionKeys(value, ['runId', 'path', 'content', 'createOnly']) &&
      validAgentId(value.runId) &&
      text(value.path, 512) &&
      text(value.content, 200 * 1024) &&
      typeof value.createOnly === 'boolean'
    );
  if (method === 'process.start')
    return (
      executionKeys(value, ['id', 'command', 'cwd']) &&
      validAgentId(value.id) &&
      text(value.command, 64000) &&
      !!value.command &&
      absolute(value.cwd)
    );
  if (method === 'process.poll') return executionKeys(value, ['id']) && validAgentId(value.id);
  if (method === 'process.cancel')
    return (
      executionKeys(value, ['id', 'requestId']) &&
      validAgentId(value.id) &&
      validAgentId(value.requestId)
    );
  if (method === 'process.input')
    return (
      executionKeys(value, ['id', 'requestId', 'data', 'eof']) &&
      validAgentId(value.id) &&
      validAgentId(value.requestId) &&
      text(value.data, 65536) &&
      (value.eof === undefined || typeof value.eof === 'boolean')
    );
  if (method === 'documents.extract') return isDocumentUpload(value);
  return false;
}
export function isExecutionRequest(value: unknown): value is ExecutionRequest {
  return (
    executionRecord(value) &&
    executionKeys(value, ['role', 'version', 'id', 'boot', 'nonce', 'method', 'params']) &&
    value.role === 'executor' &&
    value.version === executionVersion &&
    validAgentId(value.id) &&
    (value.boot === undefined || validAgentId(value.boot)) &&
    (value.nonce === undefined || validAgentId(value.nonce)) &&
    executionMethods.includes(value.method as ExecutionMethod) &&
    isExecutionParams(value.method as ExecutionMethod, value.params)
  );
}
export function isExecutionReply(value: unknown): value is ExecutionReply {
  return (
    executionRecord(value) &&
    executionKeys(value, [
      'role',
      'version',
      'id',
      'boot',
      'ok',
      ...(value.ok === true ? ['value'] : ['error']),
    ]) &&
    value.role === 'executor' &&
    value.version === executionVersion &&
    validAgentId(value.id) &&
    validAgentId(value.boot) &&
    (value.ok === true
      ? Object.hasOwn(value, 'value')
      : value.ok === false && text(value.error, 100) && /^[A-Z_]+$/.test(value.error))
  );
}
export function isExecutionSnapshot(value: unknown): value is ExecutionSnapshot {
  if (
    !executionRecord(value) ||
    !executionKeys(value, [
      'role',
      'version',
      'boot',
      'nonce',
      'capabilities',
      'computer',
      'status',
    ]) ||
    value.role !== 'executor' ||
    value.version !== 1 ||
    !validAgentId(value.boot) ||
    !validAgentId(value.nonce) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > executionCapabilities.length + 7 ||
    new Set(value.capabilities).size !== value.capabilities.length ||
    !value.capabilities.every((capability) =>
      [
        ...executionCapabilities,
        modelExecutionCapability,
        skillPackageCapability,
        browserTaskCapability,
        workspaceReviewCapability,
        projectCapability,
        fileObservationCapability,
        taskRunCapability,
      ].includes(capability),
    ) ||
    !executionCapabilities.every(
      (capability) => Array.isArray(value.capabilities) && value.capabilities.includes(capability),
    ) ||
    !isComputerStatus(value.status) ||
    !executionRecord(value.computer)
  )
    return false;
  const c = value.computer;
  if (
    !executionKeys(c, [
      'mode',
      'sharedLogin',
      'viewport',
      'environment',
      'events',
      'bots',
      'browsers',
    ]) ||
    (c.mode !== undefined && !['agent', 'desktop', 'browser'].includes(String(c.mode))) ||
    typeof c.sharedLogin !== 'boolean' ||
    !executionRecord(c.viewport) ||
    !executionKeys(c.viewport, ['width', 'height']) ||
    c.viewport.width !== 1280 ||
    c.viewport.height !== 800 ||
    !executionRecord(c.environment) ||
    !executionKeys(c.environment, ['platform', 'arch', 'kernel', 'node', 'browser']) ||
    !['platform', 'arch', 'kernel', 'node', 'browser'].every((key) =>
      text(c.environment && executionRecord(c.environment) ? c.environment[key] : undefined, 256),
    ) ||
    !Array.isArray(c.events) ||
    c.events.length !== 0 ||
    !executionRecord(c.bots) ||
    Object.keys(c.bots).length > 16
  )
    return false;
  if (
    c.browsers !== undefined &&
    (!executionRecord(c.browsers) ||
      !Object.entries(c.browsers).every(
        ([bot, state]) => validAgentId(bot) && isBrowserState(state) && state.bot === bot,
      ))
  )
    return false;
  return Object.entries(c.bots).every(([id, bot]) => {
    if (
      !validAgentId(id) ||
      !executionRecord(bot) ||
      !executionKeys(bot, [
        'instance',
        'owner',
        'epoch',
        'running',
        'error',
        'count',
        'identity',
        'note',
        'desktop',
      ]) ||
      (bot.instance !== undefined && !validAgentId(bot.instance)) ||
      !['agent', 'human', 'handoff'].includes(String(bot.owner)) ||
      !integer(bot.epoch) ||
      typeof bot.running !== 'boolean' ||
      !(bot.error === null || text(bot.error, 100)) ||
      !integer(bot.count) ||
      !text(bot.identity, 4096) ||
      !text(bot.note, 4096)
    )
      return false;
    if (bot.desktop === undefined) return true;
    const d = bot.desktop;
    return (
      executionRecord(d) &&
      executionKeys(d, ['display', 'steps', 'lastAction', 'windows']) &&
      text(d.display, 100) &&
      integer(d.steps) &&
      text(d.lastAction, 2000) &&
      Array.isArray(d.windows) &&
      d.windows.length <= 200 &&
      d.windows.every(
        (w) =>
          executionRecord(w) &&
          executionKeys(w, ['id', 'pid', 'x', 'y', 'width', 'height', 'class', 'title']) &&
          text(w.id, 100) &&
          integer(w.pid) &&
          ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(w[key])) &&
          text(w.class, 500) &&
          text(w.title, 2000),
      )
    );
  });
}
