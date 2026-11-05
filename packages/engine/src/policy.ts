import { randomUUID } from 'node:crypto';
import {
  type ApprovalMode,
  type BudgetScope,
  isPolicyDecision,
  isTaskPlan,
  type PolicyDecision,
} from '@daban/protocol';
import { type BridgeConfig, type BridgeFetch, callBridge } from './bridge.js';
import { readOwner } from './delegation.js';

export const name = 'daban-budget';
export const inject = ['tools', 'approval', 'agents'];
interface Execution {
  readonly token?: symbol;
  signal: AbortSignal;
  name: string;
  arguments: unknown;
  agent?: unknown;
  callId?: string;
}

interface Context {
  agents?: Parameters<typeof readOwner>[0];
  effect?: (factory: () => () => unknown) => unknown;
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
export interface SearchClaim {
  readonly root: unknown;
  readonly agent: unknown;
  readonly sessionId: string;
  readonly executionSessionId: string;
  readonly queries: readonly string[];
  readonly receipt: Promise<{ claimId: string }>;
  current(): boolean;
}
const searchClaims = new Map<symbol, { bridge: BridgeConfig; claim: SearchClaim }>();
export function readSearchClaim(token: unknown, config: BridgeConfig) {
  if (typeof token !== 'symbol') return undefined;
  const entry = searchClaims.get(token);
  return entry &&
    entry.bridge.url === config.url &&
    entry.bridge.capability === config.capability &&
    entry.bridge.socketPath === config.socketPath &&
    entry.bridge.certificateFile === config.certificateFile
    ? entry.claim
    : undefined;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function searchDeclaration(ctx: Context, exec: Execution) {
  if (
    !ctx.agents ||
    !exec.agent ||
    typeof exec.agent !== 'object' ||
    !('id' in exec.agent) ||
    typeof exec.agent.id !== 'string'
  )
    return undefined;
  const root = readOwner(ctx.agents, exec.agent, 'web_search');
  const agent = ctx.agents.get(exec.agent.id);
  const args = exec.arguments;
  if (
    !root?.session?.id ||
    agent !== exec.agent ||
    !agent?.session?.id ||
    !object(args) ||
    !Array.isArray(args.queries) ||
    args.queries.length < 1 ||
    args.queries.length > 4 ||
    !args.queries.every((query): query is string => typeof query === 'string' && !!query.trim())
  )
    return undefined;
  const queries = Object.freeze([...new Set(args.queries)]);
  const sessionId = root.session.id;
  const executionSessionId = agent.session.id;
  return {
    root,
    agent,
    sessionId,
    executionSessionId,
    queries,
    current: () =>
      !exec.signal.aborted &&
      !!ctx.agents &&
      readOwner(ctx.agents, exec.agent, 'web_search') === root &&
      ctx.agents.get(agent.id) === agent &&
      agent.session?.id === executionSessionId &&
      root.session?.id === sessionId &&
      object(exec.arguments) &&
      Array.isArray(exec.arguments.queries) &&
      JSON.stringify([...new Set(exec.arguments.queries)]) === JSON.stringify(queries),
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
  request: BridgeFetch = fetch,
) {
  if (!Number.isSafeInteger(config.limit) || config.limit < 1)
    throw new Error('INVALID_TOOL_LIMIT');
  // Waiting on a guard cannot retarget the captured physical attempt or its shared budget.
  config = structuredClone(config);
  const bridge = config.url
    ? {
        url: config.url,
        capability: config.capability,
        socketPath: config.socketPath,
        certificateFile: config.certificateFile,
      }
    : undefined;
  let calls = 0;
  const executions = new Map<symbol, string>();
  const searchResults = new Map<symbol, Promise<unknown>>();
  const ownedTokens = new Set<symbol>();
  let active = true;
  ctx.effect?.(() => () => {
    active = false;
    for (const token of ownedTokens) searchClaims.delete(token);
  });
  // Search authority belongs to this accepted run and must not survive SDK session resumes.
  const urls = new Set(config.urls);
  // One DSH process serves one accepted task. Count native and MCP calls before dispatch, including parallel requests.
  ctx.on('tools/pre-execute', async (exec: Execution, next: () => Promise<unknown>) => {
    if (exec.signal.aborted) return { kind: 'cancel' };
    // Register identity and the search flight before any fence await; scheduler preparation and dispatch are separate phases.
    const prior = typeof exec.token === 'symbol' ? searchResults.get(exec.token) : undefined;
    if (prior) return prior;
    let executionId = typeof exec.token === 'symbol' ? executions.get(exec.token) : undefined;
    if (!executionId) {
      if (calls >= config.limit)
        return {
          kind: 'deny',
          reason: 'TOOL_LIMIT',
          info: { name: 'ToolLimitError', code: 'TOOL_LIMIT' },
        };
      calls++;
      if (typeof exec.token === 'symbol') {
        executionId = randomUUID();
        executions.set(exec.token, executionId);
      }
    }
    const declaration = exec.name === 'web_search' ? searchDeclaration(ctx, exec) : undefined;
    if (declaration) {
      const current = declaration.current;
      declaration.current = () => active && current();
    }
    let grant: ((receipt: { claimId: string }) => unknown) | undefined;
    let refuse: (() => unknown) | undefined;
    const searchDenied = () => ({
      kind: 'deny',
      reason: 'SEARCH_INVALID_QUERY',
      info: { name: 'SearchError', code: 'SEARCH_INVALID_QUERY' },
    });
    if (exec.name === 'web_search') {
      if (
        !declaration ||
        typeof exec.token !== 'symbol' ||
        !bridge ||
        !config.budget ||
        !config.attemptId
      )
        return searchDenied();
      const receipt = new Promise<{ claimId: string }>((resolve, reject) => {
        grant = resolve;
        refuse = () => reject(new Error('SEARCH_INVALID_QUERY'));
      });
      // Policy reports denial; provider may never run to consume this same rejected handoff.
      receipt.catch(() => undefined);
      searchClaims.set(exec.token, { bridge, claim: { ...declaration, receipt } });
      ownedTokens.add(exec.token);
    }
    const runPolicy = async () => {
      const fence = async () => {
        if (!config.attemptId) return;
        try {
          const roots = ctx.agents?.roots();
          const rootSession = roots?.length === 1 ? roots[0].session?.id : undefined;
          if (!config.url || !rootSession) throw new Error('MODEL_FENCE_UNAVAILABLE');
          // Even read-only/native tools and approval requests close the clean window before their body can begin.
          const result = await callBridge(
            { ...config, url: config.url },
            'attempt.fence',
            { sessionId: rootSession, attemptId: config.attemptId, kind: 'tool' },
            exec.signal,
            request,
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
      };
      const dispatch = async (effect = next) => {
        let claimId: string | undefined;
        if (declaration && !declaration.current()) return searchDenied();
        if (config.budget) {
          try {
            const roots = ctx.agents?.roots();
            const rootSession = roots?.length === 1 ? roots[0].session?.id : undefined;
            if (!config.url || !rootSession || !executionId)
              throw new Error('BUDGET_OWNER_UNAVAILABLE');
            const result = await callBridge(
              { ...config, url: config.url },
              'budget.tool',
              {
                scope: config.budget,
                modelAttemptId: config.attemptId,
                sessionId: rootSession,
                callId: executionId,
                ...(declaration
                  ? {
                      search: {
                        executionSessionId: declaration.executionSessionId,
                        queries: declaration.queries,
                      },
                    }
                  : {}),
              },
              exec.signal,
              request,
            );
            if (
              !result ||
              typeof result !== 'object' ||
              !('accepted' in result) ||
              result.accepted !== true
            )
              throw new Error('BUDGET_TOOL_LIMIT');
            if (declaration) {
              if (
                !declaration.current() ||
                !('searchReceipt' in result) ||
                !object(result.searchReceipt) ||
                typeof result.searchReceipt.claimId !== 'string' ||
                !/^[a-f0-9]{64}$/.test(result.searchReceipt.claimId)
              )
                throw new Error('SEARCH_INVALID_QUERY');
              claimId = result.searchReceipt.claimId;
            }
          } catch {
            return {
              kind: 'deny',
              reason: 'BUDGET_TOOL_LIMIT',
              info: { name: 'BudgetError', code: 'BUDGET_TOOL_LIMIT' },
            };
          }
        }
        // The budget/approval waits happen after the first fence; only this attempt may enter the body.
        const changedAttempt = await fence();
        if (changedAttempt) return changedAttempt;
        if (exec.signal.aborted) return { kind: 'cancel' };
        if (declaration) {
          if (!declaration.current() || !claimId) return searchDenied();
          grant?.({ claimId });
        }
        return effect();
      };

      const blockedAttempt = await fence();
      if (blockedAttempt) return blockedAttempt;
      if (
        ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'].includes(
          exec.name,
        )
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
        let hostDecision: PolicyDecision | undefined;
        const owner =
          bridge && ctx.agents ? readOwner(ctx.agents, exec.agent, exec.name) : undefined;
        const sessionId = owner?.session?.id;
        const ownsRead = () =>
          !bridge ||
          (!!sessionId &&
            !!ctx.agents &&
            readOwner(ctx.agents, exec.agent, exec.name) === owner &&
            owner?.session?.id === sessionId);
        const blocked = () => ({
          kind: 'deny',
          reason:
            'The Host approval policy refused or invalidated this request. No HTTP request was made.',
          info: { name: 'WebPolicyError', code: 'APPROVAL_POLICY_CHANGED' },
        });
        if (bridge) {
          if (!ownsRead()) return blocked();
          try {
            const decision = await callBridge(
              bridge,
              'approval.web',
              { url, sessionId },
              exec.signal,
              request,
            );
            if (
              !ownsRead() ||
              !isPolicyDecision(decision) ||
              decision.selector.kind !== 'url' ||
              decision.selector.url !== url ||
              decision.effect === 'deny'
            )
              return blocked();
            hostDecision = decision;
          } catch {
            return blocked();
          }
        }
        const needsApproval =
          hostDecision?.effect === 'ask' || config.approvalMode === 'ask' || !url || !urls.has(url);
        const checkRead = async () => {
          if (!ownsRead()) return blocked();
          if (hostDecision && bridge) {
            try {
              const checked = await callBridge(
                bridge,
                'approval.web.check',
                { url, sessionId, decision: hostDecision },
                exec.signal,
                request,
              );
              if (
                !checked ||
                typeof checked !== 'object' ||
                !('current' in checked) ||
                checked.current !== true
              )
                return blocked();
            } catch {
              return blocked();
            }
          }
          if (exec.signal.aborted) return { kind: 'cancel' };
          // Approval and Host checks can wait while the child is removed or the root task changes.
          if (!ownsRead()) return blocked();
        };
        const approvedDispatch = async () => {
          // A refusal already visible after the Human wait must not consume shared tool quota.
          const refused = await checkRead();
          if (refused) return refused;
          return dispatch(async () => {
            const changed = await checkRead();
            if (changed) return changed;
            return next();
          });
        };
        // Page text cannot authorize another destination or append private data to an approved URL.
        if (url && needsApproval && exec.agent && ctx.approval) {
          const decision = await ctx.approval.request({
            // The child keeps its own native approval pin and turn-enclosed audit.
            agent: exec.agent,
            toolName: 'web_fetch',
            callId: exec.callId,
            reason: JSON.stringify({ url }),
            signal: exec.signal,
          });
          if (decision === 'allowed-once' && !exec.signal.aborted) return approvedDispatch();
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
        if (
          !url ||
          hostDecision?.effect === 'ask' ||
          config.approvalMode === 'ask' ||
          !urls.has(url)
        )
          return {
            kind: 'deny',
            reason:
              'Only fetch exact URLs provided by the user in this task. Ask the user to supply another URL.',
            info: { name: 'WebPolicyError', code: 'WEB_URL_NOT_AUTHORIZED' },
          };
        return approvedDispatch();
      }
      return dispatch();
    };
    if (!declaration || typeof exec.token !== 'symbol') return runPolicy();
    const result = Promise.resolve()
      .then(runPolicy)
      .then(
        (decision) => {
          if (!object(decision) || decision.kind !== 'allow') refuse?.();
          return decision;
        },
        (error: unknown) => {
          refuse?.();
          throw error;
        },
      );
    searchResults.set(exec.token, result);
    return result;
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
