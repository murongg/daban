import {
  isReplyStream,
  isRuntimeFileMetadata,
  type RuntimeTaskSummary,
  replyLimit,
  validAgentId,
} from '@daban/protocol';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export interface TaskReceipt extends RuntimeTaskSummary {
  running: boolean;
}
export function isTaskReceipt(value: unknown): value is TaskReceipt {
  return (
    record(value) &&
    Object.keys(value).every((key) =>
      [
        'chatRevision',
        'runId',
        'requestId',
        'prompt',
        'phase',
        'result',
        'error',
        'files',
        'response',
        'running',
      ].includes(key),
    ) &&
    validAgentId(value.runId) &&
    validAgentId(value.requestId) &&
    typeof value.running === 'boolean' &&
    typeof value.phase === 'string' &&
    [
      'idle',
      'starting',
      'running',
      'paused',
      'waiting',
      'completed',
      'failed',
      'stopped',
      'interrupted',
    ].includes(value.phase) &&
    (value.chatRevision === undefined ||
      (Number.isSafeInteger(value.chatRevision) && Number(value.chatRevision) >= 0)) &&
    typeof value.prompt === 'string' &&
    value.prompt.length <= 12000 &&
    typeof value.result === 'string' &&
    value.result.length <= replyLimit &&
    typeof value.error === 'string' &&
    value.error.length <= replyLimit &&
    (value.files === undefined ||
      (Array.isArray(value.files) &&
        value.files.length <= 1000 &&
        value.files.every(isRuntimeFileMetadata))) &&
    (value.response === undefined || isReplyStream(value.response))
  );
}
