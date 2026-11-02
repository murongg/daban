import { beforeEach as seedBeforeEach } from 'vitest';
import { serialize as seedSerialize, storageKey as seedStorageKey } from '../../app/storage';
import { demoState as seedDemoState } from '../../test/fixtures';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
} from '@daban/protocol';
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { serialize, storageKey } from '../../app/storage';
import { demoState as initialState } from '../../test/fixtures';

afterEach(() => {
  Reflect.deleteProperty(window, 'daban');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function connect(protocol = 11, prepare?: () => Promise<RuntimeReply>) {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  snapshot.model.configured = true;
  let retained = [
    {
      id: 'a'.repeat(64),
      bot: 'a',
      name: 'mock.pdf',
      size: 14,
      sha256: 'b'.repeat(64),
      textSize: 7,
      version: '00000000-0000-4000-8000-000000000001',
      deleted: false,
    },
  ];
  let version = 1;
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'files.list') return { ok: true, value: [] };
    if (command.type === 'attachment.list')
      return {
        ok: true,
        value: {
          items:
            command.bot === 'a'
              ? retained.filter((entry) => entry.deleted === !!command.query.trash)
              : [],
          originalBytes: retained.reduce((sum, entry) => sum + entry.size, 0),
          textBytes: retained.reduce((sum, entry) => sum + entry.textSize, 0),
        },
      };
    if (command.type === 'attachment.trash' || command.type === 'attachment.restore') {
      retained = retained.map((entry) => ({
        ...entry,
        deleted: command.type === 'attachment.trash',
        version: `00000000-0000-4000-8000-${String(++version).padStart(12, '0')}`,
      }));
      return { ok: true, value: retained[0] };
    }
    if (command.type === 'attachment.purge') {
      retained = [];
      return {
        ok: true,
        value: {
          id: command.id,
          bot: command.bot,
          version: command.version,
          purged: true,
          checkpointed: true,
        },
      };
    }
    if (command.type === 'attachment.read')
      return {
        ok: true,
        value: {
          id: command.id,
          bot: command.bot,
          name: 'mock.pdf',
          size: 14,
          sha256: 'b'.repeat(64),
          content: 'MOCK-47',
        },
      };
    if (command.type === 'attachment.upload')
      return prepare
        ? prepare()
        : {
            ok: true,
            value: {
              id: 'a'.repeat(64),
              bot: command.bot,
              name: command.file.name,
              size: 14,
              sha256: 'b'.repeat(64),
              content: 'MOCK-47',
            },
          };
    if (command.type === 'status' || command.type === 'connect')
      return { ok: true, value: snapshot };
    if (command.type === 'attachment.source')
      return {
        ok: true,
        value: {
          id: command.id,
          bot: command.bot,
          file: { name: 'mock.pdf', data: btoa('%PDF-1.7\nmock') },
          sha256: 'b'.repeat(64),
        },
      };
    return { ok: true, value: {} };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => {} } as unknown as RuntimeBridge,
    },
  });
  return { invoke, snapshot };
}
it('keeps image drafts as references, previews original pixels and refuses a text-only model without consuming the draft', async () => {
  const backend = connect(26);
  backend.snapshot.knowledge = { available: true, documentParsing: false };
  backend.snapshot.model.model = 'deepseek-v4-pro';
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const imageReceipt = {
    id: 'c'.repeat(64),
    bot: 'a',
    name: 'mock-pixel.png',
    size: atob(data).length,
    sha256: 'd'.repeat(64),
    content: 'image/png · 合成图片',
  };
  const fallback = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation(async (command) => {
    if (command.type === 'attachment.upload' || command.type === 'attachment.read')
      return { ok: true, value: imageReceipt };
    if (command.type === 'attachment.source')
      return {
        ok: true,
        value: {
          id: imageReceipt.id,
          bot: 'a',
          sha256: imageReceipt.sha256,
          file: { name: imageReceipt.name, data },
        },
      };
    return fallback(command);
  });
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const file = new File([bytes], 'mock-pixel.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
  const mounted = render(<App />);
  await userEvent.upload(await screen.findByLabelText('选择附件'), file);
  const preview = await screen.findByRole('button', { name: '预览附件 mock-pixel.png' });
  expect(localStorage.getItem(storageKey)).not.toContain(data);
  await userEvent.click(preview);
  expect(await screen.findByRole('img', { name: 'mock-pixel.png' })).toHaveAttribute(
    'src',
    `data:image/png;base64,${data}`,
  );
  expect(screen.queryByRole('button', { name: '下载提取文本' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '关闭预览' }));
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), '描述合成图片');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('描述合成图片');
  expect(screen.getByRole('button', { name: '预览附件 mock-pixel.png' })).toBeVisible();
  expect(await screen.findByText(/当前模型不支持图片/)).toBeVisible();
  mounted.unmount();
  render(<App />);
  expect(await screen.findByRole('button', { name: '预览附件 mock-pixel.png' })).toBeVisible();
  expect(localStorage.getItem(storageKey)).not.toContain(data);
});

