export * from './goals.js';

import type { GoalProgress } from './goals.js';
import type { LocalComputerCommand, LocalComputerStatus } from './local-computer.js';
import {
  isSkillPackage,
  isSkillPackageInfo,
  isSkillResource,
  type SkillPackage,
  type SkillPackageCommand,
  type SkillPackageInfo,
  type SkillResource,
} from './skills.js';

export * from './execution.js';
export * from './local-computer.js';
export * from './vm.js';
export * from './windows.js';

import { isSoftwarePlan, type SoftwarePlan, type SoftwareState } from './software.js';
import type { VmCommand } from './vm.js';
import { isWindowsSetup, type QemuMode, type WindowsSetup } from './windows.js';

export * from './software.js';

import type { WorkCommentCommand } from './comments.js';
import type { WorkQuery, WorkStatus, WorkWrite } from './work.js';

export * from './comments.js';
export * from './work.js';
export * from './work-compat.js';

import { validAgentId } from './id.js';
import type { NoteAvailability, NoteCommand } from './notes.js';

export { validAgentId } from './id.js';
export * from './notes.js';
export * from './skill-sources.js';
export * from './skills.js';

export const managedProtocol = 45;
export type RuntimeBot = string;
export type RuntimeOwner = 'agent' | 'human' | 'handoff';
export const diagnosticIds = {
  host: ['configuration', 'vm', 'tunnel', 'service'],
  runtime: [
    'agent',
    'dsh',
    'model',
    'profiles',
    'knowledge',
    'attachments',
    'interactions',
    'schedules',
    'groups',
    'skills',
    'mcp',
    'computers',
    'graphics',
  ],
} as const;
export type DiagnosticId =
  | (typeof diagnosticIds.host)[number]
  | (typeof diagnosticIds.runtime)[number];
export type DiagnosticState =
  | 'ready'
  | 'degraded'
  | 'unavailable'
  | 'unconfigured'
  | 'unsupported'
  | 'unchecked'
  | 'timeout';
export interface DiagnosticCheck {
  id: DiagnosticId;
  state: DiagnosticState;
  affected?: number;
}
export interface DiagnosticReport {
  scope: 'host' | 'runtime';
  checkedAt: string;
  checks: DiagnosticCheck[];
}
export function isDiagnosticReport(value: unknown): value is DiagnosticReport {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['scope', 'checkedAt', 'checks'].includes(key))
  )
    return false;
  const report = value as DiagnosticReport;
  if (
    !['host', 'runtime'].includes(report.scope) ||
    typeof report.checkedAt !== 'string' ||
    report.checkedAt.length !== 24 ||
    !Number.isFinite(Date.parse(report.checkedAt)) ||
    new Date(report.checkedAt).toISOString() !== report.checkedAt ||
    !Array.isArray(report.checks)
  )
    return false;
  const ids =
    report.scope === 'host'
      ? [...diagnosticIds.host, ...diagnosticIds.runtime]
      : diagnosticIds.runtime;
  return (
    report.checks.length === ids.length &&
    Array.from(report.checks).every(
      (row, index) =>
        !!row &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        row.id === ids[index] &&
        Object.keys(row).every((key) => ['id', 'state', 'affected'].includes(key)) &&
        [
          'ready',
          'degraded',
          'unavailable',
          'unconfigured',
          'unsupported',
          'unchecked',
          'timeout',
        ].includes(row.state) &&
        (row.state === 'degraded'
          ? ['profiles', 'interactions', 'computers'].includes(row.id) &&
            Number.isSafeInteger(row.affected) &&
            Number(row.affected) > 0 &&
            Number(row.affected) <= 20000
          : row.affected === undefined),
    )
  );
}
export * from './app-connections.js';

import type { AppCommand, AppConnectionsCapability } from './app-connections.js';

export interface McpTool {
  name: string;
  alias: string;
  description: string;
  inputSchema: Record<string, unknown>;
  digest: string;
}
export const mcpCatalogToolLimit = 128;
// The absent view header preserves the closed 64-tool Bearer response understood by older clients.
export const legacyMcpCatalogToolLimit = 64;
export const mcpAppsView = { header: 'x-daban-mcp-view', value: 'apps' } as const;
export type McpView = 'bearer' | 'apps';

export interface McpConnection {
  ownerBot?: string;
  id: string;
  name: string;
  revision: number;
  origin: string;
  credentialConfigured: boolean;
  deleted: boolean;
  health: 'unchecked' | 'ready' | 'unavailable';
  toolCount: number;
  catalogDigest?: string;
  checkedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface McpSave {
  requestId: string;
  id: string;
  revision: number;
  name: string;
  endpoint?: string;
  bearer?: string | null;
}
export interface McpBindingInput {
  connection: string;
  configRevision: number;
  bindingRevision: number;
  catalogDigest?: string;
  tools: string[];
  enabled: boolean;
}
export interface McpAssignment {
  connection: McpConnection;
  revision: number;
  enabled: boolean;
  tools: string[];
  catalogDigest?: string;
  available: boolean;
}
export interface McpAssignments {
  bot: string;
  revision: number;
  items: McpAssignment[];
}
export interface McpCatalog {
  current: McpConnection;
  tools: McpTool[];
}
export interface McpSaved {
  receipt: { id: string; connection: string; revision: number };
  current: McpConnection;
}
export type McpStatus =
  | { available: true; revision: number }
  | { available: false; error: 'MCP_STORE_UNAVAILABLE' };
export interface McpReceipt {
  id: string;
  bot: string;
  run: string;
  session: string;
  connection: string;
  configRevision: number;
  tool: string;
  phase: 'claimed' | 'dispatched' | 'settled' | 'denied' | 'cancelled' | 'unknown';
  preview: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface McpHistory {
  bot: string;
  items: McpReceipt[];
}
export type McpCommand =
  | { type: 'mcp.list'; includeDeleted?: boolean; bot?: string }
  | { type: 'mcp.save'; input: McpSave; bot?: string }
  | { type: 'mcp.saved'; id: string; connection: string; bot?: string }
  | { type: 'mcp.catalog'; id: string; bot?: string }
  | {
      type: 'mcp.check' | 'mcp.archive' | 'mcp.restore';
      id: string;
      revision: number;
      bot?: string;
    }
  | { type: 'mcp.bindings'; bot: string }
  | { type: 'mcp.bind'; bot: string; input: McpBindingInput }
  | { type: 'mcp.calls'; bot: string; connection?: string }
  | { type: 'mcp.receipt'; bot: string; run: string; id: string };
const mcpRevision = (value: unknown, zero = false) =>
  Number.isSafeInteger(value) &&
  Number(value) >= (zero ? 0 : 1) &&
  Number(value) < Number.MAX_SAFE_INTEGER - 1;
const mcpHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const mcpDate = (value: unknown) =>
  typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value));
const mcpCode = (value: unknown) =>
  value === undefined || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value));
function mcpUrl(value: unknown, origin = false) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!origin || url.origin === value)
    );
  } catch {
    return false;
  }
}
function mcpJson(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return true;
  if (Array.isArray(value)) return value.every((item) => mcpJson(item, depth + 1));
  return profileObject(value) && Object.values(value).every((item) => mcpJson(item, depth + 1));
}
const mcpName = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value &&
  value.length <= 200 &&
  ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const mcpNames = (value: unknown, limit = 32): value is string[] =>
  Array.isArray(value) &&
  value.length <= limit &&
  value.every(mcpName) &&
  new Set(value).size === value.length;
export function isMcpSave(value: unknown): value is McpSave {
  return (
    profileObject(value) &&
    browserKeys(value, ['requestId', 'id', 'revision', 'name', 'endpoint', 'bearer']) &&
    validAgentId(value.requestId) &&
    validAgentId(value.id) &&
    mcpRevision(value.revision, true) &&
    typeof value.name === 'string' &&
    !!value.name.trim() &&
    value.name.length <= 60 &&
    !value.name.includes('\0') &&
    (value.endpoint === undefined || mcpUrl(value.endpoint)) &&
    (value.bearer === undefined ||
      value.bearer === null ||
      (typeof value.bearer === 'string' &&
        value.bearer.length <= 4096 &&
        (value.bearer === '' || /^[\x21-\x7e]+$/.test(value.bearer))))
  );
}
export function isMcpBindingInput(value: unknown): value is McpBindingInput {
  return (
    profileObject(value) &&
    browserKeys(value, [
      'connection',
      'configRevision',
      'bindingRevision',
      'catalogDigest',
      'tools',
      'enabled',
    ]) &&
    validAgentId(value.connection) &&
    mcpRevision(value.configRevision) &&
    mcpRevision(value.bindingRevision, true) &&
    typeof value.enabled === 'boolean' &&
    mcpNames(value.tools) &&
    (value.catalogDigest === undefined || mcpHash(value.catalogDigest)) &&
    (!value.enabled || (!!value.tools.length && mcpHash(value.catalogDigest)))
  );
}
export function isMcpConnection(value: unknown): value is McpConnection {
  return (
    profileObject(value) &&
    browserKeys(value, [
      'id',
      'name',
      'revision',
      'origin',
      'credentialConfigured',
      'deleted',
      'health',
      'toolCount',
      'catalogDigest',
      'checkedAt',
      'error',
      'createdAt',
      'updatedAt',
      'ownerBot',
    ]) &&
    validAgentId(value.id) &&
    (value.ownerBot === undefined || validAgentId(value.ownerBot)) &&
    typeof value.name === 'string' &&
    !!value.name.trim() &&
    value.name.length <= 60 &&
    mcpRevision(value.revision) &&
    mcpUrl(value.origin, true) &&
    typeof value.credentialConfigured === 'boolean' &&
    typeof value.deleted === 'boolean' &&
    ['unchecked', 'ready', 'unavailable'].includes(String(value.health)) &&
    browserNumber(value.toolCount) &&
    Number(value.toolCount) <= mcpCatalogToolLimit &&
    (value.catalogDigest === undefined || mcpHash(value.catalogDigest)) &&
    (value.health !== 'ready' || mcpHash(value.catalogDigest)) &&
    (value.checkedAt === undefined || mcpDate(value.checkedAt)) &&
    mcpCode(value.error) &&
    mcpDate(value.createdAt) &&
    mcpDate(value.updatedAt)
  );
}
export function isMcpStatus(value: unknown): value is McpStatus {
  return (
    profileObject(value) &&
    browserKeys(value, ['available', 'revision', 'error']) &&
    typeof value.available === 'boolean' &&
    (value.available
      ? mcpRevision(value.revision, true) && value.error === undefined
      : value.revision === undefined && value.error === 'MCP_STORE_UNAVAILABLE')
  );
}
export function isMcpList(value: unknown): value is { revision: number; items: McpConnection[] } {
  return (
    profileObject(value) &&
    browserKeys(value, ['revision', 'items']) &&
    mcpRevision(value.revision, true) &&
    Array.isArray(value.items) &&
    value.items.length <= 50 &&
    value.items.every(isMcpConnection) &&
    new Set(value.items.map((item) => item.id)).size === value.items.length
  );
}
export function isMcpCatalog(value: unknown): value is McpCatalog {
  if (
    !profileObject(value) ||
    !browserKeys(value, ['current', 'tools']) ||
    !isMcpConnection(value.current) ||
    !Array.isArray(value.tools) ||
    value.tools.length !== value.current.toolCount
  )
    return false;
  const names = new Set<string>(),
    aliases = new Set<string>();
  for (const tool of value.tools) {
    if (
      !profileObject(tool) ||
      !browserKeys(tool, ['name', 'alias', 'description', 'inputSchema', 'digest']) ||
      !mcpName(tool.name) ||
      typeof tool.alias !== 'string' ||
      !/^ext_[a-f0-9]{20}$/.test(tool.alias) ||
      typeof tool.description !== 'string' ||
      tool.description.length > 2000 ||
      !mcpHash(tool.digest) ||
      !profileObject(tool.inputSchema) ||
      tool.inputSchema.type !== 'object' ||
      !mcpJson(tool.inputSchema) ||
      names.has(tool.name) ||
      aliases.has(tool.alias)
    )
      return false;
    const definition = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
    if (new TextEncoder().encode(JSON.stringify(definition)).length > 32768) return false;
    names.add(tool.name);
    aliases.add(tool.alias);
  }
  return new TextEncoder().encode(JSON.stringify(value.tools)).length <= 256000;
}
export function isMcpSaved(value: unknown): value is McpSaved {
  return (
    profileObject(value) &&
    browserKeys(value, ['receipt', 'current']) &&
    isMcpConnection(value.current) &&
    profileObject(value.receipt) &&
    browserKeys(value.receipt, ['id', 'connection', 'revision']) &&
    validAgentId(value.receipt.id) &&
    value.receipt.connection === value.current.id &&
    mcpRevision(value.receipt.revision) &&
    value.current.revision >= Number(value.receipt.revision)
  );
}
export function isMcpAssignment(value: unknown): value is McpAssignment {
  return (
    profileObject(value) &&
    browserKeys(value, [
      'connection',
      'revision',
      'enabled',
      'tools',
      'catalogDigest',
      'available',
    ]) &&
    isMcpConnection(value.connection) &&
    !value.connection.deleted &&
    mcpRevision(value.revision, true) &&
    typeof value.enabled === 'boolean' &&
    typeof value.available === 'boolean' &&
    mcpNames(value.tools) &&
    (value.catalogDigest === undefined || mcpHash(value.catalogDigest)) &&
    (!value.enabled ||
      (mcpRevision(value.revision) && !!value.tools.length && mcpHash(value.catalogDigest))) &&
    (!value.available || (value.enabled && value.catalogDigest === value.connection.catalogDigest))
  );
}
export function isMcpAssignments(value: unknown): value is McpAssignments {
  return (
    profileObject(value) &&
    browserKeys(value, ['bot', 'revision', 'items']) &&
    validAgentId(value.bot) &&
    mcpRevision(value.revision, true) &&
    Array.isArray(value.items) &&
    value.items.length <= 50 &&
    value.items.every(isMcpAssignment) &&
    new Set(value.items.map((item) => item.connection.id)).size === value.items.length
  );
}
export function isMcpBindingResult(value: unknown): value is { bot: string; entry: McpAssignment } {
  return (
    profileObject(value) &&
    browserKeys(value, ['bot', 'entry']) &&
    validAgentId(value.bot) &&
    isMcpAssignment(value.entry)
  );
}
export function isMcpReceipt(value: unknown): value is McpReceipt {
  return (
    profileObject(value) &&
    browserKeys(value, [
      'id',
      'bot',
      'run',
      'session',
      'connection',
      'configRevision',
      'tool',
      'phase',
      'preview',
      'result',
      'error',
      'createdAt',
      'updatedAt',
    ]) &&
    [value.id, value.bot, value.run, value.connection].every(validAgentId) &&
    typeof value.session === 'string' &&
    value.session.length <= 200 &&
    mcpRevision(value.configRevision) &&
    typeof value.tool === 'string' &&
    !!value.tool &&
    value.tool.length <= 200 &&
    ['claimed', 'dispatched', 'settled', 'denied', 'cancelled', 'unknown'].includes(
      String(value.phase),
    ) &&
    typeof value.preview === 'string' &&
    new TextEncoder().encode(value.preview).length <= 64000 &&
    (value.result === undefined ||
      (typeof value.result === 'string' &&
        new TextEncoder().encode(value.result).length <= 1024 * 1024)) &&
    mcpCode(value.error) &&
    mcpDate(value.createdAt) &&
    mcpDate(value.updatedAt)
  );
}
export function isMcpHistory(value: unknown): value is McpHistory {
  return (
    profileObject(value) &&
    browserKeys(value, ['bot', 'items']) &&
    validAgentId(value.bot) &&
    Array.isArray(value.items) &&
    value.items.length <= 20 &&
    value.items.every(
      (item) => isMcpReceipt(item) && item.bot === value.bot && item.result === undefined,
    ) &&
    new Set(value.items.map((item) => item.id)).size === value.items.length
  );
}
export function isMcpCommand(value: unknown): value is McpCommand {
  if (!profileObject(value) || (value.bot !== undefined && !validAgentId(value.bot))) return false;
  switch (value.type) {
    case 'mcp.list':
      return (
        browserKeys(value, ['type', 'includeDeleted', 'bot']) &&
        (value.includeDeleted === undefined || typeof value.includeDeleted === 'boolean')
      );
    case 'mcp.save':
      return browserKeys(value, ['type', 'input', 'bot']) && isMcpSave(value.input);
    case 'mcp.saved':
      return (
        browserKeys(value, ['type', 'id', 'connection', 'bot']) &&
        validAgentId(value.id) &&
        validAgentId(value.connection)
      );
    case 'mcp.catalog':
      return browserKeys(value, ['type', 'id', 'bot']) && validAgentId(value.id);
    case 'mcp.check':
    case 'mcp.archive':
    case 'mcp.restore':
      return (
        browserKeys(value, ['type', 'id', 'revision', 'bot']) &&
        validAgentId(value.id) &&
        mcpRevision(value.revision)
      );
    case 'mcp.bindings':
      return browserKeys(value, ['type', 'bot']) && validAgentId(value.bot);
    case 'mcp.bind':
      return (
        browserKeys(value, ['type', 'bot', 'input']) &&
        validAgentId(value.bot) &&
        isMcpBindingInput(value.input)
      );
    case 'mcp.calls':
      return (
        browserKeys(value, ['type', 'bot', 'connection']) &&
        validAgentId(value.bot) &&
        (value.connection === undefined || validAgentId(value.connection))
      );
    case 'mcp.receipt':
      return (
        browserKeys(value, ['type', 'bot', 'run', 'id']) &&
        [value.bot, value.run, value.id].every(validAgentId)
      );
    default:
      return false;
  }
}
export interface SkillInvocation {
  modelInvocable: boolean;
  userInvocable: boolean;
}
export interface SkillSummary {
  ownerBot?: string;
  id: string;
  name: string;
  description: string;
  revision: number;
  size: number;
  deleted: boolean;
  invocation: SkillInvocation;
  createdAt: string;
  updatedAt: string;
  package?: SkillPackageInfo;
  system?: true;
}
export interface SkillDocument extends SkillSummary {
  content: string;
  files?: SkillResource[];
}
export interface SkillEntry extends SkillSummary {
  enabled: boolean;
  bindingRevision: number;
}
export interface SkillCatalog {
  revision: number;
  items: SkillEntry[];
}
export interface SkillCatalogResult {
  bot: string;
  catalog: SkillCatalog;
}
export interface SkillBindingResult {
  bot: string;
  entry: SkillEntry;
}
export function isSkillCatalogResult(value: unknown): value is SkillCatalogResult {
  return (
    profileObject(value) &&
    browserKeys(value, ['bot', 'catalog']) &&
    validAgentId(value.bot) &&
    isSkillCatalog(value.catalog)
  );
}
export function isSkillBindingResult(value: unknown): value is SkillBindingResult {
  return (
    profileObject(value) &&
    browserKeys(value, ['bot', 'entry']) &&
    validAgentId(value.bot) &&
    isSkillEntry(value.entry)
  );
}
export interface SkillStatus {
  available: boolean;
  revision?: number;
  error?: string;
}
export function isSkillStatus(value: unknown): value is SkillStatus {
  return (
    profileObject(value) &&
    browserKeys(value, ['available', 'revision', 'error']) &&
    typeof value.available === 'boolean' &&
    (value.available
      ? browserNumber(value.revision) && value.error === undefined
      : value.revision === undefined && value.error === 'SKILLS_UNAVAILABLE')
  );
}
export function isSkillContent(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 100000 &&
    value.length > 0 &&
    !value.includes('\0') &&
    new TextEncoder().encode(value).length <= 200000
  );
}
export interface SkillBinding {
  id: string;
  revision: number;
  bindingRevision: number;
  enabled: boolean;
}
export function isSkillName(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}
function skillFields(value: Record<string, unknown>, extra: string[]) {
  return (
    browserKeys(value, [
      'id',
      'name',
      'description',
      'revision',
      'size',
      'deleted',
      'invocation',
      'createdAt',
      'updatedAt',
      'package',
      'system',
      'ownerBot',
      ...extra,
    ]) &&
    validAgentId(value.id) &&
    isSkillName(value.name) &&
    (value.package === undefined || isSkillPackageInfo(value.package)) &&
    (value.system === undefined || value.system === true) &&
    (value.ownerBot === undefined || validAgentId(value.ownerBot)) &&
    typeof value.description === 'string' &&
    value.description.trim().length > 0 &&
    value.description.length <= 2000 &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) > 0 &&
    Number(value.size) <= 200000 &&
    typeof value.deleted === 'boolean' &&
    profileObject(value.invocation) &&
    browserKeys(value.invocation, ['modelInvocable', 'userInvocable']) &&
    typeof value.invocation.modelInvocable === 'boolean' &&
    typeof value.invocation.userInvocable === 'boolean' &&
    [value.createdAt, value.updatedAt].every(
      (date) => typeof date === 'string' && date.length <= 40 && Number.isFinite(Date.parse(date)),
    )
  );
}
export function isSkillDocument(value: unknown): value is SkillDocument {
  return (
    profileObject(value) &&
    skillFields(value, ['content', 'files']) &&
    typeof value.content === 'string' &&
    value.content.length <= 100000 &&
    !value.content.includes('\0') &&
    new TextEncoder().encode(value.content).length === value.size &&
    (value.files === undefined
      ? value.package === undefined
      : Array.isArray(value.files) &&
        value.files.length <= 199 &&
        Array.from(value.files).every(isSkillResource) &&
        isSkillPackageInfo(value.package) &&
        value.package.fileCount === value.files.length + 1 &&
        value.package.bytes ===
          Number(value.size) + value.files.reduce((sum, file) => sum + file.size, 0))
  );
}
export function isSkillEntry(value: unknown): value is SkillEntry {
  return (
    profileObject(value) &&
    skillFields(value, ['enabled', 'bindingRevision']) &&
    typeof value.enabled === 'boolean' &&
    !(value.enabled && value.deleted) &&
    Number.isSafeInteger(value.bindingRevision) &&
    Number(value.bindingRevision) >= 0
  );
}
export function isSkillCatalog(value: unknown): value is SkillCatalog {
  return (
    profileObject(value) &&
    browserKeys(value, ['revision', 'items']) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    Array.isArray(value.items) &&
    value.items.length <= 100 &&
    value.items.every(isSkillEntry) &&
    new Set(value.items.map((item) => item.id)).size === value.items.length &&
    new Set(value.items.map((item) => item.name)).size === value.items.length
  );
}
export function isSkillBinding(value: unknown): value is SkillBinding {
  return (
    profileObject(value) &&
    browserKeys(value, ['id', 'revision', 'bindingRevision', 'enabled']) &&
    validAgentId(value.id) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    Number.isSafeInteger(value.bindingRevision) &&
    Number(value.bindingRevision) >= 0 &&
    typeof value.enabled === 'boolean'
  );
}
export type ComputerPhase =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'stopping'
  | 'suspended'
  | 'failed'
  | 'interrupted';
