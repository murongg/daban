import { webcrypto } from 'node:crypto';
import {
  agentId,
  disconnected,
  knowledgeLimit,
  type Project,
  type ProjectDocument,
  projectMemoryFingerprint,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { demoState } from '../../test/fixtures';
import { Knowledge } from './Knowledge';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
Object.defineProperty(crypto, 'subtle', { configurable: true, value: webcrypto.subtle });
function fixture(available = true, loseReply = false, rejectWrite = false) {
  const state = demoState(),
    bot = state.bots.find((item) => !item.members)!;
  const scope = { projectId: 'mock-project', revision: 1 };
  state.projectScopes = { [bot.id]: scope };
  const project: Project = {
    id: scope.projectId,
    revision: 1,
    name: 'SYNTHETIC PROJECT',
    status: 'active',
    grants: [{ bot: agentId(bot.id), content: 'read', browser: false }],
    environment: { files: 'project', browser: 'private' },
  };
  const documents: ProjectDocument[] = [];
  let saved: unknown;
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'status')
      return {
        ok: true,
        value: { ...disconnected('ready'), protocolVersion: 45, knowledge: { available: true } },
      };
    if (command.type === 'knowledge.list') return { ok: true, value: [] };
    if (command.type === 'projects.list') return { ok: true, value: [project] };
    if (command.type === 'projectMemory.status')
      return { ok: true, value: { available, capability: 'project-memory-v1' } };
    if (command.type === 'projectMemory.list')
      return { ok: true, value: documents.map(({ content: _content, ...info }) => info) };
    if (command.type === 'projectMemory.candidates') return { ok: true, value: [] };
    if (command.type === 'projectMemory.preview' && command.source.kind === 'text')
      return {
        ok: true,
        value: {
          scope: command.scope,
          title: command.source.title,
          content: command.source.content,
          digest: 'a'.repeat(64),
          members: project.grants,
        },
      };
    if (
      command.type === 'projectMemory.write' &&
      command.request.action === 'publish' &&
      command.request.source.kind === 'text'
    ) {
      if (rejectWrite) return { ok: false, error: 'PROJECT_MEMORY_SOURCE_CHANGED' };
      const source = command.request.source;
      const document: ProjectDocument = {
        id: 'mock-document',
        projectId: scope.projectId,
        revision: 1,
        kind: 'reference',
        title: source.title,
        content: source.content,
        size: new TextEncoder().encode(source.content).length,
        deleted: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      documents.push(document);
      saved = {
        requestId: command.request.requestId,
        scope,
        state: 'complete',
        operation: 'write',
        signature: await projectMemoryFingerprint(command.request),
        document,
      };
      if (loseReply) throw Error('SYNTHETIC LOST RESPONSE');
      return { ok: true, value: saved };
    }
    if (command.type === 'projectMemory.receipt')
      return {
        ok: true,
        value: saved ?? { scope, requestId: command.requestId, state: 'unknown' },
      };
    return { ok: true, value: {} };
  });
  let publish: ((state: RuntimeSnapshot) => unknown) | undefined;
  const bridge: RuntimeBridge = {
    invoke: async <T,>(command: RuntimeCommand) => (await invoke(command)) as RuntimeReply<T>,
    subscribe: (listener) => {
      publish = listener;
      return () => {
        publish = undefined;
      };
    },
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime: bridge },
  });
  const view = render(
    <RuntimeProvider>
      <Knowledge state={state} bot={bot} dispatch={vi.fn()} notify={vi.fn()} />
    </RuntimeProvider>,
  );
  return { state, bot, project, invoke, view, publish: (next: RuntimeSnapshot) => publish?.(next) };
}

test('publication previews exact text and members, cancellation writes nothing and Escape restores focus', async () => {
  const f = fixture();
  const opener = await screen.findByRole('button', { name: '项目资料与记忆' });
  await userEvent.click(opener);
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.type(within(dialog).getByLabelText('资料标题'), 'Synthetic guide');
  await userEvent.type(within(dialog).getByLabelText('资料正文'), 'SYNTHETIC SHARED TEXT');
  await userEvent.click(within(dialog).getByRole('button', { name: '预览共享内容' }));
  expect(within(dialog).getByText('发布前确认')).toBeVisible();
  expect(
    within(within(dialog).getByRole('region', { name: '发布前确认' })).getByText(agentId(f.bot.id)),
  ).toBeVisible();
  expect(
    f.invoke.mock.calls.filter(([command]) => command.type === 'projectMemory.write'),
  ).toHaveLength(0);
  await userEvent.click(within(dialog).getByRole('button', { name: '取消预览' }));
  expect(
    f.invoke.mock.calls.filter(([command]) => command.type === 'projectMemory.write'),
  ).toHaveLength(0);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '项目资料与记忆' })).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

