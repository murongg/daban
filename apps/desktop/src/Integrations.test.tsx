import {
  disconnected,
  type McpAssignment,
  type McpConnection,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
} from '@daban/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Integrations } from './Integrations';
import { IntegrationTools } from './IntegrationTools';
import { RuntimeProvider } from './Runtime';
import { findSelectControl, selectControl, selectOption } from './select.fixture';
import type { Bot } from './state';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
const bots: Bot[] = ['mock-a', 'mock-b'].map((id, index) => ({
  id,
  name: `合成 Bot ${index + 1}`,
  role: '',
  color: 'mint',
  preview: '',
  time: '',
}));
const connection: McpConnection = {
  id: 'mock-connection',
  name: '合成服务',
  origin: 'https://mcp.example.test',
  credentialConfigured: true,
  revision: 1,
  deleted: false,
  health: 'ready',
  toolCount: 1,
  catalogDigest: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const tool = {
  name: 'synthetic_echo',
  alias: `ext_${'b'.repeat(20)}`,
  description: '返回合成内容',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  digest: 'c'.repeat(64),
};
function connect({
  empty = false,
  protocol = 21,
  error = '',
  changeOnCheck = false,
  stale = false,
  archived = false,
  offline = false,
} = {}) {
  let rows = empty ? [] : [{ ...structuredClone(connection), revision: stale ? 2 : 1 }];
  let offered = [tool];
  let saved: unknown;
  const bindings = new Map<string, McpAssignment>();
  const snapshot = disconnected(offline ? 'offline' : 'ready');
  snapshot.protocolVersion = protocol;
  snapshot.mcp = { available: true, revision: 1 };
  snapshot.profiles = bots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    color: 'mint',
    instructions: '',
    memory: '',
    revision: 1,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    ...(archived && bot.id === 'mock-a'
      ? {
          revision: 3,
          archived: true,
          lifecycle: {
            id: 'mock-tool-archived',
            action: 'archive' as const,
            phase: 'complete' as const,
            baseRevision: 1,
          },
        }
      : {}),
  }));
  const entry = (bot: string, row: McpConnection): McpAssignment =>
    bindings.get(`${bot}/${row.id}`) ?? {
      connection: row,
      revision: stale ? 1 : 0,
      enabled: stale,
      available: false,
      tools: stale ? [tool.name] : [],
      ...(stale ? { catalogDigest: connection.catalogDigest } : {}),
    };
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'status') return { ok: true, value: snapshot };
    if (command.type === 'mcp.list')
      return {
        ok: true,
        value: {
          revision: 1,
          items: rows.filter((row) => row.deleted === !!command.includeDeleted),
        },
      };
    if (command.type === 'mcp.check' && changeOnCheck) {
      offered = [...offered, { ...tool, name: 'synthetic_extra', alias: `ext_${'e'.repeat(20)}` }];
      rows = rows.map((row) => ({
        ...row,
        toolCount: offered.length,
        catalogDigest: 'd'.repeat(64),
      }));
    }
    if (command.type === 'mcp.catalog' || command.type === 'mcp.check')
      return {
        ok: true,
        value: { current: rows.find((row) => row.id === command.id), tools: offered },
      };
    if (command.type === 'mcp.bindings')
      return {
        ok: true,
        value: {
          bot: command.bot,
          revision: 1,
          items: rows.filter((row) => !row.deleted).map((row) => entry(command.bot, row)),
        },
      };
    if (command.type === 'mcp.bind') {
      const row = rows.find((item) => item.id === command.input.connection)!;
      const value = {
        connection: row,
        revision: command.input.bindingRevision + 1,
        enabled: command.input.enabled,
        available: command.input.enabled,
        tools: command.input.tools,
        catalogDigest: command.input.catalogDigest,
      };
      bindings.set(`${command.bot}/${row.id}`, value);
      return { ok: true, value: { bot: command.bot, entry: value } };
    }
    if (command.type === 'mcp.calls') return { ok: true, value: { bot: command.bot, items: [] } };
    if (command.type === 'mcp.save') {
      if (error === 'MCP_CONFLICT') return { ok: false, error };
      const current = {
        ...connection,
        id: command.input.id,
        name: command.input.name,
        revision: command.input.revision + 1,
      };
      saved = {
        receipt: {
          id: command.input.requestId,
          connection: current.id,
          revision: current.revision,
        },
        current,
      };
      rows = [...rows.filter((row) => row.id !== current.id), current];
      if (error) return { ok: false, error };
      return { ok: true, value: saved };
    }
    if (command.type === 'mcp.saved') return { ok: true, value: saved };
    if (command.type === 'mcp.archive' || command.type === 'mcp.restore') {
      rows = rows.map((row) =>
        row.id === command.id
          ? { ...row, deleted: command.type === 'mcp.archive', revision: row.revision + 1 }
          : row,
      );
      bindings.clear();
      return { ok: true, value: rows.find((row) => row.id === command.id) };
    }
    return { ok: true, value: {} };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => {} } as unknown as RuntimeBridge,
    },
  });
  return invoke;
}

