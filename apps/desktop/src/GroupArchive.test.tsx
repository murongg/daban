import type { Group, GroupActionAck, GroupActionRequest } from '@daban/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { expect, it, vi } from 'vitest';
import { GroupArchive } from './GroupArchive';
import { initialState, reduce, type State } from './state';
import { restore, serialize } from './storage';

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  snapshot: {
    phase: 'ready',
    protocolVersion: 28,
    groups: { available: true, revision: 1, items: [] as Group[] },
    agents: {},
  },
}));
vi.mock('./Runtime', () => ({
  runtimeError: (error: Error) => error.message,
  useRuntime: () => ({ enabled: true, snapshot: mocks.snapshot, command: mocks.command }),
}));
const group: Group = {
  id: 'crew',
  name: '合成协作',
  members: ['chief', 'a', 'b'],
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
let saved: State;
function Harness({
  seed = initialState(),
  close = () => {},
  notify = () => {},
}: {
  seed?: State;
  close?: () => unknown;
  notify?: (message: string) => unknown;
}) {
  const [state, dispatch] = useReducer(reduce, seed);
  saved = state;
  return (
    <GroupArchive
      state={state}
      bot={state.bots.find((bot) => bot.id === 'crew')!}
      dispatch={dispatch}
      close={close}
      notify={notify}
    />
  );
}
const ack = (
  request: GroupActionRequest,
  current: Group = { ...group, archived: true, revision: 2 },
): GroupActionAck => ({
  group: current,
  receipt: { request, revision: request.revision + 1, completedAt: '2026-01-01T01:00:00Z' },
});
it('keeps an uncertain action across close/reopen and reconciles its exact receipt without resending', async () => {
  mocks.snapshot.groups.items = [group];
  const seed = initialState();
  seed.drafts.crew = 'SYNTHETIC RETAINED';
  let request: GroupActionRequest | undefined;
  mocks.command.mockImplementation(async (command) => {
    if (command.type === 'group.action') {
      request = command.request;
      throw new Error('RUNTIME_TIMEOUT');
    }
    return ack(request!);
  });
  const view = render(<Harness seed={seed} />);
  await userEvent.click(screen.getByRole('button', { name: '确认归档' }));
  await waitFor(() => expect(saved.groupActions.crew?.id).toBeDefined());
  const copy = restore(serialize(saved));
  view.unmount();
  const close = vi.fn();
  render(<Harness seed={copy} close={close} />);
  await userEvent.click(screen.getByRole('button', { name: '核对操作结果' }));
  await waitFor(() => expect(saved.groupActions.crew).toBeUndefined());
  expect(saved.bots.find((bot) => bot.id === 'crew')?.archived).toBe(true);
  expect(saved.drafts.crew).toBe('SYNTHETIC RETAINED');
  expect(
    mocks.command.mock.calls.filter(([command]) => command.type === 'group.action'),
  ).toHaveLength(1);
  expect(close).toHaveBeenCalled();
});
it('shows later canonical state when an earlier archive acknowledgement is replayed', async () => {
  mocks.snapshot.groups.items = [group];
  const notify = vi.fn();
  mocks.command.mockImplementation(async (command) =>
    ack(command.request, { ...group, name: '合成后来恢复', revision: 3 }),
  );
  render(<Harness notify={notify} />);
  await userEvent.click(screen.getByRole('button', { name: '确认归档' }));
  await waitFor(() =>
    expect(saved.bots.find((bot) => bot.id === 'crew')?.name).toBe('合成后来恢复'),
  );
  expect(saved.bots.find((bot) => bot.id === 'crew')?.archived).toBe(false);
  expect(notify).toHaveBeenCalledWith('此前操作已完成，群聊后来已更新，已显示当前状态。');
});
it('clears only definite refusals and retains the draft when collaboration is still busy', async () => {
  mocks.snapshot.groups.items = [group];
  mocks.command.mockRejectedValue(new Error('GROUP_BUSY'));
  const seed = initialState();
  seed.drafts.crew = 'SYNTHETIC NOT SENT';
  render(<Harness seed={seed} />);
  await userEvent.click(screen.getByRole('button', { name: '确认归档' }));
  await waitFor(() => expect(screen.getByText(/先结束群聊中尚未完成的协作/)).toBeInTheDocument());
  expect(saved.groupActions.crew).toBeUndefined();
  expect(saved.drafts.crew).toBe('SYNTHETIC NOT SENT');
});
it('uses acknowledged group state when reopening before the next runtime snapshot arrives', async () => {
  mocks.snapshot.groups.items = [group];
  const seed = reduce(initialState(), {
    type: 'groups',
    groups: [{ ...group, name: '合成已确认归档', revision: 2, archived: true }],
  });
  mocks.command.mockImplementation(async (command) =>
    ack(command.request, { ...group, revision: 3 }),
  );
  render(<Harness seed={seed} />);
  expect(screen.getByRole('dialog', { name: '恢复群聊' })).toBeVisible();
  expect(screen.getByText('合成已确认归档')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '确认恢复' }));
  expect(mocks.command).toHaveBeenLastCalledWith({
    type: 'group.action',
    request: expect.objectContaining({
      group: 'crew',
      revision: 2,
      action: 'restore',
    }),
  });
});
