import { disconnected, type Schedule } from '@daban/protocol';
import { expect, it } from 'vitest';
import { agentUpgradeBlocked } from './agent';

const snapshot = () => ({
  ...disconnected('ready'),
  protocolVersion: 42,
  model: { configured: true, available: true, provider: 'mock', model: 'mock-chat' },
  schedules: { available: true, items: [] as Schedule[] },
  groups: { available: true, revision: 0, items: [] },
});
it('allows a readable idle legacy workspace and blocks unfinished work/recovery or unknown scheduling state', () => {
  const state = snapshot();
  expect(agentUpgradeBlocked(state)).toBeUndefined();
  expect(agentUpgradeBlocked({ ...state, phase: 'offline' })).toBe(
    'AGENT_LEGACY_RESTART_UNAVAILABLE',
  );
  expect(agentUpgradeBlocked({ ...state, schedules: undefined })).toBe(
    'AGENT_LEGACY_RESTART_UNAVAILABLE',
  );
  expect(
    agentUpgradeBlocked({
      ...state,
      reboot: { available: false, error: 'RECOVERY_HOST_STORE_UNAVAILABLE' },
    }),
  ).toBe('AGENT_UPDATE_BUSY');
  expect(
    agentUpgradeBlocked({
      ...state,
      agents: {
        mock: {
          running: true,
          phase: 'waiting',
          prompt: 'Synthetic',
          result: '',
          error: '',
          files: [],
          toolCount: 0,
          executedCount: 0,
          trace: [],
          history: [],
        },
      },
    }),
  ).toBe('AGENT_UPDATE_BUSY');
});
it('requires enabled schedules and accepted pending firings to be settled before a legacy restart', () => {
  const state = snapshot();
  const schedule: Schedule = {
    id: 'mock-schedule',
    bot: 'mock-bot',
    title: 'Synthetic',
    prompt: 'Synthetic',
    enabled: true,
    rule: { kind: 'every', everySeconds: 60 },
    revision: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    history: [],
  };
  expect(agentUpgradeBlocked({ ...state, schedules: { available: true, items: [schedule] } })).toBe(
    'AGENT_LEGACY_SCHEDULES_ACTIVE',
  );
  expect(
    agentUpgradeBlocked({
      ...state,
      schedules: {
        available: true,
        items: [
          {
            ...schedule,
            enabled: false,
            history: [
              {
                id: 'mock-firing',
                occurrenceAt: '2026-01-01T00:01:00Z',
                createdAt: '2026-01-01T00:01:00Z',
                state: 'pending',
                requestId: 'mock-request',
              },
            ],
          },
        ],
      },
    }),
  ).toBe('AGENT_UPDATE_BUSY');
});