it('does not promise usable conversation while the whole runtime is offline', async () => {
  connect({ offline: true });
  render(
    <RuntimeProvider>
      <Integrations bots={bots} />
    </RuntimeProvider>,
  );
  expect(await screen.findByText('本地运行环境尚未连接，连接恢复后可管理外部工具。')).toBeVisible();
  expect(
    screen.queryByText('外部工具服务暂不可用，普通对话和已有工作区仍可使用。'),
  ).not.toBeInTheDocument();
});
const view = () => (
  <RuntimeProvider>
    <Integrations bots={bots} />
  </RuntimeProvider>
);

it('reports its local archive dialog layer without repeating the signal on ordinary rerenders', async () => {
  connect();
  const change = vi.fn();
  const mounted = render(
    <RuntimeProvider>
      <Integrations bots={bots} onDialogChange={change} />
    </RuntimeProvider>,
  );
  const archive = await screen.findByRole('button', { name: '归档 合成服务' });
  expect(change).toHaveBeenLastCalledWith(false);
  await userEvent.click(archive);
  expect(screen.getByRole('dialog', { name: '归档连接' })).toBeVisible();
  expect(change).toHaveBeenLastCalledWith(true);
  const calls = change.mock.calls.length;
  mounted.rerender(
    <RuntimeProvider>
      <Integrations bots={[...bots]} onDialogChange={change} />
    </RuntimeProvider>,
  );
  expect(change).toHaveBeenCalledTimes(calls);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '归档连接' })).not.toBeInTheDocument();
  expect(change).toHaveBeenLastCalledWith(false);
});

it('creates a write-only connection without storing private input in the workspace, and clears it on leaving', async () => {
  const invoke = connect({ empty: true });
  const mounted = render(view());
  await userEvent.click(await screen.findByRole('button', { name: '添加连接' }));
  await userEvent.type(screen.getByLabelText('连接名称'), '合成新服务');
  await userEvent.type(
    screen.getByLabelText('服务地址'),
    'https://mcp.example.test/private?key=synthetic-url-draft',
  );
  await userEvent.type(screen.getByLabelText('Bearer Token'), 'synthetic-private-token');
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-private-token');
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-url-draft');
  await userEvent.click(screen.getByRole('button', { name: '保存连接' }));
  expect(await screen.findByText('连接已保存，请检查连接并单独为 Bot 选择工具。')).toBeVisible();
  expect(
    invoke.mock.calls.map(([command]) => command).find((command) => command.type === 'mcp.save'),
  ).toMatchObject({
    input: {
      revision: 0,
      name: '合成新服务',
      endpoint: 'https://mcp.example.test/private?key=synthetic-url-draft',
      bearer: 'synthetic-private-token',
    },
  });
  expect(screen.queryByLabelText('Bearer Token')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '编辑 合成新服务' }));
  expect(screen.getByLabelText('服务地址')).toHaveValue('');
  expect(screen.getByLabelText('Bearer Token')).toHaveValue('');
  mounted.unmount();
  render(view());
  expect(screen.queryByLabelText('Bearer Token')).not.toBeInTheDocument();
});

