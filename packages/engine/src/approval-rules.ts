import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type ApprovalRule,
  type ApprovalRuleDraft,
  type ApprovalRuleReceipt,
  type ApprovalRulesSnapshot,
  type ApprovalRulesStatus,
  type ApprovalRuleWrite,
  type ApprovalScope,
  type ApprovalSelector,
  type ApprovalTrigger,
  approvalRulesCapability,
  type InteractionInput,
  isApprovalRule,
  isApprovalRuleDraft,
  isApprovalRuleReceipt,
  isApprovalRuleWrite,
  isApprovalScope,
  isApprovalSelector,
  isApprovalTrigger,
  isPolicyDecision,
  isProjectScope,
  type PolicyDecision,
  type ProjectScope,
  type RuleEffect,
  sameApprovalScope,
} from '@daban/protocol';
import { count, eq, sql } from 'drizzle-orm';
import { migrations } from './approval-rules-migrations.js';
import { approvalRuleEdits, approvalRuleMeta, approvalRules } from './approval-rules-schema.js';
import { Fault } from './control.js';
import { configure, type Database, migrate } from './database.js';
import { canonicalJson } from './mcp-catalog.js';

export interface DecisionInput {
  riskReason?: import('@daban/protocol').CommandRiskReason;
  mode: 'ask' | 'auto' | 'full';
  baseline: RuleEffect;
  allowEligible: boolean;
  boundary?: 'ask' | 'deny';
  matches: readonly RuleEffect[];
}
export interface PolicyRequest extends Omit<DecisionInput, 'matches'> {
  project?: ProjectScope;
  scope: ApprovalScope;
  selector: ApprovalSelector;
  trigger: ApprovalTrigger;
}
export interface PolicyRun {
  id?: string;
  bot: string;
  sessionId?: string;
  conversationId?: string;
  abort: AbortController;
}
export interface RulePolicy {
  review(
    run: PolicyRun,
    selector: ApprovalSelector,
    baseline: RuleEffect,
    allowEligible?: boolean,
    riskReason?: import('@daban/protocol').CommandRiskReason,
  ): Promise<PolicyDecision>;
  assertCurrent(run: PolicyRun, decision: PolicyDecision): unknown;
}
export const approvalHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export const commandHash = (value: string) => createHash('sha256').update(value).digest('hex');
// Retain old Bot column values and SQL layout. ':' cannot occur in Bot IDs, so project keys cannot alias them.
const scopeOwner = (scope: ApprovalScope) =>
  scope.kind === 'bot' ? scope.bot : `project:${scope.scope.projectId}`;
const requestHash = (request: Pick<PolicyRequest, 'scope' | 'trigger' | 'selector' | 'project'>) =>
  approvalHash([
    request.scope,
    request.trigger,
    request.selector,
    ...(request.project ? [request.project] : []),
  ]);