test('a lost publication response queries its receipt without replaying the write', async () => {
  const f = fixture(true, true);
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.type(within(dialog).getByLabelText('资料标题'), 'Synthetic guide');
  await userEvent.type(within(dialog).getByLabelText('资料正文'), 'SYNTHETIC SHARED TEXT');
  await userEvent.click(within(dialog).getByRole('button', { name: '预览共享内容' }));
  await userEvent.click(within(dialog).getByRole('button', { name: '发布到项目' }));
  await waitFor(() =>
    expect(f.invoke.mock.calls.some(([command]) => command.type === 'projectMemory.receipt')).toBe(
      true,
    ),
  );
  await within(dialog).findByRole('button', { name: 'Synthetic guide' });
  expect(
    f.invoke.mock.calls.filter(([command]) => command.type === 'projectMemory.write'),
  ).toHaveLength(1);
});

test('manual receipt checks preserve the draft when a legacy receipt cannot prove its intent', async () => {
  const f = fixture(true, true);
  const original = f.invoke.getMockImplementation()!;
  let queries = 0;
  f.invoke.mockImplementation(async (command) => {
    const reply = await original(command);
    if (command.type !== 'projectMemory.receipt' || !reply.ok) return reply;
    if (++queries === 1)
      return {
        ok: true,
        value: { scope: command.scope, requestId: command.requestId, state: 'unknown' },
      };
    const { signature: _signature, ...legacy } = reply.value as Record<string, unknown>;
    return { ok: true, value: legacy };
  });
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.type(within(dialog).getByLabelText('资料标题'), 'Synthetic uncertain draft');
  await userEvent.type(within(dialog).getByLabelText('资料正文'), 'SYNTHETIC RETAINED DRAFT');
  await userEvent.click(within(dialog).getByRole('button', { name: '预览共享内容' }));
  await userEvent.click(within(dialog).getByRole('button', { name: '发布到项目' }));
  await userEvent.click(await within(dialog).findByRole('button', { name: '查询操作结果' }));
  await waitFor(() => expect(queries).toBe(2));
  expect(within(dialog).getByRole('button', { name: '查询操作结果' })).toBeVisible();
  expect(within(dialog).getByLabelText('资料正文')).toHaveValue('SYNTHETIC RETAINED DRAFT');
  expect(
    f.invoke.mock.calls.filter(([command]) => command.type === 'projectMemory.write'),
  ).toHaveLength(1);
});

test('a Host receipt fingerprint conflict keeps the human draft and requires a new explicit preview', async () => {
  const f = fixture();
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (command) => {
    if (command.type === 'projectMemory.write') throw Error('SYNTHETIC LOST REFUSAL');
    if (command.type === 'projectMemory.receipt')
      return { ok: false, error: 'PROJECT_MEMORY_REQUEST_REUSED' };
    return original(command);
  });
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.type(within(dialog).getByLabelText('资料标题'), 'Synthetic conflicting request');
  await userEvent.type(within(dialog).getByLabelText('资料正文'), 'SYNTHETIC RETAINED B');
  await userEvent.click(within(dialog).getByRole('button', { name: '预览共享内容' }));
  await userEvent.click(within(dialog).getByRole('button', { name: '发布到项目' }));
  await within(dialog).findByText(/范围、来源或目标版本已变更/);
  expect(within(dialog).getByLabelText('资料正文')).toHaveValue('SYNTHETIC RETAINED B');
  expect(within(dialog).getByRole('button', { name: '预览共享内容' })).toBeEnabled();
  expect(
    f.invoke.mock.calls.filter(([command]) => command.type === 'projectMemory.write'),
  ).toHaveLength(1);
});