it('keeps private drafts after a configuration conflict rather than replacing them with a late saved value', async () => {
  connect({ error: 'MCP_CONFLICT' });
  render(view());
  await userEvent.click(await screen.findByRole('button', { name: '编辑 合成服务' }));
  await userEvent.clear(screen.getByLabelText('连接名称'));
  await userEvent.type(screen.getByLabelText('连接名称'), '合成保留草稿');
  await userEvent.type(screen.getByLabelText('Bearer Token'), 'synthetic-conflict-token');
  await userEvent.click(screen.getByRole('button', { name: '保存连接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('已变化');
  expect(screen.getByLabelText('连接名称')).toHaveValue('合成保留草稿');
  expect(screen.getByLabelText('Bearer Token')).toHaveValue('synthetic-conflict-token');
});

it('inspects an uncertain save using its original nonce without sending the credential again', async () => {
  const invoke = connect({ error: 'RUNTIME_SESSION_CHANGED' });
  render(view());
  await userEvent.click(await screen.findByRole('button', { name: '编辑 合成服务' }));
  await userEvent.type(screen.getByLabelText('Bearer Token'), 'synthetic-uncertain-token');
  await userEvent.click(screen.getByRole('button', { name: '保存连接' }));
  await userEvent.click(await screen.findByRole('button', { name: '核对保存结果' }));
  await waitFor(() => expect(screen.queryByLabelText('Bearer Token')).not.toBeInTheDocument());
  const commands = invoke.mock.calls.map(([command]) => command);
  expect(commands.filter((command) => command.type === 'mcp.save')).toHaveLength(1);
  expect(commands.find((command) => command.type === 'mcp.saved')).toMatchObject({
    connection: connection.id,
  });
});

it('checks a connection without granting tools, then explicitly saves the reviewed selection for one Bot only', async () => {
  const invoke = connect();
  render(view());
  await userEvent.click(await screen.findByRole('button', { name: '检查 合成服务' }));
  expect(invoke.mock.calls.some(([command]) => command.type === 'mcp.bind')).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: '工具与授权 合成服务' }));
  await userEvent.click(await screen.findByRole('checkbox', { name: 'synthetic_echo' }));
  await userEvent.click(screen.getByRole('checkbox', { name: '允许这位 Bot 使用所选工具' }));
  await userEvent.click(screen.getByRole('button', { name: '保存工具选择' }));
  await waitFor(() =>
    expect(invoke.mock.calls.some(([command]) => command.type === 'mcp.bind')).toBe(true),
  );
  expect(
    invoke.mock.calls.map(([command]) => command).find((command) => command.type === 'mcp.bind'),
  ).toMatchObject({
    bot: 'mock-a',
    input: {
      connection: connection.id,
      configRevision: 1,
      bindingRevision: 0,
      catalogDigest: connection.catalogDigest,
      tools: ['synthetic_echo'],
      enabled: true,
    },
  });
  await selectOption(userEvent, selectControl('使用工具的 Bot'), 'mock-b');
  expect(
    await screen.findByRole('checkbox', { name: '允许这位 Bot 使用所选工具' }),
  ).not.toBeChecked();
});

it('warns that archive revokes every Bot and restore never grants tools automatically', async () => {
  const invoke = connect();
  render(view());
  await userEvent.click(await screen.findByRole('button', { name: '归档 合成服务' }));
  expect(screen.getByRole('dialog', { name: '归档连接' })).toHaveTextContent('所有 Bot');
  await userEvent.click(screen.getByRole('button', { name: '确认归档' }));
  await userEvent.click(screen.getByRole('button', { name: '已归档' }));
  await userEvent.click(await screen.findByRole('button', { name: '恢复 合成服务' }));
  expect(await screen.findByText('连接已恢复，需要重新为每位 Bot 选择并启用工具。')).toBeVisible();
  expect(invoke.mock.calls.some(([command]) => command.type === 'mcp.bind')).toBe(false);
});

