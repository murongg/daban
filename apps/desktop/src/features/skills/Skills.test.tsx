import {
  agentId,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type SkillDocument,
} from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { reduce } from '../../app/state';
import { Workspace } from '../../app/Workspace';
import { demoState as initialState } from '../../test/fixtures';
import { mockViewport } from '../../test/viewport';
import { Conversation } from '../chat/Conversation';

const content = '---\nname: mock-workflow\ndescription: 合成汇总工作流\n---\n只整理合成记录。';
const original: SkillDocument = {
  id: 'mock-workflow-id',
  name: 'mock-workflow',
  description: '合成汇总工作流',
  content,
  size: new TextEncoder().encode(content).length,
  revision: 1,
  deleted: false,
  invocation: { modelInvocable: true, userInvocable: true },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
afterEach(() => {
  Reflect.deleteProperty(window, 'daban');
  localStorage.clear();
});
function connect(extraBot?: string, system = false, count = 1) {
  let document: SkillDocument = {
      ...structuredClone(original),
      ...(!system ? { ownerBot: agentId(initialState().bots[0].id) } : {}),
      ...(system ? { system: true as const } : {}),
    },
    revision = 0;
  const bindings = new Map<string, { enabled: boolean; revision: number }>();
  const snapshot = disconnected('ready');
  snapshot.botCapabilities = true;
  snapshot.protocolVersion = 41;
  snapshot.skills = { available: true, revision: 0 };
  snapshot.model.configured = true;
  snapshot.profiles = initialState()
    .bots.filter((bot) => !bot.members)
    .map((bot) => ({
      id: agentId(bot.id),
      name: bot.name,
      instructions: '',
      memory: '',
      color: bot.color,
      revision: 1,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
    }));
  if (extraBot)
    snapshot.profiles.push({ ...snapshot.profiles[0], id: extraBot, name: '合成特殊标识' });
  const listeners = new Set<Parameters<RuntimeBridge['subscribe']>[0]>();
  const publish = () => {
    snapshot.skills = { available: true, revision: ++revision };
    for (const listener of listeners) listener(structuredClone(snapshot));
  };
  const entry = (bot?: string) => {
    const { content: _content, ...value } = document;
    return {
      ...value,
      enabled: !document.deleted && (bindings.get(bot ?? '')?.enabled ?? false),
      bindingRevision: bindings.get(bot ?? '')?.revision ?? 0,
    };
  };
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'status') return { ok: true, value: snapshot };
    if (command.type === 'skill.list')
      return {
        ok: true,
        value: {
          revision,
          items:
            command.includeDeleted === document.deleted ||
            (!command.includeDeleted && !document.deleted)
              ? Array.from({ length: count }, (_, index) => ({
                  ...entry(command.bot),
                  ...(count > 1
                    ? { id: `mock-skill-${index}`, name: `SYNTHETIC SKILL ${index}` }
                    : {}),
                }))
              : [],
        },
      };
    if (command.type === 'skill.read') return { ok: true, value: { ...document, id: command.id } };
    if (command.type === 'skill.bind') {
      if (command.binding.revision !== document.revision)
        return { ok: false, error: 'SKILL_CONFLICT' };
      bindings.set(command.bot, {
        enabled: command.binding.enabled,
        revision: command.binding.bindingRevision + 1,
      });
      publish();
      return { ok: true, value: entry(command.bot) };
    }
    if (command.type === 'skill.import' || command.type === 'skill.update') {
      if (command.type === 'skill.update' && command.revision !== document.revision)
        return { ok: false, error: 'SKILL_CONFLICT' };
      document = {
        ...document,
        content: command.content,
        size: new TextEncoder().encode(command.content).length,
        revision: document.revision + 1,
      };
      publish();
      return { ok: true, value: document };
    }
    if (command.type === 'skill.recycle' || command.type === 'skill.restore') {
      if (command.revision !== document.revision) return { ok: false, error: 'SKILL_CONFLICT' };
      document = {
        ...document,
        revision: document.revision + 1,
        deleted: command.type === 'skill.recycle',
      };
      for (const [bot, value] of bindings)
        bindings.set(bot, { enabled: false, revision: value.revision + 1 });
      publish();
      return { ok: true, value: document };
    }
    return { ok: false, error: 'UNEXPECTED_SYNTHETIC_COMMAND' };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: Parameters<RuntimeBridge['subscribe']>[0]) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  return {
    invoke,
    advance: () => {
      document = {
        ...document,
        revision: document.revision + 1,
        content: `${content}\n合成后台版本`,
        size: new TextEncoder().encode(`${content}\n合成后台版本`).length,
      };
      publish();
    },
  };
}
function Pane({ initialBot }: { initialBot?: string }) {
  const [state, dispatch] = useReducer(reduce, undefined, () => {
    const value = initialBot
      ? reduce(initialState(), {
          type: 'create',
          id: initialBot,
          name: '合成特殊标识',
          role: '',
          color: 'mint',
        })
      : initialState();
    value.panel = 'skills';
    value.drafts.research = '合成聊天草稿';
    return value;
  });
  const bot = state.bots.find((item) => item.id === state.selected)!;
  return (
    <>
      <button
        type="button"
        onClick={() =>
          dispatch({ type: 'select', bot: state.selected === 'research' ? 'writer' : 'research' })
        }
      >
        切换合成 Bot
      </button>
      <Conversation
        state={state}
        bot={bot}
        dispatch={dispatch}
        notify={() => {}}
        preview={() => {}}
        onModel={() => {}}
      />
      <Workspace
        state={state}
        bot={bot}
        dispatch={dispatch}
        notify={() => {}}
        preview={() => {}}
        expand={() => {}}
      />
    </>
  );
}
const mount = (initialBot?: string) =>
  render(
    <RuntimeProvider>
      <Pane initialBot={initialBot} />
    </RuntimeProvider>,
  );