it('reconciles an uncertain image send with the same request after the next-task model changes', async () => {
  const backend = connect(26, async () => ({
    ok: true,
    value: {
      id: 'c'.repeat(64),
      bot: 'a',
      name: 'mock.png',
      size: 16,
      sha256: 'd'.repeat(64),
      content: 'image/png · 合成图片',
    },
  }));
  backend.snapshot.model.model = 'deepseek-flash';
  const fallback = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation(async (command) =>
    command.type === 'task.start' ? { ok: false, error: 'RUNTIME_UNAVAILABLE' } : fallback(command),
  );
  const bytes = new TextEncoder().encode('synthetic pixels');
  const file = new File([bytes], 'mock.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
  const mounted = render(<App />);
  await userEvent.upload(await screen.findByLabelText('选择附件'), file);
  await screen.findByRole('button', { name: '预览附件 mock.png' });
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), '合成图片发送结果未知');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '重试发送' });
  mounted.unmount();
  backend.snapshot.model.model = 'deepseek-v4-pro';
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '重试发送' }));
  const sends = backend.invoke.mock.calls
    .map(([command]) => command)
    .filter((command) => command.type === 'task.start');
  expect(sends).toHaveLength(2);
  expect(sends[1]).toEqual(sends[0]);
});

function syntheticFile(name = 'mock.pdf') {
  const bytes = new TextEncoder().encode('%PDF-1.7\nmock');
  const file = new File([bytes], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
  return file;
}
it('gates GIF bytes before upload on old runtimes and previews the preserved original with a static-model disclosure', async () => {
  const close = vi.fn();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 32, height: 16, close })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/png;base64,c3ludGhldGlj',
  );
  const backend = connect(30);
  const data =
    'R0lGODlhIAAQAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACAAAACwAAAAAIAAQAAAIJwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjxADAgAh+QQBCAABACwAAAAAIAAQAIEAAP8AAAAAAAAAAAAIJwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjxADAgA7';
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const file = new File([bytes], 'mock.gif', { type: 'image/gif' });
  const read = vi.fn(async () => bytes.buffer);
  Object.defineProperty(file, 'arrayBuffer', { value: read });
  const receipt = {
    id: 'c'.repeat(64),
    bot: 'a',
    name: file.name,
    size: file.size,
    sha256: 'd'.repeat(64),
    content: '合成动图原件',
  };
  const base = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation((command) =>
    command.type === 'attachment.upload' || command.type === 'attachment.read'
      ? Promise.resolve({ ok: true, value: receipt })
      : command.type === 'attachment.source'
        ? Promise.resolve({
            ok: true,
            value: {
              id: receipt.id,
              bot: receipt.bot,
              sha256: receipt.sha256,
              file: { name: file.name, data },
            },
          })
        : base(command),
  );
  let mounted = render(<App />);
  await userEvent.type(await screen.findByRole('textbox', { name: '发送消息' }), '保留合成草稿');
  fireEvent.paste(screen.getByRole('textbox', { name: '发送消息' }), {
    clipboardData: { files: [file], items: [], getData: () => '' },
  });
  expect(await screen.findByText(/需要更新本地运行环境.*聊天/)).toBeVisible();
  expect(read).not.toHaveBeenCalled();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'attachment.upload')).toBe(
    false,
  );
  mounted.unmount();
  backend.snapshot.protocolVersion = 31;
  mounted = render(<App />);
  await screen.findByRole('button', { name: /Bot 模型：/ });
  fireEvent.paste(screen.getByRole('textbox', { name: '发送消息' }), {
    clipboardData: { files: [file], items: [], getData: () => '' },
  });
  await userEvent.click(await screen.findByRole('button', { name: '预览附件 mock.gif' }));
  expect(await screen.findByRole('img', { name: 'mock.gif' })).toHaveAttribute(
    'src',
    'data:image/png;base64,c3ludGhldGlj',
  );
  expect(
    await screen.findByText(
      '此处预览静态首帧；发送图片时，模型服务也只读取首帧。原件下载保留动画。',
    ),
  ).toBeVisible();
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('选择附件')).toHaveAttribute(
    'accept',
    expect.stringContaining('.gif'),
  );
  expect(screen.getByLabelText('选择附件')).toHaveAttribute(
    'accept',
    expect.stringContaining('.webp'),
  );
  expect(localStorage.getItem(storageKey)).not.toContain(data);
  await userEvent.click(screen.getByRole('button', { name: '关闭预览' }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('保留合成草稿');
  mounted.unmount();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockRejectedValue(new Error('synthetic decode failure')),
  );
  mounted = render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '预览附件 mock.gif' }));
  expect(await screen.findByText('无法生成静态首帧预览，可下载原件后查看。')).toBeVisible();
  expect(screen.queryByRole('img', { name: 'mock.gif' })).toBeNull();
  expect(screen.getByRole('button', { name: '下载原件' })).toBeEnabled();
  mounted.unmount();
});
it('pastes actual clipboard items and plain text at the selection without sending or persisting encoded bytes', async () => {
  const backend = connect(30);
  render(<App />);
  const input = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '发送消息' });
  await userEvent.type(input, '前后');
  input.setSelectionRange(1, 1);
  const event = createEvent.paste(input, {
    clipboardData: {
      files: [],
      items: [{ kind: 'file', getAsFile: () => syntheticFile() }],
      getData: (type: string) => (type === 'text/plain' ? '合成说明' : '<b>untrusted</b>'),
    },
  });
  fireEvent(input, event);
  expect(await screen.findByRole('button', { name: '预览附件 mock.pdf' })).toBeVisible();
  expect(event.defaultPrevented).toBe(true);
  expect(input).toHaveValue('前合成说明后');
  expect(localStorage.getItem(storageKey)).not.toContain(btoa('%PDF-1.7\nmock'));
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);
  const text = createEvent.paste(input, {
    clipboardData: { files: [], items: [], getData: () => 'ordinary text' },
  });
  fireEvent(input, text);
  expect(text.defaultPrevented).toBe(false);
});