export interface ComputerState {
  bot: string;
  revision: number;
  phase: ComputerPhase;
  desired: boolean;
  reserved: boolean;
  instance?: string;
  error?: string;
  recovery?: 'stop' | 'restart';
  updatedAt?: string;
}
export interface ComputerStatus {
  available: boolean;
  limit: number;
  revision: number;
  items: ComputerState[];
  error?: string;
}
export interface ComputerRequest {
  id: string;
  bot: string;
  action: 'connect' | 'stop';
  revision: number;
  instance?: string;
  confirmation?: 'close-apps';
}
export interface ComputerReceipt {
  id: string;
  bot: string;
  phase: 'unknown' | 'claimed' | 'settled' | 'interrupted';
  error?: string;
  uncertain?: boolean;
}
export interface ComputerAck {
  receipt: ComputerReceipt;
  state: ComputerState;
}
export function isComputerRequest(value: unknown): value is ComputerRequest {
  if (
    !profileObject(value) ||
    !browserKeys(value, ['id', 'bot', 'action', 'revision', 'instance', 'confirmation']) ||
    !validAgentId(value.id) ||
    !validAgentId(value.bot) ||
    !browserNumber(value.revision) ||
    !['connect', 'stop'].includes(String(value.action)) ||
    (value.instance !== undefined && !validAgentId(value.instance)) ||
    (value.confirmation !== undefined && value.confirmation !== 'close-apps')
  )
    return false;
  return (
    value.action !== 'connect' || (value.instance === undefined && value.confirmation === undefined)
  );
}
export function isComputerState(value: unknown): value is ComputerState {
  if (
    !profileObject(value) ||
    !browserKeys(value, [
      'bot',
      'revision',
      'phase',
      'desired',
      'reserved',
      'instance',
      'error',
      'recovery',
      'updatedAt',
    ]) ||
    !validAgentId(value.bot) ||
    !browserNumber(value.revision) ||
    ![
      'disconnected',
      'connecting',
      'connected',
      'stopping',
      'suspended',
      'failed',
      'interrupted',
    ].includes(String(value.phase)) ||
    typeof value.desired !== 'boolean' ||
    typeof value.reserved !== 'boolean' ||
    (value.instance !== undefined && !validAgentId(value.instance)) ||
    !browserCode(value.error) ||
    (value.recovery !== undefined && !['stop', 'restart'].includes(String(value.recovery))) ||
    (value.updatedAt !== undefined &&
      (typeof value.updatedAt !== 'string' ||
        value.updatedAt.length > 40 ||
        !Number.isFinite(Date.parse(value.updatedAt))))
  )
    return false;
  if (!value.reserved && (value.instance !== undefined || value.recovery !== undefined))
    return false;
  if (value.phase === 'connected')
    return value.reserved && value.desired && validAgentId(value.instance);
  if (value.phase === 'disconnected') return !value.reserved && !value.desired;
  if (value.phase === 'suspended') return !value.reserved && value.desired;
  if (value.phase === 'connecting') return value.reserved && value.desired;
  if (value.phase === 'stopping') return value.reserved && !value.desired;
  return true;
}
export function isComputerStatus(value: unknown): value is ComputerStatus {
  return (
    profileObject(value) &&
    browserKeys(value, ['available', 'limit', 'revision', 'items', 'error']) &&
    typeof value.available === 'boolean' &&
    Number.isSafeInteger(value.limit) &&
    Number(value.limit) >= 1 &&
    Number(value.limit) <= 16 &&
    browserNumber(value.revision) &&
    browserCode(value.error) &&
    Array.isArray(value.items) &&
    value.items.length <= 2000 &&
    value.items.every(isComputerState) &&
    new Set(value.items.map((item) => item.bot)).size === value.items.length
  );
}
export function isComputerReceipt(value: unknown): value is ComputerReceipt {
  return (
    profileObject(value) &&
    browserKeys(value, ['id', 'bot', 'phase', 'error', 'uncertain']) &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    ['unknown', 'claimed', 'settled', 'interrupted'].includes(String(value.phase)) &&
    browserCode(value.error) &&
    (value.uncertain === undefined || typeof value.uncertain === 'boolean') &&
    (value.phase !== 'unknown' || (value.error === undefined && value.uncertain === undefined))
  );
}
export function isComputerAck(value: unknown): value is ComputerAck {
  return (
    profileObject(value) &&
    browserKeys(value, ['receipt', 'state']) &&
    isComputerReceipt(value.receipt) &&
    isComputerState(value.state) &&
    value.receipt.bot === value.state.bot
  );
}
export interface RecoveryScreen {
  computer: ComputerState;
  lease?: { owner: RuntimeOwner; epoch: number };
}
export interface RecoveryReview {
  boot: string;
  instance: string;
  revision: number;
  computersRevision: number;
  digest: string;
  screens: RecoveryScreen[];
  running: string[];
  changing: boolean;
}
export interface RecoveryRequest {
  id: string;
  revision: number;
  review: string;
  confirmation: 'restart-all-apps';
}
export interface RecoveryReceipt {
  id: string;
  revision: number;
  phase: 'prepared' | 'claimed' | 'cancelled' | 'complete';
  review: RecoveryReview;
  boot?: string;
  instance?: string;
}
export type RecoveryStatus =
  | { available: true; revision: number; operation?: RecoveryReceipt }
  | { available: false; error: 'RECOVERY_STORE_UNAVAILABLE' };
export type RebootStage =
  | 'preparing'
  | 'prepared'
  | 'stop-issued'
  | 'stopped'
  | 'start-issued'
  | 'complete'
  | 'cancelled'
  | 'rejected';
export interface RebootOperation {
  id: string;
  stage: RebootStage;
  review: RecoveryReview;
  backend?: RecoveryReceipt;
  error?: string;
}
export type RebootStatus =
  | { available: false; error: 'RECOVERY_HOST_STORE_UNAVAILABLE' | 'RECOVERY_TARGET_CHANGED' }
  | {
      available: true;
      revision: number;
      busy: boolean;
      vm: 'running' | 'stopped' | 'unknown';
      checkedAt?: string;
      operation?: RebootOperation;
    };
