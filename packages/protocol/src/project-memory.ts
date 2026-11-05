import { validAgentId } from './id.js';
import { type DocumentUpload, isDocumentUpload, isKnowledgeContent } from './index.js';
import {
  isProjectScope,
  type ProjectGrant,
  type ProjectScope,
  sameProjectScope,
} from './projects.js';

export const projectMemoryCapability = 'project-memory-v1';
export interface ProjectMemoryAvailability {
  available: boolean;
  capability: typeof projectMemoryCapability;
  error?: string;
}
export interface ProjectDocumentRef {
  id: string;
  revision: number;
}
export interface ProjectDocumentInfo extends ProjectDocumentRef {
  projectId: string;
  kind: 'reference' | 'confirmed-memory';
  title: string;
  size: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectDocument extends ProjectDocumentInfo {
  content: string;
}
export type ProjectPublishSource =
  | { kind: 'text'; title: string; content: string }
  | { kind: 'upload'; file: DocumentUpload }
  | {
      kind: 'bot-document';
      bot: string;
      document: ProjectDocumentRef;
      expectedRevision: number;
    };
export type ProjectOrigin =
  | { kind: 'text' }
  | { kind: 'upload'; name: string; digest: string }
  | { kind: 'candidate'; candidate: ProjectDocumentRef; sources: ProjectDocumentRef[] }
  | Extract<ProjectPublishSource, { kind: 'bot-document' }>;
export interface ProjectDocumentVersion extends ProjectDocumentInfo {
  // Private publication and candidate IDs belong only on human audit routes, never model document DTOs.
  origin?: ProjectOrigin;
}
export interface ProjectPublicationPreview {
  scope: ProjectScope;
  title: string;
  content: string;
  digest: string;
  members: ProjectGrant[];
}
export type ProjectMemoryWrite = { requestId: string; scope: ProjectScope } & (
  | { action: 'publish'; digest: string; source: ProjectPublishSource }
  | { action: 'update'; document: ProjectDocumentRef; title: string; content: string }
  | { action: 'withdraw'; document: ProjectDocumentRef }
  | { action: 'restore'; document: ProjectDocumentRef; targetRevision: number }
);
export interface MemoryProposal {
  requestId: string;
  scope: ProjectScope;
  content: string;
  reason: string;
  sources: ProjectDocumentRef[];
}
export type ProposalState = 'pending' | 'accepted' | 'rejected' | 'stale';
export interface MemoryCandidate {
  id: string;
  projectId: string;
  scopeRevision: number;
  proposer: string;
  revision: number;
  state: ProposalState;
  content: string;
  reason: string;
  sources: ProjectDocumentRef[];
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
}
export interface MemoryDecision {
  requestId: string;
  scope: ProjectScope;
  candidateId: string;
  candidateRevision: number;
  action: 'accept' | 'reject';
  content: string;
  target?: ProjectDocumentRef;
}
export type ProjectMemoryReceipt = {
  requestId: string;
  scope: ProjectScope;
} & (
  | { state: 'unknown' }
  | {
      state: 'complete';
      operation: 'write' | 'propose' | 'decide';
      // Legacy stored receipts omit this; completing a pending intent requires an exact signature.
      signature?: string;
      document?: ProjectDocument;
      candidate?: MemoryCandidate;
    }
);
export type ProjectMemoryCommand =
  | { type: 'projectMemory.status' }
  | { type: 'projectMemory.preview'; scope: ProjectScope; source: ProjectPublishSource }
  | { type: 'projectMemory.list'; scope: ProjectScope; includeDeleted?: boolean }
  | { type: 'projectMemory.read'; scope: ProjectScope; document: ProjectDocumentRef }
  | { type: 'projectMemory.versions'; scope: ProjectScope; id: string; before?: number }
  | { type: 'projectMemory.candidates'; scope: ProjectScope; state?: ProposalState }
  | { type: 'projectMemory.candidate'; scope: ProjectScope; id: string }
  | { type: 'projectMemory.write'; request: ProjectMemoryWrite }
  | { type: 'projectMemory.decide'; request: MemoryDecision }
  | { type: 'projectMemory.receipt'; scope: ProjectScope; requestId: string; signature?: string };

// Keep the canonical bytes stable: existing durable operation signatures use this encoding.
export const projectMemoryText = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
export async function projectMemoryFingerprint(request: ProjectMemoryWrite | MemoryDecision) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(projectMemoryText(request)),
  );
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const text = (value: unknown, max: number) =>
  typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const content = (value: unknown): value is string => isKnowledgeContent(value) && !!value.trim();
