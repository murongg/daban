import {
  disconnected,
  type McpAssignment,
  type McpConnection,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
} from '@daban/protocol';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { BotTools } from './BotTools';
import { Integrations } from './Integrations';
import { IntegrationTools } from './IntegrationTools';

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
  protocol = 41,
  error = '',
  changeOnCheck = false,
  stale = false,
  archived = false,
  offline = false,
  ownerBot,
}: {
  empty?: boolean;
  protocol?: number;
  error?: string;
  changeOnCheck?: boolean;
  stale?: boolean;
  archived?: boolean;
  offline?: boolean;
  ownerBot?: string;
} = {}) {
  let rows = empty
    ? []
    : [
        {
          ...structuredClone(connection),
          revision: stale ? 2 : 1,
          ...(ownerBot ? { ownerBot } : {}),
        },
      ];
  let offered = [tool];
  let saved: unknown;
  const bindings = new Map<string, McpAssignment>();
  const snapshot = disconnected(offline ? 'offline' : 'ready');
  snapshot.botCapabilities = true;
  if (ownerBot) snapshot.appWorkspace = true;
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
          items: rows.filter(
            (row) =>
              row.deleted === !!command.includeDeleted &&
              (command.allOwners || !row.ownerBot || row.ownerBot === command.bot),
          ),
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
          items: rows
            .filter((row) => !row.deleted && (!row.ownerBot || row.ownerBot === command.bot))
            .map((row) => entry(command.bot, row)),
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
        ...(command.bot ? { ownerBot: command.bot } : {}),
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
const botView = (bot = bots[0], onDirty = vi.fn()) => (
  <RuntimeProvider>
    <BotTools bot={bot} onDirty={onDirty} />
  </RuntimeProvider>
);
const view = () => (
  <RuntimeProvider>
    <Integrations bots={bots} />
  </RuntimeProvider>
);

async function details() {
  const row = (await screen.findByRole('heading', { name: '合成服务' })).closest<HTMLElement>(
    '.integration-row',
  )!;
  const summary = within(row).getByText('连接详情', { selector: 'summary' });
  if (!summary.parentElement?.hasAttribute('open')) await userEvent.click(summary);
}

it('reports its local archive dialog layer without repeating the signal on ordinary rerenders', async () => {
  connect();
  const change = vi.fn();
  const mounted = render(
    <RuntimeProvider>
      <Integrations bots={bots} onDialogChange={change} />
    </RuntimeProvider>,
  );
  await details();
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

it('lets settings add a connection before any Bot exists and grants no tools', async () => {
  const invoke = connect({ empty: true });
  render(
    <RuntimeProvider>
      <Integrations bots={[]} />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '添加连接' }));
  await userEvent.type(screen.getByLabelText('连接名称'), 'Synthetic workspace MCP');
  await userEvent.type(screen.getByLabelText('服务地址'), 'https://mcp.example.test/mcp');
  await userEvent.click(screen.getByRole('button', { name: '保存连接' }));
  await screen.findByRole('heading', { name: 'Synthetic workspace MCP' });
  const commands = invoke.mock.calls.map(([command]) => command);
  expect(commands.find((command) => command.type === 'mcp.save')).not.toHaveProperty('bot');
  expect(commands.some((command) => command.type === 'mcp.bind')).toBe(false);
});

it('keeps private drafts after a configuration conflict rather than replacing them with a late saved value', async () => {
  connect({ error: 'MCP_CONFLICT' });
  render(view());
  await details();
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
  await details();
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
  const settings = render(view());
  await userEvent.click(await screen.findByRole('button', { name: '检查 合成服务' }));
  expect(invoke.mock.calls.some(([command]) => command.type === 'mcp.bind')).toBe(false);
  expect(screen.queryByRole('button', { name: '工具与授权 合成服务' })).not.toBeInTheDocument();
  settings.unmount();
  const first = render(botView());
  await userEvent.click(await screen.findByRole('button', { name: '工具与授权 合成服务' }));
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
  await waitFor(() => expect(screen.getByText('已启用')).toBeVisible());
  first.unmount();
  render(botView(bots[1]));
  await userEvent.click(await screen.findByRole('button', { name: '工具与授权 合成服务' }));
  expect(
    await screen.findByRole('checkbox', { name: '允许这位 Bot 使用所选工具' }),
  ).not.toBeChecked();
});

it('warns that archive revokes every Bot and restore never grants tools automatically', async () => {
  const invoke = connect();
  render(view());
  await details();
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
  expect(
    await screen.findByText('请更新本地 Agent，以使用 Bot 独立的技能安装和外部连接。'),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: '添加连接' })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command.type.startsWith('mcp.'))).toBe(false);
});