it('accepts file drops inside the composer, announces the target and leaves plain text drags native', async () => {
  const backend = connect(30);
  render(<App />);
  await screen.findByRole('button', { name: /Bot 模型：/ });
  const form = screen.getByRole('textbox', { name: '发送消息' }).closest('form')!;
  const transfer = { types: ['Files'], files: [syntheticFile()], items: [], dropEffect: 'none' };
  fireEvent.dragEnter(form, { dataTransfer: transfer });
  expect(screen.getByText('松开即可添加附件')).toBeVisible();
  fireEvent.dragEnter(screen.getByRole('textbox', { name: '发送消息' }), {
    dataTransfer: transfer,
  });
  fireEvent.dragLeave(screen.getByRole('textbox', { name: '发送消息' }), {
    dataTransfer: transfer,
  });
  expect(screen.getByText('松开即可添加附件')).toBeVisible();
  const drag = createEvent.dragOver(form, { dataTransfer: transfer });
  fireEvent(form, drag);
  expect(drag.defaultPrevented).toBe(true);
  expect(transfer.dropEffect).toBe('copy');
  const drop = createEvent.drop(form, { dataTransfer: transfer });
  fireEvent(form, drop);
  expect(drop.defaultPrevented).toBe(true);
  expect(await screen.findByRole('button', { name: '预览附件 mock.pdf' })).toBeVisible();
  expect(screen.queryByText('松开即可添加附件')).toBeNull();
  const text = createEvent.drop(form, {
    dataTransfer: { types: ['text/plain'], files: [], items: [], getData: () => 'example.test' },
  });
  fireEvent(form, text);
  expect(text.defaultPrevented).toBe(false);
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'attachment.upload'),
  ).toHaveLength(1);
});