const proposalContent = (value: unknown): value is string =>
  content(value) && Array.from(value).length <= 2000;
export function isProjectMemoryAvailability(value: unknown): value is ProjectMemoryAvailability {
  return (
    object(value) &&
    keys(value, ['available', 'capability', 'error']) &&
    typeof value.available === 'boolean' &&
    value.capability === projectMemoryCapability &&
    (value.error === undefined ||
      (typeof value.error === 'string' && /^[A-Z_]{1,100}$/.test(value.error)))
  );
}
export function isProposalState(value: unknown): value is ProposalState {
  return ['pending', 'accepted', 'rejected', 'stale'].includes(String(value));
}
export function isProjectDocumentRef(value: unknown): value is ProjectDocumentRef {
  return (
    object(value) &&
    keys(value, ['id', 'revision']) &&
    validAgentId(value.id) &&
    revision(value.revision)
  );
}
function sourceReferences(value: unknown): value is ProjectDocumentRef[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 10 &&
    value.every(isProjectDocumentRef) &&
    new Set(value.map((source) => source.id)).size === value.length
  );
}
export function isProjectPublishSource(value: unknown): value is ProjectPublishSource {
  if (!object(value)) return false;
  if (value.kind === 'text')
    return (
      keys(value, ['kind', 'title', 'content']) && text(value.title, 240) && content(value.content)
    );
  if (value.kind === 'upload') return keys(value, ['kind', 'file']) && isDocumentUpload(value.file);
  return (
    value.kind === 'bot-document' &&
    keys(value, ['kind', 'bot', 'document', 'expectedRevision']) &&
    validAgentId(value.bot) &&
    isProjectDocumentRef(value.document) &&
    revision(value.expectedRevision) &&
    value.document.revision <= Number(value.expectedRevision)
  );
}
export function isProjectMemoryWrite(value: unknown): value is ProjectMemoryWrite {
  if (!object(value) || !validAgentId(value.requestId) || !isProjectScope(value.scope))
    return false;
  const base = ['requestId', 'scope', 'action'];
  if (value.action === 'publish')
    return (
      keys(value, [...base, 'source', 'digest']) &&
      digest(value.digest) &&
      isProjectPublishSource(value.source)
    );
  if (!isProjectDocumentRef(value.document)) return false;
  if (value.action === 'withdraw') return keys(value, [...base, 'document']);
  if (value.action === 'restore')
    return keys(value, [...base, 'document', 'targetRevision']) && revision(value.targetRevision);
  return (
    value.action === 'update' &&
    keys(value, [...base, 'document', 'title', 'content']) &&
    text(value.title, 240) &&
    content(value.content)
  );
}
export function isMemoryProposal(value: unknown): value is MemoryProposal {
  return (
    object(value) &&
    keys(value, ['requestId', 'scope', 'content', 'reason', 'sources']) &&
    validAgentId(value.requestId) &&
    isProjectScope(value.scope) &&
    proposalContent(value.content) &&
    text(value.reason, 1000) &&
    sourceReferences(value.sources)
  );
}
export function isMemoryDecision(value: unknown): value is MemoryDecision {
  return (
    object(value) &&
    keys(value, [
      'requestId',
      'scope',
      'candidateId',
      'candidateRevision',
      'action',
      'content',
      'target',
    ]) &&
    validAgentId(value.requestId) &&
    isProjectScope(value.scope) &&
    validAgentId(value.candidateId) &&
    revision(value.candidateRevision) &&
    ['accept', 'reject'].includes(String(value.action)) &&
    proposalContent(value.content) &&
    (value.target === undefined ||
      (value.action === 'accept' && isProjectDocumentRef(value.target)))
  );
}
export function isProjectMemoryCommand(value: unknown): value is ProjectMemoryCommand {
  if (!object(value)) return false;
  if (value.type === 'projectMemory.status') return keys(value, ['type']);
  if (value.type === 'projectMemory.write')
    return keys(value, ['type', 'request']) && isProjectMemoryWrite(value.request);
  if (value.type === 'projectMemory.decide')
    return keys(value, ['type', 'request']) && isMemoryDecision(value.request);
  if (!isProjectScope(value.scope)) return false;
  if (value.type === 'projectMemory.preview')
    return keys(value, ['type', 'scope', 'source']) && isProjectPublishSource(value.source);
  if (value.type === 'projectMemory.list')
    return (
      keys(value, ['type', 'scope', 'includeDeleted']) &&
      (value.includeDeleted === undefined || typeof value.includeDeleted === 'boolean')
    );
  if (value.type === 'projectMemory.read')
    return keys(value, ['type', 'scope', 'document']) && isProjectDocumentRef(value.document);
  if (value.type === 'projectMemory.versions')
    return (
      keys(value, ['type', 'scope', 'id', 'before']) &&
      validAgentId(value.id) &&
      (value.before === undefined || revision(value.before))
    );
  if (value.type === 'projectMemory.candidates')
    return (
      keys(value, ['type', 'scope', 'state']) &&
      (value.state === undefined || isProposalState(value.state))
    );
  if (value.type === 'projectMemory.candidate')
    return keys(value, ['type', 'scope', 'id']) && validAgentId(value.id);
  return (
    value.type === 'projectMemory.receipt' &&
    keys(value, ['type', 'scope', 'requestId', 'signature']) &&
    validAgentId(value.requestId) &&
    (value.signature === undefined || digest(value.signature))
  );
}
export function isProjectDocumentInfo(value: unknown): value is ProjectDocumentInfo {
  return (
    object(value) &&
    keys(value, [
      'id',
      'revision',
      'projectId',
      'kind',
      'title',
      'size',
      'deleted',
      'createdAt',
      'updatedAt',
    ]) &&
    validAgentId(value.id) &&
    revision(value.revision) &&
    validAgentId(value.projectId) &&
    ['reference', 'confirmed-memory'].includes(String(value.kind)) &&
    text(value.title, 240) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) > 0 &&
    Number(value.size) <= 200 * 1024 &&
    typeof value.deleted === 'boolean' &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}
