import {
  approvalRulesCapability,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
} from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { selectControl, selectOption } from '../../test/select.fixture';
import { Rules } from './Rules';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
const bots: Bot[] = [
  { id: 'mock-bot', name: '合成 Bot', role: '', color: 'mint', preview: '', time: '' },
];
function connect(supported = true) {
  const snapshot = disconnected('ready');
  if (supported)
    snapshot.approvalRules = { capability: approvalRulesCapability, available: true, revision: 0 };
  snapshot.profiles = [
    {
      id: 'mock-bot',
      name: '合成 Bot',
      color: 'mint',
      instructions: '',
      memory: '',
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'status' || command.type === 'connect')
      return { ok: true, value: snapshot };
    if (command.type === 'approval.rules.list')
      return { ok: true, value: { scope: command.scope, revision: 0, rules: [] } };
    if (command.type === 'approval.rules.preview')
      return {
        ok: true,
        value: { effect: 'deny', source: 'rule', reasonCode: 'ruleDenied', matchedRules: [] },
      };
    if (command.type === 'approval.rules.write')
      return {
        ok: true,
        value: {
          requestId: command.request.requestId,
          id: command.request.action === 'save' ? command.request.rule.id : command.request.id,
          revision: command.request.expectedRevision + 1,
          scope: command.request.scope,
          ...(command.request.action === 'save'
            ? { rule: { ...command.request.rule, scope: command.request.scope, revision: 1 } }
            : { deleted: true }),
        },
      };
    return { ok: true, value: {} };
  });
  const bridge: RuntimeBridge = {
    invoke: async <T,>(command: RuntimeCommand) => (await invoke(command)) as RuntimeReply<T>,
    subscribe: () => () => undefined,
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime: bridge },
  });
  return invoke;
}
async function openNewRule() {
  const opener = await screen.findByRole('button', { name: '新建规则' });
  await waitFor(() => expect(opener).toBeEnabled());
  await userEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: '新建规则' });
  return { opener, dialog };
}
it('previews without saving or executing and saves only after an explicit action', async () => {
  const invoke = connect();
  render(
    <StrictMode>
      <RuntimeProvider>
        <Rules bots={bots} />
      </RuntimeProvider>
    </StrictMode>,
  );
  const { dialog } = await openNewRule();
  await userEvent.type(within(dialog).getByRole('textbox', { name: '规则名称' }), '合成精确 URL');
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: '精确 URL' }),
    'https://example.test/mock',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: '预览决策' }));
  expect(invoke.mock.calls.some(([command]) => command.type === 'approval.rules.preview')).toBe(
    true,
  );
  expect(await screen.findByText('精确规则拒绝了此次操作。')).toBeVisible();
  expect(
    invoke.mock.calls.some(
      ([command]) => command.type === 'approval.rules.write' || command.type === 'task.start',
    ),
  ).toBe(false);
  await userEvent.click(within(dialog).getByRole('button', { name: '保存规则' }));
  expect(
    invoke.mock.calls.filter(([command]) => command.type === 'approval.rules.write'),
  ).toHaveLength(1);
  expect(
    invoke.mock.calls.some(
      ([command]) => command.type === 'task.start' || command.type === 'interaction.reply',
    ),
  ).toBe(false);
});
it('Escape closes the editor and returns focus to its opener; old services disable editing', async () => {
  connect();
  const mounted = render(
    <RuntimeProvider>
      <Rules bots={bots} />
    </RuntimeProvider>,
  );
  const { opener } = await openNewRule();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '新建规则' })).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
  mounted.unmount();
  connect(false);
  render(
    <RuntimeProvider>
      <Rules bots={bots} />
    </RuntimeProvider>,
  );
  expect(await screen.findByRole('button', { name: '新建规则' })).toBeDisabled();
  expect(screen.getByText('此服务尚不支持审批规则，请升级 Host。')).toBeVisible();
});

