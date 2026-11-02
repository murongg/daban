import { beforeEach as seedBeforeEach } from 'vitest';
import { serialize as seedSerialize, storageKey as seedStorageKey } from '../../app/storage';
import { demoState as seedDemoState } from '../../test/fixtures';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  disconnected,
  type Interaction,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';

afterEach(() => Reflect.deleteProperty(window, 'daban'));

it('shows the exact external connection, tool and argument preview before a scoped one-time approval', async () => {
  const request = {
    ...base,
    id: 'mock-mcp-card',
    bot: 'a',
    runId: 'mock-run-a',
    kind: 'approval',
    tool: 'mcp_call',
    connection: 'mock-connection',
    configRevision: 2,
    catalogDigest: 'a'.repeat(64),
    name: '合成连接',
    origin: 'https://mcp.example.test',
    operation: 'synthetic_echo',
    arguments: '{"value":"SYNTHETIC-PREVIEW"}',
    inputHash: 'b'.repeat(64),
  } as unknown as Interaction;
  const invoke = connect([request]);
  render(<App />);
  expect(await screen.findByRole('heading', { name: '调用外部工具' })).toBeVisible();
  expect(screen.getByText('合成连接 · synthetic_echo')).toBeVisible();
  expect(screen.getByText('https://mcp.example.test')).toBeVisible();
  expect(screen.getByText(/SYNTHETIC-PREVIEW/)).not.toBeVisible();
  await userEvent.click(screen.getByLabelText('查看调用参数'));
  expect(screen.getByText(/SYNTHETIC-PREVIEW/)).toBeVisible();
  expect(screen.getByLabelText('本次工具调用参数')).toHaveAttribute('tabindex', '0');
  await userEvent.click(screen.getByRole('button', { name: '仅允许这一次' }));
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'interaction.reply',
    bot: 'a',
    runId: 'mock-run-a',
    id: request.id,
    reply: { kind: 'decision', allow: true },
  });
});
const base = {
  sessionId: 'mock-session',
  status: 'pending' as const,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const question: Interaction = {
  ...base,
  id: 'mock-question',
  bot: 'a',
  runId: 'mock-run-a',
  kind: 'question',
  questions: [
    {
      id: 'format',
      question: '采用哪种合成格式？',
      options: [{ label: 'Markdown' }, { label: '纯文本' }],
    },
  ],
};
const approval: Interaction = {
  ...base,
  id: 'mock-approval',
  bot: 'b',
  runId: 'mock-run-b',
  kind: 'approval',
  tool: 'web_fetch',
  url: 'https://example.test/new?item=mock',
};
function connect(
  requests: Interaction[] = [question, approval],
  software?: RuntimeSnapshot['software'],
) {
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = 4;
  snapshot.model.configured = true;
  snapshot.interactions = requests;
  snapshot.software = software;
  snapshot.agents.a = {
    phase: 'waiting',
    running: true,
    runId: 'mock-run-a',
    requestId: 'mock-task-a',
    prompt: '合成任务',
    result: '',
    error: '',
    files: [],
    toolCount: 1,
    executedCount: 0,
    trace: [],
    history: [],
    plan: [
      { content: '核对合成格式', status: 'in_progress' },
      { content: '生成合成文件', status: 'pending' },
    ],
  };
  const subscribers = new Set<(snapshot: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'interaction.reply') {
      const current = snapshot.interactions!.find((item) => item.id === command.id)!;
      const updated = { ...current, status: 'resolved' as const, reply: command.reply };
      snapshot = {
        ...snapshot,
        interactions: snapshot.interactions!.map((item) =>
          item.id === current.id ? updated : item,
        ),
      };
      for (const subscriber of subscribers) subscriber(snapshot);
      return { ok: true as const, value: updated };
    }
    return {
      ok: true as const,
      value:
        command.type === 'status'
          ? snapshot
          : command.type === 'frame'
            ? 'data:image/jpeg;base64,c3ludGhldGlj'
            : {},
    };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (callback: (state: RuntimeSnapshot) => unknown) => {
          subscribers.add(callback);
          return () => subscribers.delete(callback);
        },
      } as unknown as RuntimeBridge,
    },
  });
  return invoke;
}
it('shows the native plan and preserves a question draft while switching Bots, then replies to the request owner from the inbox', async () => {
  const invoke = connect();
  render(<App />);
  expect(await screen.findByText('等待你的回复')).toBeVisible();
  expect(screen.getByText('核对合成格式')).toBeVisible();
  await userEvent.click(screen.getByRole('radio', { name: 'Markdown' }));
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await userEvent.click(within(nav).getByRole('button', { name: '写作搭档' }));
  expect(screen.getByText(approval.url)).toBeVisible();
  expect(invoke.mock.calls.some(([command]) => command.type === 'interaction.reply')).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: /收件箱/ }));
  expect(screen.queryByText('示例请求')).not.toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Markdown' })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: '提交回复' }));
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'interaction.reply',
    bot: 'a',
    id: 'mock-question',
    runId: 'mock-run-a',
    reply: { kind: 'answer', answers: [{ id: 'format', selected: ['Markdown'], custom: '' }] },
  });
  await userEvent.click(screen.getByRole('tab', { name: '已处理' }));
  expect(screen.getByText('Markdown')).toBeVisible();
});
it('requires an explicit one-shot web decision and sends refusal as a real backend decision', async () => {
  const invoke = connect();
  render(<App />);
  await screen.findByText('等待你的回复');
  await userEvent.click(screen.getByRole('button', { name: /收件箱/ }));
  expect(screen.getByRole('button', { name: '仅允许这一次' })).toBeEnabled();
  await userEvent.click(screen.getByRole('button', { name: '拒绝' }));
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'interaction.reply',
    bot: 'b',
    id: 'mock-approval',
    runId: 'mock-run-b',
    reply: { kind: 'decision', allow: false },
  });
  await userEvent.click(screen.getByRole('tab', { name: '已处理' }));
  expect(screen.getByText('已拒绝')).toBeVisible();
});
it('retains an ambiguous reply for an exact retry without changing it into another answer', async () => {
  const invoke = connect();
  const original = invoke.getMockImplementation()!;
  let attempts = 0;
  invoke.mockImplementation(async (command) => {
    if (command.type === 'interaction.reply' && ++attempts === 1)
      return { ok: false as const, error: 'RUNTIME_UNAVAILABLE' };
    return original(command);
  });
  render(<App />);
  await screen.findByText('等待你的回复');
  await userEvent.click(screen.getByRole('radio', { name: 'Markdown' }));
  await userEvent.click(screen.getByRole('button', { name: '提交回复' }));
  expect(await screen.findByRole('button', { name: '重试提交' })).toBeVisible();
  expect(screen.getByRole('radio', { name: '纯文本' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '重试提交' }));
  const replies = invoke.mock.calls
    .map(([command]) => command)
    .filter((command) => command.type === 'interaction.reply');
  expect(replies).toHaveLength(2);
  expect(replies[1]).toEqual(replies[0]);
});
it('handles model-provided question IDs as data, including prototype names in multi-select questions', async () => {
  const invoke = connect([
    {
      ...question,
      questions: [
        {
          id: '__proto__',
          question: '合成多选？',
          multiSelect: true,
          options: [{ label: 'Alpha' }, { label: 'Beta' }],
        },
      ],
    },
  ]);
  render(<App />);
  await screen.findByText('等待你的回复');
  await userEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
  await userEvent.click(screen.getByRole('button', { name: '提交回复' }));
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'interaction.reply',
    bot: 'a',
    runId: 'mock-run-a',
    id: 'mock-question',
    reply: {
      kind: 'answer',
      answers: [{ id: '__proto__', selected: ['Alpha', 'Beta'], custom: '' }],
    },
  });
});
it('brings a new human request into view instead of scrolling to the message marker above it', async () => {
  const seen: string[] = [];
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: function (this: HTMLElement, options?: ScrollIntoViewOptions) {
      // Horizontal workspace-tab visibility must not race the conversation's vertical request scroll.
      if (options?.block !== 'nearest' || options.inline !== 'nearest')
        seen.push(this.textContent || '');
    },
  });
  try {
    connect();
    render(<App />);
    await screen.findByText('等待你的回复');
    expect(seen.at(-1)).toContain('采用哪种合成格式？');
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

it('retains each original question and detail beside its own settled answer', async () => {
  connect([
    {
      ...question,
      status: 'resolved',
      questions: [
        { id: 'format', question: '合成输出格式？', detail: '仅用于合成展示。' },
        { id: 'count', question: '合成样本数量？' },
      ],
      reply: {
        kind: 'answer',
        answers: [
          { id: 'count', selected: [], custom: '47' },
          { id: 'format', selected: ['Markdown'], custom: '保留标题' },
        ],
      },
    },
  ]);
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: /收件箱/ }));
  await userEvent.click(screen.getByRole('tab', { name: '已处理' }));
  const format = await screen.findByText('合成输出格式？');
  expect(within(format.parentElement!).getByText('仅用于合成展示。')).toBeVisible();
  expect(within(format.parentElement!).getByText('Markdown；保留标题')).toBeVisible();
  expect(within(format.parentElement!).queryByText('47')).not.toBeInTheDocument();
  const count = screen.getByText('合成样本数量？');
  expect(within(count.parentElement!).getByText('47')).toBeVisible();
  expect(screen.queryByRole('button', { name: '提交回复' })).not.toBeInTheDocument();
});

