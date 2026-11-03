import type { TaskPhase } from '@daban/protocol';
import { type MessageKey, t } from './locale';

const errors: Record<string, MessageKey> = {
  MODEL_CANCELLED: 'state.taskStoppedSavedFilesRetained',
  MODEL_TIME_LIMIT: 'errors.taskTimeLimit',
  TOOL_LIMIT: 'errors.taskToolLimit',
  RESPONSE_TOO_LARGE: 'errors.taskReplyTooLarge',
  TASK_INTERRUPTED: 'errors.taskEnvironmentRestarted',
  GROUP_RESULT_EMPTY: 'errors.taskNoVisibleResult',
  GROUP_SOURCE_CLOSED: 'errors.groupSourceClosed',
  GROUP_COLLABORATION_CONFLICT: 'errors.groupCollaborationConflict',
};
const phases: Partial<Record<TaskPhase, MessageKey>> = {
  starting: 'execution.preparing',
  running: 'common.running',
  waiting: 'execution.waitingReply',
  paused: 'common.waitingComputerHandback',
  completed: 'common.completed',
  failed: 'common.incomplete',
  stopped: 'common.stopped',
  interrupted: 'common.interrupted',
};
export const taskErrorKey = (code: string) =>
  Object.hasOwn(errors, code) ? errors[code] : undefined;
export function taskPhase(phase: TaskPhase) {
  return t(phases[phase]) || phase;
}
