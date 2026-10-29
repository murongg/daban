import {
  disconnected,
  type Interaction,
  type McpAssignment,
  type McpConnection,
  type McpReceipt,
  type RuntimeBridge,
  type RuntimeCommand,
} from '@daban/protocol';
import { useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Integrations } from '../src/Integrations';
import { IntegrationTools } from '../src/IntegrationTools';
import { Requests } from '../src/Requests';
import { RuntimeProvider } from '../src/Runtime';
import { type Bot, initialState, reduce } from '../src/state';
import '../src/tokens.css';
import '../src/styles.css';

const query = new URLSearchParams(location.search);
const mode = query.get('mode') ?? 'library';
const width = query.get('width') === '420' ? 420 : 960;
document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const bots: Bot[] = ['a', 'b'].map((id) => ({
  id: `mock-${id}`,
  name: `合成 Bot ${id.toUpperCase()}`,
  role: '合成验收',
  color: 'mint',
  preview: '',
  time: '',
}));
const connection: McpConnection = {
  id: 'mock-preview-connection',
  name: '合成资料服务',
  origin: 'https://mcp.example.test',
  revision: 1,
  credentialConfigured: true,
  deleted: false,
  health: 'ready',
  toolCount: 2,
  catalogDigest: 'a'.repeat(64),
  checkedAt: '2026-01-01T09:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T09:00:00Z',
};
let rows = mode === 'empty' ? [] : [connection];
const tools = [
  {
    name: 'synthetic_find',
    alias: `ext_${'b'.repeat(20)}`,
    description: '检索合成资料，返回匹配条目。不会修改服务中的内容。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '合成检索词' } },
      required: ['query'],
      additionalProperties: false,
    },
    digest: 'b'.repeat(64),
  },
  {
    name: 'synthetic_save',
    alias: `ext_${'c'.repeat(20)}`,
    description: '将用户确认的合成摘要保存到目标服务。此操作可能修改外部内容。',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, summary: { type: 'string' } },
      required: ['title', 'summary'],
      additionalProperties: false,
    },
    digest: 'c'.repeat(64),
  },
];
const snapshot = disconnected('ready');
snapshot.protocolVersion = 21;
snapshot.mcp =
  mode === 'unavailable'
    ? { available: false, error: 'MCP_STORE_UNAVAILABLE' }
    : { available: true, revision: 1 };
