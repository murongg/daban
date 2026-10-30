import {
  type BrowserState,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
} from '@daban/protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Browser } from './Browser';
import { Computer } from './Computer';
import { demoState as initialState } from './fixtures';
import { RuntimeProvider } from './Runtime';

afterEach(() => {
  Reflect.deleteProperty(window, 'daban');
  localStorage.clear();
});
function setup() {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 16;
  snapshot.bots = {
    a: { owner: 'human', epoch: 3, task: {} as never },
    b: { owner: 'agent', epoch: 0, task: {} as never },
  };
  const state: BrowserState = {
    bot: 'a',
    available: true,
    instance: crypto.randomUUID(),
    revision: 1,
    active: 'mock-tab-a',
    tabs: [{ id: 'mock-tab-a', url: 'about:blank', title: '', generation: 0 }],
    pending: [],
  };
  snapshot.browsers = { a: state };
  let uncertain = false;
  let publish: (state: typeof snapshot) => unknown = () => {};
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'status') return { ok: true, value: { ...snapshot } };
    if (command.type === 'browser.state') return { ok: true, value: { ...state } };
    if (command.type === 'browser.view')
      return {
        ok: true,
        value: {
          bot: command.bot,
          epoch: 3,
          binding: { instance: state.instance, tab: state.active, generation: 0 },
          image: 'data:image/jpeg;base64,c3ludGhldGlj',
          width: 960,
          height: 640,
        },
      };
    if (command.type === 'browser.command' || command.type === 'browser.answer') {
      if (uncertain) throw new Error('SYNTHETIC-CONNECTION-LOSS');
      return { ok: true, value: { id: command.id, state: { ...state } } };
    }
    if (command.type === 'browser.receipt')
      return { ok: true, value: { id: command.id, bot: command.bot, phase: 'claimed' } };
    return { ok: true, value: { ok: true } };
  });
  Object.defineProperty(window, 'daban', {
    value: {
      runtime: {
        invoke,
        subscribe: (listener: typeof publish) => {
          publish = listener;
          return () => {};
        },
      } as unknown as RuntimeBridge,
      platform: 'darwin',
    },
    configurable: true,
  });
  return {
    state,
    snapshot,
    invoke,
    publish: (value: typeof snapshot) => publish(value),
    loseConnection: () => {
      uncertain = true;
    },
  };
}
const app = () => (
  <RuntimeProvider>
    <Browser bot="a" name="合成 Bot" notify={() => {}} />
  </RuntimeProvider>
);
it.each(['ack', 'receipt', 'receipt-without-metadata', 'receipt-unreadable'])(
  'keeps an uncertain settled %s distinct from a safe retry',
  async (source) => {
    const { state, invoke } = setup();
    const original = invoke.getMockImplementation()!;
    let metadataUnavailable = false;
    invoke.mockImplementation(async (command) => {
      if (command.type === 'browser.command') {
        if (source !== 'ack') throw new Error('SYNTHETIC-LOST-REPLY');
        return {
          ok: true,
          value: { id: command.id, state, error: 'BROWSER_COMMAND_FAILED', uncertain: true },
        };
      }
      if (command.type === 'browser.state' && metadataUnavailable)
        throw new Error('INVALID_RUNTIME_STATE');
      if (command.type === 'browser.receipt') {
        if (source === 'receipt-unreadable') throw new Error('RUNTIME_UNAVAILABLE');
        metadataUnavailable = source === 'receipt-without-metadata';
        return {
          ok: true,
          value: {
            id: command.id,
            bot: command.bot,
            phase: 'settled',
            error: 'BROWSER_COMMAND_FAILED',
            uncertain: true,
          },
        };
      }
      return original(command);
    });
    const user = userEvent.setup();
    render(app());
    const address = await screen.findByRole('textbox', { name: '网页地址' });
    await waitFor(() => expect(address).toBeEnabled());
    await user.type(address, 'https://example.test/synthetic-request');
    await user.click(screen.getByRole('button', { name: '打开网页' }));
    expect(
      await screen.findByText('操作可能已经发生。不会自动重试，请先核对网页状态，再决定后续操作。'),
    ).toBeVisible();
    expect(screen.queryByText('操作未确认，请检查连接和任务状态后重试。')).not.toBeInTheDocument();
    expect(
      invoke.mock.calls.filter(([command]) => command.type === 'browser.command'),
    ).toHaveLength(1);
    expect(address).toHaveValue('https://example.test/synthetic-request');
  },
);
it('retains a confirmed successful receipt when only the following metadata refresh fails', async () => {
  const { invoke } = setup();
  const original = invoke.getMockImplementation()!;
  let metadataUnavailable = false;
  invoke.mockImplementation(async (command) => {
    if (command.type === 'browser.command') throw new Error('SYNTHETIC-LOST-REPLY');
    if (command.type === 'browser.receipt') {
      metadataUnavailable = true;
      return { ok: true, value: { id: command.id, bot: command.bot, phase: 'settled' } };
    }
    if (command.type === 'browser.state' && metadataUnavailable)
      throw new Error('INVALID_RUNTIME_STATE');
    return original(command);
  });
  const user = userEvent.setup();
  render(app());
  const address = await screen.findByRole('textbox', { name: '网页地址' });
  await waitFor(() => expect(address).toBeEnabled());
  await user.type(address, 'https://example.test/synthetic-confirmed');
  await user.click(screen.getByRole('button', { name: '打开网页' }));
  expect(
    await screen.findByText('本次请求已处理，暂时无法刷新网页状态。请先查看页面，避免重复提交。'),
  ).toBeVisible();
  expect(invoke.mock.calls.filter(([command]) => command.type === 'browser.command')).toHaveLength(
    1,
  );
});
it('preserves unsent address edits across closing the panel, and navigates only after an explicit submit', async () => {
  const { invoke } = setup();
  const user = userEvent.setup();
  const mounted = render(app());
  const address = await screen.findByRole('textbox', { name: '网页地址' });
  await waitFor(() => expect(address).toBeEnabled());
  await user.type(address, 'https://example.test/synthetic');
  expect(invoke.mock.calls.some(([c]) => c.type === 'browser.command')).toBe(false);
  mounted.unmount();
  render(app());
  const restored = await screen.findByRole('textbox', { name: '网页地址' });
  expect(restored).toHaveValue('https://example.test/synthetic');
  await user.click(screen.getByRole('button', { name: '打开网页' }));
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([c]) =>
          c.type === 'browser.command' &&
          c.action === 'navigate' &&
          c.url === 'https://example.test/synthetic' &&
          c.tab === 'mock-tab-a' &&
          c.epoch === 3,
      ),
    ).toBe(true),
  );
});

