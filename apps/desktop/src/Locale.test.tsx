import { disconnected, type RuntimeBridge } from '@daban/protocol';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { setLocale } from './locale';
import { selectControl, selectOption } from './select.fixture';
import { initialState, reduce } from './state';
import { serialize, storageKey } from './storage';

afterEach(() => Reflect.deleteProperty(window, 'daban'));

it('switches the whole workspace immediately and retains the chosen language after reopening settings', async () => {
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await selectOption(userEvent, selectControl('界面语言'), 'en');
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Models & providers' })).toBeVisible();
  expect(document.documentElement.lang).toBe('en');
  await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  await act(async () => {});
  expect(await screen.findByRole('heading', { name: 'Start with your first Bot' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(selectControl('Interface language')).toHaveTextContent('English');
});

it('keeps authored content and an unsent draft literal when translating app chrome', async () => {
  const state = reduce(initialState(), {
    type: 'create',
    id: 'mock-bot',
    name: 'SYNTHETIC BOT',
    role: '',
    color: 'mint',
  });
  state.messages['mock-bot'] = [
    { id: 'mock-user', role: 'user', text: '设置' },
    { id: 'mock-answer', role: 'bot', text: '需要确认' },
  ];
  state.drafts['mock-bot'] = 'SYNTHETIC 设置 <tag> {0}';
  localStorage.setItem(storageKey, serialize(state));
  render(<App />);
  await act(async () => {
    await setLocale('en');
  });
  expect(screen.getByRole('button', { name: 'Settings' })).toBeVisible();
  expect(screen.getByText('设置')).toBeVisible();
  expect(screen.getByText('需要确认')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Send message' })).toHaveValue(
    state.drafts['mock-bot'],
  );
});

it('retains a private unsaved key and model form while the interface language changes', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 39;
  snapshot.model = {
    configured: false,
    available: true,
    provider: 'deepseek',
    revision: 0,
    model: 'deepseek-flash',
    connections: [],
  };
  const invoke = vi.fn(async () => ({ ok: true as const, value: snapshot }));
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { runtime: { invoke, subscribe: () => () => {} } as RuntimeBridge },
  });
  render(<App />);
  await act(async () => {});
  await screen.findByRole('heading', { name: '连接你的第一个模型' });
  const key = screen.getByLabelText('API Key');
  await userEvent.type(key, 'SYNTHETIC-UNSAVED-CREDENTIAL');
  await selectOption(userEvent, selectControl('界面语言'), 'en');
  expect(screen.getByRole('heading', { name: 'Connect your first model' })).toBeVisible();
  expect(screen.getByLabelText('API Key')).toBe(key);
  expect(key).toHaveValue('SYNTHETIC-UNSAVED-CREDENTIAL');
  expect(
    invoke.mock.calls.every(
      (args) => !JSON.stringify(args).includes('SYNTHETIC-UNSAVED-CREDENTIAL'),
    ),
  ).toBe(true);
});

it('does not let a late preference read overwrite a newer language choice', async () => {
  let finish!: (reply: { ok: true; value: 'zh-CN' }) => unknown;
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      locale: {
        invoke: (command: { type: string; locale?: string }) =>
          command.type === 'get'
            ? new Promise((resolve) => {
                finish = resolve;
              })
            : Promise.resolve({ ok: true, value: command.locale }),
      },
    },
  });
  render(<App />);
  await act(async () => {
    await setLocale('en');
  });
  await act(async () => {
    finish({ ok: true, value: 'zh-CN' });
  });
  expect(screen.getByRole('button', { name: 'Settings' })).toBeVisible();
});
