import { beforeEach as seedBeforeEach } from 'vitest';
import { serialize as seedSerialize, storageKey as seedStorageKey } from '../../app/storage';
import { demoState as seedDemoState } from '../../test/fixtures';
import { appAction, workspaceTab } from '../../test/navigation.fixture';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  agentId,
  type BotProfile,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { serialize, storageKey } from '../../app/storage';
import { demoState as initialState } from '../../test/fixtures';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
const seed = initialState();
const name = seed.bots.find((bot) => bot.id === 'research')!.name;
function connect({
  uncertain = false,
  connected = false,
  allArchived = false,
  missingArchived = false,
} = {}) {
  const local = initialState();
  local.panel = null;
  local.drafts.research = 'SYNTHETIC-UNSENT-DRAFT';
  local.messages.research.push({
    id: 'mock-retained-history',
    role: 'user',
    text: 'SYNTHETIC-RETAINED-HISTORY',
  });
  if (missingArchived)
    local.bots = local.bots.map((bot) =>
      bot.id === 'research' ? { ...bot, archived: true } : bot,
    );
  localStorage.setItem(storageKey, serialize(local));
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = 22;
  snapshot.mcp = { available: true, revision: 0 };
  snapshot.skills = { available: true, revision: 0 };
  snapshot.computers = {
    available: true,
    revision: 0,
    limit: 2,
    items: connected
      ? [
          {
            bot: 'a',
            revision: 1,
            phase: 'connected',
            desired: true,
            reserved: true,
            instance: 'mock-instance',
          },
        ]
      : [],
  };
  snapshot.model = {
    available: true,
    configured: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    revision: 1,
  };
  snapshot.profiles = local.bots
    .filter((bot) => !bot.members && !(missingArchived && bot.id === 'research'))
    .map(
      (bot): BotProfile => ({
        id: agentId(bot.id),
        name: bot.name,
        instructions: bot.role,
        memory: local.memories[bot.id],
        color: bot.color,
        revision: allArchived ? 3 : 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T01:00:00Z',
        ...(allArchived
          ? {
              archived: true,
              lifecycle: {
                id: `mock-archived-${agentId(bot.id)}`,
                action: 'archive',
                phase: 'complete',
                baseRevision: 1,
              },
            }
          : {}),
      }),
    );
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const publish = () => {
    snapshot = structuredClone(snapshot);
    for (const listener of listeners) listener(snapshot);
  };
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'status') return { ok: true, value: snapshot };
    if (command.type === 'mcp.list') return { ok: true, value: { revision: 0, items: [] } };
    if (command.type === 'bot.register')
      return {
        ok: true,
        value: snapshot.profiles.find((profile) => profile.id === command.profile.id),
      };
    if (command.type === 'bot.action') {
      const request = command.request;
      const old = snapshot.profiles.find((profile) => profile.id === request.bot)!;
      const profile: BotProfile = {
        ...old,
        revision: request.revision + (request.action === 'archive' ? 2 : 1),
        archived: request.action === 'archive',
        lifecycle: {
          id: request.id,
          action: request.action,
          phase: 'complete',
          baseRevision: request.revision,
        },
      };
      snapshot.profiles = snapshot.profiles.map((row) => (row.id === profile.id ? profile : row));
      publish();
      if (uncertain) return { ok: false, error: 'RUNTIME_SESSION_CHANGED' };
      return { ok: true, value: { profile, receipt: { ...profile.lifecycle!, bot: profile.id } } };
    }
    if (command.type === 'bot.receipt') {
      const profile = snapshot.profiles.find((row) => row.id === command.bot)!;
      return { ok: true, value: { profile, receipt: { ...profile.lifecycle!, bot: profile.id } } };
    }
    return { ok: true, value: {} };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: (value: RuntimeSnapshot) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as RuntimeBridge,
    },
  });
  return invoke;
}
async function archiveDialog() {
  await appAction(userEvent, '编辑 Bot 资料');
  await userEvent.click(await screen.findByRole('button', { name: '归档 Bot' }));
  return screen.findByRole('dialog', { name: '归档 Bot' });
}