snapshot.profiles = bots.map((bot) => ({
  id: bot.id,
  name: bot.name,
  color: 'mint',
  instructions: '',
  memory: '',
  revision: 1,
  createdAt: connection.createdAt,
  updatedAt: connection.updatedAt,
}));
const approval: Interaction = {
  id: 'mock-mcp-approval',
  bot: bots[0].id,
  runId: 'mock-preview-run',
  sessionId: 'mock-preview-session',
  kind: 'approval',
  tool: 'mcp_call',
  connection: connection.id,
  configRevision: 1,
  catalogDigest: connection.catalogDigest!,
  name: connection.name,
  origin: connection.origin,
  operation: 'synthetic_save',
  inputHash: 'd'.repeat(64),
  status: 'pending',
  arguments: JSON.stringify(
    { title: '合成周报', summary: '用户确认后才发送到外部服务。\n'.repeat(18) },
    null,
    2,
  ),
  createdAt: connection.createdAt,
  updatedAt: connection.updatedAt,
};
snapshot.interactions = mode === 'approval' ? [approval] : [];
const bindings = new Map<string, McpAssignment>();
const receipts: McpReceipt[] = [
  {
    id: 'mock-preview-call',
    bot: bots[0].id,
    run: 'mock-preview-run',
    session: 'mock-preview-session',
    connection: connection.id,
    configRevision: 1,
    tool: 'synthetic_save',
    phase: 'unknown',
    preview: '{"title":"合成周报","summary":"SYNTHETIC-CONTENT"}',
    error: 'MCP_OUTCOME_UNKNOWN',
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  },
];
const listeners = new Set<Parameters<RuntimeBridge['subscribe']>[0]>();
let revision = 1;
let saved: unknown;
function publish() {
  if (snapshot.mcp?.available) snapshot.mcp.revision = ++revision;
  for (const listener of listeners) listener(structuredClone(snapshot));
}
function assignment(bot: string, row: McpConnection): McpAssignment {
  const bound = bindings.get(`${bot}/${row.id}`);
  return bound
    ? {
        ...bound,
        connection: row,
        available:
          bound.enabled &&
          bound.connection.revision === row.revision &&
          bound.catalogDigest === row.catalogDigest,
      }
    : {
        connection: row,
        revision: 0,
        enabled: false,
        available: false,
        tools: [],
      };
}
function fixture(command: RuntimeCommand): unknown {
  if (command.type === 'status') return structuredClone(snapshot);
  if (command.type === 'mcp.list')
    return { revision, items: rows.filter((row) => row.deleted === !!command.includeDeleted) };
  if (command.type === 'mcp.check')
    rows = rows.map((row) =>
      row.id === command.id
        ? {
            ...row,
            health: 'ready',
            toolCount: tools.length,
            catalogDigest: connection.catalogDigest,
          }
        : row,
    );
  if (command.type === 'mcp.catalog' || command.type === 'mcp.check') {
    const current = rows.find((row) => row.id === command.id);
    return { current, tools: current?.toolCount ? tools : [] };
  }
  if (command.type === 'mcp.bindings')
    return {
      bot: command.bot,
      revision,
      items: rows.filter((row) => !row.deleted).map((row) => assignment(command.bot, row)),
    };
  if (command.type === 'mcp.bind') {
    const row = rows.find((item) => item.id === command.input.connection)!;
    const entry = {
      connection: row,
      revision: command.input.bindingRevision + 1,
      enabled: command.input.enabled,
      available: command.input.enabled,
      tools: command.input.tools,
      catalogDigest: command.input.catalogDigest,
    };
    bindings.set(`${command.bot}/${row.id}`, entry);
    publish();
    return { bot: command.bot, entry };
  }
  if (command.type === 'mcp.save') {
    if (mode === 'conflict') throw new Error('MCP_CONFLICT');
    const current = {
      ...connection,
      id: command.input.id,
      revision: command.input.revision + 1,
      name: command.input.name,
      health: 'unchecked' as const,
      toolCount: 0,
      catalogDigest: undefined,
    };
    rows = [...rows.filter((row) => row.id !== current.id), current];
    saved = {
      receipt: { id: command.input.requestId, connection: current.id, revision: current.revision },
      current,
    };
    publish();
    if (mode === 'uncertain') throw new Error('RUNTIME_SESSION_CHANGED');
    return saved;
  }
  if (command.type === 'mcp.saved') return saved;
  if (command.type === 'mcp.calls')
    return {
      bot: command.bot,
      items: receipts.filter(
        (item) =>
          item.bot === command.bot &&
          (!command.connection || item.connection === command.connection),
      ),
    };
  if (command.type === 'mcp.receipt')
    return receipts.find((item) => item.id === command.id && item.bot === command.bot);
  if (command.type === 'mcp.archive' || command.type === 'mcp.restore') {
    rows = rows.map((row) =>
      row.id === command.id
        ? { ...row, deleted: command.type === 'mcp.archive', revision: row.revision + 1 }
        : row,
    );
    bindings.clear();
    publish();
    return rows.find((row) => row.id === command.id);
  }
  if (command.type === 'interaction.reply') {
    const current = { ...approval, status: 'resolved' as const, reply: command.reply };
    snapshot.interactions = [current];
    publish();
    return current;
  }
  return {};
}
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: {
    platform: 'darwin',
    runtime: {
      invoke: async (command: RuntimeCommand) => {
        try {
          return { ok: true, value: fixture(command) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'SYNTHETIC_FAILURE' };
        }
      },
      subscribe: (listener: Parameters<RuntimeBridge['subscribe']>[0]) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as RuntimeBridge,
  },
});
function Preview() {
  const [state, dispatch] = useReducer(reduce, { ...initialState(), bots });
  const [notice, setNotice] = useState('');
  return (
    <main style={{ width, maxWidth: '100%', margin: '0 auto', padding: 24 }} data-mcp-preview>
      <style>{'html,body,#root{height:auto;min-height:100%;overflow:visible}'}</style>
      <h1 className="page-heading">设置</h1>
      <p className="field-help">
        合成内容验收预览 · {width === 420 ? '紧凑内容区，非手机端' : '桌面内容区'} · 生产组件
      </p>
      {mode === 'approval' ? (
        <Requests state={state} dispatch={dispatch} notify={setNotice} bot={bots[0].id} />
      ) : mode === 'tools' ? (
        <div className="integration-settings">
          <IntegrationTools connection={connection} bots={bots} onClose={() => {}} />
        </div>
      ) : (
        <Integrations bots={bots} />
      )}
      {notice && <p role="status">{notice}</p>}
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('SYNTHETIC_ROOT_MISSING');
createRoot(root).render(
  <RuntimeProvider>
    <Preview />
  </RuntimeProvider>,
);
