import type { SearchCommand, SearchReceipt, SearchStatus, SearchUpdate } from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { selectControl, selectOption } from '../../test/select.fixture';
import { Search } from './Search';

const state = vi.hoisted(() => ({
  runtime: {
    enabled: true,
    snapshot: { phase: 'ready', searchSettings: true },
    command: vi.fn<(command: SearchCommand) => Promise<unknown>>(),
  },
}));
vi.mock('../../app/Runtime', () => ({ useRuntime: () => state.runtime }));

const initial = (changes: Partial<SearchStatus> = {}): SearchStatus => ({
  revision: 2,
  checkRevision: 1,
  enabled: true,
  provider: 'deepseek',
  credentialConfigured: true,
  credentialSource: 'legacy-linked',
  health: 'unchecked',
  ...changes,
});
function saved(input: SearchUpdate): SearchReceipt {
  return {
    kind: 'configure',
    requestId: input.requestId,
    phase: 'saved',
    revision: input.revision + 1,
    checkRevision: 1,
    status: initial({
      revision: input.revision + 1,
      provider: input.provider,
      enabled: input.enabled,
      credentialSource: input.key ? 'independent' : 'legacy-linked',
    }),
  };
}
beforeEach(() => {
  localStorage.clear();
  state.runtime.enabled = true;
  state.runtime.snapshot = { phase: 'ready', searchSettings: true };
  state.runtime.command.mockReset();
  state.runtime.command.mockImplementation(async (command) => {
    if (command.type === 'search.status') return initial();
    if (command.type === 'search.configure') return saved(command.input);
    throw new Error('Unexpected synthetic command');
  });
});
afterEach(() => vi.restoreAllMocks());