test.each(['project', 'bot', 'connection'] as const)(
  'a lost write response after changing %s cannot start recovery in the new panel',
  async (change) => {
    const f = fixture();
    const original = f.invoke.getMockImplementation()!;
    let reject: ((reason: Error) => unknown) | undefined;
    f.invoke.mockImplementation((command) =>
      command.type === 'projectMemory.write'
        ? new Promise((_resolve, refuse) => {
            reject = refuse;
          })
        : original(command),
    );
    await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
    const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
    await userEvent.type(within(dialog).getByLabelText('资料标题'), 'Synthetic previous owner');
    await userEvent.type(within(dialog).getByLabelText('资料正文'), 'SYNTHETIC PREVIOUS OWNER');
    await userEvent.click(within(dialog).getByRole('button', { name: '预览共享内容' }));
    await userEvent.click(within(dialog).getByRole('button', { name: '发布到项目' }));
    await waitFor(() => expect(reject).toBeDefined());
    if (change === 'connection') {
      act(() => {
        f.publish(disconnected('connecting'));
      });
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: '项目资料与记忆' })).not.toBeInTheDocument(),
      );
    } else {
      const bot = change === 'bot' ? { ...f.bot, id: 'mock-next-bot' } : f.bot;
      const nextScope = {
        projectId: change === 'project' ? 'mock-next-project' : f.project.id,
        revision: 1,
      };
      const state = { ...f.state, projectScopes: { [bot.id]: nextScope } };
      f.view.rerender(
        <RuntimeProvider>
          <Knowledge state={state} bot={bot} dispatch={vi.fn()} notify={vi.fn()} />
        </RuntimeProvider>,
      );
    }
    await act(async () => {
      reject!(Error('SYNTHETIC LOST OLD OWNER RESPONSE'));
    });
    expect(
      f.invoke.mock.calls.filter(([command]) => command.type === 'projectMemory.write'),
    ).toHaveLength(1);
    expect(f.invoke.mock.calls.some(([command]) => command.type === 'projectMemory.receipt')).toBe(
      false,
    );
  },
);

test('an older service leaves the private knowledge panel usable without a project entry', async () => {
  const f = fixture(false);
  await waitFor(() =>
    expect(f.invoke.mock.calls.some(([command]) => command.type === 'projectMemory.status')).toBe(
      true,
    ),
  );
  expect(screen.queryByRole('button', { name: '项目资料与记忆' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /新建/ })).toBeVisible();
});

test('a rejected changed source retains the draft and permits a fresh review instead of an unknown-result lock', async () => {
  fixture(true, false, true);
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.type(within(dialog).getByLabelText('资料标题'), 'Synthetic guide');
  await userEvent.type(within(dialog).getByLabelText('资料正文'), 'SYNTHETIC RETAINED DRAFT');
  await userEvent.click(within(dialog).getByRole('button', { name: '预览共享内容' }));
  await userEvent.click(within(dialog).getByRole('button', { name: '发布到项目' }));
  await within(dialog).findByText(/范围、来源或目标版本已变更/);
  expect(within(dialog).getByLabelText('资料正文')).toHaveValue('SYNTHETIC RETAINED DRAFT');
  expect(within(dialog).getByRole('button', { name: '预览共享内容' })).toBeEnabled();
  expect(within(dialog).queryByRole('button', { name: '查询操作结果' })).not.toBeInTheDocument();
});

test('a scope revision change preserves the draft and requires explicit review before a new preview', async () => {
  const f = fixture();
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.type(within(dialog).getByLabelText('资料标题'), 'Synthetic draft');
  await userEvent.type(within(dialog).getByLabelText('资料正文'), 'SYNTHETIC RETAINED DRAFT');
  await userEvent.click(within(dialog).getByRole('button', { name: '预览共享内容' }));
  const state = {
    ...f.state,
    projectScopes: { [f.bot.id]: { projectId: f.project.id, revision: 2 } },
  };
  f.project.revision = 2;
  f.view.rerender(
    <RuntimeProvider>
      <Knowledge state={state} bot={f.bot} dispatch={vi.fn()} notify={vi.fn()} />
    </RuntimeProvider>,
  );
  expect(within(dialog).getByRole('button', { name: '发布到项目' })).toBeDisabled();
  expect(within(dialog).getByLabelText('资料正文')).toHaveValue('SYNTHETIC RETAINED DRAFT');
  await userEvent.click(within(dialog).getByRole('button', { name: '复核新范围' }));
  expect(within(dialog).queryByRole('button', { name: '发布到项目' })).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: '预览共享内容' })).toBeEnabled();
  expect(
    f.invoke.mock.calls.filter(([command]) => command.type === 'projectMemory.write'),
  ).toHaveLength(0);
});

