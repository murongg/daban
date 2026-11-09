import { beforeEach as seedBeforeEach } from 'vitest';
import { serialize as seedSerialize, storageKey as seedStorageKey } from '../../app/storage';
import { demoState as seedDemoState } from '../../test/fixtures';
import { selectControl, selectOption } from '../../test/select.fixture.ts';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  type BotProfile,
  disconnected,
  type ModelConnection,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { appAction } from '../../test/navigation.fixture';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function connect(protocol = 14) {
  const profiles = new Map<string, BotProfile>([
    [
      'a',
      {
        id: 'a',
        name: '合成甲',
        instructions: '合成职责甲',
        memory: '合成偏好甲',
        color: 'mint',
        revision: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
    [
      'b',
      {
        id: 'b',
        name: '合成乙',
        instructions: '合成职责乙',
        memory: '合成偏好乙',
        color: 'violet',
        model: 'deepseek-v4-pro',
        revision: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
  ]);
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  snapshot.profiles = [...profiles.values()];
  snapshot.model = {
    configured: true,
    available: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    revision: 0,
  };
  const listeners = new Set<(snapshot: RuntimeSnapshot) => unknown>();
  const publish = () => {
    snapshot = { ...snapshot, profiles: [...profiles.values()] };
    for (const listener of listeners) listener(snapshot);
  };
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'bot.register') {
      if (!profiles.has(command.profile.id)) {
        profiles.set(command.profile.id, {
          ...command.profile,
          revision: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        });
        publish();
      }
      return { ok: true, value: profiles.get(command.profile.id) };
    }
    if (command.type === 'bot.update') {
      const current = profiles.get(command.bot)!;
      if (command.revision !== current.revision)
        return { ok: false, error: 'BOT_PROFILE_CONFLICT' };
      const { model, ...fields } = command.patch;
      const next = { ...current, ...fields, revision: current.revision + 1 };
      if (model === null) delete next.model;
      else if (model !== undefined) next.model = model;
      profiles.set(next.id, next);
      publish();
      return { ok: true, value: next };
    }
    return { ok: true, value: command.type === 'status' ? snapshot : {} };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: (value: RuntimeSnapshot) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as RuntimeBridge,
    },
  });
  return {
    invoke,
    profiles,
    catalog(connections: ModelConnection[], model: string) {
      snapshot = { ...snapshot, model: { ...snapshot.model, connections, model } };
      act(publish);
    },
    advance(id: string, patch: Partial<BotProfile>) {
      const current = profiles.get(id)!;
      profiles.set(id, { ...current, ...patch, revision: current.revision + 1 });
      act(publish);
    },
    running(phase: 'running' | 'waiting' | 'completed' = 'running') {
      snapshot.agents.a = {
        running: phase !== 'completed',
        phase,
        model: 'deepseek-flash',
        runId: 'mock-active',
        requestId: 'mock-request',
        prompt: '合成任务',
        result: '',
        error: '',
        files: [],
        toolCount: 0,
        executedCount: 0,
        trace: [],
        history: [],
      };
      act(publish);
    },
  };
}

it('selects a model from another supplier for one Bot and preserves an unavailable saved route', async () => {
  const backend = connect(39);
  backend.catalog(
    [
      {
        id: 'synthetic-provider',
        name: '示例供应商',
        baseURL: 'https://models.example.test/v1',
        models: [
          { id: 'alpha', name: '示例 Alpha', vision: true, contextWindow: 128000, maxTokens: 8192 },
          { id: 'beta', name: '示例 Beta', vision: false, contextWindow: 64000, maxTokens: 4096 },
        ],
      },
    ],
    'provider:synthetic-provider:alpha',
  );
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: 'Bot 模型：示例 Alpha' }));
  await selectOption(userEvent, selectControl('此 Bot 的模型'), 'provider:synthetic-provider:beta');
  await userEvent.click(screen.getByRole('button', { name: '保存模型' }));
  expect(await screen.findByRole('button', { name: 'Bot 模型：示例 Beta' })).toBeVisible();
  expect(backend.profiles.get('a')?.model).toBe('provider:synthetic-provider:beta');
  expect(backend.profiles.get('b')?.model).toBe('deepseek-v4-pro');
  backend.advance('a', { model: 'provider:missing-provider:missing-model' });
  await appAction(userEvent, '编辑 Bot 资料');
  expect(selectControl('此 Bot 的模型')).toHaveAttribute(
    'data-value',
    'provider:missing-provider:missing-model',
  );
  expect(selectControl('此 Bot 的模型')).toHaveTextContent('未配置');
});

it('shows the inherited supplier mark when a Bot follows the workspace model', async () => {
  connect();
  render(<App />);
  const picker = await screen.findByRole('button', { name: 'Bot 模型：DeepSeek V4.1 Flash' });
  expect(picker.querySelector('[data-provider="deepseek"] img')).toBeInTheDocument();
  await appAction(userEvent, '编辑 Bot 资料');
  expect(
    selectControl('此 Bot 的模型').querySelector('[data-provider="deepseek"] img'),
  ).toBeInTheDocument();
});