export function isRebootOperation(value: unknown): value is RebootOperation {
  if (
    !profileObject(value) ||
    !browserKeys(value, ['id', 'stage', 'review', 'backend', 'error']) ||
    !validAgentId(value.id) ||
    !isRecoveryReview(value.review) ||
    !browserCode(value.error)
  )
    return false;
  if (['preparing', 'rejected'].includes(String(value.stage)))
    return (
      value.backend === undefined && (value.stage !== 'rejected' || typeof value.error === 'string')
    );
  if (
    !isRecoveryReceipt(value.backend) ||
    value.backend.id !== value.id ||
    value.backend.review.digest !== value.review.digest ||
    value.backend.review.revision !== value.review.revision
  )
    return false;
  if (value.stage === 'prepared') return ['prepared', 'claimed'].includes(value.backend.phase);
  if (['stop-issued', 'stopped', 'start-issued'].includes(String(value.stage)))
    return value.backend.phase === 'claimed';
  if (value.stage === 'complete')
    return value.backend.phase === 'complete' && value.error === undefined;
  return (
    value.stage === 'cancelled' && value.backend.phase === 'cancelled' && value.error === undefined
  );
}
export function isRebootStatus(value: unknown): value is RebootStatus {
  return (
    profileObject(value) &&
    (value.available === false
      ? browserKeys(value, ['available', 'error']) &&
        ['RECOVERY_HOST_STORE_UNAVAILABLE', 'RECOVERY_TARGET_CHANGED'].includes(String(value.error))
      : value.available === true &&
        browserKeys(value, ['available', 'revision', 'busy', 'vm', 'checkedAt', 'operation']) &&
        browserNumber(value.revision) &&
        typeof value.busy === 'boolean' &&
        ['running', 'stopped', 'unknown'].includes(String(value.vm)) &&
        (value.checkedAt === undefined ||
          (typeof value.checkedAt === 'string' &&
            value.checkedAt.length === 24 &&
            Number.isFinite(Date.parse(value.checkedAt)) &&
            new Date(value.checkedAt).toISOString() === value.checkedAt)) &&
        (value.operation === undefined ? value.revision === 0 : isRebootOperation(value.operation)))
  );
}
export function isRecoveryStatus(value: unknown): value is RecoveryStatus {
  return (
    profileObject(value) &&
    (value.available === true
      ? browserKeys(value, ['available', 'revision', 'operation']) &&
        browserNumber(value.revision) &&
        (value.operation === undefined ||
          (isRecoveryReceipt(value.operation) && value.operation.revision === value.revision))
      : value.available === false &&
        browserKeys(value, ['available', 'error']) &&
        value.error === 'RECOVERY_STORE_UNAVAILABLE')
  );
}
export function isRecoveryReview(value: unknown): value is RecoveryReview {
  if (
    !profileObject(value) ||
    !browserKeys(value, [
      'boot',
      'instance',
      'revision',
      'computersRevision',
      'digest',
      'screens',
      'running',
      'changing',
    ]) ||
    !validAgentId(value.boot) ||
    !validAgentId(value.instance) ||
    !browserNumber(value.revision) ||
    Number(value.revision) > Number.MAX_SAFE_INTEGER - 4 ||
    !browserNumber(value.computersRevision) ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    typeof value.changing !== 'boolean' ||
    !Array.isArray(value.running) ||
    value.running.length > 2000 ||
    !Array.from(value.running).every(validAgentId) ||
    new Set(value.running).size !== value.running.length ||
    !Array.isArray(value.screens) ||
    value.screens.length > 16
  )
    return false;
  const screens = value.screens;
  return (
    Array.from(screens).every(
      (row) =>
        profileObject(row) &&
        browserKeys(row, ['computer', 'lease']) &&
        isComputerState(row.computer) &&
        row.computer.reserved &&
        (row.lease === undefined ||
          (profileObject(row.lease) &&
            browserKeys(row.lease, ['owner', 'epoch']) &&
            ['agent', 'human', 'handoff'].includes(String(row.lease.owner)) &&
            browserNumber(row.lease.epoch))),
    ) && new Set(screens.map((row) => row.computer.bot)).size === screens.length
  );
}
export function isRecoveryRequest(value: unknown): value is RecoveryRequest {
  return (
    profileObject(value) &&
    browserKeys(value, ['id', 'revision', 'review', 'confirmation']) &&
    validAgentId(value.id) &&
    browserNumber(value.revision) &&
    Number(value.revision) <= Number.MAX_SAFE_INTEGER - 4 &&
    typeof value.review === 'string' &&
    /^[a-f0-9]{64}$/.test(value.review) &&
    value.confirmation === 'restart-all-apps'
  );
}
export function isRecoveryReceipt(value: unknown): value is RecoveryReceipt {
  if (
    !profileObject(value) ||
    !browserKeys(value, ['id', 'revision', 'phase', 'review', 'boot', 'instance']) ||
    !validAgentId(value.id) ||
    !isRecoveryReview(value.review) ||
    !browserNumber(value.revision)
  )
    return false;
  const step =
    value.phase === 'prepared'
      ? 1
      : value.phase === 'claimed' || value.phase === 'cancelled'
        ? 2
        : value.phase === 'complete'
          ? 3
          : 0;
  if (!step || value.revision !== value.review.revision + step) return false;
  return value.phase === 'complete'
    ? validAgentId(value.boot) &&
        value.boot !== value.review.boot &&
        validAgentId(value.instance) &&
        value.instance !== value.review.instance
    : value.boot === undefined && value.instance === undefined;
}
export type TaskPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'paused'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';
export interface TaskTrace {
  name: string;
  surface: string;
  phase: string;
  at: string;
  code?: string;
}
export const transcriptPageLimit = 20;
export const transcriptChunkLimit = 32000;
export const transcriptEventLimit = 8 * 1024 * 1024;
export type TranscriptScope = { bot: string; runId: string } & (
  | { chatRevision: number; conversationId?: never }
  | { conversationId: string; chatRevision?: never }
);
export type TranscriptState = 'recording' | 'complete' | 'interrupted' | 'unavailable';
export interface TranscriptItem {
  seq: number;
  kind: 'call' | 'result' | 'assistant' | 'thinking' | 'plan' | 'interaction';
  at: string;
  name?: string;
  callId?: string;
  thinkingId?: string;
  isError?: boolean;
  code?: string;
  characters: number;
}
export interface TranscriptQuery {
  scope: TranscriptScope;
  after?: number;
}
export interface TranscriptContentQuery {
  scope: TranscriptScope;
  seq: number;
  offset?: number;
}
export interface SessionStats {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
}
export function isSessionStats(value: unknown): value is SessionStats {
  const fields = [
    'turns',
    'steps',
    'llmMs',
    'toolMs',
    'ttftMs',
    'ttftSteps',
    'decodeMs',
    'decodeTokens',
  ];
  return (
    profileObject(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((key) => {
      const number = value[key];
      return (
        typeof number === 'number' &&
        Number.isFinite(number) &&
        number >= 0 &&
        number <= Number.MAX_SAFE_INTEGER &&
        (!['turns', 'steps', 'ttftSteps'].includes(key) || Number.isSafeInteger(number))
      );
    })
  );
}
export type RunStatistics = TranscriptScope & { stats?: SessionStats };
export function isRunStatistics(value: unknown): value is RunStatistics {
  return (
    transcriptScope(value, ['stats']) && (value.stats === undefined || isSessionStats(value.stats))
  );
}
export type TranscriptPage = TranscriptScope & {
  state: TranscriptState;
  items: TranscriptItem[];
  nextAfter?: number;
};
export type TranscriptContent = TranscriptScope & {
  seq: number;
  offset: number;
  total: number;
  text: string;
  nextOffset?: number;
};
function transcriptScope(
  value: unknown,
  fields: string[] = [],
): value is TranscriptScope & Record<string, unknown> {
  return (
    profileObject(value) &&
    exactKeys(value, ['bot', 'runId', 'chatRevision', 'conversationId', ...fields]) &&
    validAgentId(value.bot) &&
    validAgentId(value.runId) &&
    (value.conversationId === undefined
      ? browserNumber(value.chatRevision)
      : validAgentId(value.conversationId) && value.chatRevision === undefined)
  );
}
export function isTranscriptScope(value: unknown): value is TranscriptScope {
  return transcriptScope(value);
}
export function sameTranscriptScope(left: TranscriptScope, right: TranscriptScope) {
  return (
    left.bot === right.bot &&
    left.runId === right.runId &&
    left.chatRevision === right.chatRevision &&
    left.conversationId === right.conversationId
  );
}
export function isTranscriptQuery(value: unknown): value is TranscriptQuery {
  return (
    profileObject(value) &&
    exactKeys(value, ['scope', 'after']) &&
    isTranscriptScope(value.scope) &&
    (value.after === undefined || browserNumber(value.after))
  );
}
export function isTranscriptContentQuery(value: unknown): value is TranscriptContentQuery {
  return (
    profileObject(value) &&
    exactKeys(value, ['scope', 'seq', 'offset']) &&
    isTranscriptScope(value.scope) &&
    browserNumber(value.seq) &&
    value.seq > 0 &&
    (value.offset === undefined || browserNumber(value.offset))
  );
}
export function isTranscriptItem(value: unknown): value is TranscriptItem {
  return (
    profileObject(value) &&
    exactKeys(value, [
      'seq',
      'kind',
      'at',
      'name',
      'callId',
      'thinkingId',
      'isError',
      'code',
      'characters',
    ]) &&
    browserNumber(value.seq) &&
    value.seq > 0 &&
    typeof value.kind === 'string' &&
    ['call', 'result', 'assistant', 'thinking', 'plan', 'interaction'].includes(value.kind) &&
    mcpDate(value.at) &&
    browserNumber(value.characters) &&
    value.characters <= transcriptEventLimit &&
    (value.name === undefined || boundedText(value.name, 300)) &&
    (value.callId === undefined || boundedText(value.callId, 300)) &&
    (value.thinkingId === undefined ||
      (value.kind === 'thinking' && boundedText(value.thinkingId, 200))) &&
    (value.isError === undefined || typeof value.isError === 'boolean') &&
    (value.code === undefined ||
      (value.isError === true &&
        typeof value.code === 'string' &&
        /^[A-Z][A-Z0-9_]{0,80}$/.test(value.code)))
  );
}
export function isTranscriptPage(value: unknown): value is TranscriptPage {
  if (
    !transcriptScope(value, ['state', 'items', 'nextAfter']) ||
    typeof value.state !== 'string' ||
    !['recording', 'complete', 'interrupted', 'unavailable'].includes(value.state) ||
    !Array.isArray(value.items) ||
    value.items.length > transcriptPageLimit ||
    !value.items.every(isTranscriptItem)
  )
    return false;
  const items = value.items;
  return (
    items.every((item, index) => index === 0 || item.seq > items[index - 1].seq) &&
    (value.state !== 'unavailable' || (!items.length && value.nextAfter === undefined)) &&
    (value.nextAfter === undefined || (!!items.length && value.nextAfter === items.at(-1)!.seq))
  );
}
export function isTranscriptContent(value: unknown): value is TranscriptContent {
  if (
    !transcriptScope(value, ['seq', 'offset', 'total', 'text', 'nextOffset']) ||
    !browserNumber(value.seq) ||
    value.seq <= 0 ||
    !browserNumber(value.offset) ||
    !browserNumber(value.total) ||
    value.total > transcriptEventLimit ||
    typeof value.text !== 'string' ||
    value.text.length > transcriptChunkLimit ||
    value.offset + value.text.length > value.total
  )
    return false;
  const end = value.offset + value.text.length;
  return end === value.total
    ? value.nextOffset === undefined
    : value.text.length > 0 && value.nextOffset === end;
}
// One task is at most this many human turns, counting the original request plus every accepted insert.
export const turnLimit = 20;
export interface RunTurn {
  id: string;
  prompt: string;
  result: string;
  error?: string;
}
export interface RunInsert {
  id: string;
  text: string;
  done: boolean;
  // True once the turn began executing; an accepted insert that never started may be retried safely.
  started?: boolean;
}
export function isRunInsert(value: unknown): value is RunInsert {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['id', 'text', 'done', 'started'].includes(key)) &&
    validAgentId(value.id) &&
    typeof value.text === 'string' &&
    value.text.length <= 12000 &&
    typeof value.done === 'boolean' &&
    (value.started === undefined || typeof value.started === 'boolean')
  );
}
export function isRunTurn(value: unknown): value is RunTurn {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['id', 'prompt', 'result', 'error'].includes(key)) &&
    validAgentId(value.id) &&
    typeof value.prompt === 'string' &&
    value.prompt.length <= 12000 &&
    typeof value.result === 'string' &&
    value.result.length <= replyLimit &&
    (value.error === undefined ||
      (typeof value.error === 'string' && value.error.length <= replyLimit))
  );
}
export interface RuntimeTask {
  goal?: GoalProgress;
  planning?: boolean;
  elapsedMs?: number;
  chatRevision?: number;
  conversationId?: string;
  model?: ModelId;
  response?: ReplyStream;
  plan?: TaskPlan;
  running: boolean;
  phase: TaskPhase;
  runId?: string;
  requestId?: string;
  sessionId?: string;
  prompt: string;
  result: string;
  error: string;
  files: RuntimeFile[];
  toolCount: number;
  executedCount: number;
  outputDirectory?: string;
  trace: TaskTrace[];
  history: RuntimeTaskSummary[];
  turns?: RunTurn[];
  // Accepted inserts that have no turn yet; an unstarted one can be queued again without replaying work.
  inserts?: RunInsert[];
}
export interface RuntimeTaskSummary {
  elapsedMs?: number;
  chatRevision?: number;
  conversationId?: string;
  response?: ReplyStream;
  runId: string;
  requestId: string;
  prompt: string;
  phase: TaskPhase;
  result: string;
  error: string;
  files?: RuntimeFile[];
  turns?: RunTurn[];
}
export type RuntimeNotice =
  | {
      kind: 'task';
      id: string;
      bot: string;
      chatRevision: number;
      phase: 'completed' | 'failed' | 'interrupted';
    }
  | { kind: 'group'; id: string; group: string; phase: 'completed' | 'failed' | 'interrupted' };
export interface RuntimeNoticeStatus {
  available: boolean;
  items: RuntimeNotice[];
  error?: string;
}
export function isRuntimeNotice(value: unknown): value is RuntimeNotice {
  if (
    !profileObject(value) ||
    !validAgentId(value.id) ||
    typeof value.phase !== 'string' ||
    !['completed', 'failed', 'interrupted'].includes(value.phase)
  )
    return false;
  if (value.kind === 'task')
    return (
      Object.keys(value).every((key) =>
        ['kind', 'id', 'bot', 'chatRevision', 'phase'].includes(key),
      ) &&
      validAgentId(value.bot) &&
      Number.isSafeInteger(value.chatRevision) &&
      Number(value.chatRevision) >= 0
    );
  return (
    value.kind === 'group' &&
    Object.keys(value).every((key) => ['kind', 'id', 'group', 'phase'].includes(key)) &&
    validAgentId(value.group)
  );
}
export function isRuntimeNoticeStatus(value: unknown): value is RuntimeNoticeStatus {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['available', 'items', 'error'].includes(key)) &&
    typeof value.available === 'boolean' &&
    Array.isArray(value.items) &&
    value.items.length <= 2000 &&
    value.items.every(isRuntimeNotice) &&
    browserCode(value.error)
  );
}
export interface EnvironmentImage {
  id: string;
  file: 'system.raw.gz';
  url: string;
  bytes: number;
  sha256: string;
  rawBytes: number;
  rawSha256: string;
}
export const environmentImage: Readonly<EnvironmentImage> = Object.freeze({
  id: 'daban-38-0b2c13631d754382',
  file: 'system.raw.gz',
  url: 'https://github.com/murongg/daban/releases/download/environment-v38/system.raw.gz',
  bytes: 1243539382,
  sha256: '0b2c13631d75438214b32ebe5f016b625e27c993d602019b83eee47e044ebde9',
  rawBytes: 17179869184,
  rawSha256: 'e74a74239cb93d057b17d9a7c72f4dfd2fcab051a1be052766ed350f6bb62df7',
});

export const setupPhases = [
  'existing',
  'available',
  'downloading',
  'verifying',
  'extracting',
  'creating',
  'starting',
  'connecting',
  'waiting',
  'cancelling',
  'cancelled',
  'complete',
  'failed',
  'unavailable',
] as const;
export type SetupPhase = (typeof setupPhases)[number];
export interface SetupStatus {
  required: boolean;
  phase: SetupPhase;
  target?: 'agent' | 'linux';
  progress?: number;
  downloaded?: number;
  total?: number;
  error?: string;
  windows?: WindowsSetup;
}
export function isSetupStatus(value: unknown): value is SetupStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).every((key) =>
      [
        'required',
        'phase',
        'target',
        'progress',
        'downloaded',
        'total',
        'error',
        'windows',
      ].includes(key),
    ) &&
    typeof item.required === 'boolean' &&
    setupPhases.includes(item.phase as SetupPhase) &&
    (item.target === undefined || item.target === 'agent' || item.target === 'linux') &&
    (item.windows === undefined || (item.target === 'linux' && isWindowsSetup(item.windows))) &&
    (item.progress === undefined ||
      (typeof item.progress === 'number' &&
        Number.isFinite(item.progress) &&
        item.progress >= 0 &&
        item.progress <= 100)) &&
    ((item.downloaded === undefined && item.total === undefined) ||
      (typeof item.downloaded === 'number' &&
        Number.isSafeInteger(item.downloaded) &&
        item.downloaded >= 0 &&
        typeof item.total === 'number' &&
        Number.isSafeInteger(item.total) &&
        item.total > 0 &&
        item.total <= 4 * 1024 ** 3 &&
        item.downloaded <= item.total)) &&
    (item.error === undefined ||
      (typeof item.error === 'string' && /^[A-Z_]{1,100}$/.test(item.error)))
  );
}
export interface RuntimeSnapshot {
  appConnections?: AppConnectionsCapability;
  botCapabilities?: true;
  localComputer?: LocalComputerStatus;
  agent?: {
    location: 'host';
    execution: 'linux-vm' | 'local-workspace';
    privilege: 'sudo' | 'workspace';
    approvals: 'host';
  };
  notes?: NoteAvailability;
  work?: WorkStatus;
  notices?: RuntimeNoticeStatus;
  chats?: ChatStatus;
  setup?: SetupStatus;
  reboot?: RebootStatus;
  recovery?: RecoveryStatus;
  mcp?: McpStatus;
  skills?: SkillStatus;
  computers?: ComputerStatus;
  computerError?: 'COMPUTER_START_FAILED';
  browsers?: Partial<Record<RuntimeBot, BrowserState>>;
  groups?: { available: boolean; revision: number; items: Group[]; error?: string };
  knowledge?: { available: boolean; revision?: number; error?: string; documentParsing?: boolean };
  schedules?: { available: boolean; items: Schedule[]; error?: string };
  interactions?: Interaction[];
  software?: SoftwareState;
  phase: 'connecting' | 'ready' | 'offline' | 'unsupported';
  error?: string;
  protocolVersion: number;
  model: {
    configured: boolean;
    available: boolean;
    provider: string;
    model: string;
    revision?: number;
    connections?: ModelConnection[];
    inspection?: boolean;
  };
  bots: Partial<
    Record<RuntimeBot, { instance?: string; owner: RuntimeOwner; epoch: number; task: RuntimeTask }>
  >;
  agents: Record<string, RuntimeTask>;
  profiles: BotProfile[];
  sharedLogin: boolean;
  viewport: { width: number; height: number };
}
export function recoveryBlocked(snapshot: Pick<RuntimeSnapshot, 'reboot' | 'recovery'>) {
  return (
    (!!snapshot.reboot &&
      (!snapshot.reboot.available ||
        snapshot.reboot.busy ||
        (!!snapshot.reboot.operation &&
          !['complete', 'cancelled', 'rejected'].includes(snapshot.reboot.operation.stage)))) ||
    (!!snapshot.recovery &&
      (!snapshot.recovery.available ||
        (!!snapshot.recovery.operation &&
          ['prepared', 'claimed'].includes(snapshot.recovery.operation.phase))))
  );
}
export function recoveryReader(command: RuntimeCommand) {
  if (command.type === 'input') return command.input.type === 'release';
  return [
    'app.catalog',
    'app.oauth.status',
    'frame',
    'files.list',
    'files.read',
    'files.download',
    'computer.receipt',
    'browser.state',
    'browser.view',
    'browser.frame',
    'browser.receipt',
    'bot.receipt',
    'bot.copy.receipt',
    'group.copy.receipt',
    'work.list',
    'work.read',
    'work.receipt',
    'work.comments',
    'work.comment-receipt',
    'notes.status',
    'notes.list',
    'notes.read',
    'notes.receipt',
    'chat.receipt',
    'chat.history',
    'transcript.statistics',
    'transcript.list',
    'transcript.content',
    'memory.history',
    'bot.export',
    'bot.import.status',
    'bot.import.cancel',
    'skill.list',
    'skill.read',
    'skill.resource',
    'skill.package.export',
    'knowledge.list',
    'knowledge.read',
    'knowledge.versions',
    'knowledge.source',
    'attachment.list',
    'attachment.read',
    'attachment.source',
    'group.read',
    'group.input',
    'group.receipt',
    'schedule.get',
    'schedule.preview',
    'mcp.list',
    'mcp.saved',
    'mcp.catalog',
    'mcp.bindings',
    'mcp.calls',
    'mcp.receipt',
  ].includes(command.type);
}
export type BotColor = 'mint' | 'violet' | 'orange' | 'blue' | 'teal' | 'pink';
export interface GroupInput {
  id: string;
  name: string;
  members: string[];
}
export interface GroupCopyRequest {
  id: string;
  group: string;
  revision: number;
  name: string;
}
export function groupCopyKey(request: GroupCopyRequest) {
  // Persisted origins hash this tuple; keep its order stable across reader and writer versions.
  return JSON.stringify([
    'daban.group-copy.v1',
    request.id,
    request.group,
    request.revision,
    request.name,
  ]);
}
export interface GroupCopyAck {
  request: GroupCopyRequest;
  state: 'complete';
  group: Group;
}
export type GroupCopyReceipt = GroupCopyAck | { request: GroupCopyRequest; state: 'unknown' };
export interface Group extends GroupInput {
  archived?: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ChatState {
  bot: string;
  revision: number;
  updatedAt?: string;
}
export interface ChatRequest {
  id: string;
  bot: string;
  revision: number;
}
export interface ChatReceipt {
  request: ChatRequest;
  revision: number;
  completedAt: string;
}
export interface ChatAck {
  chat: ChatState;
  receipt: ChatReceipt;
}
export interface ChatStatus {
  available: boolean;
  revision: number;
  items: ChatState[];
  error?: string;
}
export interface ChatPage {
  bot: string;
  revision: number;
  items: RuntimeTaskSummary[];
  nextBefore?: string;
}
export interface GroupActionRequest {
  id: string;
  group: string;
  action: 'archive' | 'restore';
  revision: number;
}
export interface GroupActionReceipt {
  request: GroupActionRequest;
  revision: number;
  completedAt: string;
}
export interface GroupActionAck {
  group: Group;
  receipt: GroupActionReceipt;
}
export interface GroupSend {
  revision?: number;
  id: string;
  group: string;
  prompt: string;
  recipients: string[];
  files?: TaskFile[];
}
export interface GroupMessage {
  runId?: string;
  inputNames?: string[];
  id: string;
  group: string;
  sequence: number;
  sourceId: string;
  role: 'user' | 'bot' | 'notice';
  text: string;
  createdAt: string;
  author?: string;
  name?: string;
  phase?: TaskPhase;
  model?: ModelId;
  files?: RuntimeFile[];
}
export type GroupDeliveryState =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';
export interface GroupDelivery {
  requestId: string;
  id: string;
  group: string;
  sourceId: string;
  bot: string;
  position: number;
  state: GroupDeliveryState;
  runId?: string;
  error?: string;
}
export interface GroupPage {
  group: Group;
  revision: number;
  messages: GroupMessage[];
  deliveries: GroupDelivery[];
  nextBefore?: number;
  accepted?: GroupMessage;
  cancelledSource?: string;
}
export function isGroupMessage(value: unknown): value is GroupMessage {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) =>
      [
        'id',
        'group',
        'sequence',
        'sourceId',
        'role',
        'text',
        'createdAt',
        'author',
        'name',
        'phase',
        'model',
        'files',
        'runId',
        'inputNames',
      ].includes(key),
    ) &&
    validAgentId(value.id) &&
    validAgentId(value.group) &&
    validAgentId(value.sourceId) &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) > 0 &&
    ['user', 'bot', 'notice'].includes(String(value.role)) &&
    typeof value.text === 'string' &&
    value.text.length <= replyLimit &&
    !value.text.includes('\0') &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    (value.author === undefined || validAgentId(value.author)) &&
    (value.runId === undefined || validAgentId(value.runId)) &&
    (value.inputNames === undefined ||
      (Array.isArray(value.inputNames) &&
        value.inputNames.length <= 4 &&
        value.inputNames.every(isTaskFileName))) &&
    (value.name === undefined ||
      (typeof value.name === 'string' && value.name.length <= 80 && !value.name.includes('\0'))) &&
    (value.phase === undefined ||
      ['completed', 'failed', 'stopped', 'interrupted'].includes(String(value.phase))) &&
    (value.model === undefined || isModelId(value.model)) &&
    (value.files === undefined ||
      (Array.isArray(value.files) &&
        value.files.length <= 20 &&
        value.files.every(isRuntimeFileMetadata)))
  );
}
export function isGroupDelivery(value: unknown): value is GroupDelivery {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) =>
      [
        'id',
        'group',
        'sourceId',
        'bot',
        'position',
        'state',
        'runId',
        'error',
        'requestId',
      ].includes(key),
    ) &&
    validAgentId(value.id) &&
    validAgentId(value.requestId) &&
    validAgentId(value.group) &&
    validAgentId(value.sourceId) &&
    validAgentId(value.bot) &&
    Number.isSafeInteger(value.position) &&
    Number(value.position) >= 0 &&
    Number(value.position) < 8 &&
    ['pending', 'claimed', 'running', 'completed', 'failed', 'interrupted', 'cancelled'].includes(
      String(value.state),
    ) &&
    (value.runId === undefined || validAgentId(value.runId)) &&
    (value.error === undefined || (typeof value.error === 'string' && value.error.length <= 12000))
  );
}
export function isGroupPage(value: unknown): value is GroupPage {
  if (
    !profileObject(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'group',
          'revision',
          'messages',
          'deliveries',
          'nextBefore',
          'accepted',
          'cancelledSource',
        ].includes(key),
    ) ||
    !isGroup(value.group) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !Array.isArray(value.messages) ||
    value.messages.length > 40 ||
    !Array.isArray(value.deliveries) ||
    value.deliveries.length > 160
  )
    return false;
  const group = value.group.id;
  return (
    value.messages.every(
      (message, index, all) =>
        isGroupMessage(message) &&
        message.group === group &&
        (!index || message.sequence > all[index - 1].sequence),
    ) &&
    value.deliveries.every((delivery) => isGroupDelivery(delivery) && delivery.group === group) &&
    (value.nextBefore === undefined ||
      (Number.isSafeInteger(value.nextBefore) &&
        Number(value.nextBefore) > 0 &&
        value.messages.length > 0 &&
        value.nextBefore === value.messages[0].sequence)) &&
    (value.accepted === undefined ||
      (isGroupMessage(value.accepted) &&
        value.accepted.group === group &&
        value.accepted.role === 'user' &&
        value.accepted.id === value.accepted.sourceId)) &&
    (value.cancelledSource === undefined || validAgentId(value.cancelledSource))
  );
}