test('a human edits a pending candidate and explicitly chooses acceptance without supplying an actor', async () => {
  const f = fixture();
  const candidate = {
    id: 'mock-candidate',
    projectId: f.project.id,
    scopeRevision: 1,
    proposer: 'mock-proposer',
    revision: 1,
    state: 'pending',
    content: 'SYNTHETIC CANDIDATE',
    reason: 'Synthetic project evidence',
    sources: [{ id: 'mock-source', revision: 1 }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (command) => {
    if (command.type === 'projectMemory.candidate') return { ok: true, value: candidate };
    if (command.type === 'projectMemory.candidates') return { ok: true, value: [candidate] };
    if (command.type === 'projectMemory.decide')
      return {
        ok: true,
        value: {
          requestId: command.request.requestId,
          scope: command.request.scope,
          state: 'complete',
          operation: 'decide',
          signature: await projectMemoryFingerprint(command.request),
          candidate: {
            ...candidate,
            state: 'accepted',
            revision: 2,
            content: command.request.content,
          },
          document: {
            id: 'mock-confirmed',
            projectId: f.project.id,
            revision: 1,
            kind: 'confirmed-memory',
            title: command.request.content,
            content: command.request.content,
            size: new TextEncoder().encode(command.request.content).length,
            deleted: false,
            createdAt: candidate.createdAt,
            updatedAt: candidate.updatedAt,
          },
        },
      };
    return original(command);
  });
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.click(await within(dialog).findByRole('button', { name: candidate.content }));
  await userEvent.clear(within(dialog).getByLabelText('候选正文'));
  await userEvent.type(within(dialog).getByLabelText('候选正文'), 'SYNTHETIC HUMAN REVISION');
  expect(f.invoke.mock.calls.some(([command]) => command.type === 'projectMemory.decide')).toBe(
    false,
  );
  await userEvent.click(within(dialog).getByRole('button', { name: '接受为项目记忆' }));
  await waitFor(() =>
    expect(f.invoke.mock.calls.some(([command]) => command.type === 'projectMemory.decide')).toBe(
      true,
    ),
  );
  const mutation = f.invoke.mock.calls.find(
    ([command]) => command.type === 'projectMemory.decide',
  )?.[0];
  expect(mutation).toMatchObject({
    request: {
      scope: { projectId: f.project.id, revision: 1 },
      candidateId: candidate.id,
      candidateRevision: 1,
      action: 'accept',
      content: 'SYNTHETIC HUMAN REVISION',
    },
  });
  expect(mutation).not.toHaveProperty('actor');
});

test('a delayed preview from a previous project cannot appear in the newly selected project', async () => {
  const f = fixture();
  const original = f.invoke.getMockImplementation()!;
  let release: ((value: RuntimeReply) => unknown) | undefined;
  const pending = new Promise<RuntimeReply>((resolve) => {
    release = resolve;
  });
  f.invoke.mockImplementation((command) =>
    command.type === 'projectMemory.preview' ? pending : original(command),
  );
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.type(within(dialog).getByLabelText('资料标题'), 'Synthetic previous project');
  await userEvent.type(
    within(dialog).getByLabelText('资料正文'),
    'SYNTHETIC PREVIOUS PROJECT TEXT',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: '预览共享内容' }));
  const state = {
    ...f.state,
    projectScopes: { [f.bot.id]: { projectId: 'mock-project-next', revision: 1 } },
  };
  f.view.rerender(
    <RuntimeProvider>
      <Knowledge state={state} bot={f.bot} dispatch={vi.fn()} notify={vi.fn()} />
    </RuntimeProvider>,
  );
  release?.({
    ok: true,
    value: {
      scope: { projectId: f.project.id, revision: 1 },
      title: 'Synthetic previous project',
      content: 'SYNTHETIC PREVIOUS PROJECT TEXT',
      digest: 'a'.repeat(64),
      members: f.project.grants,
    },
  });
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const next = screen.getByRole('dialog', { name: '项目资料与记忆' });
  expect(within(next).queryByText('SYNTHETIC PREVIOUS PROJECT TEXT')).not.toBeInTheDocument();
  expect(within(next).getByLabelText('资料正文')).toHaveValue('');
  expect(f.invoke.mock.calls.some(([command]) => command.type === 'projectMemory.write')).toBe(
    false,
  );
});

