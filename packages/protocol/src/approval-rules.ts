import { validAgentId } from './id.js';
import { isProjectScope, type ProjectScope } from './projects.js';

// Complete project scopes and decision context require negotiation; legacy clients retain their one-time shape.
export const approvalRulesCapability = 'approval-rules-v3';
export type RuleEffect = 'allow' | 'ask' | 'deny';
export type CommandRiskReason = 'literal-read' | 'model-low' | 'forced-human' | 'unavailable';
export type ApprovalTrigger = 'interactive' | 'automation';
export interface McpPurposeScope {
  taskId: string;
  turnId: string;
}
export function isMcpPurposeScope(value: unknown): value is McpPurposeScope {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    Object.keys(value).every((key) => key === 'taskId' || key === 'turnId') &&
    'taskId' in value &&
    validAgentId(value.taskId) &&
    'turnId' in value &&
    validAgentId(value.turnId)
  );
}
export type ApprovalScope = { kind: 'bot'; bot: string } | { kind: 'project'; scope: ProjectScope };
export const sameApprovalSubject = (a: ApprovalScope, b: ApprovalScope) =>
  a.kind === 'bot'
    ? b.kind === 'bot' && a.bot === b.bot
    : b.kind === 'project' && a.scope.projectId === b.scope.projectId;
export const sameApprovalScope = (a: ApprovalScope, b: ApprovalScope) =>
  sameApprovalSubject(a, b) &&
  (a.kind === 'bot' || (b.kind === 'project' && a.scope.revision === b.scope.revision));
export type ApprovalSelector =
  | { kind: 'url'; url: string }
  | {
      kind: 'command';
      tool: 'shell' | 'process_start' | 'process_input';
      commandHash: string;
      cwd: string;
    }
  | {
      kind: 'mcp';
      connection: string;
      configRevision: number;
      catalogDigest: string;
      tool: string;
      inputHash: string;
    }
  | { kind: 'software'; planId: string; planHash: string };
export interface ApprovalRuleDraft {
  id: string;
  name: string;
  enabled: boolean;
  effect: RuleEffect;
  trigger: ApprovalTrigger;
  selector: ApprovalSelector;
  expiresAt?: string;
  purposeConfirmed?: true;
}
export interface ApprovalRule extends ApprovalRuleDraft {
  scope: ApprovalScope;
  revision: number;
}
export interface PolicyDecision {
  project?: ProjectScope;
  riskReason?: CommandRiskReason;
  effect: RuleEffect;
  source: 'boundary' | 'rule' | 'mode' | 'risk';
  reasonCode:
    | 'boundaryDenied'
    | 'ruleDenied'
    | 'boundaryAsked'
    | 'ruleAsked'
    | 'modeAsked'
    | 'ruleAllowed'
    | 'baselineAllowed'
    | 'baselineAsked';
  matchedRules: { id: string; revision: number; name: string; effect: RuleEffect }[];
  policyRevision: number;
  requestHash: string;
  scope: ApprovalScope;
  trigger: ApprovalTrigger;
  selector: ApprovalSelector;
}
export interface ApprovalRulesStatus {
  capability: typeof approvalRulesCapability;
  available: boolean;
  revision: number;
  error?: string;
}
export interface ApprovalRulesSnapshot {
  scope: ApprovalScope;
  revision: number;
  rules: ApprovalRule[];
}
export type ApprovalRuleWrite = {
  requestId: string;
  expectedRevision: number;
  scope: ApprovalScope;
} & ({ action: 'save'; rule: ApprovalRuleDraft } | { action: 'delete'; id: string });
export interface ApprovalRuleReceipt {
  requestId: string;
  revision: number;
  scope: ApprovalScope;
  id: string;
  rule?: ApprovalRule;
  deleted?: true;
}
export type ApprovalRulesCommand =
  | { type: 'approval.rules.list'; scope: ApprovalScope }
  | { type: 'approval.rules.write'; request: ApprovalRuleWrite }
  | { type: 'approval.rules.receipt'; scope: ApprovalScope; requestId: string }
  | {
      type: 'approval.rules.preview';
      scope: ApprovalScope;
      trigger: ApprovalTrigger;
      selector: ApprovalSelector;
      mode: 'ask' | 'auto' | 'full';
      rule?: ApprovalRuleDraft;
    };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).every((key) => names.includes(key));
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= max &&
  !value.includes('\0');