it.each(['cancelled', 'interrupted'] as const)(
  'preserves the original question after it is %s without offering reply controls',
  async (status) => {
    connect([{ ...question, status }]);
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /收件箱/ }));
    await userEvent.click(screen.getByRole('tab', { name: '已处理' }));
    expect(await screen.findByText('采用哪种合成格式？')).toBeVisible();
    expect(
      screen.getByText(status === 'cancelled' ? '请求已撤销' : '任务已中断，这个请求不能再回复'),
    ).toBeVisible();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByText('已回复')).not.toBeInTheDocument();
  },
);

it('keeps group questions out of private messages while retaining their group provenance in the inbox', async () => {
  connect([{ ...question, conversationId: 'crew' }]);
  render(<App />);
  await screen.findByRole('button', { name: '研究员' });
  expect(screen.queryByText('采用哪种合成格式？')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /收件箱/ }));
  expect(await screen.findByText('采用哪种合成格式？')).toBeVisible();
  expect(
    within(screen.getByRole('region', { name: '收件箱' })).getByText('周报协作'),
  ).toBeVisible();
});

const softwarePlan = {
  id: 'mock-install-plan',
  requested: ['mock-calculator'],
  targets: [{ name: 'mock-calculator', version: '1.0-1' }],
  packages: [
    { name: 'mock-calculator', version: '1.0-1' },
    { name: 'mock-library', version: '2.0-1' },
  ],
  source: 'debian' as const,
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-01T00:10:00Z',
  digest: 'a'.repeat(64),
};
const softwareCard: Interaction = {
  ...base,
  id: 'mock-install-approval',
  bot: 'a',
  runId: 'mock-run-a',
  kind: 'approval',
  tool: 'software_install',
  plan: softwarePlan,
  purpose: '合成计算任务',
};
it('previews exact shared software and dependencies, then confirms once without claiming installation success', async () => {
  const invoke = connect([softwareCard], {
    available: true,
    items: [{ plan: softwarePlan, phase: 'planned', updatedAt: base.createdAt }],
  });
  render(<App />);
  expect(await screen.findByRole('heading', { name: '安装软件' })).toBeVisible();
  expect(screen.getByText('mock-calculator · 1.0-1')).not.toBeVisible();
  await userEvent.click(screen.getByLabelText('查看安装清单'));
  expect(screen.getByText('mock-calculator · 1.0-1')).toBeVisible();
  expect(screen.getByText('mock-library · 2.0-1')).toBeVisible();
  expect(screen.getByText('安装到共享 Linux，所有 Bot 都能使用。')).toBeVisible();
  expect(screen.getByRole('img', { name: 'Debian 官方软件源' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '确认安装' }));
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'interaction.reply',
    bot: 'a',
    runId: 'mock-run-a',
    id: softwareCard.id,
    reply: { kind: 'decision', allow: true },
  });
  expect(screen.queryByText('已安装，所有 Bot 均可使用')).not.toBeInTheDocument();
});
it.each([
  ['installing', '正在安装，关闭客户端后仍会继续'],
  ['installed', '已安装，所有 Bot 均可使用'],
  ['unknown', '安装结果待核对，请勿重复安装'],
  ['failed', '安装未完成，请查看结果后再处理'],
] as const)('shows actual %s receipt separately from approval', async (phase, label) => {
  connect([{ ...softwareCard, status: 'resolved', reply: { kind: 'decision', allow: true } }], {
    available: true,
    items: [{ plan: softwarePlan, phase, updatedAt: base.createdAt }],
  });
  render(<App />);
  expect(await screen.findByText(label)).toBeVisible();
  expect(screen.getByText('mock-calculator · 1.0-1')).not.toBeVisible();
  expect(screen.queryByRole('button', { name: '确认安装' })).not.toBeInTheDocument();
});