it('an old command acknowledgement cannot restore the previous browser after the runtime instance changes', async () => {
  const { state, snapshot, invoke, publish } = setup();
  const original = invoke.getMockImplementation()!;
  let finish!: (value: { ok: true; value: { id: string; state: BrowserState } }) => unknown,
    requestId = '';
  const pending = new Promise<{ ok: true; value: { id: string; state: BrowserState } }>(
    (resolve) => {
      finish = resolve;
    },
  );
  invoke.mockImplementation(async (command) => {
    if (command.type === 'browser.command') {
      requestId = command.id;
      return pending;
    }
    return original(command);
  });
  const user = userEvent.setup();
  render(app());
  const field = await screen.findByRole('textbox', { name: '网页地址' });
  await waitFor(() => expect(field).toBeEnabled());
  await user.type(field, 'https://example.test/old-request');
  await user.click(screen.getByRole('button', { name: '打开网页' }));
  await waitFor(() => expect(requestId).not.toBe(''));
  const next = {
    ...state,
    instance: 'new-browser-instance',
    revision: 0,
    active: 'new-tab',
    tabs: [{ ...state.tabs[0], id: 'new-tab', url: 'https://example.test/current' }],
  };
  publish({ ...snapshot, browsers: { a: next } });
  await waitFor(() => expect(field).toHaveValue('https://example.test/current'));
  finish({ ok: true, value: { id: requestId, state } });
  await waitFor(() => expect(screen.getByRole('button', { name: '打开网页' })).toBeEnabled());
  expect(field).toHaveValue('https://example.test/current');
});