it('serializes overlapping paste/drop events and keeps a delayed upload with its originating Bot', async () => {
  let release!: (value: RuntimeReply) => unknown;
  const backend = connect(
    30,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  render(<App />);
  await screen.findByRole('button', { name: /Bot 模型：/ });
  const input = screen.getByRole('textbox', { name: '发送消息' });
  const file = syntheticFile();
  act(() => {
    fireEvent.paste(input, { clipboardData: { files: [file], items: [], getData: () => '' } });
    fireEvent.drop(input.closest('form')!, {
      dataTransfer: { types: ['Files'], files: [file], items: [] },
    });
  });
  expect(await screen.findByText('正在准备附件…')).toBeVisible();
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'attachment.upload'),
  ).toHaveLength(1);
  await userEvent.click(
    within(screen.getByRole('navigation', { name: 'Bot 列表' })).getByRole('button', {
      name: '写作搭档',
    }),
  );
  await act(async () =>
    release({
      ok: true,
      value: {
        id: 'a'.repeat(64),
        bot: 'a',
        name: file.name,
        size: file.size,
        sha256: 'b'.repeat(64),
        content: 'synthetic document',
      },
    }),
  );
  expect(screen.queryByRole('button', { name: '预览附件 mock.pdf' })).toBeNull();
  await userEvent.click(
    within(screen.getByRole('navigation', { name: 'Bot 列表' })).getByRole('button', {
      name: '研究员',
    }),
  );
  expect(await screen.findByRole('button', { name: '预览附件 mock.pdf' })).toBeVisible();
});

it('uses the group owner for pasted/dropped attachments and blocks archived-group input', async () => {
  const backend = connect(30);
  const group = {
    id: 'crew',
    name: '周报协作',
    members: ['chief', 'a', 'b'],
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  backend.snapshot.groups = { available: true, revision: 1, items: [group] };
  const base = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation((command) =>
    command.type === 'group.read'
      ? Promise.resolve({ ok: true, value: { group, revision: 0, messages: [], deliveries: [] } })
      : base(command),
  );
  const seed = initialState();
  seed.selected = 'crew';
  seed.panel = null;
  localStorage.setItem(storageKey, serialize(seed));
  const mounted = render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  fireEvent.paste(input, {
    clipboardData: { files: [syntheticFile('mock-group.pdf')], items: [], getData: () => '' },
  });
  expect(await screen.findByRole('button', { name: 'mock-group.pdf' })).toBeVisible();
  fireEvent.drop(input.closest('form')!, {
    dataTransfer: { types: ['Files'], files: [syntheticFile('mock-drop.pdf')], items: [] },
  });
  expect(await screen.findByRole('button', { name: 'mock-drop.pdf' })).toBeVisible();
  expect(
    backend.invoke.mock.calls
      .filter(([command]) => command.type === 'attachment.upload')
      .map(([command]) => command),
  ).toEqual([
    expect.objectContaining({
      bot: 'crew',
      file: expect.objectContaining({ name: 'mock-group.pdf' }),
    }),
    expect.objectContaining({
      bot: 'crew',
      file: expect.objectContaining({ name: 'mock-drop.pdf' }),
    }),
  ]);
  mounted.unmount();
  group.revision = 2;
  backend.snapshot.groups.items[0] = { ...group, archived: true };
  render(<App />);
  const blocked = await screen.findByRole('textbox', { name: '发送消息' });
  const drop = createEvent.drop(blocked.closest('form')!, {
    dataTransfer: { types: ['Files'], files: [syntheticFile('blocked.pdf')], items: [] },
  });
  fireEvent(blocked.closest('form')!, drop);
  expect(drop.defaultPrevented).toBe(true);
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'attachment.upload'),
  ).toHaveLength(2);
});