export function approvalSelector(
  input: Extract<InteractionInput, { kind: 'approval' }>,
): ApprovalSelector {
  switch (input.tool) {
    case 'web_fetch':
      return { kind: 'url', url: new URL(input.url).href.split('#')[0] };
    case 'vm_command':
      return {
        kind: 'command',
        tool: 'shell',
        commandHash: commandHash(input.command),
        cwd: input.cwd,
      };
    case 'software_install':
      return { kind: 'software', planId: input.plan.id, planHash: approvalHash(input.plan) };
    case 'mcp_call':
      return {
        kind: 'mcp',
        connection: input.connection,
        configRevision: input.configRevision,
        catalogDigest: input.catalogDigest,
        tool: input.operation,
        inputHash: input.inputHash,
      };
  }
}
export function decide(
  input: DecisionInput,
): Pick<PolicyDecision, 'effect' | 'source' | 'reasonCode'> {
  if (input.boundary === 'deny' || input.baseline === 'deny')
    return { effect: 'deny', source: 'boundary', reasonCode: 'boundaryDenied' };
  if (input.matches.includes('deny'))
    return { effect: 'deny', source: 'rule', reasonCode: 'ruleDenied' };
  if (input.boundary === 'ask')
    return { effect: 'ask', source: 'boundary', reasonCode: 'boundaryAsked' };
  if (input.matches.includes('ask'))
    return { effect: 'ask', source: 'rule', reasonCode: 'ruleAsked' };
  if (input.mode === 'ask') return { effect: 'ask', source: 'mode', reasonCode: 'modeAsked' };
  if (input.allowEligible && input.matches.includes('allow'))
    return { effect: 'allow', source: 'rule', reasonCode: 'ruleAllowed' };
  return {
    effect: input.baseline,
    source: input.mode === 'full' ? 'mode' : 'risk',
    reasonCode: input.baseline === 'allow' ? 'baselineAllowed' : 'baselineAsked',
  };
}
export class ApprovalRules {
  readonly ready: Promise<unknown>;
  private db?: Database;
  constructor(
    readonly file: string,
    readonly clock = Date.now,
  ) {
    this.ready = this.load().catch(() => {
      this.db?.$client.close();
      this.db = undefined;
    });
  }
  private async load() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const handle = await open(
      this.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Fault('APPROVAL_RULES_UNAVAILABLE');
    } finally {
      await handle.close();
    }
    const client = new DatabaseSync(this.file);
    try {
      configure(client, { synchronous: 'FULL', busyTimeout: 1000 });
      this.db = migrate(client, migrations);
      this.db.insert(approvalRuleMeta).values({ id: 1, revision: 0 }).onConflictDoNothing().run();
      this.rows();
      await chmod(this.file, 0o600);
      configure(client, { journal: 'WAL' });
    } catch (error) {
      client.close();
      this.db = undefined;
      throw error;
    }
  }
  private available() {
    if (!this.db) throw new Fault('APPROVAL_RULES_UNAVAILABLE', 503);
    return this.db;
  }
  private revision() {
    const row = this.available()
      .select()
      .from(approvalRuleMeta)
      .where(eq(approvalRuleMeta.id, 1))
      .get();
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0)
      throw new Fault('APPROVAL_RULES_UNAVAILABLE', 503);
    return row.revision;
  }
  private rows() {
    try {
      return this.available()
        .select()
        .from(approvalRules)
        .all()
        .map((row) => {
          const value: unknown = JSON.parse(row.value);
          if (
            !isApprovalRule(value) ||
            value.id !== row.id ||
            value.revision !== row.revision ||
            scopeOwner(value.scope) !== row.scopeKey ||
            ![0, 1].includes(row.deleted)
          )
            throw new Fault('APPROVAL_RULES_UNAVAILABLE', 503);
          return { rule: value, deleted: row.deleted === 1 };
        });
    } catch {
      throw new Fault('APPROVAL_RULES_UNAVAILABLE', 503);
    }
  }
  async snapshot(scope: ApprovalScope): Promise<ApprovalRulesSnapshot> {
    await this.ready;
    if (!isApprovalScope(scope)) throw new Fault('INVALID_APPROVAL_RULE', 400);
    return {
      scope,
      revision: this.revision(),
      rules: this.rows()
        .filter((row) => !row.deleted && scopeOwner(row.rule.scope) === scopeOwner(scope))
        .map((row) => row.rule),
    };
  }
  async write(
    input: ApprovalRuleWrite,
    assertAuthority?: () => unknown,
  ): Promise<ApprovalRuleReceipt> {
    if (!isApprovalRuleWrite(input)) throw new Fault('INVALID_APPROVAL_RULE', 400);
    const request = structuredClone(input);
    await this.ready;
    const db = this.available();
    return db.transaction(
      () => {
        const hash = approvalHash(request);
        const previous = db
          .select()
          .from(approvalRuleEdits)
          .where(eq(approvalRuleEdits.id, request.requestId))
          .get();
        if (previous) {
          if (previous.scopeKey !== scopeOwner(request.scope) || previous.hash !== hash)
            throw new Fault('APPROVAL_REQUEST_ID_REUSED', 409);
          return this.decodeReceipt(previous.receipt);
        }
        // Only a new mutation needs current authority; a lost original reply remains recoverable after revocation.
        assertAuthority?.();
        const current = this.revision();
        if (current !== request.expectedRevision) throw new Fault('APPROVAL_RULE_CONFLICT', 409);
        const rows = this.rows();
        const id = request.action === 'save' ? request.rule.id : request.id;
        const old = rows.find((row) => row.rule.id === id);
        if (old && scopeOwner(old.rule.scope) !== scopeOwner(request.scope))
          throw new Fault('APPROVAL_RULE_CONFLICT', 409);
        if (request.action === 'delete' && (!old || old.deleted))
          throw new Fault('APPROVAL_RULE_NOT_FOUND', 404);
        if (
          db.select({ count: count() }).from(approvalRuleEdits).get()!.count >= 10000 ||
          (!old && rows.length >= 1000)
        )
          throw new Fault('APPROVAL_STORAGE_LIMIT', 409);
        const rule: ApprovalRule =
          request.action === 'save'
            ? { ...request.rule, scope: request.scope, revision: (old?.rule.revision ?? 0) + 1 }
            : { ...old!.rule, revision: old!.rule.revision + 1 };
        if (
          request.action === 'save' &&
          rule.enabled &&
          (!rule.expiresAt || Date.parse(rule.expiresAt) > this.clock()) &&
          rows.filter(
            (row) =>
              row.rule.id !== id &&
              !row.deleted &&
              row.rule.enabled &&
              (!row.rule.expiresAt || Date.parse(row.rule.expiresAt) > this.clock()),
          ).length >= 100
        )
          throw new Fault('APPROVAL_RULE_LIMIT', 409);
        const row = {
          id,
          scopeKey: scopeOwner(request.scope),
          revision: rule.revision,
          deleted: request.action === 'delete' ? 1 : 0,
          value: JSON.stringify(rule),
        };
        db.insert(approvalRules)
          .values(row)
          .onConflictDoUpdate({ target: approvalRules.id, set: row })
          .run();
        db.update(approvalRuleMeta)
          .set({ revision: sql`${approvalRuleMeta.revision} + 1` })
          .where(eq(approvalRuleMeta.id, 1))
          .run();
        const receipt: ApprovalRuleReceipt = {
          requestId: request.requestId,
          scope: request.scope,
          revision: current + 1,
          id,
          ...(request.action === 'save' ? { rule } : { deleted: true as const }),
        };
        db.insert(approvalRuleEdits)
          .values({
            id: request.requestId,
            scopeKey: scopeOwner(request.scope),
            hash,
            receipt: JSON.stringify(receipt),
          })
          .run();
        return receipt;
      },
      { behavior: 'immediate' },
    );
  }
  private decodeReceipt(encoded: string) {
    const value: unknown = JSON.parse(encoded);
    if (!isApprovalRuleReceipt(value)) throw new Fault('APPROVAL_RULES_UNAVAILABLE', 503);
    return value;
  }
  async receipt(scope: ApprovalScope, id: string): Promise<ApprovalRuleReceipt> {
    await this.ready;
    const row = this.available()
      .select()
      .from(approvalRuleEdits)
      .where(eq(approvalRuleEdits.id, id))
      .get();
    if (!row || row.scopeKey !== scopeOwner(scope))
      throw new Fault('APPROVAL_RECEIPT_NOT_FOUND', 404);
    const receipt = this.decodeReceipt(row.receipt);
    if (!sameApprovalScope(receipt.scope, scope))
      throw new Fault('APPROVAL_RECEIPT_NOT_FOUND', 404);
    return receipt;
  }
  private matches(
    request: Pick<PolicyRequest, 'scope' | 'selector' | 'trigger' | 'project'>,
    preview?: ApprovalRuleDraft,
  ) {
    let rows = this.rows()
      .filter((row) => !row.deleted)
      .map((row) => row.rule);
    if (preview) {
      if (!isApprovalRuleDraft(preview)) throw new Fault('INVALID_APPROVAL_RULE', 400);
      const previous = rows.find((rule) => rule.id === preview.id);
      if (previous && scopeOwner(previous.scope) !== scopeOwner(request.scope))
        throw new Fault('APPROVAL_RULE_CONFLICT', 409);
      rows = [
        ...rows.filter((rule) => rule.id !== preview.id),
        { ...preview, scope: request.scope, revision: (previous?.revision ?? 0) + 1 },
      ];
    }
    // Archived project selectors remain readable; retired project runs cannot obtain dispatch authority.
    return rows
      .filter(
        (rule) =>
          rule.enabled &&
          (scopeOwner(rule.scope) === scopeOwner(request.scope) ||
            (request.scope.kind === 'bot' &&
              request.project &&
              rule.scope.kind === 'project' &&
              rule.scope.scope.projectId === request.project.projectId)) &&
          rule.trigger === request.trigger &&
          (!rule.expiresAt || Date.parse(rule.expiresAt) > this.clock()) &&
          approvalHash(rule.selector) === approvalHash(request.selector),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, revision, name, effect }) => ({ id, revision, name, effect }));
  }
  async evaluate(request: PolicyRequest, preview?: ApprovalRuleDraft): Promise<PolicyDecision> {
    await this.ready;
    if (
      !isApprovalScope(request.scope) ||
      (request.project !== undefined &&
        (request.scope.kind !== 'bot' || !isProjectScope(request.project))) ||
      !isApprovalSelector(request.selector) ||
      !isApprovalTrigger(request.trigger)
    )
      throw new Fault('INVALID_APPROVAL_RULE', 400);
    const matchedRules = this.matches(request, preview);
    return {
      ...decide({ ...request, matches: matchedRules.map((rule) => rule.effect) }),
      matchedRules,
      policyRevision: this.revision(),
      requestHash: requestHash(request),
      scope: request.scope,
      trigger: request.trigger,
      selector: request.selector,
      ...(request.project ? { project: structuredClone(request.project) } : {}),
      ...(request.riskReason ? { riskReason: request.riskReason } : {}),
    };
  }
  assertCurrent(decision: PolicyDecision) {
    if (
      !isPolicyDecision(decision) ||
      decision.policyRevision !== this.revision() ||
      decision.requestHash !== requestHash(decision) ||
      canonicalJson(this.matches(decision)) !== canonicalJson(decision.matchedRules)
    )
      throw new Fault('APPROVAL_POLICY_CHANGED', 409);
  }
  async status(): Promise<ApprovalRulesStatus> {
    await this.ready;
    try {
      return { capability: approvalRulesCapability, available: true, revision: this.revision() };
    } catch {
      return {
        capability: approvalRulesCapability,
        available: false,
        revision: 0,
        error: 'APPROVAL_RULES_UNAVAILABLE',
      };
    }
  }
  async close() {
    await this.ready;
    this.db?.$client.close();
    this.db = undefined;
  }
}