const revision = (value: unknown, min = 1): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isRuleEffect = (value: unknown): value is RuleEffect =>
  value === 'allow' || value === 'ask' || value === 'deny';
export const isApprovalTrigger = (value: unknown): value is ApprovalTrigger =>
  value === 'interactive' || value === 'automation';
export function canonicalApprovalUrl(value: unknown) {
  if (!text(value, 2048)) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}
export function isApprovalScope(value: unknown): value is ApprovalScope {
  return (
    object(value) &&
    ((value.kind === 'bot' && keys(value, ['kind', 'bot']) && validAgentId(value.bot)) ||
      (value.kind === 'project' && keys(value, ['kind', 'scope']) && isProjectScope(value.scope)))
  );
}
export function isApprovalSelector(value: unknown): value is ApprovalSelector {
  if (!object(value)) return false;
  switch (value.kind) {
    case 'url':
      return (
        keys(value, ['kind', 'url']) &&
        canonicalApprovalUrl(value.url) !== undefined &&
        canonicalApprovalUrl(value.url) === value.url
      );
    case 'command':
      return (
        keys(value, ['kind', 'tool', 'commandHash', 'cwd']) &&
        typeof value.tool === 'string' &&
        ['shell', 'process_start', 'process_input'].includes(value.tool) &&
        hash(value.commandHash) &&
        text(value.cwd, 4096) &&
        value.cwd.startsWith('/') &&
        !value.cwd.includes('\\') &&
        (value.cwd === '/' ||
          value.cwd
            .slice(1)
            .split('/')
            .every((part) => !!part && part !== '.' && part !== '..'))
      );
    case 'mcp':
      return (
        keys(value, [
          'kind',
          'connection',
          'configRevision',
          'catalogDigest',
          'tool',
          'inputHash',
        ]) &&
        validAgentId(value.connection) &&
        revision(value.configRevision) &&
        hash(value.catalogDigest) &&
        text(value.tool, 200) &&
        hash(value.inputHash)
      );
    case 'software':
      return (
        keys(value, ['kind', 'planId', 'planHash']) &&
        validAgentId(value.planId) &&
        hash(value.planHash)
      );
    default:
      return false;
  }
}
function validExpiry(value: unknown): value is string {
  if (
    !text(value, 40) ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
}
export function isApprovalRuleDraft(value: unknown): value is ApprovalRuleDraft {
  return (
    object(value) &&
    keys(value, [
      'id',
      'name',
      'enabled',
      'effect',
      'trigger',
      'selector',
      'expiresAt',
      'purposeConfirmed',
    ]) &&
    validAgentId(value.id) &&
    text(value.name, 80) &&
    typeof value.enabled === 'boolean' &&
    isRuleEffect(value.effect) &&
    isApprovalTrigger(value.trigger) &&
    isApprovalSelector(value.selector) &&
    (value.expiresAt === undefined || validExpiry(value.expiresAt)) &&
    (value.purposeConfirmed === undefined || value.purposeConfirmed === true) &&
    !(value.effect === 'allow' && value.selector.kind === 'software') &&
    !(value.effect === 'allow' && value.selector.kind === 'mcp' && value.purposeConfirmed !== true)
  );
}
export function isApprovalRule(value: unknown): value is ApprovalRule {
  if (!object(value)) return false;
  const { scope, revision: version, ...draft } = value;
  return isApprovalScope(scope) && revision(version) && isApprovalRuleDraft(draft);
}
export function isApprovalRuleWrite(value: unknown): value is ApprovalRuleWrite {
  return (
    object(value) &&
    validAgentId(value.requestId) &&
    revision(value.expectedRevision, 0) &&
    isApprovalScope(value.scope) &&
    ((value.action === 'save' &&
      keys(value, ['requestId', 'expectedRevision', 'scope', 'action', 'rule']) &&
      isApprovalRuleDraft(value.rule)) ||
      (value.action === 'delete' &&
        keys(value, ['requestId', 'expectedRevision', 'scope', 'action', 'id']) &&
        validAgentId(value.id)))
  );
}
export function isApprovalRulesCommand(value: unknown): value is ApprovalRulesCommand {
  if (!object(value)) return false;
  if (value.type === 'approval.rules.write')
    return keys(value, ['type', 'request']) && isApprovalRuleWrite(value.request);
  if (!isApprovalScope(value.scope)) return false;
  if (value.type === 'approval.rules.list') return keys(value, ['type', 'scope']);
  if (value.type === 'approval.rules.receipt')
    return keys(value, ['type', 'scope', 'requestId']) && validAgentId(value.requestId);
  return (
    value.type === 'approval.rules.preview' &&
    keys(value, ['type', 'scope', 'trigger', 'selector', 'mode', 'rule']) &&
    isApprovalTrigger(value.trigger) &&
    isApprovalSelector(value.selector) &&
    typeof value.mode === 'string' &&
    ['ask', 'auto', 'full'].includes(value.mode) &&
    (value.rule === undefined || isApprovalRuleDraft(value.rule))
  );
}
export function isPolicyDecision(value: unknown): value is PolicyDecision {
  return (
    object(value) &&
    keys(value, [
      'effect',
      'source',
      'reasonCode',
      'riskReason',
      'project',
      'matchedRules',
      'policyRevision',
      'requestHash',
      'scope',
      'trigger',
      'selector',
    ]) &&
    isRuleEffect(value.effect) &&
    (value.riskReason === undefined ||
      (typeof value.riskReason === 'string' &&
        ['literal-read', 'model-low', 'forced-human', 'unavailable'].includes(value.riskReason))) &&
    typeof value.source === 'string' &&
    ['boundary', 'rule', 'mode', 'risk'].includes(value.source) &&
    typeof value.reasonCode === 'string' &&
    [
      'boundaryDenied',
      'ruleDenied',
      'boundaryAsked',
      'ruleAsked',
      'modeAsked',
      'ruleAllowed',
      'baselineAllowed',
      'baselineAsked',
    ].includes(value.reasonCode) &&
    revision(value.policyRevision, 0) &&
    hash(value.requestHash) &&
    isApprovalScope(value.scope) &&
    (value.project === undefined ||
      (value.scope.kind === 'bot' && isProjectScope(value.project))) &&
    isApprovalTrigger(value.trigger) &&
    isApprovalSelector(value.selector) &&
    Array.isArray(value.matchedRules) &&
    value.matchedRules.length <= 100 &&
    value.matchedRules.every(
      (rule) =>
        object(rule) &&
        keys(rule, ['id', 'revision', 'name', 'effect']) &&
        validAgentId(rule.id) &&
        revision(rule.revision) &&
        text(rule.name, 80) &&
        isRuleEffect(rule.effect),
    ) &&
    new Set(value.matchedRules.map((rule) => rule.id)).size === value.matchedRules.length
  );
}
export function isApprovalRulesStatus(value: unknown): value is ApprovalRulesStatus {
  return (
    object(value) &&
    keys(value, ['capability', 'available', 'revision', 'error']) &&
    value.capability === approvalRulesCapability &&
    typeof value.available === 'boolean' &&
    revision(value.revision, 0) &&
    (value.error === undefined || text(value.error, 100))
  );
}
export function isApprovalRulesSnapshot(value: unknown): value is ApprovalRulesSnapshot {
  return (
    object(value) &&
    keys(value, ['scope', 'revision', 'rules']) &&
    isApprovalScope(value.scope) &&
    revision(value.revision, 0) &&
    Array.isArray(value.rules) &&
    value.rules.length <= 1000 &&
    value.rules.every(
      (rule) =>
        isApprovalRule(rule) && sameApprovalSubject(rule.scope, value.scope as ApprovalScope),
    ) &&
    new Set(value.rules.map((rule) => rule.id)).size === value.rules.length
  );
}
export function isApprovalRuleReceipt(value: unknown): value is ApprovalRuleReceipt {
  return (
    object(value) &&
    keys(value, ['requestId', 'revision', 'scope', 'id', 'rule', 'deleted']) &&
    validAgentId(value.requestId) &&
    revision(value.revision) &&
    isApprovalScope(value.scope) &&
    validAgentId(value.id) &&
    ((value.deleted === true && value.rule === undefined) ||
      (value.deleted === undefined &&
        isApprovalRule(value.rule) &&
        value.rule.id === value.id &&
        sameApprovalScope(value.rule.scope, value.scope)))
  );
}