test('refreshing an edited target never silently adopts its newer revision for candidate acceptance', async () => {
  const f = fixture();
  let revision = 1;
  const stamp = '2026-01-01T00:00:00.000Z';
  const candidate = {
    id: 'mock-candidate',
    projectId: f.project.id,
    scopeRevision: 1,
    proposer: 'mock-proposer',
    revision: 1,
    state: 'pending',
    content: 'SYNTHETIC CANDIDATE',
    reason: 'Synthetic evidence',
    sources: [{ id: 'mock-source', revision: 1 }],
    createdAt: stamp,
    updatedAt: stamp,
  };
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (command) => {
    const document = {
      id: 'mock-memory',
      projectId: f.project.id,
      revision,
      kind: 'confirmed-memory',
      title: 'Synthetic target',
      content: 'SYNTHETIC EXISTING FACT',
      size: 23,
      deleted: false,
      createdAt: stamp,
      updatedAt: stamp,
    };
    if (command.type === 'projectMemory.candidate') return { ok: true, value: candidate };
    if (command.type === 'projectMemory.candidates') return { ok: true, value: [candidate] };
    if (command.type === 'projectMemory.list') {
      const { content: _content, ...info } = document;
      return { ok: true, value: [info] };
    }
    if (command.type === 'projectMemory.read')
      return {
        ok: true,
        value: {
          ...document,
          revision: command.document.revision,
          size: new TextEncoder().encode(document.content).length,
        },
      };
    if (command.type === 'projectMemory.decide')
      return { ok: false, error: 'PROJECT_MEMORY_CONFLICT' };
    return original(command);
  });
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.click(await within(dialog).findByRole('button', { name: candidate.content }));
  await userEvent.selectOptions(
    within(dialog).getByLabelText('记忆目标'),
    within(dialog).getByRole('option', { name: 'Synthetic target · v1' }),
  );
  revision = 2;
  await userEvent.click(within(dialog).getByRole('button', { name: '刷新' }));
  await within(dialog).findByRole('option', { name: 'Synthetic target · v2' });
  expect(within(dialog).getByRole('button', { name: '接受为项目记忆' })).toBeDisabled();
  expect(f.invoke.mock.calls.some(([command]) => command.type === 'projectMemory.decide')).toBe(
    false,
  );
  await userEvent.selectOptions(
    within(dialog).getByLabelText('记忆目标'),
    within(dialog).getByRole('option', { name: 'Synthetic target · v2' }),
  );
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: '接受为项目记忆' })).toBeEnabled(),
  );
  await userEvent.click(within(dialog).getByRole('button', { name: '接受为项目记忆' }));
  await waitFor(() =>
    expect(f.invoke.mock.calls.some(([command]) => command.type === 'projectMemory.decide')).toBe(
      true,
    ),
  );
  expect(
    f.invoke.mock.calls.find(([command]) => command.type === 'projectMemory.decide')?.[0],
  ).toMatchObject({ request: { target: { id: 'mock-memory', revision: 2 } } });
});

test('the private-source chooser previews the selected historical revision and its current-head guard', async () => {
  const f = fixture();
  const stamp = '2026-01-01T00:00:00.000Z';
  const privateFile = {
    id: 'mock-private',
    bot: agentId(f.bot.id),
    path: 'mock-private.md',
    revision: 40,
    size: 24,
    deleted: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (command) => {
    if (command.type === 'knowledge.list') return { ok: true, value: [privateFile] };
    if (command.type === 'knowledge.versions')
      return {
        ok: true,
        value: Array.from({ length: 20 }, (_, index) => (command.before ?? 41) - index - 1).map(
          (revision) => ({
            revision,
            path: privateFile.path,
            size: 24,
            deleted: false,
            at: stamp,
            actor: 'user',
          }),
        ),
      };
    if (command.type === 'projectMemory.preview' && command.source.kind === 'bot-document')
      return {
        ok: true,
        value: {
          scope: command.scope,
          title: privateFile.path,
          content: 'SYNTHETIC SELECTED FIRST VERSION',
          digest: 'a'.repeat(64),
          members: f.project.grants,
        },
      };
    return original(command);
  });
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.selectOptions(within(dialog).getByLabelText('资料来源'), 'private');
  await userEvent.selectOptions(
    within(dialog).getByLabelText('私人文档'),
    await within(dialog).findByRole('option', { name: privateFile.path }),
  );
  await within(dialog).findByRole('option', { name: 'v21' });
  await userEvent.click(within(dialog).getByRole('button', { name: '加载更早版本' }));
  await userEvent.selectOptions(
    within(dialog).getByLabelText('精确来源版本'),
    await within(dialog).findByRole('option', { name: 'v1' }),
  );
  await userEvent.click(within(dialog).getByRole('button', { name: '预览共享内容' }));
  await within(dialog).findByText('SYNTHETIC SELECTED FIRST VERSION');
  expect(
    f.invoke.mock.calls.find(([command]) => command.type === 'projectMemory.preview')?.[0],
  ).toMatchObject({
    source: {
      kind: 'bot-document',
      bot: agentId(f.bot.id),
      document: { id: privateFile.id, revision: 1 },
      expectedRevision: 40,
    },
  });
  expect(f.invoke.mock.calls.some(([command]) => command.type === 'projectMemory.write')).toBe(
    false,
  );
});

