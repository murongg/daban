import { disconnected } from '@daban/protocol';
import { expect, it } from 'vitest';
import {
  isNoticeStatus,
  isNoticeTarget,
  noticeCandidates,
  noticeCopy,
  noticeKey,
  parseNoticeCommand,
} from '../shared/notifications';

it('validates scoped per-Bot choices without weakening legacy status or command boundaries', () => {
  const command = {
    type: 'bot.configure',
    revision: 2,
    scope: 'a'.repeat(64),
    bot: 'mock-alpha',
    enabled: false,
  };
  expect(parseNoticeCommand(command)).toEqual(command);
  for (const invalid of [
    { ...command, scope: 'mock-invalid' },
    { ...command, bot: '../mock' },
    { ...command, enabled: 'false' },
    { ...command, revision: -1 },
    { ...command, script: 'SYNTHETIC INJECTION' },
  ])
    expect(() => parseNoticeCommand(invalid)).toThrow('INVALID_NOTIFICATION_COMMAND');
  const legacy = {
    available: true,
    supported: true,
    enabled: false,
    revision: 0,
    delivery: 'untried',
    runtime: 'ready',
  };
  const bot = { id: 'mock-alpha', name: '合成甲', enabled: false };
  const status = { ...legacy, scope: command.scope, bots: [bot] };
  expect(isNoticeStatus(legacy)).toBe(true);
  expect(isNoticeStatus(status)).toBe(true);
  for (const invalid of [
    { ...status, scope: 'bad' },
    { ...status, bots: [bot, bot] },
    { ...status, bots: [{ ...bot, name: '' }] },
    { ...status, bots: [{ ...bot, enabled: 0 }] },
    { ...status, bots: [{ ...bot, memory: 'SYNTHETIC PRIVATE' }] },
    { ...status, bots: new Array(1) },
  ])
    expect(isNoticeStatus(invalid)).toBe(false);
});

it('collects only scoped metadata, distinguishes groups/requests and never puts task or approval data in native copy', () => {
  const snapshot = disconnected('ready');
  snapshot.notices = {
    available: true,
    items: [
      { kind: 'task', id: 'mock-run', bot: 'mock-alpha', chatRevision: 2, phase: 'completed' },
      { kind: 'group', id: 'mock-turn', group: 'mock-crew', phase: 'failed' },
    ],
  };
  snapshot.interactions = [
    {
      id: 'mock-question',
      bot: 'mock-beta',
      runId: 'mock-other-run',
      kind: 'question',
      conversationId: 'mock-crew',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      sessionId: 'mock-session',
      questions: [
        {
          id: 'mock-q',
          header: 'SYNTHETIC PRIVATE',
          question: 'SYNTHETIC PRIVATE BODY',
          options: [{ label: 'SYNTHETIC YES', description: 'SYNTHETIC ONLY' }],
        },
      ],
    },
  ];
  const candidates = noticeCandidates(snapshot);
  expect(candidates).toHaveLength(3);
  expect(candidates.every(isNoticeTarget)).toBe(true);
  expect(
    noticeKey({
      phase: 'completed',
      chatRevision: 2,
      bot: 'mock-alpha',
      id: 'mock-run',
      kind: 'task',
    }),
  ).toBe(noticeKey(candidates[0]));
  expect(candidates.map(noticeKey)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('mock-run'),
      expect.stringContaining('mock-turn'),
      expect.stringContaining('mock-question'),
    ]),
  );
  expect(JSON.stringify(candidates.map((target) => noticeCopy(target)))).not.toContain(
    'SYNTHETIC PRIVATE',
  );
  expect(isNoticeTarget({ ...candidates[0], prompt: 'SYNTHETIC INJECTION' })).toBe(false);
  expect(() =>
    parseNoticeCommand({ type: 'configure', revision: 0, enabled: true, command: 'SYNTHETIC' }),
  ).toThrow('INVALID_NOTIFICATION_COMMAND');
  expect(parseNoticeCommand({ type: 'configure', revision: 0, enabled: true })).toEqual({
    type: 'configure',
    revision: 0,
    enabled: true,
  });
});
