import {
  disconnected,
  type FolderStatus,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
} from '@daban/protocol';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { LocalFiles } from './LocalFiles';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function fixture() {
  const state = { ...disconnected('ready'), localFolders: true as const };
  let result: FolderStatus = { bot: 'mock-a', folders: [], operations: [] };
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'status') return { ok: true, value: state };
    if (command.type === 'folders.pick')
      result = {
        ...result,
        folders: [
          { id: 'mock-folder', bot: 'mock-a', name: 'mock-project', path: '/mock/project' },
        ],
      };
    if (command.type === 'folders.disconnect') result = { ...result, folders: [] };
    return { ok: true, value: command.type === 'folders.status' ? result : {} };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime: { invoke, subscribe: () => () => {} } as RuntimeBridge },
  });
  return {
    invoke,
    history() {
      result = {
        ...result,
        operations: [
          {
            id: 'mock-operation',
            folder: 'mock-folder',
            bot: 'mock-a',
            kind: 'edit',
            path: 'mock.txt',
            state: 'complete',
            at: '2026-01-01T00:00:00Z',
            before: 'SYNTHETIC BEFORE',
            after: 'SYNTHETIC AFTER',
          },
        ],
      };
    },
  };
}
it('connects through the native picker, displays scope, shows changes and revokes without deleting files', async () => {
  const backend = fixture();
  render(
    <RuntimeProvider>
      <LocalFiles bot="mock-a" />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '本地文件夹' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('尚未连接本地文件夹')).toBeVisible();
  await userEvent.click(within(dialog).getByRole('button', { name: '添加文件夹' }));
  expect(await within(dialog).findByText('/mock/project')).toBeVisible();
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'folders.pick',
    bot: 'mock-a',
  });
  backend.history();
  await userEvent.click(within(dialog).getByRole('button', { name: '刷新' }));
  await userEvent.click(await within(dialog).findByText(/mock.txt/));
  expect(within(dialog).getByText('SYNTHETIC BEFORE')).toBeVisible();
  expect(within(dialog).getByText('SYNTHETIC AFTER')).toBeVisible();
  await userEvent.click(within(dialog).getByRole('button', { name: '断开 mock-project' }));
  expect(await within(dialog).findByText('尚未连接本地文件夹')).toBeVisible();
});

it('discards a late previous-Bot response after switching conversations', async () => {
  const backend = fixture();
  let finish: ((value: RuntimeReply) => unknown) | undefined;
  const fallback = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation(async (command) =>
    command.type === 'folders.status' && command.bot === 'mock-a'
      ? await new Promise<RuntimeReply>((resolve) => {
          finish = resolve;
        })
      : command.type === 'folders.status'
        ? { ok: true, value: { bot: command.bot, folders: [], operations: [] } }
        : fallback(command),
  );
  const view = render(
    <RuntimeProvider>
      <LocalFiles bot="mock-a" />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '本地文件夹' }));
  view.rerender(
    <RuntimeProvider>
      <LocalFiles bot="mock-b" />
    </RuntimeProvider>,
  );
  await act(async () =>
    finish?.({
      ok: true,
      value: {
        bot: 'mock-a',
        folders: [{ id: 'mock-folder', bot: 'mock-a', name: 'OLD BOT FOLDER', path: '/mock/old' }],
        operations: [],
      },
    }),
  );
  expect(screen.queryByText('OLD BOT FOLDER')).toBeNull();
});
