import { beforeEach as seedBeforeEach } from 'vitest';
import { serialize as seedSerialize, storageKey as seedStorageKey } from '../../app/storage';
import { demoState as seedDemoState } from '../../test/fixtures';
import { workspaceTab } from '../../test/navigation.fixture';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  disconnected,
  type KnowledgeDocument,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
const first: KnowledgeDocument = {
  id: 'mock-doc-a',
  bot: 'a',
  path: '合成规范.md',
  revision: 1,
  size: 12,
  deleted: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  content: '合成旧正文',
};
function connect(protocol = 9) {
  let document = first;
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  snapshot.knowledge = { available: true, revision: 1 };
  const listeners = new Set<(snapshot: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'knowledge.import') {
      document = {
        ...first,
        path: `${command.file.name}.txt`,
        content: '合成提取正文',
        source: { name: command.file.name, size: 12, sha256: 'a'.repeat(64) },
      };
      return { ok: true, value: document };
    }
    if (command.type === 'knowledge.list')
      return {
        ok: true,
        value:
          command.bot === 'a'
            ? [document, { ...document, id: 'mock-other-doc', path: '另一份资料.md' }].map(
                ({ content: _content, ...file }) => file,
              )
            : [],
      };
    if (command.type === 'knowledge.read')
      return {
        ok: true,
        value: {
          ...document,
          id: command.id,
          path: command.id === document.id ? document.path : '另一份资料.md',
        },
      };
    if (command.type === 'knowledge.write') {
      if (command.document.id && command.document.revision !== document.revision)
        return { ok: false, error: 'KNOWLEDGE_CONFLICT' };
      document = { ...document, ...command.document, revision: document.revision + 1 };
      return { ok: true, value: document };
    }
    if (command.type === 'knowledge.versions')
      return {
        ok: true,
        value: [
          {
            revision: 1,
            path: first.path,
            size: first.size,
            deleted: false,
            at: first.createdAt,
            actor: 'user',
          },
        ],
      };
    if (command.type === 'knowledge.restore') {
      document = { ...first, revision: command.revision + 1 };
      return { ok: true, value: document };
    }
    if (command.type === 'chat.history')
      return { ok: true, value: { bot: command.bot, revision: command.revision, items: [] } };
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
  return {
    invoke,
    snapshot,
    advance() {
      document = { ...document, revision: 2, content: '合成模型新版本' };
      snapshot = { ...snapshot, knowledge: { available: true, revision: 2 } };
      act(() => {
        for (const listener of listeners) listener(snapshot);
      });
    },
  };
}

it('rejects unsupported native document imports before reading bytes while keeping the library usable', async () => {
  const backend = connect(38);
  Object.assign(backend.snapshot.knowledge!, { documentParsing: false });
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '资料' }));
  const picker = screen.getByLabelText('选择资料文件');
  expect(picker).not.toHaveAttribute('accept', expect.stringContaining('.pdf'));
  const file = new File(['SYNTHETIC PDF'], 'mock-native.pdf', { type: 'application/pdf' });
  const read = vi.fn(async () => new ArrayBuffer(0));
  Object.defineProperty(file, 'arrayBuffer', { value: read });
  await userEvent.setup({ applyAccept: false }).upload(picker, file);
  expect(read).not.toHaveBeenCalled();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'knowledge.import')).toBe(
    false,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(/PDF.*Office.*Linux/);
  expect(screen.getByRole('button', { name: '新建资料' })).toBeEnabled();
});

it('keeps each Bot document draft and reviews a model change before saving a stale editor', async () => {
  const backend = connect();
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '资料' }));
  await userEvent.click(await screen.findByRole('button', { name: '打开资料 合成规范.md' }));
  const editor = await screen.findByRole('textbox', { name: '资料正文' });
  await userEvent.clear(editor);
  await userEvent.type(editor, '合成人类草稿');
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await userEvent.click(within(nav).getByRole('button', { name: '写作搭档' }));
  expect(screen.queryByRole('textbox', { name: '资料正文' })).not.toBeInTheDocument();
  await userEvent.click(within(nav).getByRole('button', { name: '研究员' }));
  expect(screen.getByRole('textbox', { name: '资料正文' })).toHaveValue('合成人类草稿');
  backend.advance();
  await userEvent.click(screen.getByRole('button', { name: '保存资料' }));
  expect(await screen.findByText('合成模型新版本')).toBeVisible();
  expect(screen.getByRole('textbox', { name: '资料正文' })).toHaveValue('合成人类草稿');
  await userEvent.click(screen.getByRole('button', { name: '保留草稿，按此版本重试' }));
  await userEvent.click(screen.getByRole('button', { name: '保存资料' }));
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({
      type: 'knowledge.write',
      bot: 'a',
      document: expect.objectContaining({ revision: 2, content: '合成人类草稿' }),
    }),
  );
});

it('opens the document panel directly from the conversation header after closing the workspace', async () => {
  connect();
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '关闭工作区面板' }));
  await workspaceTab(userEvent, '资料');
  expect(await screen.findByRole('heading', { name: '长期资料' })).toBeVisible();
});