it('blocks closing the Bot panel while its tool selection is dirty', async () => {
  connect();
  const dirty = vi.fn();
  render(botView(bots[0], dirty));
  await userEvent.click(await screen.findByRole('button', { name: '工具与授权 合成服务' }));
  await userEvent.click(await screen.findByRole('checkbox', { name: 'synthetic_echo' }));
  expect(dirty).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: '关闭工具设置' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '放弃选择修改' }));
  expect(dirty).toHaveBeenLastCalledWith(false);
  expect(screen.getByRole('button', { name: '关闭工具设置' })).toBeEnabled();
});

it('revalidates a changed catalog without losing dirty tool choices and requires an explicit version decision', async () => {
  const invoke = connect({ changeOnCheck: true });
  const mounted = render(
    <RuntimeProvider>
      <IntegrationTools connection={connection} bot={bots[0]} onClose={() => {}} />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('checkbox', { name: 'synthetic_echo' }));
  await invoke({ type: 'mcp.check', id: connection.id, revision: 1 });
  mounted.rerender(
    <RuntimeProvider>
      <IntegrationTools
        connection={{ ...connection, toolCount: 2, catalogDigest: 'd'.repeat(64) }}
        bot={bots[0]}
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
  render(botView());
  await userEvent.click(await screen.findByRole('button', { name: '工具与授权 合成服务' }));
  await screen.findByRole('checkbox', { name: 'synthetic_echo' });
  expect(screen.getByRole('button', { name: '关闭工具设置' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '保存工具选择' })).toBeEnabled();
  await userEvent.click(screen.getByRole('button', { name: '关闭工具设置' }));
  expect(invoke.mock.calls.some(([command]) => command.type === 'mcp.bind')).toBe(false);
});

it('makes bounded tool definitions reachable as a named keyboard scrolling area', async () => {
  connect();
  render(botView());
  await userEvent.click(await screen.findByRole('button', { name: '工具与授权 合成服务' }));
  await userEvent.click(await screen.findByText('参数定义'));
  expect(screen.getByLabelText('synthetic_echo 参数定义')).toHaveAttribute('tabindex', '0');
});

it('keeps a legacy private connection editable in settings without broadening access', async () => {
  const invoke = connect({ ownerBot: 'mock-b' });
  const settings = render(view());
  expect(await screen.findByText('仅 合成 Bot 2 可用')).toBeVisible();
  await details();
  await userEvent.click(screen.getByRole('button', { name: '编辑 合成服务' }));
  await userEvent.click(screen.getByRole('button', { name: '保存连接' }));
  expect(await screen.findByText('连接已保存，请检查连接并单独为 Bot 选择工具。')).toBeVisible();
  expect(invoke.mock.calls.find(([command]) => command.type === 'mcp.save')?.[0]).toMatchObject({
    bot: 'mock-b',
    input: { id: connection.id, revision: 1 },
  });
  settings.unmount();
  const other = render(botView());
  expect(await screen.findByText(/暂无可用连接/)).toBeVisible();
  other.unmount();
  render(botView(bots[1]));
  expect(await screen.findByRole('button', { name: '工具与授权 合成服务' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '添加连接' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '检查 合成服务' })).not.toBeInTheDocument();
});

it('does not load external-tool grants for an archived Bot', async () => {
  const invoke = connect({ archived: true });
  render(botView());
  await screen.findByText('暂时无法管理这位 Bot 的外部工具。');
  expect(invoke.mock.calls.some(([command]) => command.type === 'mcp.bindings')).toBe(false);
});