it('edits one Bot model from the composer without changing the workspace or another Bot', async () => {
  const backend = connect();
  render(<App />);
  await screen.findByRole('heading', { name: '合成甲' });
  await userEvent.click(screen.getByRole('button', { name: 'Bot 模型：DeepSeek V4.1 Flash' }));
  const dialog = screen.getByRole('dialog');
  await selectOption(userEvent, selectControl('此 Bot 的模型'), 'deepseek-v4-pro');
  await userEvent.click(within(dialog).getByRole('button', { name: '保存模型' }));
  expect(await screen.findByRole('button', { name: 'Bot 模型：DeepSeek V4 Pro' })).toBeVisible();
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'bot.update',
    bot: 'a',
    revision: 1,
    patch: { model: 'deepseek-v4-pro' },
  });
  expect(backend.profiles.get('a')?.memory).toBe('合成偏好甲');
  expect(backend.profiles.get('b')?.revision).toBe(1);
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'model.configure')).toBe(
    false,
  );
});

it('clears an override back to the workspace model and shows the actual captured model while a task runs', async () => {
  const backend = connect();
  render(<App />);
  await screen.findByRole('heading', { name: '合成甲' });
  backend.advance('a', { model: 'deepseek-v4-pro' });
  await userEvent.click(screen.getByRole('button', { name: 'Bot 模型：DeepSeek V4 Pro' }));
  await selectOption(userEvent, selectControl('此 Bot 的模型'), '');
  await userEvent.click(screen.getByRole('button', { name: '保存模型' }));
  expect(
    await screen.findByRole('button', { name: 'Bot 模型：DeepSeek V4.1 Flash' }),
  ).toBeVisible();
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'bot.update',
    bot: 'a',
    revision: 2,
    patch: { model: null },
  });
  backend.advance('a', { model: 'deepseek-v4-pro' });
  backend.running();
  await userEvent.hover(screen.getByRole('button', { name: 'Bot 模型：DeepSeek V4.1 Flash' }));
  expect(await screen.findByRole('tooltip')).toHaveTextContent('本轮');
  expect(screen.getByText(/下次任务：DeepSeek V4 Pro/)).toBeVisible();
});

it('retains a model draft through a profile conflict and requires review before retry', async () => {
  const backend = connect();
  render(<App />);
  await screen.findByRole('heading', { name: '合成甲' });
  await appAction(userEvent, '编辑 Bot 资料');
  await selectOption(userEvent, selectControl('此 Bot 的模型'), 'deepseek-v4-pro');
  backend.advance('a', { model: 'deepseek-flash' });
  await userEvent.click(screen.getByRole('button', { name: '保存资料' }));
  expect(await screen.findByText('当前模型：DeepSeek V4.1 Flash')).toBeVisible();
  expect(selectControl('此 Bot 的模型')).toHaveAttribute('data-value', 'deepseek-v4-pro');
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'bot.update'),
  ).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: '保留编辑，按此版本重试' }));
  await userEvent.click(screen.getByRole('button', { name: '保存资料' }));
  expect(await screen.findByRole('button', { name: 'Bot 模型：DeepSeek V4 Pro' })).toBeVisible();
});

it('creates a personal Bot with its selected model and keeps unsupported runtime edits unavailable', async () => {
  const backend = connect();
  const view = render(<App />);
  await screen.findByRole('heading', { name: '合成甲' });
  await userEvent.click(screen.getByRole('button', { name: '添加 Bot' }));
  await userEvent.type(screen.getByRole('textbox', { name: '名称' }), '合成新搭档');
  await selectOption(userEvent, selectControl('此 Bot 的模型'), 'deepseek-v4-pro');
  await userEvent.click(screen.getByRole('button', { name: '创建 Bot' }));
  expect(await screen.findByRole('heading', { name: '合成新搭档' })).toBeVisible();
  expect(
    backend.invoke.mock.calls.some(
      ([command]) =>
        command.type === 'bot.register' &&
        command.profile.name === '合成新搭档' &&
        command.profile.model === 'deepseek-v4-pro',
    ),
  ).toBe(true);
  view.unmount();
  localStorage.clear();
  connect(13);
  render(<App />);
  await screen.findByRole('heading', { name: '合成甲' });
  await appAction(userEvent, '编辑 Bot 资料');
  expect(selectControl('此 Bot 的模型')).toBeDisabled();
});

it('keeps an edited avatar after runtime refresh and reopening the app', async () => {
  const backend = connect();
  const view = render(<App />);
  await screen.findByRole('heading', { name: '合成甲' });
  await appAction(userEvent, '编辑 Bot 资料');
  await userEvent.click(screen.getByRole('button', { name: '蓝色' }));
  await userEvent.click(screen.getByRole('button', { name: '眨眼' }));
  await userEvent.click(screen.getByRole('button', { name: '保存资料' }));
  expect(await screen.findByRole('heading', { name: '合成甲' })).toBeVisible();
  expect(backend.profiles.get('a')?.color).toBe('blue');

  backend.advance('a', { instructions: 'Updated synthetic role' });
  view.unmount();
  render(<App />);
  await screen.findByRole('heading', { name: '合成甲' });
  await appAction(userEvent, '编辑 Bot 资料');
  expect(screen.getByRole('img', { name: '头像预览：蓝色，眨眼' })).toBeVisible();
});

it('animates a personal Bot only while its task is executing', async () => {
  const backend = connect();
  render(<App />);
  const heading = await screen.findByRole('heading', { name: '合成甲' });
  const avatar = heading.closest('.titlebar-context')?.querySelector('.bot-avatar');
  expect(avatar).toBeInTheDocument();
  expect(avatar).not.toHaveAttribute('data-working');
  backend.running();
  expect(avatar).toHaveAttribute('data-working');
  backend.running('waiting');
  expect(avatar).not.toHaveAttribute('data-working');
  backend.running();
  backend.running('completed');
  expect(avatar).not.toHaveAttribute('data-working');
});