test('an old Host gets a clear explanation and no search command', async () => {
  state.runtime.snapshot.searchSettings = false;
  render(<Search />);
  expect(
    await screen.findByText(
      '当前服务尚不支持独立搜索设置，请更新 Host 服务。旧版搜索仍由模型连接决定。',
    ),
  ).toBeVisible();
  expect(state.runtime.command).not.toHaveBeenCalled();
});
test('opening the settings only reads local status and explains legacy credentials', async () => {
  render(<Search />);
  expect(await screen.findByText('沿用旧 DeepSeek 模型连接')).toBeVisible();
  expect(screen.getByText('关闭搜索后，公开网址读取和浏览器仍按各自权限工作。')).toBeVisible();
  expect(state.runtime.command.mock.calls.map(([command]) => command.type)).toEqual([
    'search.status',
  ]);
});
test('switching provider requires a new key and saving does not run a search', async () => {
  const user = userEvent.setup();
  render(<Search />);
  await screen.findByText('沿用旧 DeepSeek 模型连接');
  await selectOption(user, selectControl('搜索供应商'), 'brave');
  expect(screen.getByRole('button', { name: '保存搜索设置' })).toBeDisabled();
  await user.type(screen.getByLabelText('搜索 API Key'), 'synthetic-brave-key');
  await user.click(screen.getByRole('button', { name: '保存搜索设置' }));
  await screen.findByText('搜索设置已保存，尚未进行远程测试。');
  const writes = state.runtime.command.mock.calls.filter(
    ([command]) => command.type === 'search.configure',
  );
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toMatchObject({
    input: { revision: 2, provider: 'brave', key: 'synthetic-brave-key' },
  });
  expect(
    state.runtime.command.mock.calls.some(([command]) => command.type === 'search.check'),
  ).toBe(false);
  expect(screen.getByLabelText('搜索 API Key')).toHaveValue('');
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-brave-key');
});
test('saving the current provider with a blank key preserves credentials', async () => {
  const user = userEvent.setup();
  render(<Search />);
  await screen.findByText('沿用旧 DeepSeek 模型连接');
  await user.click(screen.getByRole('checkbox', { name: '启用搜索' }));
  await user.click(screen.getByRole('button', { name: '保存搜索设置' }));
  await waitFor(() =>
    expect(
      state.runtime.command.mock.calls.filter(([command]) => command.type === 'search.configure'),
    ).toHaveLength(1),
  );
  const command = state.runtime.command.mock.calls.find(
    ([item]) => item.type === 'search.configure',
  )?.[0];
  expect(command).toMatchObject({ input: { provider: 'deepseek', enabled: false } });
  if (command?.type === 'search.configure') expect(command.input.key).toBeUndefined();
});
test('a search test requires explicit cost confirmation and dispatches only once', async () => {
  const user = userEvent.setup();
  state.runtime.command.mockImplementation(async (command) => {
    if (command.type === 'search.status') return initial();
    if (command.type === 'search.check')
      return {
        kind: 'check',
        requestId: command.input.requestId,
        phase: 'settled',
        revision: 2,
        checkRevision: 2,
        status: initial({
          checkRevision: 2,
          health: 'empty',
          checkedAt: '2026-01-01T00:00:00.000Z',
        }),
      } satisfies SearchReceipt;
    throw new Error('Unexpected synthetic command');
  });
  render(<Search />);
  await screen.findByText('沿用旧 DeepSeek 模型连接');
  await user.click(screen.getByRole('button', { name: '测试搜索' }));
  const dialog = screen.getByRole('dialog', { name: '测试搜索？' });
  expect(
    within(dialog).getByText(
      '将向当前供应商发送一次不含个人内容的固定搜索，可能产生一次搜索费用。不会自动重试或切换供应商。',
    ),
  ).toBeVisible();
  expect(
    state.runtime.command.mock.calls.some(([command]) => command.type === 'search.check'),
  ).toBe(false);
  await user.click(within(dialog).getByRole('button', { name: '确认并测试一次' }));
  expect(await screen.findByText('测试成功，未找到结果')).toBeVisible();
  expect(
    state.runtime.command.mock.calls.filter(([command]) => command.type === 'search.check'),
  ).toHaveLength(1);
});
test('Escape dismisses the test confirmation and restores focus without dispatching', async () => {
  const user = userEvent.setup();
  render(<Search />);
  await screen.findByText('沿用旧 DeepSeek 模型连接');
  const button = screen.getByRole('button', { name: '测试搜索' });
  await user.click(button);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '测试搜索？' })).not.toBeInTheDocument();
  expect(button).toHaveFocus();
  expect(
    state.runtime.command.mock.calls.some(([command]) => command.type === 'search.check'),
  ).toBe(false);
});
test('a lost save response checks the original receipt without resending the key', async () => {
  const user = userEvent.setup();
  let input: SearchUpdate | undefined;
  state.runtime.command.mockImplementation(async (command) => {
    if (command.type === 'search.status') return initial();
    if (command.type === 'search.configure') {
      input = command.input;
      throw new Error('synthetic-key-must-not-reflect');
    }
    if (command.type === 'search.saved' && input) return saved(input);
    throw new Error('Unexpected synthetic command');
  });
  render(<Search />);
  await screen.findByText('沿用旧 DeepSeek 模型连接');
  await user.type(screen.getByLabelText('搜索 API Key'), 'synthetic-independent-key');
  await user.click(screen.getByRole('button', { name: '保存搜索设置' }));
  await waitFor(() =>
    expect(
      state.runtime.command.mock.calls.filter(([command]) => command.type === 'search.saved'),
    ).toHaveLength(1),
  );
  const query = state.runtime.command.mock.calls.find(
    ([command]) => command.type === 'search.saved',
  )?.[0];
  expect(query).toEqual({
    type: 'search.saved',
    query: { kind: 'configure', requestId: input?.requestId },
  });
  expect(
    state.runtime.command.mock.calls.filter(([command]) => command.type === 'search.configure'),
  ).toHaveLength(1);
  expect(screen.queryByText('synthetic-key-must-not-reflect')).not.toBeInTheDocument();
});
test('closing an uncertain operation clears the key draft and reopening only queries its receipt', async () => {
  const user = userEvent.setup();
  state.runtime.command.mockImplementation(async (command) => {
    if (command.type === 'search.status') return initial();
    throw new Error('Synthetic disconnected');
  });
  const first = render(<Search />);
  await screen.findByText('沿用旧 DeepSeek 模型连接');
  await user.type(screen.getByLabelText('搜索 API Key'), 'synthetic-unsaved-key');
  await user.click(screen.getByRole('button', { name: '保存搜索设置' }));
  await screen.findByRole('button', { name: '查询操作回执' });
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-unsaved-key');
  const configure = state.runtime.command.mock.calls.find(
    ([command]) => command.type === 'search.configure',
  )?.[0];
  first.unmount();
  state.runtime.command.mockClear();
  render(<Search />);
  await screen.findByRole('button', { name: '查询操作回执' });
  expect(state.runtime.command.mock.calls[0]?.[0]).toEqual({
    type: 'search.saved',
    query: {
      kind: 'configure',
      requestId: configure?.type === 'search.configure' ? configure.input.requestId : '',
    },
  });
  expect(
    state.runtime.command.mock.calls.some(([command]) => command.type === 'search.configure'),
  ).toBe(false);
  expect(screen.getByLabelText('搜索 API Key')).toHaveValue('');
});
test('late check status does not replace edits or a newer refreshed configuration', async () => {
  const user = userEvent.setup();
  let finish: ((receipt: SearchReceipt) => unknown) | undefined;
  let latest = initial();
  state.runtime.command.mockImplementation(async (command) => {
    if (command.type === 'search.status') return latest;
    if (command.type === 'search.check')
      return new Promise<SearchReceipt>((resolve) => {
        finish = resolve;
      });
    throw new Error('Unexpected synthetic command');
  });
  render(<Search />);
  await screen.findByText('沿用旧 DeepSeek 模型连接');
  await user.click(screen.getByRole('button', { name: '测试搜索' }));
  await user.click(screen.getByRole('button', { name: '确认并测试一次' }));
  await waitFor(() => expect(finish).toBeDefined());
  latest = initial({ revision: 3, provider: 'brave', credentialSource: 'independent' });
  await user.click(screen.getByRole('button', { name: '刷新搜索状态' }));
  await act(async () =>
    finish?.({
      kind: 'check',
      requestId: 'mock-late',
      phase: 'settled',
      revision: 2,
      checkRevision: 2,
      status: initial({ health: 'ready' }),
    }),
  );
  expect(selectControl('搜索供应商')).toHaveAttribute('data-value', 'brave');
  expect(screen.queryByText('测试成功，可用于搜索')).not.toBeInTheDocument();
});

