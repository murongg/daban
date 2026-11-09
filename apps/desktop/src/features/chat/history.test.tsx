import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { demoState } from '../../test/fixtures';
import { useHistory } from './history';

const backend = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock('../../app/Runtime', () => ({
  useRuntime: () => ({ command: backend.command }),
  runtimeError: (error: Error) => error.message,
}));
beforeEach(() => {
  backend.command.mockReset();
});
const old = {
  chatRevision: 0,
  runId: 'run-1',
  requestId: 'request-1',
  prompt: 'SYNTHETIC EARLIER QUESTION',
  result: 'SYNTHETIC EARLIER ANSWER',
  error: '',
  phase: 'completed' as const,
  files: [
    {
      path: 'model-runs/run-1/a/mock.txt',
      name: 'mock.txt',
      size: 16,
      modified: '2026-01-01T00:00:00Z',
    },
  ],
};

it('pages before the oldest cached run, reuses transcript projection and leaves composer state untouched', async () => {
  const state = demoState();
  state.messages.research = [
    { id: 'request-9', role: 'user', text: 'SYNTHETIC LATEST QUESTION' },
    { id: 'runtime-result:run-9', role: 'bot', text: 'SYNTHETIC LATEST ANSWER' },
  ];
  state.drafts.research = 'SYNTHETIC UNSENT DRAFT';
  const before = JSON.stringify(state);
  backend.command.mockResolvedValue({ bot: 'a', revision: 0, items: [old], nextBefore: 'run-1' });
  const { result } = renderHook(() => useHistory(state, 'research', 0, true));
  await waitFor(() => expect(result.current.more).toBe(true));
  expect(backend.command).toHaveBeenCalledExactlyOnceWith({
    type: 'chat.history',
    bot: 'a',
    revision: 0,
    before: 'run-9',
  });
  expect(result.current.messages.map((item) => item.text)).toEqual([
    'SYNTHETIC EARLIER QUESTION',
    'SYNTHETIC EARLIER ANSWER',
  ]);
  expect(result.current.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'mock.txt', runtimePath: old.files[0]!.path }),
    ]),
  );
  expect(result.current.records).toMatchObject([{ runId: 'run-1', phase: 'completed' }]);
  expect(result.current.more).toBe(true);
  expect(JSON.stringify(state)).toBe(before);
});

it('rejects foreign or non-progressing history pages without leaking their content', async () => {
  const state = demoState();
  state.messages.research = [{ id: 'runtime-result:run-9', role: 'bot', text: 'SYNTHETIC LATEST' }];
  backend.command.mockResolvedValue({ bot: 'b', revision: 0, items: [old] });
  const { result } = renderHook(() => useHistory(state, 'research', 0, true));
  await waitFor(() => expect(result.current.error).toBeTruthy());
  expect(result.current.messages).toEqual([]);
  expect(result.current.more).toBe(false);
  expect(backend.command).toHaveBeenCalledTimes(1);
  backend.command.mockResolvedValue({
    bot: 'a',
    revision: 0,
    items: [{ ...old, runId: 'run-9' }],
    nextBefore: 'run-9',
  });
  await act(async () => result.current.load());
  expect(result.current.messages).toEqual([]);
  expect(result.current.error).toBeTruthy();
});

it('drops a late page after switching the selected Bot and does not issue duplicate in-flight reads', async () => {
  const state = demoState();
  let release: (value: unknown) => unknown = () => {};
  backend.command.mockImplementation(({ bot }: { bot: string }) =>
    bot === 'a'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve({ bot, revision: 0, items: [] }),
  );
  const { result, rerender } = renderHook(({ bot }) => useHistory(state, bot, 0, true), {
    initialProps: { bot: 'research' },
  });
  await act(async () => result.current.load());
  expect(backend.command).toHaveBeenCalledTimes(1);
  rerender({ bot: 'writer' });
  await act(async () => {
    release({ bot: 'a', revision: 0, items: [old] });
  });
  expect(backend.command).toHaveBeenCalledTimes(2);
  expect(result.current.messages).toEqual([]);
  expect(result.current.busy).toBe(false);
});
