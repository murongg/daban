import { validAgentId } from './index.js';
import { isProjectScope, type ProjectScope } from './projects.js';

export interface GoalOwner {
  /** Archived identity only; it cannot authorize a current Goal control. */
  project?: ProjectScope;
  bot: string;
  chatRevision?: number;
  conversationId?: string;
}
export interface GoalResumeTarget {
  owner: GoalOwner;
  sessionId: string;
  goalId: string;
  goalRevision: number;
  humanEpoch: number;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function isGoalOwner(value: unknown): value is GoalOwner {
  return (
    object(value) &&
    Object.keys(value).every((key) =>
      ['bot', 'chatRevision', 'conversationId', 'project'].includes(key),
    ) &&
    validAgentId(value.bot) &&
    (value.project === undefined || isProjectScope(value.project)) &&
    (value.conversationId === undefined
      ? Number.isSafeInteger(value.chatRevision) && Number(value.chatRevision) >= 0
      : validAgentId(value.conversationId) && value.chatRevision === undefined)
  );
}
export function isGoalResumeTarget(value: unknown): value is GoalResumeTarget {
  return (
    object(value) &&
    Object.keys(value).every((key) =>
      ['owner', 'sessionId', 'goalId', 'goalRevision', 'humanEpoch'].includes(key),
    ) &&
    isGoalOwner(value.owner) &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 1024 &&
    !value.sessionId.includes('\0') &&
    validAgentId(value.goalId) &&
    Number.isSafeInteger(value.goalRevision) &&
    Number(value.goalRevision) > 0 &&
    Number.isSafeInteger(value.humanEpoch) &&
    Number(value.humanEpoch) >= 0
  );
}
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
          ...(target.owner.project
            ? [target.owner.project.projectId, target.owner.project.revision]
            : []),
        ]
      : null,
  );
}
export type GoalControlCommand = { type: 'goal.target'; owner: GoalOwner };
export const isGoalControlCommand = (value: unknown): value is GoalControlCommand =>
  object(value) &&
  Object.keys(value).every((key) => ['type', 'owner'].includes(key)) &&
  value.type === 'goal.target' &&
  isGoalOwner(value.owner);

export interface GoalProgress {
  id: string;
  revision: number;
  objective: string;
  phase: 'active' | 'paused' | 'blocked' | 'complete';
  activation: 'armed' | 'disarmed';
  rounds: number;
  limit: number;
  reason?: string;
}
export function isGoalProgress(value: unknown): value is GoalProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).every((key) =>
      ['id', 'revision', 'objective', 'phase', 'activation', 'rounds', 'limit', 'reason'].includes(
        key,
      ),
    ) &&
    validAgentId(row.id) &&
    Number.isSafeInteger(row.revision) &&
    Number(row.revision) > 0 &&
    typeof row.objective === 'string' &&
    !!row.objective.trim() &&
    row.objective.length <= 1000 &&
    !row.objective.includes('\0') &&
    typeof row.phase === 'string' &&
    ['active', 'paused', 'blocked', 'complete'].includes(row.phase) &&
    typeof row.activation === 'string' &&
    ['armed', 'disarmed'].includes(row.activation) &&
    Number.isSafeInteger(row.rounds) &&
    Number(row.rounds) >= 0 &&
    Number.isSafeInteger(row.limit) &&
    Number(row.limit) >= 1 &&
    Number(row.limit) <= 3 &&
    Number(row.rounds) <= Number(row.limit) &&
    (row.reason === undefined ||
      (typeof row.reason === 'string' && row.reason.length <= 1000 && !row.reason.includes('\0')))
  );
}

export type GoalCommand =
  | { action: 'create'; objective: string }
  | { action: 'resume' | 'pause' | 'status' | 'clear' };
export function goalCommand(prompt: string): GoalCommand | undefined {
  const text = prompt.trimStart().replace(/^\/ptc\s+/, '');
  if (!/^\/goal(?:\s|$)/.test(text)) return;
  const body = text.replace(/^\/goal\s*/, '').trim();
  const control = /^(resume|pause|status|clear)(?:\s|$)/.exec(body)?.[1];
  if (control) return { action: control as 'resume' | 'pause' | 'status' | 'clear' };
  const objective = body.replace(/^create(?:\s|$)/, '').trim();
  return objective ? { action: 'create', objective } : { action: 'status' };
}