it('expands the browser surface that is currently selected', async () => {
  setup();
  const user = userEvent.setup(),
    expand = vi.fn();
  const bot = initialState().bots.find((bot) => bot.id === 'research')!;
  render(
    <RuntimeProvider>
      <Computer bot={bot} notify={() => {}} expand={expand} />
    </RuntimeProvider>,
  );
  await user.click(await screen.findByRole('button', { name: '浏览器' }));
  await user.click(screen.getByRole('button', { name: '展开' }));
  expect(expand).toHaveBeenCalledWith('browser');
});

it('identifies an inactive requesting tab and keeps a human reply bound to that tab', async () => {
  const { state, invoke } = setup();
  const user = userEvent.setup();
  state.tabs[0].url = 'https://front.example.test/';
  state.tabs.push({
    id: 'mock-background',
    url: 'https://background.example.test/upload',
    title: '合成后台标签',
    generation: 7,
  });
  state.pending = [
    {
      id: 'mock-background-prompt',
      kind: 'dialog',
      dialog: 'prompt',
      tab: 'mock-background',
      generation: 7,
      message: '后台网页提问',
      defaultValue: '',
      truncated: false,
    },
  ];
  render(app());
  expect(await screen.findByText('https://background.example.test/upload')).toBeVisible();
  expect(screen.getByRole('textbox', { name: '网页地址' })).toHaveValue(
    'https://front.example.test/',
  );
  await user.type(screen.getByRole('textbox', { name: '网页回复' }), 'SYNTHETIC-BACKGROUND');
  await user.click(screen.getByRole('button', { name: '确认网页请求' }));
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([c]) =>
          c.type === 'browser.answer' &&
          c.binding.tab === 'mock-background' &&
          c.binding.generation === 7 &&
          c.kind === 'dialog' &&
          c.text === 'SYNTHETIC-BACKGROUND',
      ),
    ).toBe(true),
  );
});
it('never automatically resends an ambiguous command after the panel reopens', async () => {
  const { invoke, loseConnection } = setup();
  const user = userEvent.setup();
  const mounted = render(app());
  const address = await screen.findByRole('textbox', { name: '网页地址' });
  await waitFor(() => expect(address).toBeEnabled());
  loseConnection();
  await user.type(address, 'https://example.test/synthetic');
  await user.click(screen.getByRole('button', { name: '打开网页' }));
  await screen.findByText(/操作结果未确认/);
  mounted.unmount();
  render(app());
  await screen.findByText(/操作结果未确认/);
  await waitFor(() =>
    expect(invoke.mock.calls.some(([c]) => c.type === 'browser.receipt')).toBe(true),
  );
  expect(invoke.mock.calls.filter(([c]) => c.type === 'browser.command')).toHaveLength(1);
  expect(screen.getByRole('button', { name: '打开网页' })).toBeDisabled();
  expect(localStorage.getItem('daban-browser-pending-v1')).not.toContain('example.test');
});
it('sends a human dialog response through the exact pending binding without writing its text to local storage', async () => {
  const { state, invoke } = setup();
  const user = userEvent.setup();
  state.pending = [
    {
      id: 'mock-dialog',
      kind: 'dialog',
      dialog: 'prompt',
      tab: state.active,
      generation: 0,
      message: '合成网页提问',
      defaultValue: '',
      truncated: false,
    },
  ];
  render(app());
  const reply = await screen.findByRole('textbox', { name: '网页回复' });
  await user.type(reply, 'SYNTHETIC-PRIVATE-TEXT');
  await user.click(screen.getByRole('button', { name: '确认网页请求' }));
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([c]) =>
          c.type === 'browser.answer' &&
          c.kind === 'dialog' &&
          c.text === 'SYNTHETIC-PRIVATE-TEXT' &&
          c.prompt === 'mock-dialog' &&
          c.binding.tab === state.active &&
          c.binding.instance === state.instance,
      ),
    ).toBe(true),
  );
  expect(JSON.stringify(localStorage)).not.toContain('SYNTHETIC-PRIVATE-TEXT');

  fireEvent.keyDown(reply, { key: 'Escape' });
});
