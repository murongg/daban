import { validAgentId } from './id.js';

// Archived metadata and older peer capabilities remain readable; they grant no current execution authority.
export const projectCapability = 'project-scope-v1';
export interface ProjectScope {
  projectId: string;
  revision: number;
}
export interface ProjectGrant {
  bot: string;
  content: 'read' | 'write';
  browser: boolean;
}
export interface Project {
  id: string;
  name: string;
  revision: number;
  status: 'active' | 'archived';
  grants: ProjectGrant[];
  environment: {
    files: 'project' | 'legacy-shared';
    browser: 'private' | 'project' | 'legacy-shared';
  };
}
export interface ProjectInput {
  name: string;
  grants: { bot: string; content?: 'read' | 'write'; browser?: boolean }[];
  browser?: 'private' | 'project';
}
export type ProjectWrite = {
  requestId: string;
  projectId: string;
  expectedRevision: number;
} & ({ action: 'create' | 'update'; value: ProjectInput } | { action: 'archive' });
export interface ProjectFileScope {
  scope: ProjectScope;
  resourceId: string;
  bot?: string;
  runId?: string;
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
export function isProjectInput(value: unknown): value is ProjectInput {
  return (
    object(value) &&
    keys(value, ['name', 'grants', 'browser']) &&
    typeof value.name === 'string' &&
    !!value.name.trim() &&
    value.name.length <= 80 &&
    !value.name.includes('\0') &&
    (value.browser === undefined || value.browser === 'private' || value.browser === 'project') &&
    Array.isArray(value.grants) &&
    value.grants.length <= 16 &&
    value.grants.every(
      (grant) =>
        object(grant) &&
        keys(grant, ['bot', 'content', 'browser']) &&
        validAgentId(grant.bot) &&
        (grant.content === undefined || grant.content === 'read' || grant.content === 'write') &&
        (grant.browser === undefined || typeof grant.browser === 'boolean'),
    ) &&
    new Set(value.grants.map((grant) => grant.bot)).size === value.grants.length
  );
}
export function isProject(value: unknown): value is Project {
  return (
    object(value) &&
    keys(value, ['id', 'name', 'revision', 'status', 'grants', 'environment']) &&
    validAgentId(value.id) &&
    revision(value.revision) &&
    ['active', 'archived'].includes(String(value.status)) &&
    object(value.environment) &&
    keys(value.environment, ['files', 'browser']) &&
    ['project', 'legacy-shared'].includes(String(value.environment.files)) &&
    ['private', 'project', 'legacy-shared'].includes(String(value.environment.browser)) &&
    isProjectInput({ name: value.name, grants: value.grants }) &&
    Array.isArray(value.grants) &&
    value.grants.every(
      (grant) =>
        object(grant) &&
        ['read', 'write'].includes(String(grant.content)) &&
        typeof grant.browser === 'boolean',
    )
  );
}
export function isProjectWrite(value: unknown): value is ProjectWrite {
  return (
    object(value) &&
    keys(value, [
      'requestId',
      'projectId',
      'expectedRevision',
      'action',
      ...(value.action === 'archive' ? [] : ['value']),
    ]) &&
    validAgentId(value.requestId) &&
    validAgentId(value.projectId) &&
    revision(value.expectedRevision, value.action === 'create' ? 0 : 1) &&
    (value.action === 'create'
      ? value.expectedRevision === 0 && isProjectInput(value.value)
      : value.action === 'update'
        ? isProjectInput(value.value)
        : value.action === 'archive')
  );
}
export function isProjectFileScope(value: unknown): value is ProjectFileScope {
  return (
    object(value) &&
    keys(value, ['scope', 'resourceId', 'bot', 'runId']) &&
    isProjectScope(value.scope) &&
    validAgentId(value.resourceId) &&
    (value.bot === undefined || validAgentId(value.bot)) &&
    (value.runId === undefined || (validAgentId(value.runId) && validAgentId(value.bot)))
  );
}
export function sameProjectScope(
  first: ProjectScope | undefined,
  second: ProjectScope | undefined,
) {
  return first === undefined
    ? second === undefined
    : !!second && first.projectId === second.projectId && first.revision === second.revision;
}

export interface ProjectFileRequest {
  project?: ProjectScope;
  task?: { bot: string; runId: string };
}
export function isProjectFileRequest(value: unknown): value is ProjectFileRequest {
  return (
    object(value) &&
    (value.project === undefined || isProjectScope(value.project)) &&
    (value.task === undefined ||
      (isProjectScope(value.project) &&
        object(value.task) &&
        keys(value.task, ['bot', 'runId']) &&
        validAgentId(value.task.bot) &&
        validAgentId(value.task.runId)))
  );
}
export function projectFileKey(value: ProjectFileRequest & { path: string }) {
  return JSON.stringify([
    value.project?.projectId ?? null,
    value.project?.revision ?? null,
    value.task?.bot ?? null,
    value.task?.runId ?? null,
    value.path,
  ]);
}
export function projectFileMatches(value: unknown, expected: ProjectFileRequest) {
  return (
    isProjectFileRequest(value) &&
    sameProjectScope(value.project, expected.project) &&
    value.task?.bot === expected.task?.bot &&
    value.task?.runId === expected.task?.runId
  );
}
