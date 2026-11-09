import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  UpdateBridge,
  UpdateCommand,
  UpdateMessage,
  UpdateStatus,
} from '../../../shared/updates';
import { Sidebar } from '../../app/Sidebar';
import { setLocale } from '../../i18n/locale';
import { demoState } from '../../test/fixtures';
import { UpdateNotice, UpdatesPanel } from './Updates';
import { UpdateProvider, useUpdateSave } from './update';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function Workspace({ save }: { save: () => unknown }) {
  useUpdateSave(save);
  return <p>Synthetic workspace</p>;
}
function SidebarFixture() {
  return (
    <Sidebar
      state={demoState()}
      dispatch={vi.fn()}
      query=""
      setQuery={vi.fn()}
      searchRef={createRef<HTMLInputElement>()}
      onCreate={vi.fn()}
      open
      close={vi.fn()}
    />
  );
}
function fixture(initial: UpdateStatus) {
  let status = initial;
  let receive: (message: UpdateMessage) => unknown = () => {};
  const invoke = vi.fn(async (command: UpdateCommand) => {
    if (command.type === 'download') status = { ...status, phase: 'downloading', percent: 0 };
    if (command.type === 'install') status = { ...status, phase: 'installing' };
    return { ok: true as const, value: status };
  });
  const bridge: UpdateBridge = {
    invoke,
    subscribe: (callback) => {
      receive = callback;
      return () => {};
    },
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', updates: bridge },
  });
  return {
    invoke,
    emit: (message: UpdateMessage) => {
      if (message.type === 'status') status = message.status;
      return receive(message);
    },
  };
}

it('downloads and installs from the sidebar in one click after dismissing the notice', async () => {
  const live = fixture({ phase: 'current', version: '1.0.0' });
  render(
    <UpdateProvider>
      <SidebarFixture />
      <UpdateNotice />
    </UpdateProvider>,
  );
  const sidebar = within(screen.getByRole('contentinfo'));
  expect(sidebar.queryByRole('button', { name: '更新并重启' })).not.toBeInTheDocument();
  await act(async () =>
    live.emit({
      type: 'status',
      status: { phase: 'available', version: '1.0.0', nextVersion: '1.1.0' },
    }),
  );
  await userEvent.click(screen.getByRole('button', { name: '关闭' }));
  const button = sidebar.getByRole('button', { name: '更新并重启' });
  expect(button).toBeVisible();
  expect(button.nextElementSibling).toBe(sidebar.getByRole('button', { name: '设置' }));
  let finish: (reply: { ok: true; value: UpdateStatus }) => unknown = () => {};
  live.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await userEvent.dblClick(button);
  expect(live.invoke.mock.calls.filter(([command]) => command.type === 'download')).toHaveLength(1);
  expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('dialog', { name: '应用更新' })).toBeVisible();
  expect(live.invoke).not.toHaveBeenCalledWith({ type: 'install' });
  await act(async () =>
    live.emit({
      type: 'status',
      status: { phase: 'downloading', version: '1.0.0', nextVersion: '1.1.0', percent: 42 },
    }),
  );
  expect(sidebar.getByRole('progressbar', { name: '更新下载进度' })).toHaveAttribute(
    'aria-valuenow',
    '42',
  );
  expect(
    within(screen.getByRole('dialog', { name: '应用更新' })).getByRole('progressbar'),
  ).toHaveAttribute('aria-valuenow', '42');
  await act(async () => {
    const status: UpdateStatus = { phase: 'downloaded', version: '1.0.0', nextVersion: '1.1.0' };
    live.emit({ type: 'status', status });
    finish({ ok: true, value: status });
  });
  await waitFor(() => expect(live.invoke).toHaveBeenCalledWith({ type: 'install' }));
  expect(live.invoke.mock.calls.filter(([command]) => command.type === 'install')).toHaveLength(1);
  expect(screen.queryByRole('dialog', { name: '重启安装更新？' })).not.toBeInTheDocument();
});