it('keeps the text limit and four-file budget across paste/drop, and recovers after an unsupported file', async () => {
  const backend = connect(30);
  render(<App />);
  await screen.findByRole('button', { name: /Bot 模型：/ });
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '发送消息' });
  fireEvent.change(input, { target: { value: 'x'.repeat(12000) } });
  input.setSelectionRange(11998, 12000);
  fireEvent.paste(input, {
    clipboardData: { files: [syntheticFile('unsupported.exe')], items: [], getData: () => 'ABCDE' },
  });
  expect(input.value).toBe('x'.repeat(11998) + 'AB');
  expect(
    await screen.findByText('请选择文本、PDF/Office 文档或 PNG、JPEG、WebP、GIF 图片。'),
  ).toBeVisible();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'attachment.upload')).toBe(
    false,
  );
  fireEvent.drop(input.closest('form')!, {
    dataTransfer: {
      types: ['Files'],
      files: Array.from({ length: 5 }, (_, index) => syntheticFile(`mock-${index}.pdf`)),
      items: [],
    },
  });
  expect(await screen.findByText('每次任务最多添加 4 个附件。')).toBeVisible();
  expect(screen.getAllByRole('button', { name: /^预览附件 mock-/ })).toHaveLength(4);
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'attachment.upload'),
  ).toHaveLength(4);
  expect(input.value).toHaveLength(12000);
});
it('prepares a document, restores the confirmed draft and sends a reference without storing encoded bytes', async () => {
  const backend = connect();
  const mounted = render(<App />);
  await userEvent.upload(await screen.findByLabelText('选择附件'), syntheticFile());
  expect(await screen.findByRole('button', { name: '预览附件 mock.pdf' })).toBeVisible();
  expect(localStorage.getItem(storageKey)).not.toContain('MOCK-47');
  expect(localStorage.getItem(storageKey)).not.toContain(btoa('%PDF-1.7\nmock'));
  mounted.unmount();
  render(<App />);
  expect(await screen.findByRole('button', { name: '预览附件 mock.pdf' })).toBeVisible();
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), '请读取合成附件');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({
      type: 'task.start',
      bot: 'a',
      task: expect.objectContaining({
        files: [{ name: 'mock.pdf', attachmentId: 'a'.repeat(64) }],
      }),
    }),
  );
});

it('manages recoverable trash and requires an explicit reviewed confirmation before permanent purge', async () => {
  const backend = connect(12);
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '文件' }));
  await userEvent.click(await screen.findByRole('button', { name: '管理聊天附件' }));
  const dialog = screen.getByRole('dialog', { name: '聊天附件' });
  await userEvent.click(await within(dialog).findByRole('button', { name: '移到回收站 mock.pdf' }));
  await userEvent.click(within(dialog).getByRole('checkbox', { name: '显示回收站' }));
  await userEvent.click(await within(dialog).findByRole('button', { name: '恢复 mock.pdf' }));
  await userEvent.click(within(dialog).getByRole('checkbox', { name: '显示回收站' }));
  await userEvent.click(await within(dialog).findByRole('button', { name: '移到回收站 mock.pdf' }));
  await userEvent.click(within(dialog).getByRole('checkbox', { name: '显示回收站' }));
  await userEvent.click(await within(dialog).findByRole('button', { name: '永久删除 mock.pdf' }));
  const confirm = within(dialog).getByRole('button', { name: '永久删除保留内容' });
  expect(confirm).toBeDisabled();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'attachment.purge')).toBe(
    false,
  );
  await userEvent.click(
    within(dialog).getByRole('checkbox', { name: '我理解旧下载和任务重试可能失效' }),
  );
  await userEvent.click(confirm);
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({ type: 'attachment.purge', bot: 'a', confirmation: 'mock.pdf' }),
  );
  expect(await within(dialog).findByText(/保留原件：0 B/)).toBeVisible();
});

