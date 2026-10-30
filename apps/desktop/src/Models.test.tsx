import { beforeEach as seedBeforeEach } from 'vitest';
import { demoState as seedDemoState } from './fixtures';
import { serialize as seedSerialize, storageKey as seedStorageKey } from './storage';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  disconnected,
  type ModelUpdate,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function connect(
  protocol = 13,
  extra?: (
    command: RuntimeCommand,
    publish: (revision: number) => unknown,
  ) => RuntimeReply | undefined,
) {
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  snapshot.model = {
    configured: true,
    available: true,
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    revision: 2,
  };
  const listeners = new Set<(snapshot: RuntimeSnapshot) => unknown>();
  const publish = (revision: number) => {
    snapshot = { ...snapshot, model: { ...snapshot.model, revision } };
    for (const listener of listeners) listener(snapshot);
  };
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    const override = extra?.(command, publish);
    if (override) return override;
    if (command.type === 'model.configure') {
      snapshot = { ...snapshot, model: { ...snapshot.model, model: command.input.model } };
      publish(command.input.revision + 1);
      return {
        ok: true,
        value: {
          provider: 'deepseek-official',
          model: command.input.model,
          revision: command.input.revision + 1,
          configured: true,
          requestId: command.input.requestId,
        },
      };
    }
    if (command.type === 'model.check')
      return {
        ok: true,
        value: {
          model: snapshot.model.model,
          revision: command.revision,
          checkedAt: '2026-01-01T00:00:00Z',
        },
      };
    return { ok: true, value: command.type === 'status' ? snapshot : {} };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: (state: RuntimeSnapshot) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as RuntimeBridge,
    },
  });
  return invoke;
}
async function open() {
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await userEvent.click(await screen.findByRole('button', { name: '修改模型设置' }));
}
it('keeps the write-only key outside persisted state and clears unsubmitted secrets when leaving settings', async () => {
  connect();
  render(<App />);
  await open();
  expect(screen.getByLabelText('API Key')).toHaveValue('');
  await userEvent.type(screen.getByLabelText('API Key'), 'synthetic-private-draft');
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-private-draft');
  await userEvent.click(screen.getByRole('button', { name: '返回对话' }));
  await open();
  expect(screen.getByLabelText('API Key')).toHaveValue('');
});
it('submits the selected model and exact revision, then clears the key after a confirmed save', async () => {
  const invoke = connect();
  render(<App />);
  await open();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '模型' }), 'deepseek-flash');
  await userEvent.type(screen.getByLabelText('API Key'), 'synthetic-save-key');
  await userEvent.click(screen.getByRole('button', { name: '验证并保存' }));
  expect(await screen.findByText('模型设置已保存，下次任务生效。')).toBeVisible();
  const command = invoke.mock.calls
    .map(([command]) => command)
    .find((command) => command.type === 'model.configure');
  expect(command).toMatchObject({
    type: 'model.configure',
    input: { model: 'deepseek-flash', apiKey: 'synthetic-save-key', revision: 2 },
  });
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-save-key');
  expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
});
it('retains an ambiguous write identity for an exact retry and omits a blank key to preserve the saved one', async () => {
  let calls = 0;
  const invoke = connect(13, (command) =>
    command.type === 'model.configure' && ++calls === 1
      ? { ok: false, error: 'RUNTIME_UNAVAILABLE' }
      : undefined,
  );
  render(<App />);
  await open();
  await userEvent.click(screen.getByRole('button', { name: '验证并保存' }));
  await userEvent.click(await screen.findByRole('button', { name: '核对并重试保存' }));
  const writes = invoke.mock.calls
    .map(([command]) => command)
    .filter((command) => command.type === 'model.configure');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]).not.toHaveProperty('input.apiKey');
});
it('reviews a newer revision without replacing the typed key or silently rebasing the write', async () => {
  let calls = 0;
  const invoke = connect(13, (command, publish) => {
    if (command.type === 'model.configure' && ++calls === 1) {
      publish(3);
      return { ok: false, error: 'MODEL_SETTINGS_CONFLICT' };
    }
    return undefined;
  });
  render(<App />);
  await open();
  await userEvent.type(screen.getByLabelText('API Key'), 'synthetic-conflict-key');
  await userEvent.click(screen.getByRole('button', { name: '验证并保存' }));
  expect(await screen.findByText(/模型设置已由其他操作更新/)).toBeVisible();
  expect(screen.getByLabelText('API Key')).toHaveValue('synthetic-conflict-key');
  expect(invoke.mock.calls.filter(([command]) => command.type === 'model.configure')).toHaveLength(
    1,
  );
  await userEvent.click(screen.getByRole('button', { name: '保留输入，按当前版本重试' }));
  await userEvent.click(screen.getByRole('button', { name: '验证并保存' }));
  const latest = invoke.mock.calls
    .map(([command]) => command)
    .filter((command) => command.type === 'model.configure')
    .at(-1);
  expect((latest as { input: ModelUpdate }).input.revision).toBe(3);
});
it('checks only the saved connection and gates new controls on older runtimes', async () => {
  const invoke = connect();
  const view = render(<App />);
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await userEvent.click(await screen.findByRole('button', { name: '检查连接' }));
  expect(await screen.findByText(/连接检查通过/)).toBeVisible();
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'model.check',
    revision: 2,
  });
  view.unmount();
  connect(12);
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(await screen.findByRole('button', { name: '修改模型设置' })).toBeDisabled();
});
