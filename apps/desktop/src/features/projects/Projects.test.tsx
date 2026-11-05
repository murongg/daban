import {
  agentId,
  disconnected,
  type ProjectWrite,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
} from '@daban/protocol';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '../../app/App';
import { RuntimeProvider } from '../../app/Runtime';
import { serialize, storageKey } from '../../app/storage';
import { demoState } from '../../test/fixtures';
import { Projects } from './Projects';
import { Scope } from './Scope';

afterEach(() => Reflect.deleteProperty(window, 'daban'));

test('an archived member remains removable without granting it new project access', async () => {
  const state = demoState(),
    bot = state.bots.find((item) => !item.members)!;
  bot.archived = true;
  const project = {
    id: 'mock-project',
    name: 'SYNTHETIC PROJECT',
    revision: 1,
    status: 'active',
    grants: [{ bot: agentId(bot.id), content: 'read', browser: false }],
    environment: { files: 'project', browser: 'private' },
  };
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'status')
      return { ok: true, value: { ...disconnected('ready'), protocolVersion: 44 } };
    if (command.type === 'projects.list') return { ok: true, value: [project] };
    return { ok: false, error: 'PROJECT_BUSY' };
  });
  const runtime: RuntimeBridge = {
    invoke: async <T,>(command: RuntimeCommand) => (await invoke(command)) as RuntimeReply<T>,
    subscribe: () => () => {},
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime },
  });
  render(
    <RuntimeProvider>
      <Projects state={state} dispatch={vi.fn()} />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: project.name }));
  const member = screen.getByRole('checkbox', { name: new RegExp(bot.name) });
  expect(member).toBeChecked();
  await userEvent.click(member);
  expect(member).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '保存项目' }));
  expect(
    invoke.mock.calls.find(([command]) => command.type === 'projects.write')?.[0],
  ).toMatchObject({ request: { value: { grants: [] } } });
});

test('project settings expose the private browser default and keep the settings dialog keyboard dismissal', async () => {
  localStorage.setItem(storageKey, serialize(demoState()));
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  const dialog = screen.getByRole('dialog', { name: '设置' });
  await userEvent.click(within(dialog).getByRole('tab', { name: '项目' }));
  expect(within(dialog).getByRole('button', { name: /浏览器身份/ })).toHaveTextContent(
    '每个 Bot 私有',
  );
  expect(within(dialog).getByText(/同一 Linux 环境/)).toBeVisible();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument();
});

test('an unsupported executor permits an explicit return to legacy without silently dropping a project scope', async () => {
  const state = demoState(),
    bot = state.bots.find((item) => !item.members)!;
  state.projectScopes = { [bot.id]: { projectId: 'mock-project', revision: 1 } };
  const invoke = vi.fn(
    async (command: RuntimeCommand): Promise<RuntimeReply> => ({
      ok: true,
      value:
        command.type === 'status'
          ? { ...disconnected('ready'), protocolVersion: 44 }
          : command.type === 'projects.list'
            ? []
            : { available: true, execution: false },
    }),
  );
  const runtime: RuntimeBridge = {
    invoke: async <T,>(command: RuntimeCommand) => (await invoke(command)) as RuntimeReply<T>,
    subscribe: () => () => {},
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime },
  });
  const dispatch = vi.fn();
  render(
    <RuntimeProvider>
      <Scope bot={bot.id} state={state} dispatch={dispatch} disabled={false} />
    </RuntimeProvider>,
  );
  expect(dispatch).not.toHaveBeenCalled();
  const trigger = screen.getByRole('button', { name: /任务项目范围/ });
  await waitFor(() => expect(trigger).toBeEnabled());
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole('option', { name: '原共享环境' }));
  expect(dispatch).toHaveBeenCalledWith({ type: 'project-scope', bot: bot.id, scope: undefined });
  expect(invoke.mock.calls.some(([command]) => command.type === 'projects.select')).toBe(false);
});

test('sharing requires explicit members and confirmation, and a lost response is reconciled without a second write', async () => {
  const state = demoState();
  localStorage.setItem(storageKey, serialize(state));
  const bot = state.bots.find((item) => !item.members && !item.archived)!;
  const snapshot = { ...disconnected('ready'), protocolVersion: 44 };
  const writes: ProjectWrite[] = [];
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'status' || command.type === 'connect')
      return { ok: true, value: snapshot };
    if (command.type === 'projects.status')
      return { ok: true, value: { available: true, execution: true } };
    if (command.type === 'projects.list') return { ok: true, value: [] };
    if (command.type === 'projects.write') {
      writes.push(command.request);
      return { ok: false, error: 'RUNTIME_UNAVAILABLE' };
    }
    if (command.type === 'projects.receipt') {
      const request = writes[0];
      if (!request || request.action === 'archive') return { ok: false, error: 'MOCK_INVALID' };
      return {
        ok: true,
        value: {
          requestId: request.requestId,
          projectId: request.projectId,
          state: 'complete',
          project: {
            id: request.projectId,
            name: request.value.name,
            revision: 1,
            status: 'active',
            grants: request.value.grants,
            environment: { files: 'project', browser: request.value.browser },
          },
        },
      };
    }
    return { ok: true, value: {} };
  });
  const runtime: RuntimeBridge = {
    invoke: async <T,>(command: RuntimeCommand) => (await invoke(command)) as RuntimeReply<T>,
    subscribe: () => () => {},
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime },
  });
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await userEvent.click(screen.getByRole('tab', { name: '项目' }));
  await userEvent.type(
    await screen.findByRole('textbox', { name: '项目名称' }),
    'SYNTHETIC PROJECT',
  );
  await userEvent.click(screen.getByRole('checkbox', { name: bot.name }));
  expect(
    screen.getByRole('button', { name: new RegExp(`${bot.name} 的内容权限`) }),
  ).toHaveTextContent('只读共享内容');
  const browser = screen.getByRole('checkbox', { name: '允许使用浏览器' });
  expect(browser).not.toBeChecked();
  await userEvent.click(browser);
  await userEvent.click(screen.getByRole('button', { name: /浏览器身份/ }));
  await userEvent.click(screen.getByRole('option', { name: '项目共享登录' }));
  expect(screen.getByRole('button', { name: '保存项目' })).toBeDisabled();
  expect(screen.getByText(`这些成员将共享站点登录：${bot.name}`)).toBeVisible();
  await userEvent.click(
    screen.getByRole('checkbox', { name: '确认向上述获授权成员共享浏览器身份' }),
  );
  await userEvent.click(screen.getByRole('button', { name: '保存项目' }));
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    value: {
      browser: 'project',
      grants: [{ bot: agentId(bot.id), content: 'read', browser: true }],
    },
  });
  await userEvent.keyboard('{Escape}');
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await userEvent.click(screen.getByRole('tab', { name: '项目' }));
  await userEvent.click(await screen.findByRole('button', { name: '查询变更回执' }));
  expect(writes).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command.type === 'projects.receipt')).toHaveLength(
    1,
  );
  expect(await screen.findByRole('button', { name: '归档项目' })).toBeEnabled();
});