it('enables a skill only for the selected Bot and inserts its native gesture into the preserved draft without sending', async () => {
  const backend = connect();
  mount();
  const toggle = await screen.findByRole('checkbox', { name: '为研究员启用 mock-workflow' });
  expect(toggle).not.toBeChecked();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'skill.bind')).toBe(false);
  await userEvent.click(toggle);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '加入草稿 mock-workflow' })).toBeEnabled(),
  );
  await userEvent.click(screen.getByRole('button', { name: '加入草稿 mock-workflow' }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue(
    '/mock-workflow 合成聊天草稿',
  );
  await userEvent.click(screen.getByRole('button', { name: '切换合成 Bot' }));
  expect(
    await screen.findByRole('checkbox', { name: '为写作搭档启用 mock-workflow' }),
  ).not.toBeChecked();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);
});

it('treats valid prototype-shaped Bot IDs as identities rather than inherited editor or catalog state', async () => {
  connect('constructor');
  mount('constructor');
  expect(
    await screen.findByRole('checkbox', { name: '为合成特殊标识启用 mock-workflow' }),
  ).not.toBeChecked();
  expect(screen.queryByRole('textbox', { name: '技能说明' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '新建技能' }));
  expect(await screen.findByRole('textbox', { name: '技能说明' })).toHaveValue(
    '---\nname: \ndescription: \n---\n\n',
  );
});

it('keeps unsaved source across Bot switches and requires an explicit version decision after a save conflict', async () => {
  const backend = connect();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '编辑 mock-workflow' }));
  const editor = screen.getByRole('textbox', { name: '技能说明' });
  await userEvent.clear(editor);
  await userEvent.type(editor, `${content}\n合成未保存修改`);
  await userEvent.click(screen.getByRole('button', { name: '切换合成 Bot' }));
  expect(screen.queryByRole('textbox', { name: '技能说明' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '切换合成 Bot' }));
  expect(screen.getByRole('textbox', { name: '技能说明' })).toHaveValue(
    `${content}\n合成未保存修改`,
  );
  act(() => backend.advance());
  await userEvent.click(screen.getByRole('button', { name: '保存技能' }));
  expect(await screen.findByText(/合成后台版本/)).toBeVisible();
  expect(screen.getByRole('textbox', { name: '技能说明' })).toHaveValue(
    `${content}\n合成未保存修改`,
  );
  await userEvent.click(screen.getByRole('button', { name: '保留我的修改，采用当前版本号' }));
  await userEvent.click(screen.getByRole('button', { name: '保存技能' }));
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({
      type: 'skill.update',
      bot: 'a',
      revision: 2,
      content: `${content}\n合成未保存修改`,
    }),
  );
});

