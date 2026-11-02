import type { RuntimeTask } from '@daban/protocol';
import { expect, it } from 'vitest';
import type { Message } from '../../app/state';
import { visibleMessages } from './response';

const task: RuntimeTask = {
  running: true,
  phase: 'running',
  runId: 'mock-run',
  requestId: 'mock-request',
  prompt: '合成请求',
  result: '',
  error: '',
  files: [],
  toolCount: 0,
  executedCount: 0,
  trace: [],
  history: [],
  response: { revision: 1, text: '合成前缀', state: 'streaming' },
};
it('renders an ephemeral reply without mutating saved conversation and replaces it with one authoritative final bubble', () => {
  const saved: Message[] = [{ id: 'mock-request', role: 'user', text: '合成请求' }];
  const visible = visibleMessages(saved, task);
  expect(saved).toHaveLength(1);
  expect(visible[1]).toMatchObject({
    id: 'runtime-result:mock-run',
    text: '合成前缀',
    streaming: true,
  });
  const complete = { ...task, running: false, phase: 'completed' as const, result: '合成完整回答' };
  expect(visibleMessages(saved, complete)[1]).toMatchObject({
    id: visible[1].id,
    text: '合成完整回答',
  });
  const final: Message = { id: visible[1].id, role: 'bot', text: '合成完整回答' };
  expect(visibleMessages([...saved, final], complete)).toHaveLength(2);
});
it('does not show the previous settled reply under a newly started turn', () => {
  const saved: Message[] = [
    { id: 'mock-request', role: 'user', text: '合成请求' },
    { id: 'runtime-turn:mock-run:mock-request', role: 'bot', text: '合成第一答' },
    { id: 'inserted:mock-insert', role: 'user', text: '合成插话' },
  ];
  const nextTurn: RuntimeTask = {
    ...task,
    turns: [
      { id: 'mock-request', prompt: '合成请求', result: '合成第一答' },
      { id: 'mock-insert', prompt: '合成插话', result: '' },
    ],
    response: { revision: 4, text: '合成第一答', state: 'settled' },
  };
  expect(visibleMessages(saved, nextTurn)).toBe(saved);
  expect(
    visibleMessages(saved, {
      ...nextTurn,
      response: { revision: 5, text: '合成第二答前缀', state: 'streaming' },
    }).at(-1),
  ).toMatchObject({
    id: 'runtime-result:mock-run',
    text: '合成第二答前缀',
    streaming: true,
  });
});
it('keeps an interrupted prefix before the failure notice without calling it a completed answer', () => {
  const notice: Message = { id: 'runtime-result:mock-run', role: 'bot', text: '合成任务已停止' };
  const visible = visibleMessages([notice], { ...task, running: false, phase: 'stopped' });
  expect(visible[0]).toMatchObject({
    id: 'runtime-partial:mock-run',
    incomplete: true,
    text: '合成前缀',
  });
  expect(visible[1]).toEqual(notice);
  expect(visibleMessages(visible, { ...task, running: false, phase: 'stopped' })).toHaveLength(2);
});
