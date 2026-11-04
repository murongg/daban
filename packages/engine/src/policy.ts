import { randomUUID } from 'node:crypto';
import { type ApprovalMode, type BudgetScope, isTaskPlan } from '@daban/protocol';
import { type BridgeConfig, callBridge } from './bridge.js';

export const name = 'daban-budget';
export const inject = ['tools', 'approval', 'agents'];
interface Execution {
  signal: AbortSignal;
  name: string;
  arguments: unknown;
  agent?: unknown;
  callId?: string;
}

interface Context {
  agents?: { roots: () => { session: { id: string } }[] };
  on: (
    ...hook:
      | ['tools/pre-execute', (exec: Execution, next: () => Promise<unknown>) => Promise<unknown>]
      | [
          'tools/post-execute',
          (exec: Execution, result: unknown, next: () => Promise<unknown>) => Promise<unknown>,
        ]
  ) => unknown;
  approval?: {
    request: (request: {
      agent: unknown;
      toolName: string;
      callId?: string;
      reason: string;
      signal: AbortSignal;
    }) => Promise<string>;
  };
}
function normalizedUrl(value: string) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    url.hash = '';
    return url.href;
  } catch {
    return;
  }
}
export function requestedUrls(prompt: string) {
  return [
    ...new Set(
      (prompt.match(/https?:\/\/[^\s<>"'`，。！？、；（）【】]+/gu) || [])
        .map((value) => normalizedUrl(value.replace(/[)\]}.;,!?]+$/u, '')))
        .filter((value): value is string => !!value),
    ),
  ];
}
export function apply(
  ctx: Context,
  config: {
    limit: number;
    urls: string[];
    approvalMode?: ApprovalMode;
    attemptId?: string;
    budget?: BudgetScope;
  } & Partial<BridgeConfig>,
) {
  if (!Number.isSafeInteger(config.limit) || config.limit < 1)
    throw new Error('INVALID_TOOL_LIMIT');
  let calls = 0;
  const internalIds = new WeakMap<Execution, string>();
  // Search authority belongs to this accepted run and must not survive SDK session resumes.
  const urls = new Set(config.urls);
  // One DSH process serves one accepted task. Count native and MCP calls before dispatch, including parallel requests.
  ctx.on('tools/pre-execute', async (exec: Execution, next: () => Promise<unknown>) => {
    if (exec.signal.aborted) return { kind: 'cancel' };
    const callId = exec.callId ?? internalIds.get(exec) ?? randomUUID();
    if (!exec.callId) internalIds.set(exec, callId);
    const dispatch = async () => {
      if (config.budget) {
        try {
          const roots = ctx.agents?.roots();
          if (!config.url || roots?.length !== 1) throw new Error('BUDGET_OWNER_UNAVAILABLE');
          const result = await callBridge(
            { ...config, url: config.url },
            'budget.tool',
            {
              scope: config.budget,
              modelAttemptId: config.attemptId,
              sessionId: roots[0].session.id,
              callId,
            },
            exec.signal,
          );
          if (
            !result ||
            typeof result !== 'object' ||
            !('accepted' in result) ||
            result.accepted !== true
          )
            throw new Error('BUDGET_TOOL_LIMIT');
        } catch {
          return {
            kind: 'deny',
            reason: 'BUDGET_TOOL_LIMIT',
            info: { name: 'BudgetError', code: 'BUDGET_TOOL_LIMIT' },
          };
        }
      }
      return next();
    };

    if (config.attemptId) {
      try {
        const roots = ctx.agents?.roots();
        if (!config.url || roots?.length !== 1) throw new Error('MODEL_FENCE_UNAVAILABLE');
        // Even read-only/native tools and approval requests close the clean window before their body can begin.
        const result = await callBridge(
          { ...config, url: config.url },
          'attempt.fence',
          { sessionId: roots[0].session.id, attemptId: config.attemptId, kind: 'tool' },
          exec.signal,
        );
        if (
          !result ||
          typeof result !== 'object' ||
          !('accepted' in result) ||
          result.accepted !== true
        )
          throw new Error('MODEL_FENCE_UNAVAILABLE');
      } catch {
        return {
          kind: 'deny',
          reason: 'MODEL_FENCE_UNAVAILABLE',
          info: { name: 'AttemptFenceError', code: 'MODEL_FENCE_UNAVAILABLE' },
        };
      }
    }
    if (++calls > config.limit)
      return {
        kind: 'deny',
        reason: 'TOOL_LIMIT',
        info: { name: 'ToolLimitError', code: 'TOOL_LIMIT' },
      };
    if (
      ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'].includes(exec.name)
    )
      return {
        kind: 'deny',
        reason:
          'Use the bot_schedule_* tools backed by the product service. Native Session reminders are not the product schedule catalog.',
        info: { name: 'SchedulePolicyError', code: 'NATIVE_SCHEDULE_DISABLED' },
      };
    if (
      exec.name === 'todo_write' &&
      (!exec.arguments ||
        typeof exec.arguments !== 'object' ||
        !('todos' in exec.arguments) ||
        !isTaskPlan(exec.arguments.todos))
    )
      return {
        kind: 'deny',
        reason:
          'A plan must contain at most 32 short steps (500 characters each) with pending, in_progress or completed status.',
        info: { name: 'TaskPlanError', code: 'INVALID_TASK_PLAN' },
      };
    if (exec.name === 'web_fetch') {
      const value = exec.arguments;
      const url =
        value && typeof value === 'object' && 'url' in value && typeof value.url === 'string'
          ? normalizedUrl(value.url)
          : undefined;
      // Page text cannot authorize another destination or append private data to an approved URL.
      if (url && (config.approvalMode === 'ask' || !urls.has(url)) && exec.agent && ctx.approval) {
        const decision = await ctx.approval.request({
          agent: exec.agent,
          toolName: 'web_fetch',
          callId: exec.callId,
          reason: JSON.stringify({ url }),
          signal: exec.signal,
        });
        if (decision === 'allowed-once' && !exec.signal.aborted) return dispatch();
        return {
          kind: 'deny',
          reason:
            decision === 'rejected'
              ? 'The user declined this exact one-time web request. No HTTP request was made. Do not retry it unless the user explicitly asks.'
              : decision === 'cancelled'
                ? 'This web approval was cancelled. No HTTP request was made.'
                : 'No approval answerer is available. No HTTP request was made.',
          info: {
            name: 'WebPolicyError',
            code:
              decision === 'rejected'
                ? 'WEB_APPROVAL_REJECTED'
                : decision === 'cancelled'
                  ? 'WEB_APPROVAL_CANCELLED'
                  : 'WEB_APPROVAL_UNAVAILABLE',
          },
        };
      }
      if (!url || config.approvalMode === 'ask' || !urls.has(url))
        return {
          kind: 'deny',
          reason:
            'Only fetch exact URLs provided by the user in this task. Ask the user to supply another URL.',
          info: { name: 'WebPolicyError', code: 'WEB_URL_NOT_AUTHORIZED' },
        };
    }
    return dispatch();
  });
  ctx.on(
    'tools/post-execute',
    async (exec: Execution, result: unknown, next: () => Promise<unknown>) => {
      const decision = await next();
      const object = (value: unknown): value is Record<string, unknown> =>
        !!value && typeof value === 'object' && !Array.isArray(value);
      if (
        exec.name === 'web_search' &&
        !exec.signal.aborted &&
        object(decision) &&
        decision.kind === 'accept' &&
        decision.value === undefined &&
        object(result) &&
        result.isError === false &&
        object(result.value) &&
        Array.isArray(result.value.sources)
      ) {
        // Only canonical search-index URLs authorize follow-up reads. Snippets, page links and query edits grant nothing.
        for (const source of result.value.sources)
          if (object(source) && typeof source.url === 'string') {
            const url = normalizedUrl(source.url);
            if (url) urls.add(url);
          }
      }
      return decision;
    },
  );
}