export function isGroupInput(value: unknown): value is GroupInput {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['id', 'name', 'members'].includes(key)) &&
    validAgentId(value.id) &&
    typeof value.name === 'string' &&
    !!value.name.trim() &&
    value.name.length <= 30 &&
    !value.name.includes('\0') &&
    Array.isArray(value.members) &&
    value.members.length >= 2 &&
    value.members.length <= 8 &&
    value.members.every(validAgentId) &&
    new Set(value.members).size === value.members.length
  );
}
export function isGroupCopyRequest(value: unknown): value is GroupCopyRequest {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['id', 'group', 'revision', 'name'].includes(key)) &&
    validAgentId(value.id) &&
    agentId(value.id) === value.id &&
    validAgentId(value.group) &&
    value.id !== value.group &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.name === 'string' &&
    !!value.name.trim() &&
    value.name.length <= 30 &&
    !value.name.includes('\0')
  );
}
export function isGroupCopyReceipt(value: unknown): value is GroupCopyReceipt {
  if (!profileObject(value) || !isGroupCopyRequest(value.request)) return false;
  if (value.state === 'unknown')
    return Object.keys(value).every((key) => ['request', 'state'].includes(key));
  return (
    value.state === 'complete' &&
    Object.keys(value).every((key) => ['request', 'state', 'group'].includes(key)) &&
    isGroup(value.group) &&
    value.group.id === value.request.id
  );
}
export function isGroup(value: unknown): value is Group {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) =>
      ['id', 'name', 'members', 'revision', 'createdAt', 'updatedAt', 'archived'].includes(key),
    ) &&
    isGroupInput({ id: value.id, name: value.name, members: value.members }) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    (value.archived === undefined || typeof value.archived === 'boolean')
  );
}
export function isGroupActionRequest(value: unknown): value is GroupActionRequest {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['id', 'group', 'action', 'revision'].includes(key)) &&
    validAgentId(value.id) &&
    validAgentId(value.group) &&
    typeof value.action === 'string' &&
    ['archive', 'restore'].includes(value.action) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1 &&
    Number(value.revision) < Number.MAX_SAFE_INTEGER
  );
}
export function isChatRequest(value: unknown): value is ChatRequest {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['id', 'bot', 'revision'].includes(key)) &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    Number(value.revision) < Number.MAX_SAFE_INTEGER
  );
}
export function isChatState(value: unknown): value is ChatState {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['bot', 'revision', 'updatedAt'].includes(key)) &&
    validAgentId(value.bot) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    (value.updatedAt === undefined
      ? value.revision === 0
      : typeof value.updatedAt === 'string' &&
        value.updatedAt.length <= 100 &&
        Number.isFinite(Date.parse(value.updatedAt)))
  );
}
export function isChatAck(value: unknown): value is ChatAck {
  if (
    !profileObject(value) ||
    Object.keys(value).some((key) => !['chat', 'receipt'].includes(key)) ||
    !isChatState(value.chat) ||
    !profileObject(value.receipt)
  )
    return false;
  const receipt = value.receipt;
  return (
    Object.keys(receipt).every((key) => ['request', 'revision', 'completedAt'].includes(key)) &&
    isChatRequest(receipt.request) &&
    receipt.request.bot === value.chat.bot &&
    receipt.revision === receipt.request.revision + 1 &&
    value.chat.revision >= Number(receipt.revision) &&
    typeof receipt.completedAt === 'string' &&
    receipt.completedAt.length <= 100 &&
    Number.isFinite(Date.parse(receipt.completedAt))
  );
}
export function isChatStatus(value: unknown): value is ChatStatus {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['available', 'revision', 'items', 'error'].includes(key)) &&
    typeof value.available === 'boolean' &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    Array.isArray(value.items) &&
    value.items.length <= 10000 &&
    value.items.every(isChatState) &&
    new Set(value.items.map((item) => item.bot)).size === value.items.length &&
    browserCode(value.error)
  );
}
export function isChatPage(value: unknown): value is ChatPage {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['bot', 'revision', 'items', 'nextBefore'].includes(key)) &&
    validAgentId(value.bot) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    (value.nextBefore === undefined || validAgentId(value.nextBefore)) &&
    Array.isArray(value.items) &&
    value.items.length <= 20 &&
    value.items.every(
      (item) =>
        profileObject(item) &&
        Object.keys(item).every((key) =>
          [
            'chatRevision',
            'runId',
            'requestId',
            'prompt',
            'phase',
            'result',
            'error',
            'files',
            'response',
            'turns',
            'elapsedMs',
          ].includes(key),
        ) &&
        item.chatRevision === value.revision &&
        validAgentId(item.runId) &&
        validAgentId(item.requestId) &&
        typeof item.phase === 'string' &&
        ['completed', 'failed', 'stopped', 'interrupted'].includes(item.phase) &&
        typeof item.prompt === 'string' &&
        item.prompt.length <= 12000 &&
        typeof item.result === 'string' &&
        item.result.length <= replyLimit &&
        typeof item.error === 'string' &&
        item.error.length <= replyLimit &&
        (item.files === undefined ||
          (Array.isArray(item.files) &&
            item.files.length <= 200 &&
            item.files.every(isRuntimeFileMetadata))) &&
        (item.response === undefined || isReplyStream(item.response)) &&
        (item.elapsedMs === undefined || browserNumber(item.elapsedMs)) &&
        (item.turns === undefined ||
          (Array.isArray(item.turns) &&
            item.turns.length <= turnLimit &&
            item.turns.every(isRunTurn))),
    )
  );
}
export function isGroupActionReceipt(value: unknown): value is GroupActionReceipt {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['request', 'revision', 'completedAt'].includes(key)) &&
    isGroupActionRequest(value.request) &&
    value.revision === value.request.revision + 1 &&
    typeof value.completedAt === 'string' &&
    value.completedAt.length <= 100 &&
    Number.isFinite(Date.parse(value.completedAt))
  );
}
export function isGroupActionAck(value: unknown): value is GroupActionAck {
  if (
    !profileObject(value) ||
    Object.keys(value).some((key) => !['group', 'receipt'].includes(key)) ||
    !isGroup(value.group) ||
    !isGroupActionReceipt(value.receipt) ||
    value.group.id !== value.receipt.request.group ||
    value.group.revision < value.receipt.revision
  )
    return false;
  return (
    value.group.revision !== value.receipt.revision ||
    !!value.group.archived === (value.receipt.request.action === 'archive')
  );
}
export function isGroupSend(value: unknown): value is GroupSend {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) =>
      ['id', 'group', 'prompt', 'recipients', 'files', 'revision'].includes(key),
    ) &&
    validAgentId(value.id) &&
    validAgentId(value.group) &&
    (value.revision === undefined ||
      (Number.isSafeInteger(value.revision) && Number(value.revision) >= 1)) &&
    typeof value.prompt === 'string' &&
    !!value.prompt.trim() &&
    value.prompt.length <= 12000 &&
    !value.prompt.includes('\0') &&
    Array.isArray(value.recipients) &&
    value.recipients.length >= 1 &&
    value.recipients.length <= 8 &&
    value.recipients.every(validAgentId) &&
    new Set(value.recipients).size === value.recipients.length &&
    (value.files === undefined ||
      (Array.isArray(value.files) &&
        value.files.length <= 4 &&
        value.files.every(isTaskFile) &&
        new Set(value.files.map((file) => file.name)).size === value.files.length))
  );
}
export interface BotProfileInput {
  id: string;
  name: string;
  instructions: string;
  memory: string;
  color: BotColor;
  model?: ModelId;
}
export interface BotProfile extends BotProfileInput {
  revision: number;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  lifecycle?: BotLifecycleState;
}
export interface BotLifecycleState {
  id: string;
  action: 'archive' | 'restore';
  phase: 'pending' | 'complete';
  baseRevision: number;
}
export interface BotLifecycleRequest {
  id: string;
  bot: string;
  action: 'archive' | 'restore';
  revision: number;
}
export interface BotLifecycleAck {
  receipt: BotLifecycleState & { bot: string; error?: 'BOT_ARCHIVE_INCOMPLETE' };
  profile: BotProfile;
}
export type BotProfilePatch = Partial<Omit<BotProfileInput, 'id' | 'model'>> & {
  model?: ModelId | null;
};
export interface BotCopyRequest {
  id: string;
  bot: string;
  revision: number;
  name: string;
  memory: boolean;
}
export function botCopyKey(request: BotCopyRequest) {
  // Persisted copy origins hash this tuple; changing its order would invalidate existing receipts.
  return JSON.stringify([
    'daban.profile-copy.v1',
    request.id,
    request.bot,
    request.revision,
    request.name,
    request.memory,
  ]);
}
export interface BotCopyAck {
  request: BotCopyRequest;
  state: 'complete';
  profile: BotProfile;
}
export type BotCopyReceipt = BotCopyAck | { request: BotCopyRequest; state: 'unknown' };
export interface MemoryVersion {
  revision: number;
  content: string;
  source: 'initial' | 'baseline' | 'edit' | 'agent';
  createdAt: string;
}
export interface MemoryQuery {
  before?: number;
}
export interface MemoryPage {
  bot: string;
  profileRevision: number;
  currentRevision: number;
  items: MemoryVersion[];
  limited: boolean;
  nextBefore?: number;
}
export function isMemoryQuery(value: unknown): value is MemoryQuery {
  return (
    profileObject(value) &&
    exactKeys(value, ['before']) &&
    (value.before === undefined ||
      (typeof value.before === 'number' && Number.isSafeInteger(value.before) && value.before > 0))
  );
}
export function isMemoryVersion(value: unknown): value is MemoryVersion {
  return (
    profileObject(value) &&
    exactKeys(value, ['revision', 'content', 'source', 'createdAt']) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    typeof value.content === 'string' &&
    isBotProfilePatch({ memory: value.content }) &&
    typeof value.source === 'string' &&
    ['initial', 'baseline', 'edit', 'agent'].includes(value.source) &&
    typeof value.createdAt === 'string' &&
    value.createdAt.length <= 40 &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}
export function isMemoryPage(value: unknown): value is MemoryPage {
  if (
    !profileObject(value) ||
    !exactKeys(value, [
      'bot',
      'profileRevision',
      'currentRevision',
      'items',
      'limited',
      'nextBefore',
    ]) ||
    !validAgentId(value.bot) ||
    typeof value.profileRevision !== 'number' ||
    !Number.isSafeInteger(value.profileRevision) ||
    value.profileRevision < 1 ||
    typeof value.currentRevision !== 'number' ||
    !Number.isSafeInteger(value.currentRevision) ||
    value.currentRevision < 1 ||
    value.currentRevision > value.profileRevision ||
    typeof value.limited !== 'boolean' ||
    !Array.isArray(value.items) ||
    value.items.length > 5 ||
    !Array.from(value.items).every(isMemoryVersion)
  )
    return false;
  const items = value.items;
  if (
    !items.every(
      (item, index) =>
        item.revision <= Number(value.currentRevision) &&
        (!index || item.revision < items[index - 1].revision),
    )
  )
    return false;
  return (
    value.nextBefore === undefined ||
    (items.length === 5 &&
      typeof value.nextBefore === 'number' &&
      value.nextBefore > 1 &&
      value.nextBefore === items.at(-1)?.revision)
  );
}
const profileObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const modelOptions = [
  { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
] as const;
export type ModelId = string;
export type DeepSeekModel = (typeof modelOptions)[number]['id'];
export type ModelApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';
export const isModelApi = (value: unknown): value is ModelApi =>
  typeof value === 'string' &&
  ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(
    value,
  );
export const modelApi = (connection: { api?: ModelApi }): ModelApi =>
  connection.api ?? 'openai-completions';
export const modelModalities = ['text', 'image', 'audio', 'video', 'pdf'] as const;
export interface ModelCapabilities {
  input?: (typeof modelModalities)[number][];
  output?: (typeof modelModalities)[number][];
  reasoning?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
}
export function isModelCapabilities(value: unknown): value is ModelCapabilities {
  if (!profileObject(value) || !Object.keys(value).length) return false;
  return Object.entries(value).every(([key, entry]) =>
    key === 'input' || key === 'output'
      ? Array.isArray(entry) &&
        entry.length > 0 &&
        entry.length <= modelModalities.length &&
        entry.every((mode) => modelModalities.some((allowed) => allowed === mode)) &&
        new Set(entry).size === entry.length
      : ['reasoning', 'toolCall', 'structuredOutput', 'temperature'].includes(key) &&
        typeof entry === 'boolean',
  );
}
export interface ModelDefinition {
  id: string;
  name: string;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  capabilities?: ModelCapabilities;
}
export interface ModelConnection {
  id: string;
  name: string;
  baseURL: string;
  api?: ModelApi;
  models: ModelDefinition[];
}
export interface ModelOption {
  id: ModelId;
  name: string;
  provider: string;
  vision: boolean;
}
const upstreamModelId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,159}$/.test(value);
export const isModelId = (value: unknown): value is ModelId =>
  typeof value === 'string' &&
  (modelOptions.some((option) => option.id === value) ||
    /^provider:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}:[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,159}$/.test(value));