test('reconnecting recovers a receipt without retaining a detached busy state or accepting its old callback', async () => {
  const user = userEvent.setup();
  let finish: ((receipt: SearchReceipt) => unknown) | undefined;
  let input: SearchUpdate | undefined;
  state.runtime.command.mockImplementation(async (command) => {
    if (command.type === 'search.status') return input ? saved(input).status : initial();
    if (command.type === 'search.configure') {
      input = command.input;
      return new Promise<SearchReceipt>((resolve) => {
        finish = resolve;
      });
    }
    if (command.type === 'search.saved' && input) return saved(input);
    throw new Error('Unexpected synthetic command');
  });
  const mounted = render(<Search />);
  await screen.findByText('沿用旧 DeepSeek 模型连接');
  await user.type(screen.getByLabelText('搜索 API Key'), 'synthetic-first-key');
  await user.click(screen.getByRole('button', { name: '保存搜索设置' }));
  await waitFor(() => expect(finish).toBeDefined());
  state.runtime.snapshot.phase = 'offline';
  mounted.rerender(<Search />);
  state.runtime.snapshot.phase = 'ready';
  mounted.rerender(<Search />);
  await screen.findByText('已配置独立搜索凭据');
  expect(screen.getByLabelText('搜索 API Key')).toBeEnabled();
  await user.type(screen.getByLabelText('搜索 API Key'), 'synthetic-newer-draft');
  await act(async () => {
    if (input) finish?.(saved(input));
  });
  expect(screen.getByLabelText('搜索 API Key')).toHaveValue('synthetic-newer-draft');
});

test('a status read from the claimed phase cannot overwrite the settled health at the same revisions', async () => {
  const user = userEvent.setup();
  let input: { requestId: string; revision: number; checkRevision: number } | undefined;
  let settle: (receipt: SearchReceipt) => unknown = () => {};
  let refresh: (status: SearchStatus) => unknown = () => {};
  state.runtime.command.mockImplementation(async (command) => {
    if (command.type === 'search.status') {
      if (!input) return initial();
      return new Promise<SearchStatus>((resolve) => {
        refresh = resolve;
      });
    }
    if (command.type === 'search.check') {
      input = command.input;
      return new Promise<SearchReceipt>((resolve) => {
        settle = resolve;
      });
    }
    throw new Error('Unexpected synthetic command');
  });
  render(<Search />);
  await screen.findByText('沿用旧 DeepSeek 模型连接');
  await user.click(screen.getByRole('button', { name: '测试搜索' }));
  await user.click(screen.getByRole('button', { name: '确认并测试一次' }));
  await waitFor(() => expect(input).toBeDefined());
  await user.click(screen.getByRole('button', { name: '刷新搜索状态' }));
  await act(async () => {
    settle({
      kind: 'check',
      requestId: input!.requestId,
      revision: 2,
      checkRevision: 2,
      phase: 'settled',
      status: initial({ checkRevision: 2, health: 'ready', checkedAt: '2026-01-02T00:00:00.000Z' }),
    });
  });
  expect(await screen.findByText('测试成功，可用于搜索')).toBeVisible();
  await act(async () => {
    refresh(initial({ checkRevision: 2, health: 'unchecked' }));
  });
  expect(screen.getByText('测试成功，可用于搜索')).toBeVisible();
  expect(
    state.runtime.command.mock.calls.filter(([command]) => command.type === 'search.check'),
  ).toHaveLength(1);
});

