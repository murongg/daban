import { isTranscriptQuery, isTranscriptScope, validAgentId } from './index.js';
import { isProjectScope, type ProjectScope } from './projects.js';
/** Provider-reported totals. Input includes cache; output includes reasoning. */
export interface ReportedUsage {
  state: 'reported';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export type TokenUsage = ReportedUsage | { state: 'unknown'; reason: string };
export interface BudgetScope {
  budgetId: string;
  revision: number;
}
export interface BudgetPolicy {
  mode: 'observe' | 'strict';
  toolLimit: number;
  activeMs: number;
  goalRounds: number;
  maxRequests?: number;
  maxTokens?: number;
  money?: { currency: string; limitMicros: number };
}
export interface BudgetPrice {
  id: string;
  routeKey: string;
  currency: string;
  createdAt: string;
  /** Integer micro-currency per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export type UsagePurpose =
  | 'main'
  | 'subtask'
  | 'compaction'
  | 'review'
  | 'fallback'
  | 'session-title';
export interface UsageReceipt {
  attemptId: string;
  scope: BudgetScope;
  runId: string;
  modelAttemptId: string;
  sessionId: string;
  rootSessionId: string;
  purpose: UsagePurpose;
  routeKey: string;
  phase: 'reserved' | 'dispatched' | 'settled' | 'released' | 'unknown';
  reservedTokens: number;
  reservedMicros?: number;
  estimatedMicros?: number;
  price?: BudgetPrice;
  usage?: TokenUsage;
  createdAt: string;
}
export interface BudgetView {
  scope: BudgetScope;
  rootId: string;
  owner?: import('./index.js').TranscriptScope;
  goalResume?: GoalResumeTarget;
  policy: BudgetPolicy;
  state: 'active' | 'limit-reached' | 'usage-unknown' | 'stopped' | 'closed';
  availability: 'recorded' | 'partial';
  historyUnmetered: boolean;
  requests: number;
  reported: ReportedUsage;
  reservedTokens: number;
  estimatedMicros?: number;
  reservedMicros?: number;
  currency?: string;
  unknownCount: number;
  unknownCostCount: number;
  warned: boolean;
  receipts: UsageReceipt[];
}
export interface BudgetSettings {
  scope: string;
  revision: number;
  policy: BudgetPolicy;
  prices: BudgetPrice[];
  strict: { requests: boolean; tokens: boolean; money: boolean; reason?: string };
}
export const defaultBudgetPolicy: BudgetPolicy = {
  mode: 'observe',
  toolLimit: 60,
  activeMs: 300000,
  goalRounds: 3,
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const positive = (v: unknown): v is number => integer(v) && v > 0;
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 1024 && !v.includes('\0');
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
export function isTokenUsage(v: unknown): v is TokenUsage {
  if (!object(v)) return false;
  if (v.state === 'unknown') return exact(v, ['state', 'reason']) && text(v.reason);
  return (
    v.state === 'reported' &&
    exact(v, ['state', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) &&
    integer(v.inputTokens) &&
    integer(v.outputTokens) &&
    integer(v.cacheReadTokens) &&
    integer(v.cacheWriteTokens) &&
    Number.isSafeInteger(v.inputTokens + v.outputTokens) &&
    v.cacheReadTokens + v.cacheWriteTokens <= v.inputTokens
  );
}
export function isBudgetScope(v: unknown): v is BudgetScope {
  return (
    object(v) && exact(v, ['budgetId', 'revision']) && text(v.budgetId) && positive(v.revision)
  );
}
export function isBudgetPolicy(v: unknown): v is BudgetPolicy {
  return (
    object(v) &&
    exact(v, [
      'mode',
      'toolLimit',
      'activeMs',
      'goalRounds',
      'maxRequests',
      'maxTokens',
      'money',
    ]) &&
    ['observe', 'strict'].includes(String(v.mode)) &&
    positive(v.toolLimit) &&
    v.toolLimit <= 10000 &&
    positive(v.activeMs) &&
    v.activeMs <= 86400000 &&
    v.goalRounds === 3 &&
    (v.maxRequests === undefined || positive(v.maxRequests)) &&
    (v.maxTokens === undefined || positive(v.maxTokens)) &&
    (v.money === undefined ||
      (object(v.money) &&
        exact(v.money, ['currency', 'limitMicros']) &&
        typeof v.money.currency === 'string' &&
        /^[A-Z]{3}$/.test(v.money.currency) &&
        positive(v.money.limitMicros)))
  );
}
export function isBudgetPrice(v: unknown): v is BudgetPrice {
  return (
    object(v) &&
    exact(v, [
      'id',
      'routeKey',
      'currency',
      'createdAt',
      'input',
      'output',
      'cacheRead',
      'cacheWrite',
    ]) &&
    text(v.id) &&
    text(v.routeKey) &&
    typeof v.currency === 'string' &&
    /^[A-Z]{3}$/.test(v.currency) &&
    text(v.createdAt) &&
    [v.input, v.output, v.cacheRead, v.cacheWrite].every(integer)
  );
}
export function isUsageReceipt(v: unknown): v is UsageReceipt {
  return (
    object(v) &&
    exact(v, [
      'attemptId',
      'scope',
      'runId',
      'modelAttemptId',
      'sessionId',
      'rootSessionId',
      'purpose',
      'routeKey',
      'phase',
      'reservedTokens',
      'reservedMicros',
      'estimatedMicros',
      'price',
      'usage',
      'createdAt',
    ]) &&
    isBudgetScope(v.scope) &&
    [
      v.attemptId,
      v.runId,
      v.modelAttemptId,
      v.sessionId,
      v.rootSessionId,
      v.routeKey,
      v.createdAt,
    ].every(text) &&
    ['main', 'subtask', 'compaction', 'review', 'fallback', 'session-title'].includes(
      String(v.purpose),
    ) &&
    ['reserved', 'dispatched', 'settled', 'released', 'unknown'].includes(String(v.phase)) &&
    integer(v.reservedTokens) &&
    (v.reservedMicros === undefined || integer(v.reservedMicros)) &&
    (v.estimatedMicros === undefined || integer(v.estimatedMicros)) &&
    (v.price === undefined || isBudgetPrice(v.price)) &&
    (v.usage === undefined || isTokenUsage(v.usage))
  );
}
export function isBudgetView(v: unknown): v is BudgetView {
  return (
    object(v) &&
    exact(v, [
      'scope',
      'rootId',
      'owner',
      'goalResume',
      'policy',
      'state',
      'availability',
      'historyUnmetered',
      'requests',
      'reported',
      'reservedTokens',
      'estimatedMicros',
      'reservedMicros',
      'currency',
      'unknownCount',
      'unknownCostCount',
      'warned',
      'receipts',
    ]) &&
    isBudgetScope(v.scope) &&
    text(v.rootId) &&
    (v.owner === undefined || isTranscriptScope(v.owner)) &&
    (v.goalResume === undefined || isGoalResumeTarget(v.goalResume)) &&
    isBudgetPolicy(v.policy) &&
    ['active', 'limit-reached', 'usage-unknown', 'stopped', 'closed'].includes(String(v.state)) &&
    ['recorded', 'partial'].includes(String(v.availability)) &&
    typeof v.historyUnmetered === 'boolean' &&
    integer(v.requests) &&
    isTokenUsage(v.reported) &&
    v.reported.state === 'reported' &&
    integer(v.reservedTokens) &&
    (v.estimatedMicros === undefined || integer(v.estimatedMicros)) &&
    (v.reservedMicros === undefined || integer(v.reservedMicros)) &&
    (v.currency === undefined ||
      (typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency))) &&
    integer(v.unknownCount) &&
    integer(v.unknownCostCount) &&
    typeof v.warned === 'boolean' &&
    Array.isArray(v.receipts) &&
    v.receipts.length <= 2000 &&
    v.receipts.every(isUsageReceipt)
  );
}
export function isBudgetSettings(v: unknown): v is BudgetSettings {
  return (
    object(v) &&
    exact(v, ['scope', 'revision', 'policy', 'prices', 'strict']) &&
    text(v.scope) &&
    integer(v.revision) &&
    isBudgetPolicy(v.policy) &&
    Array.isArray(v.prices) &&
    v.prices.length <= 200 &&
    v.prices.every(isBudgetPrice) &&
    object(v.strict) &&
    exact(v.strict, ['requests', 'tokens', 'money', 'reason']) &&
    [v.strict.requests, v.strict.tokens, v.strict.money].every((x) => typeof x === 'boolean') &&
    (v.strict.reason === undefined || text(v.strict.reason))
  );
}

export interface BudgetConfigureRequest {
  scope: string;
  id: string;
  revision: number;
  policy: BudgetPolicy;
  prices: BudgetPrice[];
}
export interface BudgetIncreaseRequest {
  goalResume?: GoalResumeTarget;
  budgetId: string;
  id: string;
  scope: import('./index.js').TranscriptScope;
  revision: number;
  policy: BudgetPolicy;
}
export type BudgetCommand =
  | { type: 'budget.goal'; owner: GoalBudgetOwner }
  | { type: 'budget.settings' }
  | { type: 'budget.configure'; request: BudgetConfigureRequest }
  | { type: 'budget.read'; query: import('./index.js').TranscriptQuery }
  | { type: 'budget.increase'; request: BudgetIncreaseRequest }
  | {
      type: 'budget.continue';
      scope: import('./index.js').TranscriptScope;
      budget: BudgetScope;
      id: string;
      goalResume?: GoalResumeTarget;
    };
export function isBudgetConfigure(v: unknown): v is BudgetConfigureRequest {
  return (
    object(v) &&
    exact(v, ['scope', 'id', 'revision', 'policy', 'prices']) &&
    text(v.scope) &&
    validAgentId(v.id) &&
    integer(v.revision) &&
    isBudgetPolicy(v.policy) &&
    Array.isArray(v.prices) &&
    v.prices.length <= 200 &&
    v.prices.every(isBudgetPrice)
  );
}

export function isBudgetCommand(v: unknown): v is BudgetCommand {
  if (!object(v)) return false;
  if (v.type === 'budget.goal') return exact(v, ['type', 'owner']) && isGoalBudgetOwner(v.owner);
  if (v.type === 'budget.settings') return exact(v, ['type']);
  if (v.type === 'budget.configure')
    return exact(v, ['type', 'request']) && isBudgetConfigure(v.request);
  if (v.type === 'budget.read') return exact(v, ['type', 'query']) && isTranscriptQuery(v.query);
  if (v.type === 'budget.increase')
    return (
      exact(v, ['type', 'request']) &&
      object(v.request) &&
      exact(v.request, ['budgetId', 'id', 'scope', 'revision', 'policy', 'goalResume']) &&
      text(v.request.budgetId) &&
      validAgentId(v.request.id) &&
      isTranscriptScope(v.request.scope) &&
      positive(v.request.revision) &&
      (v.request.goalResume === undefined || isGoalResumeTarget(v.request.goalResume)) &&
      isBudgetPolicy(v.request.policy)
    );
  return (
    v.type === 'budget.continue' &&
    exact(v, ['type', 'scope', 'budget', 'id', 'goalResume']) &&
    isBudgetScope(v.budget) &&
    (v.goalResume === undefined || isGoalResumeTarget(v.goalResume)) &&
    isTranscriptScope(v.scope) &&
    validAgentId(v.id)
  );
}

export interface GoalBudgetOwner {
  project?: ProjectScope;
  bot: string;
  chatRevision?: number;
  conversationId?: string;
}
export interface GoalResumeTarget {
  owner: GoalBudgetOwner;
  sessionId: string;
  goalId: string;
  goalRevision: number;
  humanEpoch: number;
  budget?: BudgetScope;
  historyUnmetered?: true;
}
/** Stable identity for durable Human receipts, independent of JSON object key order. */
export function goalResumeKey(target?: GoalResumeTarget) {
  return JSON.stringify(
    target
      ? [
          target.owner.bot,
          target.owner.conversationId ?? null,
          target.owner.chatRevision ?? null,
          target.sessionId,
          target.goalId,
          target.goalRevision,
          target.humanEpoch,
          target.budget?.budgetId ?? null,
          target.budget?.revision ?? null,
          target.historyUnmetered === true,
          ...(target.owner.project
            ? [target.owner.project.projectId, target.owner.project.revision]
            : []),
        ]
      : null,
  );
}
export function isGoalBudgetOwner(v: unknown): v is GoalBudgetOwner {
  return (
    object(v) &&
    exact(v, ['bot', 'chatRevision', 'conversationId', 'project']) &&
    (v.project === undefined || isProjectScope(v.project)) &&
    validAgentId(v.bot) &&
    (v.conversationId === undefined
      ? integer(v.chatRevision)
      : validAgentId(v.conversationId) && v.chatRevision === undefined)
  );
}
export function isGoalResumeTarget(v: unknown): v is GoalResumeTarget {
  return (
    object(v) &&
    exact(v, [
      'owner',
      'sessionId',
      'goalId',
      'goalRevision',
      'humanEpoch',
      'budget',
      'historyUnmetered',
    ]) &&
    isGoalBudgetOwner(v.owner) &&
    text(v.sessionId) &&
    validAgentId(v.goalId) &&
    positive(v.goalRevision) &&
    integer(v.humanEpoch) &&
    (v.budget === undefined
      ? v.historyUnmetered === true
      : isBudgetScope(v.budget) && v.historyUnmetered === undefined)
  );
}
