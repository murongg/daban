import {
  type MemoryDecision,
  matchesProjectMemoryReceipt,
  type ProjectMemoryReceipt,
  type ProjectMemoryWrite,
  type ProjectScope,
  projectMemoryFingerprint,
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

function receipt(
  value: unknown,
  mutation: MemoryMutation,
  signature: string,
): ProjectMemoryReceipt {
  if (
    !matchesProjectMemoryReceipt(
      value,
      mutation.type === 'projectMemory.write' ? 'write' : 'decide',
      mutation.request,
      signature,
    )
  )
    throw Error('PROJECT_MEMORY_RESULT_UNKNOWN');
  return value;
}
export async function queryProjectMemoryReceipt(
  command: MemoryCommand,
  mutation: MemoryMutation,
  scope: ProjectScope = mutation.request.scope,
) {
  const frozen = structuredClone(mutation);
  const signature = await projectMemoryFingerprint(frozen.request);
  // Current scope authorizes the lookup; the result must still belong to the original frozen scope.
  return receipt(
    await command({
      type: 'projectMemory.receipt',
      scope,
      requestId: frozen.request.requestId,
      signature,
    }),
    frozen,
    signature,
  );
}
export async function applyProjectMemory(command: MemoryCommand, mutation: MemoryMutation) {
  const frozen = structuredClone(mutation);
  const signature = await projectMemoryFingerprint(frozen.request);
  try {
    return receipt(await command(frozen), frozen, signature);
  } catch (error) {
    if (memoryRequestRejected(error)) throw error;
    // A lost acknowledgement is resolved through the durable receipt, never by replaying edited text.
    try {
      return await queryProjectMemoryReceipt(command, frozen);
    } catch (recoveryError) {
      // A fingerprint conflict proves this receipt belongs to another intent; scope errors do not prove a failed commit.
      if (
        recoveryError instanceof Error &&
        recoveryError.message === 'PROJECT_MEMORY_REQUEST_REUSED'
      )
        throw recoveryError;
      throw error;
    }
  }
}