it('imports single-file instructions without enabling or running them', async () => {
  const backend = connect();
  mount();
  const picker = await screen.findByLabelText('选择技能说明文件');
  const file = new File([content], 'SKILL.md', { type: 'text/markdown' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(content).buffer,
  });
  await userEvent.upload(picker, file);
  expect(await screen.findByRole('textbox', { name: '技能说明' })).toHaveValue(content);
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'skill.import',
    bot: 'a',
    content,
  });
  expect(
    backend.invoke.mock.calls.some(
      ([command]) => command.type === 'skill.bind' || command.type === 'task.start',
    ),
  ).toBe(false);
});

it('recycles with a captured version and restores without restoring old enablement', async () => {
  connect();
  mount();
  await userEvent.click(
    await screen.findByRole('checkbox', { name: '为研究员启用 mock-workflow' }),
  );
  await userEvent.click(screen.getByRole('button', { name: '移入回收站 mock-workflow' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('mock-workflow');
  await userEvent.click(within(dialog).getByRole('button', { name: '移入回收站' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: '查看回收站' }));
  await userEvent.click(await screen.findByRole('button', { name: '恢复 mock-workflow' }));
  await userEvent.click(screen.getByRole('button', { name: '返回技能库' }));
  expect(
    await screen.findByRole('checkbox', { name: '为研究员启用 mock-workflow' }),
  ).not.toBeChecked();
});

it('refreshes a clean opened skill when its shared revision changes, while keeping later edits protected', async () => {
  const backend = connect();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '编辑 mock-workflow' }));
  await screen.findByRole('textbox', { name: '技能说明' });
  act(() => backend.advance());
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: '技能说明' })).toHaveValue(
      `${content}\n合成后台版本`,
    ),
  );
});

it('brings the editor into view on selection without scrolling again on every keystroke', async () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const seen: string[] = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: function (this: HTMLElement) {
      if (this.querySelector('[aria-label="技能说明"]')) seen.push('editor');
    },
  });
  try {
    connect();
    mount();
    await userEvent.click(await screen.findByRole('button', { name: '编辑 mock-workflow' }));
    const editor = await screen.findByRole('textbox', { name: '技能说明' });
    expect(seen).toEqual(['editor']);
    await userEvent.type(editor, '合成补充');
    expect(seen).toEqual(['editor']);
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

it('shows a stale recycle failure inside the still-open confirmation without refreshing its captured version', async () => {
  const backend = connect();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '移入回收站 mock-workflow' }));
  act(() => backend.advance());
  const dialog = screen.getByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: '移入回收站' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('技能已由其他操作更新');
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'skill.recycle',
    bot: 'a',
    id: original.id,
    revision: 1,
  });
});

it('keeps a system skill readable and independently switchable while protecting its contents', async () => {
  connect(undefined, true);
  mount();
  expect(await screen.findByText('系统内置')).toBeVisible();
  expect(screen.getByRole('button', { name: '移入回收站 mock-workflow' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '查看 mock-workflow' }));
  expect(await screen.findByRole('textbox', { name: '技能说明' })).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: '保存技能' })).toBeDisabled();
});

it('mounts a bounded skill catalog without losing its controls', async () => {
  const restore = mockViewport();
  try {
    connect(undefined, false, 1000);
    mount();
    await screen.findByText('SYNTHETIC SKILL 0');
    await waitFor(() => expect(screen.queryAllByText(/^SYNTHETIC SKILL/).length).toBeLessThan(80));
  } finally {
    restore();
  }
});