test('a delayed claimed receipt cannot replace a terminal receipt from a newer recovery read', async () => {
  const user = userEvent.setup();
  const query = { kind: 'check', requestId: 'mock-existing-check' };
  localStorage.setItem('daban.search.pending.v1', JSON.stringify(query));
  let finish: (receipt: SearchReceipt) => unknown = () => {};
  let reads = 0;
  const terminal: SearchReceipt = {
    ...query,
    kind: 'check',
    phase: 'settled',
    revision: 2,
    checkRevision: 2,
    status: initial({ checkRevision: 2, health: 'ready', checkedAt: '2026-01-02T00:00:00.000Z' }),
  };
  state.runtime.command.mockImplementation(async (command) => {
    if (command.type === 'search.status') return initial();
    if (command.type === 'search.saved') {
      if (++reads === 1)
        return new Promise<SearchReceipt>((resolve) => {
          finish = resolve;
        });
      return terminal;
    }
    throw new Error('Unexpected synthetic command');
  });
  render(<Search />);
  await user.click(await screen.findByRole('button', { name: '查询操作回执' }));
  expect(await screen.findByText('测试成功，可用于搜索')).toBeVisible();
  await act(async () => {
    finish({ ...terminal, phase: 'claimed', status: initial({ checkRevision: 2 }) });
  });
  expect(screen.getByText('测试成功，可用于搜索')).toBeVisible();
  expect(screen.queryByRole('button', { name: '查询操作回执' })).not.toBeInTheDocument();
});