// Legacy official-only callers must not accept a foreign route and reuse its key as a DeepSeek key.
export const isDeepSeekModel = (value: unknown): value is DeepSeekModel =>
  modelOptions.some((option) => option.id === value);
export function modelReference(connection: string, model: string): ModelId {
  return connection === 'deepseek-official' && modelOptions.some((option) => option.id === model)
    ? model
    : `provider:${connection}:${model}`;
}
export function modelCatalog(connections?: ModelConnection[]): ModelOption[] {
  if (connections === undefined)
    return modelOptions.map((option) => ({
      ...option,
      provider: 'deepseek-official',
      vision: option.id === 'deepseek-flash',
    }));
  return connections.flatMap((connection) =>
    connection.models.map((model) => ({
      id: modelReference(connection.id, model.id),
      name: model.name,
      provider: connection.id,
      vision: model.vision,
    })),
  );
}
export const modelHasVision = (model: ModelId, catalog?: ModelOption[]) =>
  catalog === undefined
    ? model === 'deepseek-flash'
    : catalog.some((item) => item.id === model && item.vision);
const modelText = (value: string) =>
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
export function isModelBaseURL(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || !modelText(value) || /[\s?#]/.test(value))
    return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export function isModelDefinition(value: unknown): value is ModelDefinition {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) =>
      ['id', 'name', 'vision', 'contextWindow', 'maxTokens', 'capabilities'].includes(key),
    ) &&
    upstreamModelId(value.id) &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    value.name.length <= 120 &&
    modelText(value.name) &&
    typeof value.vision === 'boolean' &&
    (value.capabilities === undefined || isModelCapabilities(value.capabilities)) &&
    Number.isSafeInteger(value.contextWindow) &&
    Number(value.contextWindow) >= 4096 &&
    Number(value.contextWindow) <= 4000000 &&
    Number.isSafeInteger(value.maxTokens) &&
    Number(value.maxTokens) >= 128 &&
    Number(value.maxTokens) <= 262144 &&
    Number(value.maxTokens) <= Number(value.contextWindow)
  );
}
export function isModelConnection(value: unknown): value is ModelConnection {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['id', 'name', 'baseURL', 'api', 'models'].includes(key)) &&
    validAgentId(value.id) &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    value.name.length <= 80 &&
    modelText(value.name) &&
    isModelBaseURL(value.baseURL) &&
    (value.api === undefined || isModelApi(value.api)) &&
    // Legacy key-only writes address this reserved route, so its destination must remain fixed.
    (value.id !== 'deepseek-official' ||
      (value.baseURL === 'https://api.deepseek.com/v1' &&
        (value.api === undefined || value.api === 'openai-completions'))) &&
    Array.isArray(value.models) &&
    value.models.length >= 1 &&
    value.models.length <= 50 &&
    value.models.every(isModelDefinition) &&
    (value.api !== 'google-generative-ai' ||
      value.models.every((model) =>
        /^(?:models\/)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(model.id),
      )) &&
    new Set(value.models.map((model) => model.id)).size === value.models.length
  );
}
export const isModelConnections = (value: unknown): value is ModelConnection[] =>
  Array.isArray(value) &&
  value.length <= 20 &&
  value.every(isModelConnection) &&
  new Set(value.map((connection) => connection.id)).size === value.length;
export interface ModelStatus {
  provider: string;
  model: ModelId;
  configured: boolean;
  revision: number;
  requestId?: string;
  connections?: ModelConnection[];
}
export type ModelEndpoint = Pick<ModelConnection, 'id' | 'baseURL' | 'api'>;
export interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  source?: 'provider' | 'models.dev';
  capabilities?: ModelCapabilities;
}
export type ModelInspectionRequest = {
  connection: ModelEndpoint;
  apiKey?: string;
  revision: number;
} & ({ kind: 'list'; model?: never } | { kind: 'limits' | 'metadata' | 'test'; model: string });
export type ModelInspection = { revision: number } & (
  | { kind: 'list'; models: DiscoveredModel[] }
  | { kind: 'limits' | 'metadata'; model: DiscoveredModel }
  | { kind: 'test'; model: string; latencyMs: number; checkedAt: string }
);
export function isModelInspectionRequest(value: unknown): value is ModelInspectionRequest {
  if (
    !profileObject(value) ||
    !browserKeys(value, ['kind', 'connection', 'apiKey', 'revision', 'model']) ||
    !modelRevision(value.revision) ||
    (value.apiKey !== undefined && !isModelKey(value.apiKey)) ||
    !profileObject(value.connection) ||
    !browserKeys(value.connection, ['id', 'baseURL', 'api'])
  )
    return false;
  const connection = value.connection;
  if (
    !validAgentId(connection.id) ||
    !isModelBaseURL(connection.baseURL) ||
    (connection.api !== undefined && !isModelApi(connection.api)) ||
    (connection.id === 'deepseek-official' &&
      (connection.baseURL !== 'https://api.deepseek.com/v1' ||
        (connection.api !== undefined && connection.api !== 'openai-completions')))
  )
    return false;
  if (value.kind === 'list') return value.model === undefined;
  return (
    ['limits', 'metadata', 'test'].includes(String(value.kind)) &&
    upstreamModelId(value.model) &&
    (connection.api !== 'google-generative-ai' ||
      /^(?:models\/)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value.model))
  );
}
export function isDiscoveredModel(value: unknown): value is DiscoveredModel {
  return (
    profileObject(value) &&
    browserKeys(value, ['id', 'name', 'contextWindow', 'maxTokens', 'source', 'capabilities']) &&
    upstreamModelId(value.id) &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    value.name.length <= 120 &&
    modelText(value.name) &&
    (value.capabilities === undefined || isModelCapabilities(value.capabilities)) &&
    (value.contextWindow === undefined ||
      (Number.isSafeInteger(value.contextWindow) &&
        Number(value.contextWindow) >= 4096 &&
        Number(value.contextWindow) <= 4000000)) &&
    (value.maxTokens === undefined ||
      (Number.isSafeInteger(value.maxTokens) &&
        Number(value.maxTokens) >= 128 &&
        Number(value.maxTokens) <= 262144 &&
        (value.contextWindow === undefined ||
          Number(value.maxTokens) <= Number(value.contextWindow)))) &&
    (value.source === undefined ||
      (['provider', 'models.dev'].includes(String(value.source)) &&
        (value.contextWindow !== undefined ||
          value.maxTokens !== undefined ||
          value.capabilities !== undefined)))
  );
}
export function isModelInspection(value: unknown): value is ModelInspection {
  if (!profileObject(value) || !modelRevision(value.revision)) return false;
  if (value.kind === 'list')
    return (
      browserKeys(value, ['kind', 'revision', 'models']) &&
      Array.isArray(value.models) &&
      value.models.length <= 5000 &&
      value.models.every(isDiscoveredModel) &&
      new Set(value.models.map((model) => model.id)).size === value.models.length
    );
  if (value.kind === 'limits' || value.kind === 'metadata')
    return browserKeys(value, ['kind', 'revision', 'model']) && isDiscoveredModel(value.model);
  return (
    value.kind === 'test' &&
    browserKeys(value, ['kind', 'revision', 'model', 'latencyMs', 'checkedAt']) &&
    upstreamModelId(value.model) &&
    Number.isSafeInteger(value.latencyMs) &&
    Number(value.latencyMs) >= 0 &&
    Number(value.latencyMs) <= 120000 &&
    typeof value.checkedAt === 'string' &&
    value.checkedAt.length === 24 &&
    Number.isFinite(Date.parse(value.checkedAt))
  );
}
export interface ModelUpdate {
  model: ModelId;
  apiKey?: string;
  revision: number;
  requestId: string;
  connection?: ModelConnection;
}
export interface ModelCheck {
  model: ModelId;
  revision: number;
  checkedAt: string;
}
export const isModelKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[!-~]{10,512}$/.test(value);
const modelRevision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
export function isModelUpdate(value: unknown): value is ModelUpdate {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) =>
      ['model', 'apiKey', 'revision', 'requestId', 'connection'].includes(key),
    ) &&
    isModelId(value.model) &&
    (value.apiKey === undefined || isModelKey(value.apiKey)) &&
    (value.connection === undefined || isModelConnection(value.connection)) &&
    modelRevision(value.revision) &&
    validAgentId(value.requestId)
  );
}
export function isModelStatus(value: unknown): value is ModelStatus {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) =>
      ['provider', 'model', 'configured', 'revision', 'requestId', 'connections'].includes(key),
    ) &&
    validAgentId(value.provider) &&
    isModelId(value.model) &&
    typeof value.configured === 'boolean' &&
    (value.connections === undefined || isModelConnections(value.connections)) &&
    modelRevision(value.revision) &&
    (value.requestId === undefined || validAgentId(value.requestId))
  );
}
export function isModelCheck(value: unknown): value is ModelCheck {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['model', 'revision', 'checkedAt'].includes(key)) &&
    isModelId(value.model) &&
    modelRevision(value.revision) &&
    typeof value.checkedAt === 'string' &&
    Number.isFinite(Date.parse(value.checkedAt))
  );
}
function profileFields(value: Record<string, unknown>) {
  return (
    validAgentId(value.id) &&
    typeof value.name === 'string' &&
    !!value.name.trim() &&
    value.name.length <= 30 &&
    !value.name.includes('\0') &&
    typeof value.instructions === 'string' &&
    value.instructions.length <= 4000 &&
    !value.instructions.includes('\0') &&
    typeof value.memory === 'string' &&
    value.memory.length <= 12000 &&
    !value.memory.includes('\0') &&
    typeof value.color === 'string' &&
    ['mint', 'violet', 'orange', 'blue', 'teal', 'pink'].includes(value.color) &&
    (value.model === undefined || isModelId(value.model))
  );
}
export function isBotProfileInput(value: unknown): value is BotProfileInput {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) =>
      ['id', 'name', 'instructions', 'memory', 'color', 'model'].includes(key),
    ) &&
    profileFields(value)
  );
}
export function isBotProfile(value: unknown): value is BotProfile {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) =>
      [
        'id',
        'name',
        'instructions',
        'memory',
        'color',
        'model',
        'revision',
        'createdAt',
        'updatedAt',
        'archived',
        'lifecycle',
      ].includes(key),
    ) &&
    profileFields(value) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    (value.archived === undefined || typeof value.archived === 'boolean') &&
    profileLifecycle(value)
  );
}
export function isBotCopyRequest(value: unknown): value is BotCopyRequest {
  return (
    profileObject(value) &&
    Object.keys(value).every((key) => ['id', 'bot', 'revision', 'name', 'memory'].includes(key)) &&
    validAgentId(value.id) &&
    // Legacy display aliases would collapse a new profile into an existing client identity.
    agentId(value.id) === value.id &&
    validAgentId(value.bot) &&
    value.id !== value.bot &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1 &&
    boundedText(value.name, 30) &&
    typeof value.memory === 'boolean'
  );
}
export function isBotCopyReceipt(value: unknown): value is BotCopyReceipt {
  if (
    !profileObject(value) ||
    !Object.keys(value).every((key) => ['request', 'state', 'profile'].includes(key)) ||
    !isBotCopyRequest(value.request)
  )
    return false;
  return value.state === 'unknown'
    ? !Object.hasOwn(value, 'profile')
    : value.state === 'complete' &&
        isBotProfile(value.profile) &&
        value.profile.id === value.request.id;
}
function profileLifecycle(value: Record<string, unknown>) {
  const lifecycle = value.lifecycle;
  if (lifecycle === undefined) return value.archived !== true;
  if (
    !profileObject(lifecycle) ||
    !browserKeys(lifecycle, ['id', 'action', 'phase', 'baseRevision']) ||
    !validAgentId(lifecycle.id) ||
    !Number.isSafeInteger(lifecycle.baseRevision) ||
    Number(lifecycle.baseRevision) < 1 ||
    Number(lifecycle.baseRevision) > Number.MAX_SAFE_INTEGER - 2
  )
    return false;
  const revision = Number(value.revision);
  const base = Number(lifecycle.baseRevision);
  if (lifecycle.action === 'restore')
    return lifecycle.phase === 'complete' && value.archived === false && revision >= base + 1;
  return (
    lifecycle.action === 'archive' &&
    value.archived === true &&
    (lifecycle.phase === 'pending'
      ? revision === base + 1
      : lifecycle.phase === 'complete' && revision >= base + 2)
  );
}
export function isBotLifecycleRequest(value: unknown): value is BotLifecycleRequest {
  return (
    profileObject(value) &&
    browserKeys(value, ['id', 'bot', 'action', 'revision']) &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    (value.action === 'archive' || value.action === 'restore') &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1 &&
    Number(value.revision) <= Number.MAX_SAFE_INTEGER - 2
  );
}
export function isBotLifecycleAck(value: unknown): value is BotLifecycleAck {
  if (
    !profileObject(value) ||
    !browserKeys(value, ['receipt', 'profile']) ||
    !isBotProfile(value.profile) ||
    !value.profile.lifecycle ||
    !profileObject(value.receipt) ||
    !browserKeys(value.receipt, ['id', 'bot', 'action', 'phase', 'baseRevision', 'error']) ||
    value.receipt.bot !== value.profile.id
  )
    return false;
  const receipt = value.receipt;
  const lifecycle = value.profile.lifecycle;
  return (
    receipt.id === lifecycle.id &&
    receipt.action === lifecycle.action &&
    receipt.phase === lifecycle.phase &&
    receipt.baseRevision === lifecycle.baseRevision &&
    (receipt.error === undefined ||
      (receipt.phase === 'pending' && receipt.error === 'BOT_ARCHIVE_INCOMPLETE'))
  );
}
export function isBotProfilePatch(value: unknown): value is BotProfilePatch {
  return (
    profileObject(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).every((key) =>
      ['name', 'instructions', 'memory', 'color', 'model'].includes(key),
    ) &&
    isBotProfileInput({
      id: 'validation',
      name: 'validation',
      instructions: '',
      memory: '',
      color: 'violet',
      ...value,
      model: value.model === null ? undefined : value.model,
    })
  );
}
export type TaskPlan = { content: string; status: 'pending' | 'in_progress' | 'completed' }[];
export const replyLimit = 65536;
export interface ReplyStream {
  revision: number;
  text: string;
  state: 'streaming' | 'settled';
  // The turn that produced this prefix; older turns' text must not render as the current turn's reply.
  turnId?: string;
  thinking?: { id: string; text: string };
}
export function isReplyStream(value: unknown): value is ReplyStream {
  return (
    profileObject(value) &&
    exactKeys(value, ['revision', 'text', 'state', 'turnId', 'thinking']) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    boundedText(value.text, replyLimit, true) &&
    ['streaming', 'settled'].includes(String(value.state)) &&
    (value.turnId === undefined || validAgentId(value.turnId)) &&
    (value.thinking === undefined ||
      (profileObject(value.thinking) &&
        exactKeys(value.thinking, ['id', 'text']) &&
        boundedText(value.thinking.id, 200) &&
        boundedText(value.thinking.text, replyLimit, true)))
  );
}
export interface UserQuestion {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}
export type UserReply =
  | { kind: 'answer'; answers: { id: string; selected: string[]; custom?: string }[] }
  | { kind: 'decision'; allow: boolean };
export type InteractionInput = { id: string; sessionId: string } & (
  | { kind: 'question'; questions: UserQuestion[] }
  | { kind: 'approval'; tool: 'web_fetch'; url: string }
  | { kind: 'approval'; tool: 'software_install'; plan: SoftwarePlan; purpose: string }
  | {
      kind: 'approval';
      tool: 'vm_command';
      command: string;
      cwd: string;
      purpose: string;
      target: 'linux-vm';
    }
  | {
      kind: 'approval';
      tool: 'mcp_call';
      connection: string;
      configRevision: number;
      catalogDigest: string;
      name: string;
      origin: string;
      operation: string;
      arguments: string;
      inputHash: string;
    }
);
export type Interaction = InteractionInput & {
  decisionSource?: 'policy';
  conversationId?: string;
  bot: string;
  runId: string;
  status: 'pending' | 'resolved' | 'cancelled' | 'interrupted';
  reply?: UserReply;
  createdAt: string;
  updatedAt: string;
};
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const boundedText = (value: unknown, max: number, empty = false): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  !value.includes('\0') &&
  (empty || !!value.trim());
