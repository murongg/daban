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
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { RuntimeProvider } from '../../app/Runtime';
import { mockViewport } from '../../test/viewport';
import { RuntimeFiles } from './RuntimeFiles';

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
  list?: (command: RuntimeCommand) => Promise<RuntimeFile[]>,
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
            ? list
              ? await list(command)
              : files
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
    review() {
      snapshot.fileReview = { available: true };
      snapshot.protocolVersion = 44;
    },
    nextChat() {
      snapshot = {
        ...snapshot,
        chats: { available: true, revision: 1, items: [{ bot: 'a', revision: 1 }] },
      };
      act(() => {
        for (const listener of listeners) listener(snapshot);
      });
    },
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

it('freezes an explicit shared review selection in the accepted request', async () => {
  const backend = connect();
  backend.review();
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: '文件' }));
  await user.click(await screen.findByRole('checkbox', { name: '同时审阅 report.csv' }));
  await user.type(screen.getByRole('textbox', { name: '发送消息' }), '核对合成文件');
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({
      type: 'task.start',
      bot: 'a',
      task: expect.objectContaining({ fileReview: { sharedPaths: [file.path] } }),
    }),
  );
});

it('limits review choices to eight and keeps them within the selected Bot and chat revision', async () => {
  const backend = connect(undefined, 9);
  backend.review();
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: '文件' }));
  for (let index = 0; index < 8; index++)
    await user.click(
      await screen.findByRole('checkbox', { name: `同时审阅 SYNTHETIC FILE ${index}` }),
    );
  expect(screen.getByRole('checkbox', { name: '同时审阅 SYNTHETIC FILE 8' })).toBeDisabled();
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await user.click(within(nav).getByRole('button', { name: '写作搭档' }));
  expect(screen.getByRole('checkbox', { name: '同时审阅 SYNTHETIC FILE 0' })).not.toBeChecked();
  await user.click(within(nav).getByRole('button', { name: '研究员' }));
  expect(screen.getByRole('checkbox', { name: '同时审阅 SYNTHETIC FILE 0' })).toBeChecked();
  backend.nextChat();
  expect(screen.getByRole('checkbox', { name: '同时审阅 SYNTHETIC FILE 0' })).not.toBeChecked();
});

it('keeps an uncertain send unchanged after editing the next shared selection', async () => {
  const backend = connect(undefined, 2);
  backend.review();
  const fallback = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation(async (command) =>
    command.type === 'task.start' ? { ok: false, error: 'RUNTIME_UNAVAILABLE' } : fallback(command),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: '文件' }));
  await user.click(await screen.findByRole('checkbox', { name: '同时审阅 SYNTHETIC FILE 0' }));
  await user.type(screen.getByRole('textbox', { name: '发送消息' }), 'SYNTHETIC UNCERTAIN REVIEW');
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  await user.click(screen.getByRole('checkbox', { name: '同时审阅 SYNTHETIC FILE 1' }));
  await user.click(await screen.findByRole('button', { name: '重试发送' }));
  const starts = backend.invoke.mock.calls
    .map(([command]) => command)
    .filter((command) => command.type === 'task.start');
  expect(starts).toHaveLength(2);
  expect(starts[0]).toEqual(starts[1]);
  expect(starts[0]).toMatchObject({ task: { fileReview: { sharedPaths: ['mock-files/0.txt'] } } });
});

it('a late project file list cannot replace the newly selected scope', async () => {
  let complete: ((files: RuntimeFile[]) => unknown) | undefined;
  const earlier = new Promise<RuntimeFile[]>((resolve) => {
    complete = resolve;
  });
  connect(undefined, 1, async (command) => {
    if (command.type === 'files.list' && command.project?.projectId === 'mock-alpha')
      return earlier;
    return [
      {
        ...file,
        path: 'beta.txt',
        name: 'beta.txt',
        project: { projectId: 'mock-beta', revision: 1 },
      },
    ];
  });
  const preview = vi.fn(),
    notify = vi.fn();
  const element = (id: string) => (
    <RuntimeProvider>
      <RuntimeFiles project={{ projectId: id, revision: 1 }} preview={preview} notify={notify} />
    </RuntimeProvider>
  );
  const view = render(element('mock-alpha'));
  view.rerender(element('mock-beta'));
  expect(await screen.findByRole('button', { name: /^beta.txt/ })).toBeVisible();
  await act(async () => {
    complete?.([
      {
        ...file,
        path: 'alpha.txt',
        name: 'alpha.txt',
        project: { projectId: 'mock-alpha', revision: 1 },
      },
    ]);
    await earlier;
  });
  expect(screen.queryByText('alpha.txt')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^beta.txt/ })).toBeVisible();
});

it('a project file preview does not open after explicitly changing the task scope', async () => {
  const state = seedDemoState();
  state.projectScopes = { [state.selected]: { projectId: 'mock-alpha', revision: 1 } };
  localStorage.setItem(seedStorageKey, seedSerialize(state));
  let complete: ((file: RuntimeFile) => unknown) | undefined;
  const response = new Promise<RuntimeFile>((resolve) => {
    complete = resolve;
  });
  connect(() => response);
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '文件' }));
  await userEvent.click(await screen.findByRole('button', { name: /report.csv.*KB/ }));
  const scope = screen.getByRole('button', { name: /任务项目范围/ });
  await waitFor(() => expect(scope).toBeEnabled());
  await userEvent.click(scope);
  await userEvent.click(screen.getByRole('option', { name: '原共享环境' }));
  await act(async () => {
    complete?.({ ...file, content: 'SYNTHETIC ALPHA PRIVATE' });
    await response;
  });
  expect(screen.queryByRole('dialog', { name: 'report.csv' })).not.toBeInTheDocument();
});

it('image previews retain the selected project instead of reading a same-named legacy image', async () => {
  const state = seedDemoState();
  const project = { projectId: 'mock-alpha', revision: 1 };
  state.projectScopes = { [state.selected]: project };
  localStorage.setItem(seedStorageKey, seedSerialize(state));
  const backend = connect();
  backend.document('mock.png', 26);
  const fallback = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation(async (command) =>
    command.type === 'files.download'
      ? {
          ok: true,
          value: {
            path: command.path,
            name: 'mock.png',
            size: 1,
            modified: file.modified,
            data: 'AA==',
            sha256: 'b'.repeat(64),
            project,
          },
        }
      : fallback(command),
  );
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: '文件' }));
  await userEvent.click(await screen.findByRole('button', { name: /mock.png.*KB/ }));
  expect(await screen.findByRole('img', { name: 'mock.png' })).toBeVisible();
  expect(
    backend.invoke.mock.calls.find(([command]) => command.type === 'files.download')?.[0],
  ).toMatchObject({ project });
});