it('leaves older runtimes explicit and never sends new MCP commands to them', async () => {
  const invoke = connect({ protocol: 20 });
  render(view());
  expect(await screen.findByText('更新本地运行环境后可配置外部工具。')).toBeVisible();
  expect(screen.getByRole('button', { name: '添加连接' })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command.type.startsWith('mcp.'))).toBe(false);
});

it('keeps checking available while a tool selection is dirty and blocks navigation that would discard it', async () => {
  connect();
  render(view());
  await userEvent.click(await screen.findByRole('button', { name: '工具与授权 合成服务' }));
  await userEvent.click(await screen.findByRole('checkbox', { name: 'synthetic_echo' }));
  expect(screen.getByRole('button', { name: '编辑 合成服务' })).toBeDisabled();
  expect(selectControl('使用工具的 Bot')).toBeDisabled();
  expect(screen.getByRole('button', { name: '检查 合成服务' })).toBeEnabled();
  await userEvent.click(screen.getByRole('button', { name: '放弃选择修改' }));
  expect(selectControl('使用工具的 Bot')).toBeEnabled();
});

it('revalidates a changed catalog without losing dirty tool choices and requires an explicit version decision', async () => {
  const invoke = connect({ changeOnCheck: true });
  const mounted = render(
    <RuntimeProvider>
      <IntegrationTools connection={connection} bots={bots} onClose={() => {}} />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('checkbox', { name: 'synthetic_echo' }));
  await invoke({ type: 'mcp.check', id: connection.id, revision: 1 });
  mounted.rerender(
    <RuntimeProvider>
      <IntegrationTools
        connection={{ ...connection, toolCount: 2, catalogDigest: 'd'.repeat(64) }}
        bots={bots}
        onClose={() => {}}
      />
    </RuntimeProvider>,
  );
  expect(await screen.findByRole('checkbox', { name: 'synthetic_extra' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'synthetic_echo' })).toBeChecked();
  expect(screen.getByRole('button', { name: '保存工具选择' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '按当前版本继续编辑' }));
  expect(screen.getByRole('checkbox', { name: 'synthetic_echo' })).toBeChecked();
  expect(screen.getByRole('button', { name: '保存工具选择' })).toBeEnabled();
});

it('treats stale saved authority as a review state without trapping navigation or silently renewing consent', async () => {
  const invoke = connect({ stale: true });
  render(view());
  await userEvent.click(await screen.findByRole('button', { name: '工具与授权 合成服务' }));
  await screen.findByRole('checkbox', { name: 'synthetic_echo' });
  expect(screen.getByRole('button', { name: '关闭工具设置' })).toBeEnabled();
  expect(selectControl('使用工具的 Bot')).toBeEnabled();
  expect(screen.getByRole('button', { name: '保存工具选择' })).toBeEnabled();
  await userEvent.click(screen.getByRole('button', { name: '关闭工具设置' }));
  expect(invoke.mock.calls.some(([command]) => command.type === 'mcp.bind')).toBe(false);
});

it('makes bounded tool definitions reachable as a named keyboard scrolling area', async () => {
  connect();
  render(view());
  await userEvent.click(await screen.findByRole('button', { name: '工具与授权 合成服务' }));
  await userEvent.click(await screen.findByText('参数定义'));
  expect(screen.getByLabelText('synthetic_echo 参数定义')).toHaveAttribute('tabindex', '0');
});

it('does not select an archived identity when opening per-Bot external tool choices', async () => {
  const invoke = connect({ archived: true });
  render(view());
  await userEvent.click(await screen.findByRole('button', { name: '工具与授权 合成服务' }));
  const target = await findSelectControl('使用工具的 Bot');
  expect(target).toHaveAttribute('data-value', 'mock-b');
  expect(invoke.mock.calls.some(([command]) => command.type === 'mcp.bind')).toBe(false);
});
