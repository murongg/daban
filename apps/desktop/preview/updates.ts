import type { UpdateBridge, UpdateMessage, UpdatePhase, UpdateStatus } from '../shared/updates';

export function updatePreview(): UpdateBridge {
  const query = new URLSearchParams(location.search).get('updates');
  const phases = [
    'available',
    'downloading',
    'downloaded',
    'current',
    'unpublished',
    'error',
    'unsupported',
  ];
  let state: UpdateStatus = {
    version: '0.1.0',
    phase: phases.includes(query ?? '') ? (query as UpdatePhase) : 'current',
  };
  if (['available', 'downloading', 'downloaded'].includes(state.phase))
    state = {
      ...state,
      nextVersion: '0.2.0',
      notes: '## Synthetic update\n\n- 合成更新内容 / Synthetic release notes',
      percent: state.phase === 'downloading' ? 42 : state.phase === 'downloaded' ? 100 : undefined,
    };
  if (state.phase === 'error') state.error = 'UPDATE_CHECK_FAILED';
  const listeners = new Set<(message: UpdateMessage) => unknown>();
  const publish = (value: Partial<UpdateStatus>) => {
    state = { ...state, ...value };
    for (const listener of listeners) listener({ type: 'status', status: { ...state } });
  };
  return {
    subscribe: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    invoke: async (command) => {
      if (command.type === 'check') publish({ phase: 'available', nextVersion: '0.2.0' });
      if (command.type === 'download') publish({ phase: 'downloading', percent: 42 });
      if (command.type === 'cancel') publish({ phase: 'available', percent: undefined });
      if (command.type === 'install') return { ok: false, error: 'AGENT_UPDATE_BUSY' };
      return { ok: true, value: { ...state } };
    },
  };
}
