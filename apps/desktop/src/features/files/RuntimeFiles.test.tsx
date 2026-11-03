import { beforeEach as seedBeforeEach } from 'vitest';
import { serialize as seedSerialize, storageKey as seedStorageKey } from '../../app/storage';
import { demoState as seedDemoState } from '../../test/fixtures';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeFile,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { mockViewport } from '../../test/viewport';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
const file: RuntimeFile = {
  path: 'bot-alpha/task-mock/report.csv',
  name: 'report.csv',
  size: 24,
  modified: '2026-01-01T00:00:00Z',
};
function connect(
  read: () => Promise<RuntimeFile> = async () => ({ ...file, content: 'alpha,12\n' }),
  count = 1,
) {
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = 4;
  snapshot.model.configured = true;
  let files = Array.from({ length: count }, (_, index) => ({
    ...file,
    ...(count > 1 ? { path: `mock-files/${index}.txt`, name: `SYNTHETIC FILE ${index}` } : {}),
  }));
  const listeners = new Set<(state: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(
    async (command: RuntimeCommand): Promise<RuntimeReply> => ({
      ok: true,
      value:
        command.type === 'status'
          ? snapshot
          : command.type === 'files.list'
            ? files
            : command.type === 'files.read'
              ? await read()
              : {},
    }),
  );
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
    document(name = 'mock.pdf', protocol = 11) {
      files = [{ ...file, name, path: `mock/task/${name}` }];
      snapshot.protocolVersion = protocol;
    },
    complete() {
      files = [...files, { ...file, path: 'chief/mock-note.md', name: 'mock-note.md' }];
      snapshot = {
        ...snapshot,
        agents: {
          chief: {
            running: false,
            phase: 'completed',
            runId: 'mock-chief-run',
            requestId: 'mock-chief-request',
            prompt: '生成合成文件',
            result: '',
            error: '',
            files: [],
            toolCount: 1,
            executedCount: 1,
            trace: [],
            history: [],
          },
        },
      };
      act(() => {
        for (const listener of listeners) listener(snapshot);
      });
    },
  };
}

it.each([
  ['mock.pdf', 11],
  ['mock.png', 26],
] as const)(
  'reattaches %s through scoped staging while preserving original bytes',
  async (name, protocol) => {
    const backend = connect();
    backend.document(name, protocol);
    const invoke = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation(async (command) => {
      if (command.type === 'files.download')
        return {
          ok: true,
          value: {
            path: command.path,
            name,
            size: 8,
            modified: file.modified,
            data: btoa('%PDF-mock'),
            sha256: 'b'.repeat(64),
          },
        };
      if (command.type === 'attachment.upload')
        return {
          ok: true,
          value: {
            id: 'a'.repeat(64),
            bot: command.bot,
            name: command.file.name,
            size: 8,
            sha256: 'b'.repeat(64),
            content: 'MOCK-47',
          },
        };
      return invoke(command);
    });
    render(<App />);
    await userEvent.click(await screen.findByRole('tab', { name: '文件' }));
    await userEvent.click(await screen.findByRole('button', { name: `添加 ${name} 到消息` }));
    expect(await screen.findByRole('button', { name: `预览附件 ${name}` })).toBeVisible();
    expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
      type: 'attachment.upload',
      bot: 'a',
      file: { name, data: btoa('%PDF-mock') },
    });
  },
);

it('previews a shared raster from its bounded binary download without a text read', async () => {
  const backend = connect();
  backend.document('mock.png', 26);
  const fallback = backend.invoke.getMockImplementation()!;
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  backend.invoke.mockImplementation(async (command) =>
    command.type === 'files.download'
      ? {
          ok: true,
          value: {
            path: command.path,
            name: 'mock.png',
            size: atob(data).length,
            modified: file.modified,
            data,
            sha256: 'b'.repeat(64),
          },
        }
      : fallback(command),
  );
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '文件' }));
  await userEvent.click(await screen.findByRole('button', { name: /mock.png.*KB/ }));
  expect(await screen.findByRole('img', { name: 'mock.png' })).toHaveAttribute(
    'src',
    `data:image/png;base64,${data}`,
  );
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'files.read')).toBe(false);
});

it('attaches a shared file to the initiating Bot after switching and submits the captured bytes', async () => {
  let resolve!: (value: RuntimeFile) => unknown;
  const backend = connect(() => new Promise<RuntimeFile>((done) => (resolve = done)));
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '文件' }));
  await userEvent.click(await screen.findByRole('button', { name: '添加 report.csv 到消息' }));
  expect(screen.getByRole('button', { name: '添加 report.csv 到消息' })).toBeDisabled();
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await userEvent.click(within(nav).getByRole('button', { name: '写作搭档' }));
  await act(async () => resolve({ ...file, content: 'alpha,12\n' }));
  expect(screen.queryByRole('button', { name: '移除附件 report.csv' })).not.toBeInTheDocument();
  await userEvent.click(within(nav).getByRole('button', { name: '研究员' }));
  expect(screen.getByRole('button', { name: '移除附件 report.csv' })).toBeVisible();
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), '处理合成文件');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({
      type: 'task.start',
      bot: 'a',
      task: expect.objectContaining({ files: [{ name: 'report.csv', content: 'alpha,12\n' }] }),
    }),
  );
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'files.read'),
  ).toHaveLength(1);
});

it('shows failed or oversized reads without creating an attachment', async () => {
  let fail = true;
  connect(async () => {
    if (fail) throw new Error('RUNTIME_OFFLINE');
    return { ...file, content: '甲'.repeat(70000) };
  });
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '文件' }));
  await userEvent.click(await screen.findByRole('button', { name: '添加 report.csv 到消息' }));
  expect(await screen.findByText(/本地运行环境尚未连接/)).toBeVisible();
  fail = false;
  await userEvent.click(screen.getByRole('button', { name: '添加 report.csv 到消息' }));
  expect(await screen.findByText('这个文件超过 200 KB，请选择更小的文本文件。')).toBeVisible();
  expect(screen.queryByRole('button', { name: '移除附件 report.csv' })).not.toBeInTheDocument();
});

it('refreshes shared outputs when a Bot without a computer finishes a task', async () => {
  const backend = connect();
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '文件' }));
  await screen.findByText(file.path);
  backend.complete();
  expect(await screen.findByText('chief/mock-note.md')).toBeVisible();
});

it('mounts only a window of a large shared file list', async () => {
  const restore = mockViewport();
  try {
    connect(undefined, 1000);
    render(<App />);
    await userEvent.click(await screen.findByRole('tab', { name: '文件' }));
    await screen.findByText('SYNTHETIC FILE 0');
    expect(screen.queryAllByText(/^SYNTHETIC FILE/).length).toBeLessThan(80);
  } finally {
    restore();
  }
});
