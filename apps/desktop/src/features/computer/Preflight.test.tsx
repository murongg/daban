import { createHash, webcrypto } from 'node:crypto';
import {
  disconnected,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { demoState } from '../../test/fixtures';
import { Conversation } from '../chat/Conversation';
import * as downloads from '../files/files';
import { Preflight } from './Preflight';

function bridge(read: (command: RuntimeCommand) => unknown | Promise<unknown>, supported = true) {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 14;
  snapshot.model = {
    configured: true,
    available: true,
    provider: 'mock-provider',
    model: 'deepseek-flash',
    revision: 1,
  };
  if (supported) Object.assign(snapshot, { preflight: 1 });
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(
    async (command: RuntimeCommand, _host?: string | null): Promise<RuntimeReply> => ({
      ok: true,
      value: command.type === 'status' ? snapshot : await read(command),
    }),
  );
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      runtime: {
        invoke,
        subscribe: (listener: (value: RuntimeSnapshot) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  return {
    invoke,
    snapshot,
    publish: () => {
      for (const listener of listeners) listener(snapshot);
    },
  };
}

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => {
  Reflect.deleteProperty(window, 'daban');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('button', { name: '检查所需能力' });
  await waitFor(() => expect(screen.getByRole('button', { name: '检查所需能力' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '检查所需能力' }));
}

it('offers a manual task preflight without sending the draft or starting a task', async () => {
  const backend = bridge(() => {
    throw Error('unexpected preflight read');
  });
  const state = demoState();
  const bot = state.bots.find((item) => item.id === 'research')!;
  state.drafts[bot.id] = 'SYNTHETIC PRIVATE DRAFT';
  const send = vi.fn();
  render(
    <RuntimeProvider>
      <Conversation
        state={state}
        bot={bot}
        dispatch={vi.fn()}
        preview={vi.fn()}
        notify={vi.fn()}
        onModel={vi.fn()}
        onSend={send}
      />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await openPanel(user);
  expect(screen.getByRole('dialog', { name: '任务能力预检' })).toBeVisible();
  expect(backend.invoke.mock.calls.map(([command]) => command.type)).toEqual(['status']);
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: '检查所需能力' })).toHaveFocus();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC PRIVATE DRAFT');
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'task.stop')).toBe(false);
});