it('shows an exact Linux-only command before permission and does not describe approval as execution success', async () => {
  const card: Interaction = {
    ...base,
    id: 'mock-vm-command',
    bot: 'a',
    runId: 'mock-run-a',
    kind: 'approval',
    tool: 'vm_command',
    command: 'sudo npm install -g mock-cli@1.0.0',
    cwd: '/mock/vm/workspace',
    purpose: '合成命令验收',
    target: 'linux-vm',
  };
  const invoke = connect([card]);
  render(<App />);
  expect(await screen.findByRole('heading', { name: '在 Linux 中运行命令' })).toBeVisible();
  expect(screen.getByText('sudo npm install -g mock-cli@1.0.0')).not.toBeVisible();
  expect(screen.getByText('合成命令验收')).toBeVisible();
  expect(screen.getByText('Linux 虚拟机 · 可使用 sudo · 仅限本次')).toBeVisible();
  const details = screen.getByLabelText('查看命令与目录');
  await userEvent.hover(details);
  expect(await screen.findByRole('tooltip')).toHaveTextContent('查看命令与目录');
  await userEvent.click(details);
  expect(screen.getByText('sudo npm install -g mock-cli@1.0.0')).toBeVisible();
  expect(
    within(screen.getByRole('region', { name: '执行目录' })).getByText('/mock/vm/workspace'),
  ).toBeVisible();
  expect(screen.getByText(/不会在宿主机执行/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '确认执行' }));
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'interaction.reply',
    bot: 'a',
    runId: 'mock-run-a',
    id: card.id,
    reply: { kind: 'decision', allow: true },
  });
  expect(screen.queryByText('命令执行成功')).not.toBeInTheDocument();
  expect(screen.getByText('已确认本次虚拟机命令')).toBeVisible();
  const history = screen.getByLabelText('合成命令验收 · 查看操作详情').closest('details')!;
  expect(within(history.querySelector('summary')!).getByText('合成命令验收')).toBeVisible();
  expect(screen.getByText('sudo npm install -g mock-cli@1.0.0')).not.toBeVisible();
  expect(screen.queryByRole('heading', { name: '在 Linux 中运行命令' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByLabelText('合成命令验收 · 查看操作详情'));
  expect(screen.getByText('sudo npm install -g mock-cli@1.0.0')).toBeVisible();
  expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
});