it('archives and restores a Bot without discarding its draft/history or silently starting work', async () => {
  const invoke = connect();
  render(<App />);
  await screen.findByText('SYNTHETIC-RETAINED-HISTORY');
  await archiveDialog();
  await userEvent.click(screen.getByRole('button', { name: '确认归档' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: '归档 Bot' })).not.toBeInTheDocument(),
  );
  expect(
    within(screen.getByRole('navigation', { name: 'Bot 列表' })).queryByRole('button', {
      name,
    }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC-UNSENT-DRAFT');
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveAttribute('readonly');
  await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
  expect(screen.getByRole('menuitem', { name: '编辑 Bot 资料' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await userEvent.keyboard('{Escape}');
  await workspaceTab(userEvent, '电脑');
  for (const name of ['资料', '记忆', '定时'])
    expect(screen.getByRole('tab', { name })).toBeDisabled();
  expect(screen.getByRole('button', { name: /^Bot 模型：/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  expect(screen.getByText('SYNTHETIC-RETAINED-HISTORY')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await userEvent.click(screen.getByRole('tab', { name: '归档管理' }));
  await userEvent.click(await screen.findByRole('button', { name: `恢复 ${name}` }));
  await userEvent.click(screen.getByRole('button', { name: '确认恢复' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: '恢复 Bot' })).not.toBeInTheDocument(),
  );
  expect(
    invoke.mock.calls.filter(([command]) =>
      ['task.start', 'computer.action', 'schedule.run'].includes(command.type),
    ),
  ).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC-UNSENT-DRAFT');
  expect(screen.getByRole('textbox', { name: '发送消息' })).toBeEnabled();
});

it('retains an uncertain operation nonce and inspects it without automatically repeating archive', async () => {
  const invoke = connect({ uncertain: true });
  render(<App />);
  await archiveDialog();
  await userEvent.click(screen.getByRole('button', { name: '确认归档' }));
  await screen.findByText('Bot 操作待核对');
  expect(screen.queryByText('已归档 · 历史只读')).not.toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: '核对操作结果' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: '归档 Bot' })).not.toBeInTheDocument(),
  );
  expect(invoke.mock.calls.filter(([command]) => command.type === 'bot.action')).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command.type === 'bot.receipt')).toHaveLength(1);
  const saved = JSON.parse(localStorage.getItem(storageKey)!);
  expect(saved.state.lifecycleRequests.research).toBeUndefined();
  expect(saved.state.drafts.research).toBe('SYNTHETIC-UNSENT-DRAFT');
});

it('recovers an uncertain operation after relaunch using only an explicit receipt query', async () => {
  const invoke = connect({ uncertain: true });
  const mounted = render(<App />);
  await archiveDialog();
  await userEvent.click(screen.getByRole('button', { name: '确认归档' }));
  await screen.findByRole('button', { name: '核对操作结果' });
  mounted.unmount();
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '核对 Bot 状态' }));
  await userEvent.click(screen.getByRole('button', { name: '核对操作结果' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: '归档 Bot' })).not.toBeInTheDocument(),
  );
  expect(invoke.mock.calls.filter(([command]) => command.type === 'bot.action')).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command.type === 'bot.receipt')).toHaveLength(1);
});

it('keeps saved-content and computer teardown in the existing flow before archive is allowed', async () => {
  const invoke = connect({ connected: true });
  render(<App />);
  const dialog = await archiveDialog();
  expect(dialog).toHaveTextContent('停止电脑');
  expect(screen.getByRole('button', { name: '确认归档' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '管理电脑' })).toBeVisible();
  expect(
    invoke.mock.calls.some(
      ([command]) => command.type === 'bot.action' || command.type === 'computer.action',
    ),
  ).toBe(false);
});

it('keeps all-archived and missing-backend history readable without recreating archived identities', async () => {
  const invoke = connect({ missingArchived: true });
  const mounted = render(<App />);
  expect(await screen.findByText('SYNTHETIC-RETAINED-HISTORY')).toBeVisible();
  expect(
    invoke.mock.calls.some(
      ([command]) => command.type === 'bot.register' && command.profile.id === 'a',
    ),
  ).toBe(false);
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveAttribute('readonly');
  mounted.unmount();
  connect({ allArchived: true });
  render(<App />);
  expect(await screen.findByText('所有 Bot 都已归档')).toBeVisible();
  expect(screen.getByText('SYNTHETIC-RETAINED-HISTORY')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await userEvent.click(screen.getByRole('tab', { name: '归档管理' }));
  expect(await screen.findByRole('button', { name: `查看历史 ${name}` })).toBeVisible();
});