it('explains missing capability without sending a preflight command', async () => {
  const backend = bridge(() => {
    throw Error('unexpected external read');
  }, false);
  const { Preflight } = await import('./Preflight');
  render(
    <RuntimeProvider>
      <Preflight bot="mock-bot" selection="mock-selection" onAction={vi.fn()} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await openPanel(user);
  expect(screen.getByText('当前服务不支持任务预检，可继续使用原有环境检查。')).toBeVisible();
  expect(screen.queryByRole('button', { name: '检查已选需求' })).not.toBeInTheDocument();
  expect(backend.invoke.mock.calls.map(([command]) => command.type)).toEqual(['status']);
});

it('requires an explicit check and submits only selected requirements', async () => {
  const backend = bridge(() => {
    throw Error('SYNTHETIC PRIVATE OWNER ERROR');
  });
  const { Preflight } = await import('./Preflight');
  render(
    <RuntimeProvider>
      <Preflight bot="mock-bot" selection="mock-selection" onAction={vi.fn()} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('checkbox', { name: '工具调用声明' }));
  await user.type(screen.getByRole('spinbutton', { name: '最小输入预算（tokens）' }), '12000');
  await user.click(screen.getByRole('checkbox', { name: '搜索配置' }));
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  const command = backend.invoke.mock.calls
    .map(([value]) => value)
    .find((value) => value.type === 'preflight.inspect');
  expect(command).toEqual({
    type: 'preflight.inspect',
    query: {
      id: expect.any(String),
      bot: 'mock-bot',
      requirements: [
        { kind: 'model', vision: false, tools: true, minContextTokens: 12000 },
        { kind: 'search' },
      ],
    },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('检查未完成，请重新进行只读检查。');
  expect(document.body.textContent).not.toContain('SYNTHETIC PRIVATE OWNER ERROR');
  expect(backend.invoke.mock.calls.map(([value]) => value.type)).toEqual([
    'status',
    'preflight.inspect',
  ]);
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function makeReport(command: RuntimeCommand) {
  if (!('query' in command)) throw Error('SYNTHETIC INVALID QUERY');
  const query = command.query as { id: string; bot: string; requirements: { kind: string }[] };
  const sampled = Date.now();
  const checkedAt = new Date(sampled).toISOString();
  const report = {
    schema: 1,
    id: query.id,
    bot: query.bot,
    workspace: 'mock-host-scope',
    checkedAt,
    freshUntil: new Date(sampled + 30000).toISOString(),
    expiresAt: new Date(sampled + 300000).toISOString(),
    requirements: query.requirements,
    versions: ['model', 'profile', 'mcp', 'computer', 'runtime', 'search'].map((source) => ({
      source,
      stamp: null,
    })),
    checks: query.requirements.map((_, index) => ({
      index,
      state: 'ready',
      reason: 'CONFIG_PRESENT',
      action: 'none',
      evidence: 'local-config',
      observedAt: checkedAt,
    })),
    summary: 'ready',
    externalProbe: 'not-run',
  };
  return { ...report, digest: hash(canonical(report)) };
}
function makePackage(report: ReturnType<typeof makeReport>) {
  const json = canonical({
    schemaVersion: 1,
    productVersion: '0.1.7',
    protocolVersion: 44,
    platform: 'linux',
    ageSeconds: 0,
    checks: report.checks.map((check, index) => ({
      index,
      kind: report.requirements[index].kind,
      state: check.state,
      reason: check.reason,
      evidence: check.evidence,
      botAlias: 'bot-1',
    })),
  });
  return { id: report.id, reportDigest: report.digest, packageDigest: hash(json), json };
}
function panel(selection = 'mock-selection', onAction = vi.fn()) {
  return (
    <RuntimeProvider>
      <Preflight bot="mock-bot" selection={selection} onAction={onAction} />
    </RuntimeProvider>
  );
}

it('shows source and time without claiming a model call, and invalidates a changed requirement', async () => {
  bridge((command) => makeReport(command));
  render(panel());
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  expect(await screen.findByText('所选配置条件已满足')).toBeVisible();
  expect(screen.getByText('外部服务与模型连通性：本次未测试。')).toBeVisible();
  expect(screen.getByText(/^已保存配置/)).toBeVisible();
  expect(screen.getByRole('time')).toHaveAttribute('dateTime');
  await user.click(screen.getByRole('checkbox', { name: '图片输入声明' }));
  expect(screen.queryByText('所选配置条件已满足')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '预览诊断包' })).not.toBeInTheDocument();
});

it('drops a cancelled check and a response belonging to the previous selection', async () => {
  let finish: (value: unknown) => unknown = () => {};
  let saved: RuntimeCommand | undefined;
  const backend = bridge((command) => {
    saved = command;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const view = render(panel());
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  await user.click(screen.getByRole('button', { name: '取消等待' }));
  await act(async () => {
    if (saved) finish(makeReport(saved));
  });
  expect(screen.queryByText('所选配置条件已满足')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  view.rerender(panel('mock-changed-model'));
  await act(async () => {
    if (saved) finish(makeReport(saved));
  });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'task.stop')).toBe(false);
});

it('previews exact JSON and downloads only the identical explicitly exported bytes', async () => {
  let report: ReturnType<typeof makeReport> | undefined;
  let pack: ReturnType<typeof makePackage> | undefined;
  const backend = bridge((command) => {
    if (command.type === 'preflight.inspect') {
      report = makeReport(command);
      pack = makePackage(report);
      return report;
    }
    return pack;
  });
  const download = vi.spyOn(downloads, 'downloadBlob').mockImplementation(() => {});
  render(panel());
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  await user.click(await screen.findByRole('button', { name: '预览诊断包' }));
  const preview = await screen.findByRole('dialog', { name: '诊断包预览' });
  expect(within(preview).getByRole('textbox', { name: '确切导出 JSON' })).toHaveValue(pack?.json);
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  await waitFor(() =>
    expect(within(preview).getByRole('button', { name: '下载此诊断包' })).toBeEnabled(),
  );
  await user.tab();
  expect(within(preview).getByRole('textbox', { name: '确切导出 JSON' })).toHaveFocus();
  await user.tab();
  expect(within(preview).getByRole('button', { name: '下载此诊断包' })).toHaveFocus();
  expect(download).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: '预览诊断包' })).toHaveFocus();
  expect(download).not.toHaveBeenCalled();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'preflight.export')).toBe(
    false,
  );
  await user.click(screen.getByRole('button', { name: '预览诊断包' }));
  await screen.findByRole('dialog', { name: '诊断包预览' });
  await user.click(screen.getByRole('button', { name: '下载此诊断包' }));
  await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  expect(download.mock.calls[0][0]).toBe('daban-diagnostic.json');
  const exported = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(Error('SYNTHETIC READ FAILED'));
    reader.onerror = () => reject(Error('SYNTHETIC READ FAILED'));
    reader.readAsText(download.mock.calls[0][1]);
  });
  expect(exported).toBe(pack?.json);
  expect(backend.invoke.mock.calls.map(([command]) => command.type)).toEqual([
    'status',
    'preflight.inspect',
    'preflight.preview',
    'preflight.preview',
    'preflight.export',
  ]);
});