test('a rejected legacy reenable checks its receipt and asks for an independent key without replaying', async () => {
  const user = userEvent.setup();
  state.runtime.command.mockImplementation(async (command) => {
    if (command.type === 'search.status') return initial({ enabled: false, health: 'disabled' });
    if (command.type === 'search.configure') throw new Error('SEARCH_CREDENTIAL_REQUIRED');
    if (command.type === 'search.saved')
      return { ...command.query, phase: 'superseded' } satisfies SearchReceipt;
    throw new Error('Unexpected synthetic command');
  });
  render(<Search />);
  await screen.findByText('沿用旧 DeepSeek 模型连接');
  await user.click(screen.getByRole('checkbox', { name: '启用搜索' }));
  await user.click(screen.getByRole('button', { name: '保存搜索设置' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '请输入当前搜索供应商的独立 API Key，原凭据不能用于本次保存。',
  );
  expect(screen.getByLabelText('搜索 API Key')).toBeEnabled();
  expect(screen.getByLabelText('搜索 API Key')).toBeRequired();
  expect(screen.getByRole('button', { name: '保存搜索设置' })).toBeDisabled();
  expect(
    screen.queryByText('该回执已被较新的操作替代，请核对当前设置，再明确发起新的操作。'),
  ).not.toBeInTheDocument();
  const writes = state.runtime.command.mock.calls.filter(
    ([command]) => command.type === 'search.configure',
  );
  const lookups = state.runtime.command.mock.calls.filter(
    ([command]) => command.type === 'search.saved',
  );
  expect(writes).toHaveLength(1);
  expect(lookups).toHaveLength(1);
  const submitted = writes[0][0];
  expect(lookups[0][0]).toEqual({
    type: 'search.saved',
    query: {
      kind: 'configure',
      requestId: submitted.type === 'search.configure' ? submitted.input.requestId : '',
    },
  });
  expect(
    state.runtime.command.mock.calls.some(([command]) => command.type === 'search.check'),
  ).toBe(false);
  await user.type(screen.getByLabelText('搜索 API Key'), 'synthetic-independent-search-key');
  expect(screen.getByRole('button', { name: '保存搜索设置' })).toBeEnabled();
});

test('keyless DuckDuckGo has no credential field and can run one explicitly confirmed test', async () => {
  const user = userEvent.setup();
  const status = initial({
    provider: 'duckduckgo' as SearchStatus['provider'],
    credentialConfigured: false,
    credentialSource: 'none',
  });
  state.runtime.command.mockImplementation(async (command) => {
    if (command.type === 'search.status') return status;
    if (command.type === 'search.check')
      return {
        kind: 'check',
        requestId: command.input.requestId,
        phase: 'settled',
        revision: status.revision,
        checkRevision: status.checkRevision + 1,
        status: { ...status, checkRevision: status.checkRevision + 1, health: 'ready' },
      };
    throw new Error('Unexpected synthetic command');
  });
  render(<Search />);
  expect(await screen.findByText('DuckDuckGo')).toBeVisible();
  expect(screen.queryByLabelText('搜索 API Key')).not.toBeInTheDocument();
  expect(
    screen.getByText(
      '无需 API Key。使用 DuckDuckGo 的公开搜索页，仍需联网；网站限流或验证可能导致暂时不可用。',
    ),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: '测试搜索' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: '测试搜索' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('不需要搜索 API Key');
  await user.click(screen.getByRole('button', { name: '确认并测试一次' }));
  expect(await screen.findByText('测试成功，可用于搜索')).toBeVisible();
  expect(
    state.runtime.command.mock.calls.filter(([command]) => command.type === 'search.check'),
  ).toHaveLength(1);
});

test('switching to DuckDuckGo clears a drafted paid key and saves without credentials', async () => {
  const user = userEvent.setup();
  state.runtime.command.mockImplementation(async (command) => {
    if (command.type === 'search.status') return initial();
    if (command.type === 'search.configure')
      return {
        ...saved(command.input),
        status: initial({
          revision: command.input.revision + 1,
          provider: 'duckduckgo' as SearchStatus['provider'],
          credentialConfigured: false,
          credentialSource: 'none',
        }),
      };
    throw new Error('Unexpected synthetic command');
  });
  render(<Search />);
  const key = await screen.findByLabelText('搜索 API Key');
  await user.type(key, 'synthetic-draft-paid-secret');
  await selectOption(user, selectControl('搜索供应商'), 'duckduckgo');
  expect(screen.queryByLabelText('搜索 API Key')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '保存搜索设置' }));
  await waitFor(() =>
    expect(state.runtime.command).toHaveBeenCalledWith({
      type: 'search.configure',
      input: { requestId: expect.any(String), revision: 2, enabled: true, provider: 'duckduckgo' },
    }),
  );
  expect(
    state.runtime.command.mock.calls.filter(([command]) => command.type === 'search.check'),
  ).toHaveLength(0);
});

test.each(['forbidden', 'unauthorized'] as const)(
  'keyless %s errors describe website restrictions instead of asking for an API key',
  async (health) => {
    state.runtime.command.mockResolvedValue(
      initial({
        provider: 'duckduckgo',
        credentialConfigured: false,
        credentialSource: 'none',
        health,
      }),
    );
    render(<Search />);
    expect(
      await screen.findByText('DuckDuckGo 限制了请求或要求验证，请稍后主动重试。'),
    ).toBeVisible();
    expect(screen.queryByText('认证失败，请更换搜索密钥。')).not.toBeInTheDocument();
  },
);

test('changing from keyless search to Brave requires its corresponding key before saving', async () => {
  const user = userEvent.setup();
  state.runtime.command.mockImplementation(async (command) => {
    if (command.type === 'search.status')
      return initial({
        provider: 'duckduckgo',
        credentialConfigured: false,
        credentialSource: 'none',
      });
    if (command.type === 'search.configure') return saved(command.input);
    throw new Error('Unexpected synthetic command');
  });
  render(<Search />);
  await screen.findByText('DuckDuckGo');
  await selectOption(user, selectControl('搜索供应商'), 'brave');
  expect(screen.getByLabelText('搜索 API Key')).toBeRequired();
  expect(screen.getByRole('button', { name: '保存搜索设置' })).toBeDisabled();
  expect(screen.getByText('本次保存需要新的独立密钥，不能留空。')).toBeVisible();
  await user.type(screen.getByLabelText('搜索 API Key'), 'synthetic-brave-key');
  await user.click(screen.getByRole('button', { name: '保存搜索设置' }));
  await waitFor(() =>
    expect(state.runtime.command).toHaveBeenCalledWith({
      type: 'search.configure',
      input: {
        requestId: expect.any(String),
        revision: 2,
        enabled: true,
        provider: 'brave',
        key: 'synthetic-brave-key',
      },
    }),
  );
});