export function isTaskPlan(value: unknown): value is TaskPlan {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (item) =>
        profileObject(item) &&
        exactKeys(item, ['content', 'status']) &&
        boundedText(item.content, 500) &&
        ['pending', 'in_progress', 'completed'].includes(String(item.status)),
    )
  );
}
function isQuestion(value: unknown): value is UserQuestion {
  if (
    !profileObject(value) ||
    !exactKeys(value, ['id', 'question', 'header', 'detail', 'options', 'multiSelect']) ||
    !boundedText(value.id, 80) ||
    !boundedText(value.question, 2000) ||
    (value.header !== undefined && !boundedText(value.header, 100)) ||
    (value.detail !== undefined && !boundedText(value.detail, 4000)) ||
    (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean')
  )
    return false;
  if (value.options === undefined) return true;
  return (
    Array.isArray(value.options) &&
    value.options.length <= 8 &&
    value.options.every(
      (option) =>
        profileObject(option) &&
        exactKeys(option, ['label', 'description']) &&
        boundedText(option.label, 100) &&
        (option.description === undefined || boundedText(option.description, 500)),
    ) &&
    new Set(value.options.map((option) => option.label)).size === value.options.length
  );
}
export function publicUrl(value: unknown): value is string {
  if (!boundedText(value, 2048)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
export function isInteractionInput(value: unknown): value is InteractionInput {
  if (!profileObject(value) || !validAgentId(value.id) || !boundedText(value.sessionId, 200))
    return false;
  if (value.kind === 'approval' && value.tool === 'web_fetch')
    return (
      exactKeys(value, ['id', 'sessionId', 'kind', 'tool', 'url']) &&
      value.tool === 'web_fetch' &&
      publicUrl(value.url)
    );
  if (value.kind === 'approval' && value.tool === 'software_install')
    return (
      exactKeys(value, ['id', 'sessionId', 'kind', 'tool', 'plan', 'purpose']) &&
      isSoftwarePlan(value.plan) &&
      boundedText(value.purpose, 500)
    );
  if (value.kind === 'approval' && value.tool === 'vm_command')
    return (
      exactKeys(value, [
        'id',
        'sessionId',
        'kind',
        'tool',
        'command',
        'cwd',
        'purpose',
        'target',
      ]) &&
      boundedText(value.command, 12000) &&
      boundedText(value.cwd, 4096) &&
      value.cwd.startsWith('/') &&
      !value.cwd.includes('\\') &&
      !value.cwd.split('/').includes('..') &&
      boundedText(value.purpose, 500) &&
      value.target === 'linux-vm'
    );
  if (value.kind === 'approval' && value.tool === 'mcp_call') {
    if (!publicUrl(value.origin)) return false;
    const origin = new URL(value.origin);
    return (
      exactKeys(value, [
        'id',
        'sessionId',
        'kind',
        'tool',
        'connection',
        'configRevision',
        'catalogDigest',
        'name',
        'origin',
        'operation',
        'arguments',
        'inputHash',
      ]) &&
      validAgentId(value.connection) &&
      Number.isSafeInteger(value.configRevision) &&
      Number(value.configRevision) > 0 &&
      typeof value.catalogDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(value.catalogDigest) &&
      boundedText(value.name, 60) &&
      origin.protocol === 'https:' &&
      origin.origin === value.origin &&
      boundedText(value.operation, 200) &&
      boundedText(value.arguments, 48000) &&
      new TextEncoder().encode(value.arguments).length <= 48000 &&
      typeof value.inputHash === 'string' &&
      /^[a-f0-9]{64}$/.test(value.inputHash)
    );
  }
  return (
    value.kind === 'question' &&
    exactKeys(value, ['id', 'sessionId', 'kind', 'questions']) &&
    Array.isArray(value.questions) &&
    value.questions.length > 0 &&
    value.questions.length <= 4 &&
    value.questions.every(isQuestion) &&
    new Set(value.questions.map((question) => question.id)).size === value.questions.length
  );
}
export function isUserReply(value: unknown): value is UserReply {
  if (!profileObject(value)) return false;
  if (value.kind === 'decision')
    return exactKeys(value, ['kind', 'allow']) && typeof value.allow === 'boolean';
  return (
    value.kind === 'answer' &&
    exactKeys(value, ['kind', 'answers']) &&
    Array.isArray(value.answers) &&
    value.answers.length > 0 &&
    value.answers.length <= 4 &&
    value.answers.every(
      (answer) =>
        profileObject(answer) &&
        exactKeys(answer, ['id', 'selected', 'custom']) &&
        boundedText(answer.id, 80) &&
        Array.isArray(answer.selected) &&
        answer.selected.length <= 8 &&
        answer.selected.every((label) => boundedText(label, 100)) &&
        new Set(answer.selected).size === answer.selected.length &&
        (answer.custom === undefined || boundedText(answer.custom, 4000, true)) &&
        (answer.selected.length > 0 ||
          (typeof answer.custom === 'string' && !!answer.custom.trim())),
    ) &&
    new Set(value.answers.map((answer) => answer.id)).size === value.answers.length
  );
}
export function matchesReply(input: InteractionInput, reply: unknown): reply is UserReply {
  if (!isUserReply(reply)) return false;
  if (input.kind === 'approval') return reply.kind === 'decision';
  return (
    reply.kind === 'answer' &&
    reply.answers.length === input.questions.length &&
    reply.answers.every((answer) => {
      const question = input.questions.find((question) => question.id === answer.id);
      return (
        question &&
        (question.multiSelect || answer.selected.length <= 1) &&
        answer.selected.every((label) => question.options?.some((option) => option.label === label))
      );
    })
  );
}
export function isInteraction(value: unknown): value is Interaction {
  if (!profileObject(value)) return false;
  const {
    bot,
    runId,
    status,
    reply,
    createdAt,
    updatedAt,
    conversationId,
    decisionSource,
    ...input
  } = value;
  return (
    isInteractionInput(input) &&
    (decisionSource === undefined ||
      (decisionSource === 'policy' &&
        input.kind === 'approval' &&
        status === 'resolved' &&
        profileObject(reply) &&
        reply.kind === 'decision' &&
        reply.allow === true)) &&
    validAgentId(bot) &&
    validAgentId(runId) &&
    (conversationId === undefined || validAgentId(conversationId)) &&
    ['pending', 'resolved', 'cancelled', 'interrupted'].includes(String(status)) &&
    boundedText(createdAt, 100) &&
    Number.isFinite(Date.parse(createdAt)) &&
    boundedText(updatedAt, 100) &&
    Number.isFinite(Date.parse(updatedAt)) &&
    (status === 'resolved' ? matchesReply(input, reply) : reply === undefined)
  );
}
export type ApprovalMode = 'ask' | 'auto' | 'full';
export function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === 'ask' || value === 'auto' || value === 'full';
}
export interface TaskRequest {
  approvalMode?: ApprovalMode;
  chatRevision?: number;
  requestId: string;
  prompt: string;
  retryOf?: string;
  retryTurn?: string;
  memory?: string;
  files?: TaskFile[];
}
export interface TaskInsert {
  id: string;
  text: string;
  runId: string;
  chatRevision: number;
}
export function isTaskInsert(value: unknown): value is TaskInsert {
  return (
    profileObject(value) &&
    exactKeys(value, ['id', 'text', 'runId', 'chatRevision']) &&
    validAgentId(value.id) &&
    validAgentId(value.runId) &&
    Number.isSafeInteger(value.chatRevision) &&
    Number(value.chatRevision) >= 0 &&
    typeof value.text === 'string' &&
    !!value.text.trim() &&
    value.text.length <= 12000 &&
    !value.text.includes('\0')
  );
}
export type TaskFile =
  | { name: string; content: string; attachmentId?: never }
  | { name: string; attachmentId: string; content?: never };
export function isTaskFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !!value.trim() &&
    value.length <= 160 &&
    new TextEncoder().encode(value).length <= 255 &&
    !/[\\/]/.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32)
  );
}
export function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
export function isTaskFile(value: unknown): value is TaskFile {
  return (
    profileObject(value) &&
    isTaskFileName(value.name) &&
    (value.attachmentId === undefined
      ? exactKeys(value, ['name', 'content']) && isKnowledgeContent(value.content)
      : exactKeys(value, ['name', 'attachmentId']) && isAttachmentId(value.attachmentId))
  );
}
export interface AttachmentRef extends DocumentSource {
  id: string;
  bot: string;
}
export interface AttachmentReceipt extends AttachmentRef {
  content: string;
}
export interface AttachmentEntry extends AttachmentRef {
  version: string;
  deleted: boolean;
  textSize: number;
}
export interface AttachmentQuery {
  trash?: boolean;
  query?: string;
  before?: string;
}
export interface AttachmentPage {
  items: AttachmentEntry[];
  originalBytes: number;
  textBytes: number;
  next?: string;
}
export interface AttachmentPurge {
  id: string;
  bot: string;
  version: string;
  purged: true;
  checkpointed: boolean;
}
export function isAttachmentVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
}
export function isAttachmentQuery(value: unknown): value is AttachmentQuery {
  return (
    profileObject(value) &&
    exactKeys(value, ['trash', 'query', 'before']) &&
    (value.trash === undefined || typeof value.trash === 'boolean') &&
    (value.query === undefined ||
      (typeof value.query === 'string' &&
        value.query.length <= 200 &&
        !value.query.includes('\0'))) &&
    (value.before === undefined || isAttachmentId(value.before))
  );
}
export function isAttachmentEntry(value: unknown): value is AttachmentEntry {
  if (!profileObject(value)) return false;
  const { version, deleted, textSize, ...ref } = value;
  return (
    isAttachmentRef(ref) &&
    isAttachmentVersion(version) &&
    typeof deleted === 'boolean' &&
    Number.isSafeInteger(textSize) &&
    Number(textSize) >= 0 &&
    Number(textSize) <= knowledgeLimit
  );
}
export function isAttachmentPage(value: unknown): value is AttachmentPage {
  return (
    profileObject(value) &&
    exactKeys(value, ['items', 'originalBytes', 'textBytes', 'next']) &&
    Array.isArray(value.items) &&
    value.items.length <= 50 &&
    value.items.every(isAttachmentEntry) &&
    Number.isSafeInteger(value.originalBytes) &&
    Number(value.originalBytes) >= 0 &&
    Number.isSafeInteger(value.textBytes) &&
    Number(value.textBytes) >= 0 &&
    (value.next === undefined ||
      (isAttachmentId(value.next) &&
        value.items.length === 50 &&
        value.next === value.items.at(-1)?.id))
  );
}
export function isAttachmentPurge(value: unknown): value is AttachmentPurge {
  return (
    profileObject(value) &&
    exactKeys(value, ['id', 'bot', 'version', 'purged', 'checkpointed']) &&
    isAttachmentId(value.id) &&
    validAgentId(value.bot) &&
    isAttachmentVersion(value.version) &&
    value.purged === true &&
    typeof value.checkpointed === 'boolean'
  );
}
export function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (!profileObject(value)) return false;
  const { id, bot, ...source } = value;
  return (
    isAttachmentId(id) &&
    validAgentId(bot) &&
    isTaskFileName(source.name) &&
    isUploadSource(source, (name) => isDocumentName(name) || !!imageMime(name))
  );
}
export function isAttachmentReceipt(value: unknown): value is AttachmentReceipt {
  if (!profileObject(value)) return false;
  const { content, ...ref } = value;
  return isAttachmentRef(ref) && isKnowledgeContent(content) && !!content.trim();
}
export interface RuntimeFile {
  path: string;
  name: string;
  size: number;
  modified: string;
  content?: string;
}
export function isRuntimeFileMetadata(value: unknown): value is RuntimeFile {
  return (
    profileObject(value) &&
    exactKeys(value, ['path', 'name', 'size', 'modified']) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    value.path.length <= 512 &&
    !value.path.includes('\\') &&
    !value.path.includes('\0') &&
    !value.path.startsWith('/') &&
    value.path.split('/').every((part) => part && part !== '.' && part !== '..') &&
    value.name === value.path.split('/').at(-1) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0 &&
    typeof value.modified === 'string' &&
    Number.isFinite(Date.parse(value.modified))
  );
}
export interface RuntimeDownload extends Omit<RuntimeFile, 'content'> {
  data: string;
  sha256: string;
}
export function isRuntimeDownload(value: unknown): value is RuntimeDownload {
  return (
    profileObject(value) &&
    exactKeys(value, ['path', 'name', 'size', 'modified', 'data', 'sha256']) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    value.path.length <= 512 &&
    !value.path.includes('\\') &&
    !value.path.includes('\0') &&
    !value.path.startsWith('/') &&
    value.path.split('/').every((part) => part && part !== '.' && part !== '..') &&
    value.name === value.path.split('/').at(-1) &&
    Number.isSafeInteger(value.size) &&
    value.size === encodedSize(value.data) &&
    typeof value.modified === 'string' &&
    Number.isFinite(Date.parse(value.modified)) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  );
}
export const knowledgeLimit = 200 * 1024;
export const documentLimit = 5 * 1024 * 1024;
export interface DocumentUpload {
  name: string;
  data: string;
}
export interface DocumentSource {
  name: string;
  size: number;
  sha256: string;
}
export interface DocumentOriginal {
  id: string;
  bot: string;
  file: DocumentUpload;
  sha256: string;
}
export function isDocumentOriginal(value: unknown): value is DocumentOriginal {
  return isOriginal(value, isDocumentUpload);
}
export function isAttachmentOriginal(value: unknown): value is DocumentOriginal {
  return isOriginal(value, isAttachmentUpload);
}
function isOriginal(value: unknown, upload: (file: unknown) => boolean): value is DocumentOriginal {
  return (
    profileObject(value) &&
    exactKeys(value, ['id', 'bot', 'file', 'sha256']) &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    upload(value.file) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  );
}
export function isDocumentName(value: unknown): value is string {
  return (
    isKnowledgePath(value) &&
    value.length <= 236 &&
    !value.includes('/') &&
    /\.(pdf|docx|xlsx|pptx)$/i.test(value)
  );
}
export function imageMime(
  name: unknown,
): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (!isTaskFileName(name)) return undefined;
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.webp$/i.test(name)) return 'image/webp';
  if (/\.gif$/i.test(name)) return 'image/gif';
  return undefined;
}
export function isAttachmentUpload(value: unknown): value is DocumentUpload {
  return (
    isDocumentUpload(value) ||
    (profileObject(value) &&
      exactKeys(value, ['name', 'data']) &&
      !!imageMime(value.name) &&
      !!encodedSize(value.data))
  );
}
export function imageProtocol(name: unknown) {
  const mime = imageMime(name);
  return mime ? (mime === 'image/gif' || mime === 'image/webp' ? 31 : 26) : undefined;
}
export function isDocumentUpload(value: unknown): value is DocumentUpload {
  if (!profileObject(value) || !exactKeys(value, ['name', 'data']) || !isDocumentName(value.name))
    return false;
  const size = encodedSize(value.data);
  return size !== undefined && size > 0;
}
function encodedSize(data: unknown): number | undefined {
  if (data === '') return 0;
  if (
    typeof data !== 'string' ||
    !data.length ||
    data.length > 4 * Math.ceil(documentLimit / 3) ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    return undefined;
  const bytes = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  return bytes > 0 && bytes <= documentLimit ? bytes : undefined;
}
export function isDocumentSource(value: unknown): value is DocumentSource {
  return isUploadSource(value, isDocumentName);
}
function isUploadSource(
  value: unknown,
  name: (value: unknown) => boolean,
): value is DocumentSource {
  return (
    profileObject(value) &&
    exactKeys(value, ['name', 'size', 'sha256']) &&
    name(value.name) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) > 0 &&
    Number(value.size) <= documentLimit &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  );
}
export interface KnowledgeFile {
  id: string;
  bot: string;
  path: string;
  revision: number;
  size: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  source?: DocumentSource;
}
export interface KnowledgeDocument extends KnowledgeFile {
  content: string;
}
export interface KnowledgeWrite {
  id?: string;
  path: string;
  revision: number;
  content: string;
}
export interface KnowledgeVersion {
  revision: number;
  path: string;
  size: number;
  deleted: boolean;
  at: string;
  actor: 'user' | 'bot';
  runId?: string;
}
export function isKnowledgePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
    value.split('/').every((part) => part.trim().length > 0 && !part.startsWith('.'))
  );
}
export function isKnowledgeContent(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= knowledgeLimit &&
    !value.includes('\0') &&
    new TextEncoder().encode(value).length <= knowledgeLimit
  );
}
export function isKnowledgeWrite(value: unknown): value is KnowledgeWrite {
  return (
    profileObject(value) &&
    exactKeys(value, ['id', 'path', 'revision', 'content']) &&
    isKnowledgePath(value.path) &&
    isKnowledgeContent(value.content) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    (value.id === undefined
      ? value.revision === 0
      : validAgentId(value.id) && Number(value.revision) > 0)
  );
}
export function isKnowledgeFile(value: unknown): value is KnowledgeFile {
  return (
    profileObject(value) &&
    exactKeys(value, [
      'id',
      'bot',
      'path',
      'revision',
      'size',
      'deleted',
      'createdAt',
      'updatedAt',
      'source',
    ]) &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    isKnowledgePath(value.path) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0 &&
    Number(value.size) <= knowledgeLimit &&
    typeof value.deleted === 'boolean' &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    (value.source === undefined || isDocumentSource(value.source))
  );
}
export function isKnowledgeDocument(value: unknown): value is KnowledgeDocument {
  if (!profileObject(value)) return false;
  const { content, ...file } = value;
  return isKnowledgeFile(file) && isKnowledgeContent(content);
}
export function isKnowledgeVersion(value: unknown): value is KnowledgeVersion {
  return (
    profileObject(value) &&
    exactKeys(value, ['revision', 'path', 'size', 'deleted', 'at', 'actor', 'runId']) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    isKnowledgePath(value.path) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0 &&
    Number(value.size) <= knowledgeLimit &&
    typeof value.deleted === 'boolean' &&
    typeof value.at === 'string' &&
    Number.isFinite(Date.parse(value.at)) &&
    ['user', 'bot'].includes(String(value.actor)) &&
    (value.runId === undefined || validAgentId(value.runId))
  );
}
export type ScheduleRule =
  | { kind: 'every'; everySeconds: number }
  | { kind: 'daily'; time: string; timeZone: string }
  | { kind: 'weekly'; time: string; timeZone: string; weekdays: number[] }
  | { kind: 'once'; date: string; time: string; timeZone: string }
  | { kind: 'cron'; expression: string; timeZone: string };