it('rejects corrupt digests and an exported package differing from the preview', async () => {
  let pack: ReturnType<typeof makePackage> | undefined;
  const backend = bridge((command) => {
    if (command.type === 'preflight.inspect') {
      const report = makeReport(command);
      pack = makePackage(report);
      return report;
    }
    return command.type === 'preflight.export' ? { ...pack, json: `${pack?.json} ` } : pack;
  });
  const download = vi.spyOn(downloads, 'downloadBlob').mockImplementation(() => {});
  render(panel());
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  await user.click(await screen.findByRole('button', { name: '预览诊断包' }));
  await screen.findByRole('dialog', { name: '诊断包预览' });
  await user.click(screen.getByRole('button', { name: '下载此诊断包' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('诊断包与已预览内容不一致，未下载。');
  expect(download).not.toHaveBeenCalled();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);
});

it('loads exact MCP options on demand and clears a stale page with its selections', async () => {
  let page = 0;
  const backend = bridge((command) => {
    if (command.type === 'preflight.options') {
      if (++page === 2) throw Error('PREFLIGHT_OPTIONS_STALE');
      return {
        bot: 'mock-bot',
        workspace: 'mock-host-scope',
        state: 'ready',
        version: 'a'.repeat(64),
        truncated: true,
        items: [
          {
            connection: 'mock-connection',
            catalogDigest: 'b'.repeat(64),
            tool: 'ext_01234567890123456789',
            connectionLabel: '<mock-connection>',
            toolLabel: 'Mock read',
          },
        ],
        next: 'mock-cursor',
      };
    }
    return makeReport(command);
  });
  render(panel());
  const user = userEvent.setup();
  await openPanel(user);
  expect(backend.invoke.mock.calls.map(([command]) => command.type)).toEqual(['status']);
  await user.click(screen.getByRole('button', { name: '选择 MCP 工具' }));
  await user.click(await screen.findByRole('checkbox', { name: '<mock-connection> · Mock read' }));
  expect(screen.getByText('仅列出前 500 项。可在原工具设置中缩小已选范围。')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '加载下一页' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '工具选择已变化，已清空旧选择。请重新加载。',
  );
  expect(
    screen.queryByRole('checkbox', { name: '<mock-connection> · Mock read' }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  await screen.findByText('所选配置条件已满足');
  const inspect = backend.invoke.mock.calls
    .map(([command]) => command)
    .find((command) => command.type === 'preflight.inspect');
  expect(inspect).toEqual({
    type: 'preflight.inspect',
    query: {
      id: expect.any(String),
      bot: 'mock-bot',
      requirements: [{ kind: 'model', vision: false, tools: false }],
    },
  });
  expect(backend.invoke.mock.calls.some(([command]) => command.type.startsWith('mcp.'))).toBe(
    false,
  );
});

it('marks a report stale after 30 seconds and expires it after five minutes without a background recheck', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const backend = bridge((command) => makeReport(command));
  render(panel());
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  await screen.findByText('所选配置条件已满足');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(31000);
  });
  expect(screen.getByText('报告已超过 30 秒，状态可能变化。请重新检查。')).toBeVisible();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(270000);
  });
  expect(screen.getByText('报告已过期，请重新进行只读检查。')).toBeVisible();
  expect(screen.getByRole('button', { name: '预览诊断包' })).toBeDisabled();
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'preflight.inspect'),
  ).toHaveLength(1);
});

