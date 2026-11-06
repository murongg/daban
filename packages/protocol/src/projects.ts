import { validAgentId } from './id.js';

// Legacy scope metadata remains distinct; it grants no current project execution.
export interface ProjectScope {
  projectId: string;
  revision: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

const revision = (value: unknown, min = 1) => Number.isSafeInteger(value) && Number(value) >= min;

export function isProjectScope(value: unknown): value is ProjectScope {
  return (
    object(value) &&
    keys(value, ['projectId', 'revision']) &&
    validAgentId(value.projectId) &&
    revision(value.revision)
  );
}