export interface ScheduleInput {
  id: string;
  bot: string;
  title: string;
  prompt: string;
  rule: ScheduleRule;
  enabled?: boolean;
  locked?: boolean;
}
export interface ScheduleFiring {
  id: string;
  occurrenceAt: string;
  createdAt: string;
  state:
    | 'pending'
    | 'claimed'
    | 'running'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'cancelled'
    | 'coalesced';
  requestId: string;
  runId?: string;
  error?: string;
}
export interface Schedule extends ScheduleInput {
  revision: number;
  enabled: boolean;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
  history: ScheduleFiring[];
}
export type SchedulePatch = Partial<
  Pick<ScheduleInput, 'title' | 'prompt' | 'rule' | 'enabled' | 'locked'>
>;
export function isScheduleRule(value: unknown): value is ScheduleRule {
  if (!profileObject(value)) return false;
  if (value.kind === 'every')
    return (
      exactKeys(value, ['kind', 'everySeconds']) &&
      Number.isSafeInteger(value.everySeconds) &&
      Number(value.everySeconds) >= 60 &&
      Number(value.everySeconds) <= 31536000
    );
  if (!boundedText(value.timeZone, 100)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timeZone });
  } catch {
    return false;
  }
  if (value.kind === 'cron')
    return (
      exactKeys(value, ['kind', 'expression', 'timeZone']) && boundedText(value.expression, 150)
    );
  if (typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time))
    return false;
  if (value.kind === 'daily') return exactKeys(value, ['kind', 'time', 'timeZone']);
  if (value.kind === 'once')
    return (
      exactKeys(value, ['kind', 'date', 'time', 'timeZone']) &&
      typeof value.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    );
  return (
    value.kind === 'weekly' &&
    exactKeys(value, ['kind', 'time', 'timeZone', 'weekdays']) &&
    Array.isArray(value.weekdays) &&
    value.weekdays.length > 0 &&
    value.weekdays.length <= 7 &&
    new Set(value.weekdays).size === value.weekdays.length &&
    value.weekdays.every((day) => Number.isSafeInteger(day) && day >= 0 && day <= 6)
  );
}
export function isScheduleInput(value: unknown): value is ScheduleInput {
  return (
    profileObject(value) &&
    exactKeys(value, ['id', 'bot', 'title', 'prompt', 'rule', 'enabled', 'locked']) &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    boundedText(value.title, 120) &&
    boundedText(value.prompt, 8000) &&
    isScheduleRule(value.rule) &&
    (value.enabled === undefined || typeof value.enabled === 'boolean') &&
    (value.locked === undefined || typeof value.locked === 'boolean')
  );
}
export function isSchedulePatch(value: unknown): value is SchedulePatch {
  return (
    profileObject(value) &&
    Object.keys(value).length > 0 &&
    exactKeys(value, ['title', 'prompt', 'rule', 'enabled', 'locked']) &&
    isScheduleInput({
      id: 'validation',
      bot: 'validation',
      title: 'validation',
      prompt: 'validation',
      rule: { kind: 'every', everySeconds: 60 },
      ...value,
    })
  );
}
export function isScheduleFiring(item: unknown): item is ScheduleFiring {
  return (
    profileObject(item) &&
    exactKeys(item, ['id', 'requestId', 'occurrenceAt', 'createdAt', 'state', 'runId', 'error']) &&
    validAgentId(item.id) &&
    boundedText(item.requestId, 100) &&
    [
      'pending',
      'claimed',
      'running',
      'completed',
      'failed',
      'interrupted',
      'cancelled',
      'coalesced',
    ].includes(String(item.state)) &&
    typeof item.occurrenceAt === 'string' &&
    Number.isFinite(Date.parse(item.occurrenceAt)) &&
    typeof item.createdAt === 'string' &&
    Number.isFinite(Date.parse(item.createdAt)) &&
    (item.runId === undefined || validAgentId(item.runId)) &&
    (item.error === undefined || boundedText(item.error, 1000, true))
  );
}
export function isSchedule(value: unknown): value is Schedule {
  if (!profileObject(value)) return false;
  const { revision, nextRunAt, createdAt, updatedAt, history, ...input } = value;
  return (
    isScheduleInput(input) &&
    typeof value.enabled === 'boolean' &&
    Number.isSafeInteger(revision) &&
    Number(revision) > 0 &&
    typeof createdAt === 'string' &&
    Number.isFinite(Date.parse(createdAt)) &&
    typeof updatedAt === 'string' &&
    Number.isFinite(Date.parse(updatedAt)) &&
    (nextRunAt === undefined ||
      (typeof nextRunAt === 'string' && Number.isFinite(Date.parse(nextRunAt)))) &&
    Array.isArray(history) &&
    history.length <= 20 &&
    history.every(isScheduleFiring)
  );
}
export type DesktopInput =
  | { type: 'release' }
  | { type: 'click'; x: number; y: number; button?: number }
  | { type: 'pointer'; x: number; y: number; phase: 'down' | 'up' | 'move'; button?: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string }
  | { type: 'scroll'; deltaY: number };
export interface BrowserBinding {
  instance: string;
  tab: string;
  generation: number;
}
export interface BrowserState {
  pending?: BrowserPrompt[];
  bot: string;
  available: boolean;
  instance: string;
  revision: number;
  active: string;
  tabs: {
    id: string;
    url: string;
    title: string;
    generation: number;
    suspended?: boolean;
    restoreUrl?: string;
  }[];
  error?: string;
}
export interface BrowserView {
  paused?: true;
  bot: string;
  epoch: number;
  binding: BrowserBinding;
  image?: string;
  width: 960;
  height: 640;
}
export interface BrowserCommandRequest {
  epoch: number;
  instance: string;
  id: string;
  action:
    | 'navigate'
    | 'new'
    | 'open'
    | 'select'
    | 'close'
    | 'resume'
    | 'back'
    | 'forward'
    | 'reload';
  tab?: string;
  url?: string;
}
export interface BrowserAck {
  id: string;
  state: BrowserState;
  error?: string;
  uncertain?: boolean;
}
export interface BrowserReceipt {
  id: string;
  bot: string;
  phase: 'unknown' | 'claimed' | 'settled';
  error?: string;
  uncertain?: boolean;
}
const browserKeys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
export type BrowserPrompt = { id: string; tab: string; generation: number } & (
  | {
      kind: 'dialog';
      dialog: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
      message: string;
      defaultValue: string;
      truncated: boolean;
    }
  | { kind: 'files'; multiple: boolean }
);
export type BrowserAnswerRequest = {
  epoch: number;
  id: string;
  binding: BrowserBinding;
  prompt: string;
} & (
  | { kind: 'dialog'; accept: boolean; text?: string }
  | { kind: 'files'; files: { name: string; data: string; mimeType?: string }[] }
);
export function isBrowserPrompt(value: unknown): value is BrowserPrompt {
  if (
    !profileObject(value) ||
    !validAgentId(value.id) ||
    !validAgentId(value.tab) ||
    !browserNumber(value.generation)
  )
    return false;
  if (value.kind === 'files')
    return (
      browserKeys(value, ['id', 'tab', 'generation', 'kind', 'multiple']) &&
      typeof value.multiple === 'boolean'
    );
  return (
    value.kind === 'dialog' &&
    browserKeys(value, [
      'id',
      'tab',
      'generation',
      'kind',
      'dialog',
      'message',
      'defaultValue',
      'truncated',
    ]) &&
    ['alert', 'confirm', 'prompt', 'beforeunload'].includes(String(value.dialog)) &&
    typeof value.message === 'string' &&
    value.message.length <= 16000 &&
    !value.message.includes('\0') &&
    typeof value.defaultValue === 'string' &&
    value.defaultValue.length <= 2000 &&
    !value.defaultValue.includes('\0') &&
    typeof value.truncated === 'boolean'
  );
}
export function isBrowserAnswerRequest(value: unknown): value is BrowserAnswerRequest {
  if (
    !profileObject(value) ||
    !browserNumber(value.epoch) ||
    !validAgentId(value.id) ||
    !validAgentId(value.prompt) ||
    !isBrowserBinding(value.binding)
  )
    return false;
  if (value.kind === 'dialog')
    return (
      browserKeys(value, ['epoch', 'id', 'binding', 'prompt', 'kind', 'accept', 'text']) &&
      typeof value.accept === 'boolean' &&
      (value.text === undefined ||
        (value.accept &&
          typeof value.text === 'string' &&
          value.text.length <= 2000 &&
          !value.text.includes('\0')))
    );
  if (
    value.kind !== 'files' ||
    !browserKeys(value, ['epoch', 'id', 'binding', 'prompt', 'kind', 'files']) ||
    !Array.isArray(value.files) ||
    value.files.length > 4
  )
    return false;
  let bytes = 0;
  for (const file of value.files) {
    if (
      !profileObject(file) ||
      !browserKeys(file, ['name', 'data', 'mimeType']) ||
      (file.mimeType !== undefined &&
        (typeof file.mimeType !== 'string' ||
          file.mimeType.length > 200 ||
          !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.mimeType))) ||
      !isTaskFileName(file.name) ||
      typeof file.data !== 'string' ||
      file.data.length > Math.ceil(documentLimit / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)
    )
      return false;
    bytes +=
      (file.data.length / 4) * 3 - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0);
  }
  return bytes <= documentLimit;
}
const browserNumber = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const browserCode = (value: unknown) =>
  value === undefined || (typeof value === 'string' && /^[A-Z_]{1,100}$/.test(value));