export function isProjectDocument(value: unknown): value is ProjectDocument {
  if (!object(value)) return false;
  const { content: body, ...info } = value;
  return (
    isProjectDocumentInfo(info) &&
    content(body) &&
    new TextEncoder().encode(body).length === info.size
  );
}
export function isProjectPublicationPreview(value: unknown): value is ProjectPublicationPreview {
  return (
    object(value) &&
    keys(value, ['scope', 'title', 'content', 'digest', 'members']) &&
    isProjectScope(value.scope) &&
    text(value.title, 240) &&
    content(value.content) &&
    digest(value.digest) &&
    Array.isArray(value.members) &&
    value.members.length <= 16 &&
    value.members.every(
      (member) =>
        object(member) &&
        keys(member, ['bot', 'content', 'browser']) &&
        validAgentId(member.bot) &&
        ['read', 'write'].includes(String(member.content)) &&
        typeof member.browser === 'boolean',
    ) &&
    new Set(value.members.map((member) => member.bot)).size === value.members.length
  );
}
export function isProjectDocumentVersion(value: unknown): value is ProjectDocumentVersion {
  if (!object(value)) return false;
  const { origin, ...info } = value;
  return (
    isProjectDocumentInfo(info) &&
    (origin === undefined ||
      (object(origin) &&
        (origin.kind === 'text'
          ? keys(origin, ['kind'])
          : origin.kind === 'upload'
            ? keys(origin, ['kind', 'name', 'digest']) &&
              text(origin.name, 240) &&
              digest(origin.digest)
            : origin.kind === 'candidate'
              ? keys(origin, ['kind', 'candidate', 'sources']) &&
                isProjectDocumentRef(origin.candidate) &&
                sourceReferences(origin.sources)
              : isProjectPublishSource(origin))))
  );
}
export function isMemoryCandidate(value: unknown): value is MemoryCandidate {
  if (!object(value)) return false;
  const {
    id,
    projectId,
    scopeRevision,
    proposer,
    revision: version,
    state,
    createdAt,
    updatedAt,
    reviewedAt,
    ...proposal
  } = value;
  return (
    validAgentId(id) &&
    validAgentId(proposer) &&
    revision(version) &&
    isProposalState(state) &&
    isMemoryProposal({
      ...proposal,
      requestId: id,
      scope: { projectId, revision: scopeRevision },
    }) &&
    typeof createdAt === 'string' &&
    Number.isFinite(Date.parse(createdAt)) &&
    typeof updatedAt === 'string' &&
    Number.isFinite(Date.parse(updatedAt)) &&
    (reviewedAt === undefined ||
      (typeof reviewedAt === 'string' && Number.isFinite(Date.parse(reviewedAt))))
  );
}
export function isProjectMemoryReceipt(value: unknown): value is ProjectMemoryReceipt {
  if (!object(value) || !validAgentId(value.requestId) || !isProjectScope(value.scope))
    return false;
  if (value.state === 'unknown') return keys(value, ['requestId', 'scope', 'state']);
  return (
    value.state === 'complete' &&
    keys(value, [
      'requestId',
      'scope',
      'state',
      'operation',
      'signature',
      'document',
      'candidate',
    ]) &&
    ['write', 'propose', 'decide'].includes(String(value.operation)) &&
    (value.signature === undefined || digest(value.signature)) &&
    (value.document === undefined ||
      (isProjectDocument(value.document) && value.document.projectId === value.scope.projectId)) &&
    (value.candidate === undefined ||
      (isMemoryCandidate(value.candidate) &&
        value.candidate.projectId === value.scope.projectId)) &&
    (value.operation === 'write' ? value.document !== undefined : value.candidate !== undefined)
  );
}