it('keeps a busy attachment intact and discards a stale purge review instead of retrying against a fresh version', async () => {
  const backend = connect(12);
  const base = backend.invoke.getMockImplementation()!;
  let busy = true;
  backend.invoke.mockImplementation((command) =>
    command.type === 'attachment.trash' && busy
      ? Promise.resolve({ ok: false, error: 'ATTACHMENT_BUSY' })
      : command.type === 'attachment.purge'
        ? Promise.resolve({ ok: false, error: 'ATTACHMENT_CONFLICT' })
        : base(command),
  );
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '文件' }));
  await userEvent.click(await screen.findByRole('button', { name: '管理聊天附件' }));
  const dialog = screen.getByRole('dialog', { name: '聊天附件' });
  await userEvent.click(await within(dialog).findByRole('button', { name: '移到回收站 mock.pdf' }));
  expect(await within(dialog).findByText(/正在被任务使用/)).toBeVisible();
  expect(within(dialog).getByRole('button', { name: '移到回收站 mock.pdf' })).toBeVisible();
  busy = false;
  await userEvent.click(within(dialog).getByRole('button', { name: '移到回收站 mock.pdf' }));
  await userEvent.click(within(dialog).getByRole('checkbox', { name: '显示回收站' }));
  await userEvent.click(await within(dialog).findByRole('button', { name: '永久删除 mock.pdf' }));
  await userEvent.click(
    within(dialog).getByRole('checkbox', { name: '我理解旧下载和任务重试可能失效' }),
  );
  await userEvent.click(within(dialog).getByRole('button', { name: '永久删除保留内容' }));
  expect(await within(dialog).findByText(/状态已更新/)).toBeVisible();
  expect(
    within(dialog).queryByRole('button', { name: '永久删除保留内容' }),
  ).not.toBeInTheDocument();
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'attachment.purge'),
  ).toHaveLength(1);
});
it('keeps a delayed upload with its originating Bot and prevents sending while it is preparing', async () => {
  let release!: (reply: RuntimeReply) => unknown;
  const backend = connect(
    11,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  render(<App />);
  await userEvent.type(await screen.findByRole('textbox', { name: '发送消息' }), '合成草稿');
  await userEvent.upload(screen.getByLabelText('选择附件'), syntheticFile());
  expect(await screen.findByText('正在准备附件…')).toBeVisible();
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await userEvent.click(within(nav).getByRole('button', { name: '写作搭档' }));
  await act(async () => {
    release({
      ok: true,
      value: {
        id: 'a'.repeat(64),
        bot: 'a',
        name: 'mock.pdf',
        size: 14,
        sha256: 'b'.repeat(64),
        content: 'MOCK-47',
      },
    });
  });
  expect(screen.queryByRole('button', { name: '预览附件 mock.pdf' })).not.toBeInTheDocument();
  await userEvent.click(within(nav).getByRole('button', { name: '研究员' }));
  expect(await screen.findByRole('button', { name: '预览附件 mock.pdf' })).toBeVisible();
  expect(
    backend.invoke.mock.calls.find(([command]) => command.type === 'attachment.upload')?.[0],
  ).toMatchObject({ bot: 'a' });
});
it('rejects native-mode PDF attachments before reading bytes even when file selection bypasses accept', async () => {
  const backend = connect(26);
  backend.snapshot.knowledge = { available: true };
  Object.assign(backend.snapshot.knowledge, { documentParsing: false });
  render(<App />);
  const picker = await screen.findByLabelText('选择附件');
  expect(picker).not.toHaveAttribute('accept', expect.stringContaining('.pdf'));
  expect(picker).toHaveAttribute('accept', expect.stringContaining('.png'));
  const file = new File(['SYNTHETIC PDF'], 'mock-native.pdf', { type: 'application/pdf' });
  const read = vi.fn(async () => new ArrayBuffer(0));
  Object.defineProperty(file, 'arrayBuffer', { value: read });
  await userEvent.setup({ applyAccept: false }).upload(picker, file);
  expect(read).not.toHaveBeenCalled();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'attachment.upload')).toBe(
    false,
  );
  expect(await screen.findByText(/PDF.*Office.*Linux/)).toBeVisible();
});

it('rejects document uploads on older runtimes before reading or submitting bytes', async () => {
  const backend = connect(10);
  render(<App />);
  await userEvent.upload(await screen.findByLabelText('选择附件'), syntheticFile());
  expect(await screen.findByText(/需要更新本地运行环境.*聊天/)).toBeVisible();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'attachment.upload')).toBe(
    false,
  );
});

it('previews extracted text and requests the scoped original instead of downloading text with a PDF extension', async () => {
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const backend = connect();
  render(<App />);
  await userEvent.upload(await screen.findByLabelText('选择附件'), syntheticFile());
  await userEvent.click(await screen.findByRole('button', { name: '预览附件 mock.pdf' }));
  const dialog = screen.getByRole('dialog', { name: 'mock.pdf' });
  expect(within(dialog).getByText('MOCK-47')).toBeVisible();
  expect(within(dialog).getByText(/当前显示提取文本/)).toBeVisible();
  await userEvent.click(within(dialog).getByRole('button', { name: '下载原件' }));
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'attachment.source',
    bot: 'a',
    id: 'a'.repeat(64),
  });
});