it('rejects a mismatched report digest instead of displaying a ready result', async () => {
  bridge((command) => ({ ...makeReport(command), digest: 'a'.repeat(64) }));
  render(panel());
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('检查未完成，请重新进行只读检查。');
  expect(screen.queryByText('所选配置条件已满足')).not.toBeInTheDocument();
});

it('discards a late MCP page when the Host changes and never falls back to the local Host', async () => {
  let finish: (value: unknown) => unknown = () => {};
  const backend = bridge(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <RuntimeProvider host={'a'.repeat(64)}>
      <Preflight bot="mock-bot" selection="mock" onAction={vi.fn()} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '选择 MCP 工具' }));
  view.rerender(
    <RuntimeProvider host={'b'.repeat(64)}>
      <Preflight bot="mock-bot" selection="mock" onAction={vi.fn()} />
    </RuntimeProvider>,
  );
  await act(async () =>
    finish({
      bot: 'mock-bot',
      workspace: 'mock-old-scope',
      state: 'ready',
      version: 'a'.repeat(64),
      truncated: false,
      items: [
        {
          connection: 'mock-old',
          catalogDigest: 'b'.repeat(64),
          tool: 'ext_01234567890123456789',
          connectionLabel: 'SYNTHETIC OLD HOST',
          toolLabel: 'Mock tool',
        },
      ],
    }),
  );
  expect(screen.queryByText('SYNTHETIC OLD HOST')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  for (const call of backend.invoke.mock.calls) expect(call[1]).toMatch(/^[ab]{64}$/);
});

it('previews the exact selected MCP tool and computer access before checking', async () => {
  const backend = bridge((command) =>
    command.type === 'preflight.options'
      ? {
          bot: 'mock-bot',
          workspace: 'mock-host-scope',
          state: 'ready',
          version: 'a'.repeat(64),
          truncated: false,
          items: [
            {
              connection: 'mock-connection',
              catalogDigest: 'b'.repeat(64),
              tool: 'ext_01234567890123456789',
              connectionLabel: 'Mock connection',
              toolLabel: 'Mock read',
            },
          ],
        }
      : makeReport(command),
  );
  render(panel());
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: /电脑需求$/ }));
  await user.click(screen.getByRole('option', { name: '本机电脑' }));
  await user.click(screen.getByRole('button', { name: /所需权限$/ }));
  await user.click(screen.getByRole('option', { name: '控制' }));
  await user.click(screen.getByRole('button', { name: '选择 MCP 工具' }));
  await user.click(await screen.findByRole('checkbox', { name: 'Mock connection · Mock read' }));
  const selection = screen.getByRole('region', { name: '需求预览' });
  expect(within(selection).getByText('Mock connection · Mock read')).toBeVisible();
  expect(within(selection).getByText('本机电脑 · 控制')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'preflight.inspect',
    query: {
      id: expect.any(String),
      bot: 'mock-bot',
      requirements: [
        { kind: 'model', vision: false, tools: false },
        { kind: 'computer', mode: 'local', access: 'control' },
        {
          kind: 'mcp',
          connection: 'mock-connection',
          catalogDigest: 'b'.repeat(64),
          tool: 'ext_01234567890123456789',
        },
      ],
    },
  });
});