export function matchesProjectMemoryReceipt(
  value: unknown,
  operation: 'write' | 'decide',
  request: ProjectMemoryWrite | MemoryDecision,
  signature: string,
): value is Extract<ProjectMemoryReceipt, { state: 'complete' }> {
  if (
    !isProjectMemoryReceipt(value) ||
    value.state !== 'complete' ||
    value.requestId !== request.requestId ||
    !sameProjectScope(value.scope, request.scope) ||
    value.operation !== operation ||
    value.signature !== signature
  )
    return false;
  if (isMemoryDecision(request)) {
    if (
      value.candidate?.id !== request.candidateId ||
      value.candidate.revision !== request.candidateRevision + 1 ||
      value.candidate.content !== request.content ||
      value.candidate.state !== (request.action === 'accept' ? 'accepted' : 'rejected')
    )
      return false;
    return request.action === 'reject'
      ? !value.document
      : !!value.document &&
          value.document.kind === 'confirmed-memory' &&
          !value.document.deleted &&
          value.document.content === request.content &&
          (request.target
            ? value.document.id === request.target.id &&
              value.document.revision === request.target.revision + 1
            : value.document.revision === 1);
  }
  const document = value.document;
  if (!document) return false;
  if (request.action === 'publish')
    return (
      document.revision === 1 &&
      document.kind === 'reference' &&
      !document.deleted &&
      (request.source.kind !== 'text' ||
        (document.title === request.source.title && document.content === request.source.content))
    );
  return (
    document.id === request.document.id &&
    document.revision === request.document.revision + 1 &&
    document.deleted === (request.action === 'withdraw') &&
    (request.action !== 'update' ||
      (document.title === request.title && document.content === request.content))
  );
}
