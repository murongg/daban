import { validAgentId } from './index.js';

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