it.each([
  ['Markdown', '- [Synthetic release note](https://example.test/release)'],
  [
    'GitHub HTML',
    `<p><strong>Synthetic changes</strong></p>
    <details><summary>Details</summary><ul>
      <li><a href="https://example.test/release">Synthetic release note</a></li>
      <li><a href="javascript:alert(1)">Unsafe link</a></li>
    </ul></details>`,
  ],
])('shows %s release notes directly in the update dialog during download', async (_, notes) => {
  fixture({ phase: 'available', version: '1.0.0', nextVersion: '1.1.0', notes });
  render(
    <UpdateProvider>
      <SidebarFixture />
    </UpdateProvider>,
  );

  await userEvent.click(await screen.findByRole('button', { name: '更新并重启' }));

  const dialog = within(screen.getByRole('dialog', { name: '应用更新' }));
  expect(dialog.getByRole('heading', { name: '更新日志 v1.1.0' })).toBeVisible();
  expect(dialog.queryByText('当前版本 1.0.0')).not.toBeInTheDocument();
  const link = dialog.getByRole('link', { name: 'Synthetic release note' });
  expect(link).toBeVisible();
  expect(link).toHaveAttribute('href', 'https://example.test/release');
  expect(dialog.queryByRole('link', { name: 'Unsafe link' })).not.toBeInTheDocument();
  const progress = dialog.getByRole('progressbar');
  expect(progress).toBeVisible();
  expect(link.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('shows only the changelog matching the current interface language', async () => {
  fixture({
    phase: 'available',
    version: '1.0.0',
    nextVersion: '1.1.0',
    notes: 'Synthetic release fallback',
    changelogs: { en: '- Synthetic English changes', 'zh-CN': '- 合成更新日志' },
  });
  render(
    <UpdateProvider>
      <SidebarFixture />
    </UpdateProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '更新并重启' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText('合成更新日志')).toBeVisible();
  expect(dialog.queryByText('Synthetic English changes')).not.toBeInTheDocument();
  expect(dialog.queryByText('Synthetic release fallback')).not.toBeInTheDocument();
  await act(() => setLocale('en'));
  expect(dialog.getByText('Synthetic English changes')).toBeVisible();
  expect(dialog.queryByText('合成更新日志')).not.toBeInTheDocument();
});

it('fills the sidebar progress ring from live download percentages and removes it after cancellation', async () => {
  const live = fixture({
    phase: 'downloading',
    version: '1.0.0',
    nextVersion: '1.1.0',
    percent: 0,
  });
  render(
    <UpdateProvider>
      <SidebarFixture />
    </UpdateProvider>,
  );
  const button = await screen.findByRole('button', { name: '更新并重启' });
  for (const percent of [0, 42, 83, 100]) {
    await act(async () =>
      live.emit({
        type: 'status',
        status: { phase: 'downloading', version: '1.0.0', nextVersion: '1.1.0', percent },
      }),
    );
    const progress = screen.getByRole('progressbar', { name: '更新下载进度' });
    expect(progress).toHaveAttribute('aria-valuemin', '0');
    expect(progress).toHaveAttribute('aria-valuemax', '100');
    expect(progress).toHaveAttribute('aria-valuenow', String(percent));
    expect(progress.querySelector('.update-ring-value')).toHaveAttribute(
      'stroke-dashoffset',
      String(100 - percent),
    );
  }
  expect(button).toHaveAttribute('aria-disabled', 'true');
  await act(async () =>
    live.emit({
      type: 'status',
      status: { phase: 'available', version: '1.0.0', nextVersion: '1.1.0' },
    }),
  );
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(button).toHaveAttribute('aria-disabled', 'false');
});

it('installs an already downloaded update directly and reports a busy host without restarting', async () => {
  const live = fixture({ phase: 'downloaded', version: '1.0.0', nextVersion: '1.1.0' });
  render(
    <UpdateProvider>
      <SidebarFixture />
    </UpdateProvider>,
  );
  const button = await screen.findByRole('button', { name: '更新并重启' });
  live.invoke.mockRejectedValueOnce(Error('AGENT_UPDATE_BUSY'));
  await userEvent.click(button);
  expect(live.invoke).toHaveBeenCalledWith({ type: 'install' });
  expect(live.invoke).not.toHaveBeenCalledWith({ type: 'download' });
  expect(screen.getByRole('alert')).toHaveTextContent('后台仍有任务');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute('aria-disabled', 'false');
});

it.each(['cancelled', 'failed'] as const)('does not install a %s download', async (outcome) => {
  const live = fixture({ phase: 'available', version: '1.0.0', nextVersion: '1.1.0' });
  render(
    <UpdateProvider>
      <SidebarFixture />
    </UpdateProvider>,
  );
  const button = await screen.findByRole('button', { name: '更新并重启' });
  live.invoke.mockResolvedValueOnce({
    ok: true,
    value: {
      phase: 'available',
      version: '1.0.0',
      nextVersion: '1.1.0',
      error: outcome === 'failed' ? 'UPDATE_DOWNLOAD_FAILED' : undefined,
    },
  });
  await userEvent.click(button);
  expect(live.invoke).toHaveBeenCalledWith({ type: 'download' });
  expect(live.invoke).not.toHaveBeenCalledWith({ type: 'install' });
  expect(button).toHaveAttribute('aria-disabled', 'false');
  if (outcome === 'failed') expect(screen.getByRole('alert')).toHaveTextContent('更新下载失败');
});

it.each(['downloading', 'preparing', 'installing'] as const)(
  'keeps the sidebar update disabled during %s',
  async (phase) => {
    const live = fixture({ phase, version: '1.0.0', nextVersion: '1.1.0' });
    render(
      <UpdateProvider>
        <SidebarFixture />
      </UpdateProvider>,
    );
    const button = await screen.findByRole('button', { name: '更新并重启' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(button);
    expect(live.invoke).not.toHaveBeenCalledWith({ type: 'download' });
    expect(live.invoke).not.toHaveBeenCalledWith({ type: 'install' });
  },
);

it.each(['unsupported', 'idle', 'checking', 'current', 'unpublished', 'error'] as const)(
  'hides the update entry in the %s phase even with cached release metadata',
  async (phase) => {
    fixture({ phase, version: '1.0.0', nextVersion: '1.1.0' });
    await act(async () =>
      render(
        <UpdateProvider>
          <SidebarFixture />
        </UpdateProvider>,
      ),
    );
    expect(screen.queryByRole('button', { name: '更新并重启' })).not.toBeInTheDocument();
  },
);

it('hides the update entry in browser previews and without a release version', async () => {
  const view = render(<SidebarFixture />);
  expect(screen.queryByRole('button', { name: '更新并重启' })).not.toBeInTheDocument();
  view.unmount();
  fixture({ phase: 'available', version: '1.0.0' });
  await act(async () =>
    render(
      <UpdateProvider>
        <SidebarFixture />
      </UpdateProvider>,
    ),
  );
  expect(screen.queryByRole('button', { name: '更新并重启' })).not.toBeInTheDocument();
});

it('shows download progress and requires explicit confirmation before restarting', async () => {
  const live = fixture({
    phase: 'available',
    version: '1.0.0',
    nextVersion: '1.1.0',
    notes: 'Synthetic release',
  });
  render(
    <UpdateProvider>
      <UpdatesPanel />
    </UpdateProvider>,
  );
  expect(await screen.findByText('发现新版本 1.1.0')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '下载更新' }));
  await act(async () =>
    live.emit({
      type: 'status',
      status: { phase: 'downloading', version: '1.0.0', nextVersion: '1.1.0', percent: 42 },
    }),
  );
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
  await act(async () =>
    live.emit({
      type: 'status',
      status: {
        phase: 'downloading',
        version: '1.0.0',
        nextVersion: '1.1.0',
        downloadTarget: 'runtime',
        percent: 65,
      },
    }),
  );
  expect(screen.getByRole('status')).toHaveTextContent('正在下载基础组件');
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '65');
  expect(screen.queryByRole('button', { name: '重启并安装' })).not.toBeInTheDocument();
  await act(async () =>
    live.emit({
      type: 'status',
      status: { phase: 'downloaded', version: '1.0.0', nextVersion: '1.1.0', percent: 100 },
    }),
  );
  await userEvent.click(screen.getByRole('button', { name: '重启并安装' }));
  expect(live.invoke).not.toHaveBeenCalledWith({ type: 'install' });
  expect(screen.getByText(/保存尚未提交的设置/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '已保存，重启安装' }));
  await waitFor(() => expect(live.invoke).toHaveBeenCalledWith({ type: 'install' }));
});
it('acknowledges workspace persistence and refuses a failed save', async () => {
  const live = fixture({ phase: 'idle', version: '1.0.0' });
  const save = vi.fn(() => {
    throw Error('SYNTHETIC_QUOTA');
  });
  render(
    <UpdateProvider>
      <Workspace save={save} />
    </UpdateProvider>,
  );
  await act(async () => live.emit({ type: 'prepare', id: 'a'.repeat(48) }));
  await waitFor(() =>
    expect(live.invoke).toHaveBeenCalledWith({ type: 'saved', id: 'a'.repeat(48), success: false }),
  );
});
it('cannot check or install updates in a plain browser preview', () => {
  render(
    <UpdateProvider>
      <UpdatesPanel />
    </UpdateProvider>,
  );
  expect(screen.queryByRole('button', { name: '检查更新' })).not.toBeInTheDocument();
  expect(screen.getByText(/网页预览/)).toBeVisible();
});

it('returns to the update card and exposes a busy-host rejection after confirmation', async () => {
  const live = fixture({ phase: 'downloaded', version: '1.0.0', nextVersion: '1.1.0' });
  render(
    <UpdateProvider>
      <UpdatesPanel />
    </UpdateProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '重启并安装' }));
  live.invoke.mockRejectedValueOnce(Error('AGENT_UPDATE_BUSY'));
  await userEvent.click(screen.getByRole('button', { name: '已保存，重启安装' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('alert')).toHaveTextContent('后台仍有任务');
});