export function isBrowserBinding(value: unknown): value is BrowserBinding {
  return (
    profileObject(value) &&
    browserKeys(value, ['instance', 'tab', 'generation']) &&
    validAgentId(value.instance) &&
    validAgentId(value.tab) &&
    browserNumber(value.generation)
  );
}
export function isBrowserState(value: unknown): value is BrowserState {
  if (
    !profileObject(value) ||
    !browserKeys(value, [
      'bot',
      'available',
      'instance',
      'revision',
      'active',
      'tabs',
      'error',
      'pending',
    ]) ||
    !validAgentId(value.bot) ||
    typeof value.available !== 'boolean' ||
    !validAgentId(value.instance) ||
    !browserNumber(value.revision) ||
    !validAgentId(value.active) ||
    !browserCode(value.error) ||
    !Array.isArray(value.tabs) ||
    !value.tabs.length ||
    value.tabs.length > 8
  )
    return false;
  const ids = new Set<string>();
  for (const tab of value.tabs) {
    if (
      !profileObject(tab) ||
      !browserKeys(tab, ['id', 'url', 'title', 'generation', 'suspended', 'restoreUrl']) ||
      !validAgentId(tab.id) ||
      ids.has(tab.id) ||
      (tab.url !== 'about:blank' && !publicUrl(tab.url)) ||
      typeof tab.title !== 'string' ||
      tab.title.length > 200 ||
      tab.title.includes('\0') ||
      !browserNumber(tab.generation) ||
      (tab.suspended !== undefined && typeof tab.suspended !== 'boolean') ||
      (tab.restoreUrl !== undefined && !publicUrl(tab.restoreUrl)) ||
      (tab.suspended === true && (tab.url !== 'about:blank' || !publicUrl(tab.restoreUrl)))
    )
      return false;
    ids.add(tab.id);
  }
  return (
    ids.has(value.active) &&
    (value.pending === undefined ||
      (Array.isArray(value.pending) &&
        value.pending.length <= 16 &&
        value.pending.every((prompt) => isBrowserPrompt(prompt) && ids.has(prompt.tab))))
  );
}
export function isBrowserView(value: unknown): value is BrowserView {
  return (
    profileObject(value) &&
    browserKeys(value, ['bot', 'epoch', 'binding', 'image', 'width', 'height', 'paused']) &&
    validAgentId(value.bot) &&
    browserNumber(value.epoch) &&
    isBrowserBinding(value.binding) &&
    value.width === 960 &&
    value.height === 640 &&
    (value.paused === undefined || value.paused === true) &&
    ((value.paused === true && value.image === undefined) ||
      (typeof value.image === 'string' &&
        value.image.length <= 8 * 1024 * 1024 &&
        /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image)))
  );
}
export function isBrowserCommandRequest(value: unknown): value is BrowserCommandRequest {
  if (
    !profileObject(value) ||
    !browserKeys(value, ['epoch', 'instance', 'id', 'action', 'tab', 'url']) ||
    !browserNumber(value.epoch) ||
    !validAgentId(value.instance) ||
    !validAgentId(value.id)
  )
    return false;
  if (value.action === 'new') return value.tab === undefined && value.url === undefined;
  if (value.action === 'open') return value.tab === undefined && !!publicUrl(value.url);
  if (
    !['navigate', 'select', 'close', 'resume', 'back', 'forward', 'reload'].includes(
      String(value.action),
    ) ||
    !validAgentId(value.tab)
  )
    return false;
  return value.action === 'navigate' ? !!publicUrl(value.url) : value.url === undefined;
}
export function isBrowserAck(value: unknown): value is BrowserAck {
  return (
    profileObject(value) &&
    browserKeys(value, ['id', 'state', 'error', 'uncertain']) &&
    validAgentId(value.id) &&
    isBrowserState(value.state) &&
    browserCode(value.error) &&
    (value.uncertain === undefined || typeof value.uncertain === 'boolean')
  );
}
export function isBrowserReceipt(value: unknown): value is BrowserReceipt {
  return (
    profileObject(value) &&
    browserKeys(value, ['id', 'bot', 'phase', 'error', 'uncertain']) &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    ['unknown', 'claimed', 'settled'].includes(String(value.phase)) &&
    browserCode(value.error) &&
    (value.uncertain === undefined || typeof value.uncertain === 'boolean')
  );
}
export function isBrowserInput(value: unknown): value is DesktopInput {
  if (!profileObject(value)) return false;
  if (value.type === 'release') return browserKeys(value, ['type']);
  if (value.type === 'text')
    return (
      browserKeys(value, ['type', 'text']) &&
      typeof value.text === 'string' &&
      value.text.length <= 2000 &&
      !value.text.includes('\0')
    );
  if (value.type === 'key')
    return (
      browserKeys(value, ['type', 'key']) &&
      typeof value.key === 'string' &&
      /^(?:(?:Control|Meta|Alt|Shift|ControlOrMeta)\+)*(?:[a-zA-Z0-9]|Enter|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Escape|Home|End|PageUp|PageDown|Space)$/.test(
        value.key,
      )
    );
  if (value.type === 'scroll')
    return (
      browserKeys(value, ['type', 'deltaY']) &&
      Number.isFinite(value.deltaY) &&
      Math.abs(Number(value.deltaY)) <= 10000
    );
  if (value.type !== 'click' && value.type !== 'pointer') return false;
  return (
    browserKeys(value, [
      'type',
      'x',
      'y',
      'button',
      ...(value.type === 'pointer' ? ['phase'] : []),
    ]) &&
    Number.isFinite(value.x) &&
    Number(value.x) >= 0 &&
    Number(value.x) < 960 &&
    Number.isFinite(value.y) &&
    Number(value.y) >= 0 &&
    Number(value.y) < 640 &&
    (value.button === undefined ||
      (typeof value.button === 'number' && [1, 2, 3].includes(value.button))) &&
    (value.type !== 'pointer' || ['down', 'up', 'move'].includes(String(value.phase)))
  );
}
export type RuntimeCommand =
  | VmCommand
  | NoteCommand
  | WorkCommentCommand
  | { type: 'work.list'; query: WorkQuery }
  | { type: 'work.read'; id: string }
  | { type: 'work.write' | 'work.receipt'; request: WorkWrite }
  | { type: 'transcript.statistics'; query: TranscriptQuery }
  | { type: 'transcript.list'; query: TranscriptQuery }
  | { type: 'transcript.content'; query: TranscriptContentQuery }
  | { type: 'chat.new'; request: ChatRequest }
  | { type: 'chat.receipt'; bot: string; id: string }
  | { type: 'chat.history'; bot: string; revision: number; before?: string; runId?: string }
  | { type: 'bot.export'; input: BotExportRequest }
  | { type: 'bot.import.begin' | 'bot.import.cancel'; header: BotImportHeader }
  | { type: 'bot.import.submit'; id: string; bundle: BotBundle }
  | { type: 'bot.import.status' | 'bot.import.retry'; id: string }
  | { type: 'setup.status' | 'setup.cancel' }
  | { type: 'setup.start'; mode?: QemuMode }
  | { type: 'setup.enable' | 'setup.restart'; confirmed: true }
  | { type: 'agent.upgrade'; confirmed: true }
  | { type: 'recovery.status' | 'recovery.review' }
  | { type: 'recovery.restart'; request: RecoveryRequest }
  | { type: 'recovery.inspect' | 'recovery.cancel' | 'recovery.start'; id: string }
  | { type: 'runtime.inspect' }
  | McpCommand
  | AppCommand
  | { type: 'skill.list'; bot: string; includeDeleted?: boolean }
  | { type: 'skill.read'; bot: string; id: string }
  | SkillPackageCommand
  | { type: 'skill.import'; bot: string; content: string }
  | { type: 'skill.copy'; bot: string; id: string; revision: number; targetBot: string }
  | { type: 'skill.update'; bot: string; id: string; revision: number; content: string }
  | { type: 'skill.recycle' | 'skill.restore'; bot: string; id: string; revision: number }
  | { type: 'skill.bind'; bot: string; binding: SkillBinding }
  | LocalComputerCommand
  | { type: 'computer.action'; request: ComputerRequest }
  | { type: 'computer.receipt'; id: string; bot: string }
  | ({ type: 'browser.answer'; bot: RuntimeBot } & BrowserAnswerRequest)
  | { type: 'browser.state' | 'browser.view'; bot: RuntimeBot }
  | ({ type: 'browser.command'; bot: RuntimeBot } & BrowserCommandRequest)
  | { type: 'browser.receipt'; bot: RuntimeBot; id: string }
  | {
      type: 'browser.input';
      bot: RuntimeBot;
      epoch: number;
      binding: BrowserBinding;
      input: DesktopInput;
    }
  | { type: 'group.register'; group: GroupInput }
  | { type: 'group.copy' | 'group.copy.receipt'; request: GroupCopyRequest }
  | { type: 'group.update'; group: string; revision: number; input: Omit<GroupInput, 'id'> }
  | { type: 'group.read'; group: string; before?: number }
  | { type: 'group.input'; group: string; sourceId: string; name: string }
  | { type: 'group.send'; input: GroupSend }
  | { type: 'group.cancel'; group: string; sourceId: string }
  | { type: 'group.action'; request: GroupActionRequest }
  | { type: 'group.receipt'; group: string; id: string }
  | { type: 'model.configure'; input: ModelUpdate }
  | { type: 'model.check'; revision: number }
  | { type: 'model.inspect'; input: ModelInspectionRequest }
  | { type: 'clipboard.write'; text: string }
  | { type: 'link.open'; url: string }
  | { type: 'knowledge.list'; bot: string; includeDeleted?: boolean; query?: string }
  | { type: 'knowledge.read'; bot: string; id: string; version?: number }
  | { type: 'knowledge.write'; bot: string; document: KnowledgeWrite }
  | { type: 'knowledge.import'; bot: string; file: DocumentUpload }
  | { type: 'knowledge.source'; bot: string; id: string }
  | { type: 'attachment.upload'; bot: string; file: DocumentUpload }
  | { type: 'attachment.source'; bot: string; id: string }
  | { type: 'attachment.read'; bot: string; id: string }
  | { type: 'attachment.list'; bot: string; query: AttachmentQuery }
  | { type: 'attachment.trash' | 'attachment.restore'; bot: string; id: string; version: string }
  | { type: 'attachment.purge'; bot: string; id: string; version: string; confirmation: string }
  | { type: 'knowledge.remove'; bot: string; id: string; revision: number }
  | { type: 'knowledge.versions'; bot: string; id: string; before?: number }
  | { type: 'knowledge.restore'; bot: string; id: string; revision: number; targetRevision: number }
  | { type: 'schedule.get'; id: string }
  | { type: 'schedule.preview'; rule: ScheduleRule }
  | { type: 'schedule.create'; input: ScheduleInput }
  | { type: 'schedule.update'; id: string; revision: number; patch: SchedulePatch }
  | { type: 'schedule.remove'; id: string; revision: number }
  | { type: 'schedule.run'; id: string; requestId: string }
  | { type: 'interaction.reply'; bot: string; runId: string; id: string; reply: UserReply }
  | { type: 'status' | 'connect' }
  | { type: 'bot.register'; profile: BotProfileInput }
  | { type: 'bot.copy' | 'bot.copy.receipt'; request: BotCopyRequest }
  | { type: 'bot.action'; request: BotLifecycleRequest }
  | { type: 'bot.receipt'; bot: string; id: string }
  | { type: 'bot.update'; bot: string; revision: number; patch: BotProfilePatch }
  | { type: 'memory.history'; bot: string; query: MemoryQuery }
  | { type: 'task.start'; bot: string; task: TaskRequest }
  | {
      type: 'task.insert';
      bot: string;
      id: string;
      text: string;
      runId: string;
      chatRevision: number;
    }
  | { type: 'task.stop'; bot: string }
  | { type: 'control'; bot: RuntimeBot; epoch: number; owner: 'human' | 'agent'; instance?: string }
  | {
      type: 'frame';
      bot: RuntimeBot;
      surface: 'desktop' | 'browser';
      instance?: string;
      epoch?: number;
    }
  | { type: 'input'; bot: RuntimeBot; epoch: number; input: DesktopInput; instance?: string }
  | {
      type: 'app';
      bot: RuntimeBot;
      epoch: number;
      instance?: string;
      app: 'terminal' | 'files' | 'editor' | 'browser';
    }
  | { type: 'files.list' }
  | { type: 'files.read'; path: string }
  | { type: 'files.download'; path: string };
export type RuntimeReply<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
export interface RuntimeBridge {
  invoke<T = unknown>(command: RuntimeCommand): Promise<RuntimeReply<T>>;
  subscribe(callback: (snapshot: RuntimeSnapshot) => unknown): () => unknown;
}
export const runtimeTargets: Readonly<Record<string, RuntimeBot>> = Object.assign(
  Object.create(null) as Record<string, RuntimeBot>,
  { research: 'a', writer: 'b' },
);
export function agentId(bot: string) {
  return runtimeTargets[bot] || bot;
}
export function computerTarget(snapshot: RuntimeSnapshot, bot: string): string | undefined {
  return snapshot.protocolVersion >= 19 ? agentId(bot) : runtimeTargets[bot];
}
export function agentTask(snapshot: RuntimeSnapshot, bot: string) {
  const id = agentId(bot);
  if (snapshot.agents && Object.hasOwn(snapshot.agents, id)) return snapshot.agents[id];
  const computer = runtimeTargets[bot];
  return computer ? snapshot.bots[computer]?.task : undefined;
}
export function disconnected(
  phase: RuntimeSnapshot['phase'] = 'offline',
  error = '',
): RuntimeSnapshot {
  return {
    phase,
    error,
    protocolVersion: 0,
    model: { configured: false, available: false, provider: '', model: '' },
    bots: {},
    agents: {},
    profiles: [],
    interactions: [],
    sharedLogin: false,
    viewport: { width: 1280, height: 800 },
  };
}

export const botBundleLimit = 100 * 1024 * 1024;
export interface BotBundle {
  format: 'daban.bot';
  version: 1 | 2;
  profile: Pick<BotProfileInput, 'name' | 'instructions' | 'color'>;
  preferences: string;
  skills: { name: string; content: string; package?: SkillPackage }[];
  knowledge: { path: string; content: string; original?: DocumentUpload }[];
}
export interface BotExportRequest {
  originals?: boolean;
  bot: string;
  revision: number;
  memory: boolean;
  skills: { id: string; revision: number }[];
  knowledge: { id: string; revision: number }[];
}
export interface BotImportHeader {
  id: string;
  sha256: string;
  size: number;
}
export type BotImportState =
  | 'unknown'
  | 'awaiting'
  | 'validating'
  | 'applying'
  | 'failed'
  | 'complete'
  | 'cancelled';
export interface BotImportReceipt {
  id: string;
  state: BotImportState;
  sha256?: string;
  profile?: BotProfile;
  progress?: { done: number; total: number };
  error?: string;
  canCancel?: boolean;
}
export function botBundleText(value: BotBundle) {
  // Stable projection excludes identity, permissions and any property not owned by this format.
  return JSON.stringify({
    format: 'daban.bot',
    version: value.version,
    profile: {
      name: value.profile.name,
      instructions: value.profile.instructions,
      color: value.profile.color,
    },
    preferences: value.preferences,
    skills: value.skills.map((skill) => ({
      name: skill.name,
      content: skill.content,
      ...(value.version === 2 && skill.package
        ? {
            package: {
              ...(skill.package.root ? { root: skill.package.root } : {}),
              files: skill.package.files.map((file) => ({
                path: file.path,
                data: file.data,
                ...(file.executable === undefined ? {} : { executable: file.executable }),
              })),
            },
          }
        : {}),
    })),
    knowledge: value.knowledge.map((document) => ({
      path: document.path,
      content: document.content,
      ...(document.original
        ? { original: { name: document.original.name, data: document.original.data } }
        : {}),
    })),
  });
}
export function isBotBundle(value: unknown): value is BotBundle {
  if (
    !profileObject(value) ||
    !exactKeys(value, ['format', 'version', 'profile', 'preferences', 'skills', 'knowledge']) ||
    value.format !== 'daban.bot' ||
    (value.version !== 1 && value.version !== 2) ||
    !profileObject(value.profile) ||
    !exactKeys(value.profile, ['name', 'instructions', 'color']) ||
    !isBotProfileInput({ id: 'portable', ...value.profile, memory: value.preferences }) ||
    !Array.isArray(value.skills) ||
    value.skills.length > 20 ||
    !Array.isArray(value.knowledge) ||
    value.knowledge.length > 100
  )
    return false;
  const skills = value.skills;
  const knowledge = value.knowledge;
  if (
    !Array.from(skills).every(
      (skill) =>
        profileObject(skill) &&
        exactKeys(
          skill,
          value.version === 2 ? ['name', 'content', 'package'] : ['name', 'content'],
        ) &&
        isSkillName(skill.name) &&
        isSkillContent(skill.content) &&
        (skill.package === undefined ||
          (isSkillPackage(skill.package) &&
            (skill.package.root === undefined || skill.package.root === skill.name) &&
            skillMainMatches(skill.package, skill.content))),
    ) ||
    !Array.from(knowledge).every(
      (document) =>
        profileObject(document) &&
        exactKeys(document, ['path', 'content', 'original']) &&
        isKnowledgePath(document.path) &&
        isKnowledgeContent(document.content) &&
        (document.original === undefined || isDocumentUpload(document.original)),
    )
  )
    return false;
  const valid = value as unknown as BotBundle;
  if (
    new Set(valid.skills.map((skill) => skill.name)).size !== valid.skills.length ||
    new Set(valid.knowledge.map((document) => document.path)).size !== valid.knowledge.length
  )
    return false;
  const text = [
    valid.profile.name,
    valid.profile.instructions,
    valid.preferences,
    ...valid.skills.flatMap((skill) => [skill.name, skill.content]),
    ...valid.knowledge.flatMap((document) => [
      document.path,
      document.content,
      ...(document.original ? [document.original.name] : []),
    ]),
  ];
  // SQLite and UTF-8 must receive exactly the reviewed text, including valid emoji pairs.
  if (text.some((value) => /[\uD800-\uDFFF]/u.test(value))) return false;
  const originals = valid.knowledge.flatMap((document) =>
    document.original ? [document.original] : [],
  );
  if (
    new Set(originals.map((file) => file.name)).size !== originals.length ||
    originals.reduce((total, file) => total + (encodedSize(file.data) ?? botBundleLimit), 0) >
      50 * 1024 * 1024 ||
    valid.knowledge.reduce(
      (total, document) => total + new TextEncoder().encode(document.content).length,
      0,
    ) >
      20 * 1024 * 1024
  )
    return false;
  return new TextEncoder().encode(botBundleText(valid)).length <= botBundleLimit;
}

function skillMainMatches(bundle: SkillPackage, content: string) {
  const file = bundle.files.find((file) => file.path === 'SKILL.md');
  if (!file) return false;
  try {
    const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
    // BOM is part of the reviewed source and must survive a portable round trip.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) === content;
  } catch {
    return false;
  }
}
export function isBotExportRequest(value: unknown): value is BotExportRequest {
  const selections = (items: unknown, limit: number) =>
    Array.isArray(items) &&
    items.length <= limit &&
    Array.from(items).every(
      (item) =>
        profileObject(item) &&
        exactKeys(item, ['id', 'revision']) &&
        validAgentId(item.id) &&
        Number.isSafeInteger(item.revision) &&
        Number(item.revision) > 0,
    ) &&
    new Set(items.map((item) => item.id)).size === items.length;
  return (
    profileObject(value) &&
    exactKeys(value, ['bot', 'revision', 'memory', 'skills', 'knowledge', 'originals']) &&
    validAgentId(value.bot) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.memory === 'boolean' &&
    (value.originals === undefined || typeof value.originals === 'boolean') &&
    selections(value.skills, 20) &&
    selections(value.knowledge, 100)
  );
}
export function isBotImportHeader(value: unknown): value is BotImportHeader {
  return (
    profileObject(value) &&
    exactKeys(value, ['id', 'sha256', 'size']) &&
    validAgentId(value.id) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) > 0 &&
    Number(value.size) <= botBundleLimit
  );
}
export function isBotImportReceipt(value: unknown): value is BotImportReceipt {
  if (
    !profileObject(value) ||
    !exactKeys(value, ['id', 'state', 'sha256', 'profile', 'progress', 'error', 'canCancel']) ||
    !validAgentId(value.id)
  )
    return false;
  if (value.state === 'unknown') return Object.keys(value).length === 2;
  return (
    ['awaiting', 'validating', 'applying', 'failed', 'complete', 'cancelled'].includes(
      String(value.state),
    ) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    (value.canCancel === undefined || typeof value.canCancel === 'boolean') &&
    (value.error === undefined ||
      (typeof value.error === 'string' && /^[A-Z_]{1,100}$/.test(value.error))) &&
    (value.progress === undefined ||
      (profileObject(value.progress) &&
        exactKeys(value.progress, ['done', 'total']) &&
        Number.isSafeInteger(value.progress.done) &&
        Number.isSafeInteger(value.progress.total) &&
        Number(value.progress.done) >= 0 &&
        Number(value.progress.total) >= 0 &&
        Number(value.progress.done) <= Number(value.progress.total) &&
        Number(value.progress.total) <= 121)) &&
    (value.state === 'complete'
      ? isBotProfile(value.profile) && value.error === undefined
      : value.profile === undefined)
  );
}

export function parseBotJSON(text: string): unknown {
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).length > botBundleLimit + 64 * 1024
  )
    throw new Error('INVALID_BOT_BUNDLE');
  let quoted = false,
    escaped = false,
    depth = 0,
    containers = 0,
    punctuation = 0;
  // Large originals live in strings; object depth/count must be bounded before JSON allocates a graph.
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      depth++;
      containers++;
      if (depth > 8 || containers > 512) throw new Error('INVALID_BOT_BUNDLE');
    } else if (character === '}' || character === ']') {
      if (--depth < 0) throw new Error('INVALID_BOT_BUNDLE');
    } else if (character === ',' || character === ':') {
      if (++punctuation > 4096) throw new Error('INVALID_BOT_BUNDLE');
    }
  }
  if (quoted || depth !== 0) throw new Error('INVALID_BOT_BUNDLE');
  return JSON.parse(text);
}

export interface BotImportReference extends BotImportHeader {
  name: string;
  selection?: { memory: boolean; skills: boolean; knowledge: boolean };
  cancelRequested?: boolean;
}
export function isBotImportReference(value: unknown): value is BotImportReference {
  return (
    profileObject(value) &&
    exactKeys(value, ['id', 'sha256', 'size', 'name', 'selection', 'cancelRequested']) &&
    isBotImportHeader({ id: value.id, sha256: value.sha256, size: value.size }) &&
    typeof value.name === 'string' &&
    !!value.name.trim() &&
    value.name.length <= 30 &&
    !value.name.includes('\0') &&
    (value.selection === undefined ||
      (profileObject(value.selection) &&
        exactKeys(value.selection, ['memory', 'skills', 'knowledge']) &&
        typeof value.selection.memory === 'boolean' &&
        typeof value.selection.skills === 'boolean' &&
        typeof value.selection.knowledge === 'boolean')) &&
    (value.cancelRequested === undefined || typeof value.cancelRequested === 'boolean')
  );
}