it('discards an export that returns after the initiating selection has been replaced', async () => {
  let pack: ReturnType<typeof makePackage> | undefined;
  let finish: (value: unknown) => unknown = () => {};
  bridge((command) => {
    if (command.type === 'preflight.inspect') {
      const report = makeReport(command);
      pack = makePackage(report);
      return report;
    }
    if (command.type === 'preflight.export')
      return new Promise((resolve) => {
        finish = resolve;
      });
    return pack;
  });
  const download = vi.spyOn(downloads, 'downloadBlob').mockImplementation(() => {});
  const view = render(panel());
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  await user.click(await screen.findByRole('button', { name: '预览诊断包' }));
  await screen.findByRole('dialog', { name: '诊断包预览' });
  await user.click(screen.getByRole('button', { name: '下载此诊断包' }));
  view.rerender(panel('mock-new-attachment-type'));
  await act(async () => finish(pack));
  expect(download).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('keeps unknown declarations distinct and opens settings only after an explicit action', async () => {
  const backend = bridge((command) => {
    const { digest: _old, ...report } = makeReport(command);
    report.checks[0].state = 'unknown';
    report.checks[0].reason = 'MODEL_CAPABILITY_UNKNOWN';
    report.checks[0].action = 'models';
    report.summary = 'attention';
    return { ...report, digest: hash(canonical(report)) };
  });
  const action = vi.fn();
  render(panel('mock', action));
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('checkbox', { name: '工具调用声明' }));
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  expect(await screen.findByText('模型尚未声明所需能力，无法确认。')).toBeVisible();
  expect(screen.getByText('未知', { exact: true })).toBeVisible();
  expect(action).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '打开模型设置' }));
  expect(action).toHaveBeenCalledWith('models');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(backend.invoke.mock.calls.map(([command]) => command.type)).toEqual([
    'status',
    'preflight.inspect',
  ]);
});

it.each([
  ['PREFLIGHT_LIMIT', '诊断快照已达到内存上限，稍后重新检查。'],
  ['PREFLIGHT_STORAGE_LIMIT', '诊断快照已达到内存上限，稍后重新检查。'],
  ['PREFLIGHT_AUTHORITY_CHANGED', '目标来源已变化，请在当前目标重新检查。'],
  ['BOT_ARCHIVED', '目标来源已变化，请在当前目标重新检查。'],
  ['BOT_PROFILE_NOT_FOUND', '目标来源已变化，请在当前目标重新检查。'],
])('maps fixed Host error %s to an actionable local message', async (code, message) => {
  bridge(() => {
    throw Error(code);
  });
  render(panel());
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '检查已选需求' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
});

it('retains exact MCP options in tuple order when connection IDs share a prefix', async () => {
  bridge(() => ({
    bot: 'mock-bot',
    workspace: 'mock-host-scope',
    state: 'ready',
    version: 'a'.repeat(64),
    truncated: false,
    items: [
      {
        connection: 'a',
        catalogDigest: 'b'.repeat(64),
        tool: 'ext_01234567890123456789',
        connectionLabel: 'Mock A',
        toolLabel: 'Mock read',
      },
      {
        connection: 'a-b',
        catalogDigest: 'c'.repeat(64),
        tool: 'ext_12345678901234567890',
        connectionLabel: 'Mock AB',
        toolLabel: 'Mock read',
      },
    ],
  }));
  render(panel());
  const user = userEvent.setup();
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '选择 MCP 工具' }));
  expect(await screen.findByRole('checkbox', { name: 'Mock A · Mock read' })).toBeVisible();
  expect(screen.getByRole('checkbox', { name: 'Mock AB · Mock read' })).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
