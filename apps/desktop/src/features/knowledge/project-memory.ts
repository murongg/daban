import {
  isProjectMemoryReceipt,
  type MemoryDecision,
  type ProjectMemoryReceipt,
  type ProjectMemoryWrite,
  type RuntimeCommand,
} from '@daban/protocol';

export type MemoryMutation =
  | { type: 'projectMemory.write'; request: ProjectMemoryWrite }
  | { type: 'projectMemory.decide'; request: MemoryDecision };
export type MemoryCommand = <T = unknown>(command: RuntimeCommand) => Promise<T>;

const rejected = new Set([
  'INVALID_PROJECT_MEMORY',
  'INVALID_PROJECT_SCOPE',
  'PROJECT_MEMORY_CONFLICT',
  'PROJECT_MEMORY_SOURCE_CHANGED',
  'PROJECT_MEMORY_REQUEST_REUSED',
  'PROJECT_MEMORY_LIMIT',
  'PROJECT_SCOPE_STALE',
  'PROJECT_ACCESS_DENIED',
  'PROJECT_ARCHIVED',
  'PROJECT_NOT_FOUND',
  'PROJECT_DOCUMENT_NOT_FOUND',
  'PROJECT_CANDIDATE_NOT_FOUND',
  'BOT_ARCHIVED',
]);
export const memoryRequestRejected = (error: unknown) =>
  error instanceof Error && rejected.has(error.message);

function receipt(value: unknown, mutation: MemoryMutation): ProjectMemoryReceipt {
  if (
    !isProjectMemoryReceipt(value) ||
    value.requestId !== mutation.request.requestId ||
    value.scope.projectId !== mutation.request.scope.projectId ||
    value.state !== 'complete'
  )
    throw Error('PROJECT_MEMORY_RESULT_UNKNOWN');
  return value;
}
export async function applyProjectMemory(command: MemoryCommand, mutation: MemoryMutation) {
  try {
    return receipt(await command(mutation), mutation);
  } catch (error) {
    if (memoryRequestRejected(error)) throw error;
    // A lost acknowledgement is resolved through the durable receipt, never by replaying edited text.
    try {
      return receipt(
        await command({
          type: 'projectMemory.receipt',
          scope: mutation.request.scope,
          requestId: mutation.request.requestId,
        }),
        mutation,
      );
    } catch {
      throw error;
    }
  }
}