test('refreshing a stale candidate preserves the human draft and prevents acceptance', async () => {
  const f = fixture();
  const stamp = '2026-01-01T00:00:00.000Z';
  let candidate = {
    id: 'mock-candidate',
    projectId: f.project.id,
    scopeRevision: 1,
    proposer: 'mock-proposer',
    revision: 1,
    state: 'pending',
    content: 'SYNTHETIC CANDIDATE',
    reason: 'Synthetic evidence',
    sources: [{ id: 'mock-source', revision: 1 }],
    createdAt: stamp,
    updatedAt: stamp,
  };
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (command) => {
    if (command.type === 'projectMemory.candidate') return { ok: true, value: candidate };
    if (command.type === 'projectMemory.candidates')
      return {
        ok: true,
        value: candidate.state === (command.state ?? 'pending') ? [candidate] : [],
      };
    return original(command);
  });
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.click(await within(dialog).findByRole('button', { name: candidate.content }));
  await userEvent.clear(within(dialog).getByLabelText('候选正文'));
  await userEvent.type(within(dialog).getByLabelText('候选正文'), 'SYNTHETIC RETAINED HUMAN EDIT');
  candidate = { ...candidate, state: 'stale', revision: 2 };
  await userEvent.click(within(dialog).getByRole('button', { name: '刷新' }));
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: '接受为项目记忆' })).toBeDisabled(),
  );
  expect(within(dialog).getByLabelText('候选正文')).toHaveValue('SYNTHETIC RETAINED HUMAN EDIT');
  expect(within(dialog).getByLabelText('候选正文')).toHaveAttribute('readonly');
});

test('a stale-scope rejection of an uncertain retry does not discard the original receipt lookup', async () => {
  const f = fixture();
  const original = f.invoke.getMockImplementation()!;
  let writes = 0;
  f.invoke.mockImplementation(async (command) => {
    if (command.type === 'projectMemory.write') {
      if (++writes === 1) throw Error('SYNTHETIC LOST RESPONSE');
      return { ok: false, error: 'PROJECT_SCOPE_STALE' };
    }
    return original(command);
  });
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.type(within(dialog).getByLabelText('资料标题'), 'Synthetic uncertain write');
  await userEvent.type(within(dialog).getByLabelText('资料正文'), 'SYNTHETIC UNCERTAIN TEXT');
  await userEvent.click(within(dialog).getByRole('button', { name: '预览共享内容' }));
  await userEvent.click(within(dialog).getByRole('button', { name: '发布到项目' }));
  await within(dialog).findByRole('button', { name: '查询操作结果' });
  await userEvent.click(within(dialog).getByRole('button', { name: '重试相同请求' }));
  await waitFor(() => expect(writes).toBe(2));
  expect(within(dialog).getByRole('button', { name: '查询操作结果' })).toBeVisible();
  const requests = f.invoke.mock.calls
    .map(([command]) => command)
    .filter((command) => command.type === 'projectMemory.write');
  expect(requests[1]).toStrictEqual(requests[0]);
});

test('oversized text uploads are refused before reading their bytes', async () => {
  fixture();
  await userEvent.click(await screen.findByRole('button', { name: '项目资料与记忆' }));
  const dialog = screen.getByRole('dialog', { name: '项目资料与记忆' });
  await userEvent.selectOptions(within(dialog).getByLabelText('资料来源'), 'upload');
  const file = new File(['x'.repeat(knowledgeLimit + 1)], 'mock-large.txt', { type: 'text/plain' });
  const bytes = vi.fn(async () => new TextEncoder().encode('SYNTHETIC BYTES').buffer);
  Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: bytes });
  await userEvent.upload(within(dialog).getByLabelText('明确上传文件'), file);
  await within(dialog).findByRole('alert');
  expect(bytes).not.toHaveBeenCalled();
});