it('brings an opened document editor into view without scrolling on every keystroke', async () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const seen: string[] = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: function (this: HTMLElement) {
      if (this.querySelector('[aria-label="资料正文"]')) seen.push('editor');
    },
  });
  try {
    connect();
    render(<App />);
    await userEvent.click(await screen.findByRole('tab', { name: '资料' }));
    await userEvent.click(await screen.findByRole('button', { name: '打开资料 合成规范.md' }));
    await screen.findByRole('textbox', { name: '资料正文' });
    expect(seen).toContain('editor');
    const count = seen.length;
    await userEvent.type(screen.getByRole('textbox', { name: '资料正文' }), ' 编辑');
    expect(seen).toHaveLength(count);
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

it('imports a text snapshot and can restore a saved document as a new version', async () => {
  const backend = connect();
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '资料' }));
  const file = new File(['合成导入正文'], '导入资料.md', { type: 'text/markdown' });
  Object.defineProperty(file, 'text', { value: async () => '合成导入正文' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode('合成导入正文').buffer,
  });
  await userEvent.upload(screen.getByLabelText('选择资料文件'), file);
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({
      type: 'knowledge.write',
      bot: 'a',
      document: { path: '导入资料.md', revision: 0, content: '合成导入正文' },
    }),
  );
  expect(await screen.findByRole('textbox', { name: '资料正文' })).toHaveValue('合成导入正文');
  await userEvent.click(screen.getByRole('button', { name: '查看资料版本' }));
  await userEvent.click(await screen.findByRole('button', { name: '恢复 v1' }));
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({ type: 'knowledge.restore', bot: 'a', targetRevision: 1 }),
  );
  expect(await screen.findByRole('textbox', { name: '资料正文' })).toHaveValue(first.content);
});

it('rejects invalid UTF-8 imports instead of silently saving replacement characters', async () => {
  const backend = connect();
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '资料' }));
  const file = new File([new Uint8Array([0xff, 0x80])], 'bad.txt', { type: 'text/plain' });
  Object.defineProperty(file, 'text', { value: async () => '\ufffd\ufffd' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new Uint8Array([0xff, 0x80]).buffer,
  });
  await userEvent.upload(screen.getByLabelText('选择资料文件'), file);
  expect(await screen.findByText(/UTF-8 编码/)).toBeVisible();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'knowledge.write')).toBe(
    false,
  );
});

it('imports a binary original through the runtime and shows extracted text with provenance', async () => {
  const backend = connect(10);
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '资料' }));
  const bytes = new TextEncoder().encode('%PDF-1.7\nmock');
  const file = new File([bytes], '合成原件.pdf', { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
  await userEvent.upload(screen.getByLabelText('选择资料文件'), file);
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'knowledge.import',
    bot: 'a',
    file: { name: file.name, data: btoa('%PDF-1.7\nmock') },
  });
  expect(await screen.findByRole('textbox', { name: '资料正文' })).toHaveValue('合成提取正文');
  expect(await screen.findByText(/导入原件：合成原件.pdf/)).toBeVisible();
  expect(screen.getByRole('button', { name: '下载导入原件' })).toBeVisible();
});

it('keeps existing text support but rejects binary imports on an older runtime', async () => {
  const backend = connect(9);
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '资料' }));
  const file = new File(['%PDF-1.7'], 'old.pdf', { type: 'application/pdf' });
  await userEvent.upload(screen.getByLabelText('选择资料文件'), file);
  expect(await screen.findByText(/需要更新本地运行环境/)).toBeVisible();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'knowledge.import')).toBe(
    false,
  );
});

it('keeps an in-flight binary import with its originating Bot when the user changes screens', async () => {
  const backend = connect(10);
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '资料' }));
  let release!: (buffer: ArrayBuffer) => unknown;
  const bytes = new TextEncoder().encode('%PDF-1.7\nmock');
  const pending = new Promise<ArrayBuffer>((resolve) => {
    release = resolve;
  });
  const file = new File([bytes], 'delayed.pdf', { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', { value: () => pending });
  await userEvent.upload(screen.getByLabelText('选择资料文件'), file);
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await userEvent.click(within(nav).getByRole('button', { name: '写作搭档' }));
  await act(async () => {
    release(bytes.buffer);
  });
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({ type: 'knowledge.import', bot: 'a' }),
  );
  expect(screen.queryByRole('textbox', { name: '资料正文' })).not.toBeInTheDocument();
  await userEvent.click(within(nav).getByRole('button', { name: '研究员' }));
  expect(await screen.findByRole('textbox', { name: '资料正文' })).toHaveValue('合成提取正文');
});

it('shows a failed extraction without replacing the open document', async () => {
  const backend = connect(10);
  const invoke = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation((command) =>
    command.type === 'knowledge.import'
      ? Promise.resolve({ ok: false, error: 'DOCUMENT_UNREADABLE' })
      : invoke(command),
  );
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '资料' }));
  await userEvent.click(await screen.findByRole('button', { name: '打开资料 合成规范.md' }));
  const bytes = new TextEncoder().encode('%PDF-broken');
  const file = new File([bytes], 'broken.pdf', { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
  await userEvent.upload(screen.getByLabelText('选择资料文件'), file);
  expect(await screen.findByText(/文件无法解析/)).toBeVisible();
  expect(screen.getByRole('textbox', { name: '资料正文' })).toHaveValue(first.content);
});

it('never replaces a dirty document by opening another file and retains it across a client remount', async () => {
  const backend = connect();
  const mounted = render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '资料' }));
  await userEvent.click(await screen.findByRole('button', { name: '打开资料 合成规范.md' }));
  await userEvent.type(await screen.findByRole('textbox', { name: '资料正文' }), ' 未保存');
  const count = backend.invoke.mock.calls.filter(
    ([command]) => command.type === 'knowledge.read',
  ).length;
  await userEvent.click(screen.getByRole('button', { name: '打开资料 另一份资料.md' }));
  expect(screen.getByRole('textbox', { name: '资料正文' })).toHaveValue('合成旧正文 未保存');
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'knowledge.read'),
  ).toHaveLength(count);
  mounted.unmount();
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '资料' }));
  expect(screen.getByRole('textbox', { name: '资料正文' })).toHaveValue('合成旧正文 未保存');
});