it('retains editable saved rules and ignores an obsolete preview after the draft changes', async () => {
  const invoke = connect();
  const original = invoke.getMockImplementation()!;
  let finish: (value: RuntimeReply) => unknown = () => undefined;
  const held = new Promise<RuntimeReply>((resolve) => {
    finish = resolve;
  });
  invoke.mockImplementation(async (command) => {
    if (command.type === 'approval.rules.list')
      return {
        ok: true,
        value: {
          scope: command.scope,
          revision: 2,
          rules: [
            {
              scope: command.scope,
              revision: 1,
              id: 'mock-rule',
              name: '合成已有规则',
              enabled: true,
              effect: 'deny',
              trigger: 'interactive',
              selector: { kind: 'url', url: 'https://example.test/mock' },
            },
          ],
        },
      };
    if (command.type === 'approval.rules.preview') return held;
    return original(command);
  });
  render(
    <RuntimeProvider>
      <Rules bots={bots} />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
  const dialog = screen.getByRole('dialog', { name: '编辑规则' });
  await userEvent.click(within(dialog).getByRole('button', { name: '预览决策' }));
  expect(
    invoke.mock.calls.filter(([command]) => command.type === 'approval.rules.preview'),
  ).toHaveLength(1);
  await userEvent.type(within(dialog).getByRole('textbox', { name: '规则名称' }), '变更');
  await act(async () => {
    finish({
      ok: true,
      value: {
        effect: 'deny',
        reasonCode: 'ruleDenied',
        matchedRules: [{ id: 'mock-old', revision: 1, name: '迟到预览', effect: 'deny' }],
      },
    });
  });
  expect(screen.queryByText(/迟到预览/)).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: '预览决策' })).toBeEnabled();
});

it('an uncertain save is inspected before retry and its late reply cannot move to another Bot', async () => {
  const invoke = connect();
  const original = invoke.getMockImplementation()!;
  let finish: (value: RuntimeReply) => unknown = () => undefined;
  const held = new Promise<RuntimeReply>((resolve) => {
    finish = resolve;
  });
  invoke.mockImplementation(async (command) =>
    command.type === 'approval.rules.write' ? held : original(command),
  );
  render(
    <RuntimeProvider>
      <Rules bots={[...bots, { ...bots[0], id: 'mock-other', name: '另一合成 Bot' }]} />
    </RuntimeProvider>,
  );
  const { dialog } = await openNewRule();
  await userEvent.type(within(dialog).getByRole('textbox', { name: '规则名称' }), '合成待确认保存');
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: '精确 URL' }),
    'https://example.test/mock',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: '保存规则' }));
  await act(async () => {
    finish({ ok: false, error: 'RUNTIME_UNAVAILABLE' });
  });
  expect(within(dialog).getByRole('button', { name: '保存规则' })).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: '查询保存回执' })).toBeEnabled();
  await userEvent.keyboard('{Escape}');
  await selectOption(userEvent, selectControl('选择 Bot 或项目'), 'mock-other');
  expect(screen.queryByText(/保存结果尚未确认/)).not.toBeInTheDocument();
  expect(
    invoke.mock.calls.filter(([command]) => command.type === 'approval.rules.write'),
  ).toHaveLength(1);
});

it('changing the exact MCP resource requires a fresh independent purpose confirmation', async () => {
  const invoke = connect();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command) => {
    if (command.type === 'approval.rules.list')
      return {
        ok: true,
        value: {
          scope: command.scope,
          revision: 1,
          rules: [
            {
              scope: command.scope,
              revision: 1,
              id: 'mock-mcp-rule',
              name: '合成 MCP 规则',
              effect: 'allow',
              enabled: true,
              trigger: 'interactive',
              purposeConfirmed: true,
              selector: {
                kind: 'mcp',
                connection: 'mock-connection',
                configRevision: 1,
                catalogDigest: 'a'.repeat(64),
                tool: 'synthetic_echo',
                inputHash: 'b'.repeat(64),
              },
            },
          ],
        },
      };
    return original(command);
  });
  render(
    <RuntimeProvider>
      <Rules bots={bots} />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
  const dialog = screen.getByRole('dialog', { name: '编辑规则' });
  const confirmed = within(dialog).getByRole('checkbox', { name: /我已独立确认此连接工具/ });
  expect(confirmed).toBeChecked();
  await userEvent.type(within(dialog).getByRole('textbox', { name: '连接工具名' }), '_changed');
  expect(confirmed).not.toBeChecked();
  await userEvent.click(within(dialog).getByRole('button', { name: '保存规则' }));
  expect(invoke.mock.calls.some(([command]) => command.type === 'approval.rules.write')).toBe(
    false,
  );
});
