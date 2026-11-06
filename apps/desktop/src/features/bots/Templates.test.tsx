import { disconnected } from '@daban/protocol';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { GallerySources } from './GallerySources';
import { RemoteGallery } from './RemoteGallery';
import { TemplateManager } from './TemplateManager';

const bridge = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock('../../app/Runtime', async () => {
  const { disconnected } = await import('@daban/protocol');
  return {
    useRuntime: () => ({
      enabled: true,
      snapshot: { ...disconnected('ready'), botReleases: true },
      command: bridge.command,
    }),
    runtimeError: (error: Error) => error.message,
  };
});
beforeEach(() => {
  localStorage.clear();
  bridge.command.mockReset();
});

test('keeps gallery credentials out of persisted UI state and previews before installing', async () => {
  const user = userEvent.setup();
  bridge.command.mockImplementation(async (command) => {
    if (command.type === 'skill.list') return { items: [] };
    if (command.type === 'knowledge.list') return [];
    if (command.type === 'gallery.sources' || command.type === 'gallery.source.save') return [];
    if (command.type === 'status') return disconnected('ready');
    return {};
  });
  render(<GallerySources />);
  await user.type(screen.getByLabelText(/广场地址|Gallery address/), 'https://mock.example.test');
  await user.type(screen.getByLabelText(/访问令牌|Access token/), 'SYNTHETIC SECRET');
  await user.click(screen.getByRole('button', { name: /添加广场|Add gallery/ }));
  await waitFor(() =>
    expect(bridge.command).toHaveBeenCalledWith({
      type: 'gallery.source.save',
      origin: 'https://mock.example.test',
      token: 'SYNTHETIC SECRET',
    }),
  );
  expect(JSON.stringify(localStorage)).not.toContain('SYNTHETIC SECRET');
  expect(bridge.command.mock.calls.some(([command]) => command.type === 'gallery.install')).toBe(
    false,
  );
});

test('requires a deliberate choice before applying an upgrade conflict', async () => {
  const user = userEvent.setup();
  bridge.command.mockImplementation(async (command) => {
    if (command.type === 'skill.list') return { items: [] };
    if (command.type === 'knowledge.list') return [];
    if (command.type === 'bot.installation.read')
      return {
        installation: {
          botId: 'mock-bot',
          templateId: '10000000-0000-4000-8000-000000000001',
          revision: 1,
          releaseVersion: '1.0.0',
          source: { sourceOrigin: 'https://mock.example.test' },
        },
        definition: {
          profile: { instructions: 'SYNTHETIC LOCAL' },
          defaultPreferences: '',
          skills: [],
          knowledge: [],
        },
        history: [],
        draft: null,
      };
    if (command.type === 'gallery.upgrade.prepare')
      return {
        id: 'mock-plan',
        digest: 'a'.repeat(64),
        revision: 1,
        conflicts: ['instructions'],
        before: { profile: { instructions: 'SYNTHETIC LOCAL' }, skills: [], knowledge: [] },
        after: { profile: { instructions: 'SYNTHETIC LOCAL' }, skills: [], knowledge: [] },
        target: { profile: { instructions: 'SYNTHETIC UPSTREAM' }, skills: [], knowledge: [] },
        version: '1.1.0',
      };
    if (command.type === 'gallery.releases')
      return { items: [{ version: '1.1.0', state: 'published' }], nextCursor: null };
    return {};
  });
  render(<TemplateManager bot="mock-bot" />);
  await user.click(await screen.findByRole('button', { name: /检查更新|Check for updates/ }));
  await user.click(await screen.findByRole('button', { name: /^(预览升级|Preview upgrade)$/ }));
  expect(await screen.findByText('SYNTHETIC UPSTREAM')).toBeInTheDocument();
  const commit = screen.getByRole('button', { name: /应用版本|Apply version/ });
  expect(commit).toBeDisabled();
  await user.click(screen.getByRole('button', { name: /解决冲突|Resolve conflict/ }));
  await user.click(screen.getByRole('option', { name: /保留本地|Keep local/ }));
  expect(commit).toBeEnabled();
});

test('gallery browsing keeps connection settings and package fields out of the page until requested', async () => {
  const user = userEvent.setup();
  bridge.command.mockImplementation(async (command) =>
    command.type === 'gallery.sources' ? [] : {},
  );
  const settings = vi.fn();
  render(<RemoteGallery onSettings={settings} />);
  expect(screen.queryByLabelText(/广场地址|Gallery address/)).toBeNull();
  expect(screen.queryByLabelText(/访问令牌|Access token/)).toBeNull();
  expect(screen.queryByRole('button', { name: /选择文件|Choose file/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: /管理来源|Manage sources/ }));
  expect(settings).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: /^(导入模板包|Import template package)$/ }));
  expect(
    await screen.findByRole('dialog', { name: /导入模板包|Import template package/ }),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: /选择文件|Choose file/ })).toBeVisible();
});

test('source choices refresh after settings closes and discard a result from the previous source', async () => {
  const user = userEvent.setup();
  let sources = [
    {
      origin: 'https://mock-old.example.test',
      sourceId: 'mock-old',
      name: 'Old synthetic gallery',
      authenticated: false,
    },
  ];
  let finish: (value: unknown) => unknown = () => {};
  bridge.command.mockImplementation(async (command) => {
    if (command.type === 'gallery.sources') return sources;
    if (command.type === 'gallery.templates')
      return new Promise((resolve) => {
        finish = resolve;
      });
    return {};
  });
  const component = render(<RemoteGallery onSettings={() => {}} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Old synthetic gallery/ })).toHaveTextContent(
      'Old synthetic gallery',
    ),
  );
  await user.click(screen.getByRole('button', { name: /^(搜索模板|Search templates)$/ }));
  component.rerender(<RemoteGallery active={false} onSettings={() => {}} />);
  sources = [
    {
      origin: 'https://mock-new.example.test',
      sourceId: 'mock-new',
      name: 'New synthetic gallery',
      authenticated: false,
    },
  ];
  component.rerender(<RemoteGallery active onSettings={() => {}} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /New synthetic gallery/ })).toHaveTextContent(
      'New synthetic gallery',
    ),
  );
  await act(async () =>
    finish({
      items: [{ id: 'mock-stale', name: 'SYNTHETIC STALE RESULT', latest: { version: '1.0.0' } }],
      nextCursor: null,
    }),
  );
  expect(screen.queryByText('SYNTHETIC STALE RESULT')).toBeNull();
});

test('a list read started during a source write cannot erase the saved connection', async () => {
  const user = userEvent.setup();
  let requests = 0;
  let saved: (value: unknown) => unknown = () => {};
  let listed: (value: unknown) => unknown = () => {};
  bridge.command.mockImplementation(async (command) => {
    if (command.type === 'gallery.source.save')
      return new Promise((resolve) => {
        saved = resolve;
      });
    if (command.type === 'gallery.sources') {
      if (++requests === 1) return [];
      return new Promise((resolve) => {
        listed = resolve;
      });
    }
    return {};
  });
  const component = render(<GallerySources />);
  await waitFor(() => expect(requests).toBe(1));
  await user.type(
    screen.getByLabelText(/广场地址|Gallery address/),
    'https://mock-gallery.example.test',
  );
  await user.click(screen.getByRole('button', { name: /^(添加广场|Add gallery)$/ }));
  component.rerender(<GallerySources active={false} />);
  component.rerender(<GallerySources active />);
  await waitFor(() => expect(requests).toBe(2));
  await act(async () =>
    saved([
      {
        origin: 'https://mock-gallery.example.test',
        name: 'SYNTHETIC SAVED SOURCE',
        authenticated: false,
        sourceId: 'mock-source',
      },
    ]),
  );
  expect(screen.getByText('SYNTHETIC SAVED SOURCE')).toBeVisible();
  await act(async () => listed([]));
  expect(screen.getByText('SYNTHETIC SAVED SOURCE')).toBeVisible();
});

test('closing a package import does not reopen a late preview', async () => {
  const user = userEvent.setup();
  const release = {
    format: 'daban.bot',
    version: 3,
    manifest: {
      templateId: '10000000-0000-4000-8000-000000000001',
      releaseVersion: '1.0.0',
      summary: 'SYNTHETIC',
      license: 'UNLICENSED',
      changelog: '',
      derivedFrom: null,
      requires: {
        capabilities: ['bot-releases-v1'],
        tools: [],
        model: { toolCalling: false, vision: false },
      },
    },
    definition: {
      profile: { name: 'SYNTHETIC IMPORT', instructions: 'SYNTHETIC ROLE', color: 'mint' },
      defaultPreferences: '',
      skills: [],
      knowledge: [],
    },
  };
  let finish: (value: unknown) => unknown = () => {};
  bridge.command.mockImplementation(async (command) => {
    if (command.type === 'gallery.sources') return [];
    if (command.type === 'bot.install.prepare')
      return new Promise((resolve) => {
        finish = resolve;
      });
    return {};
  });
  render(<RemoteGallery onSettings={() => {}} />);
  await user.click(screen.getByRole('button', { name: /^(导入模板包|Import template package)$/ }));
  const file = new File([], 'synthetic.bot.json', { type: 'application/json' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(JSON.stringify(release)).buffer,
  });
  fireEvent.change(
    screen.getByLabelText(/^(导入模板包|Import template package)$/, { selector: 'input' }),
    {
      target: { files: [file] },
    },
  );
  await waitFor(() =>
    expect(
      bridge.command.mock.calls.some(([command]) => command.type === 'bot.install.prepare'),
    ).toBe(true),
  );
  await user.click(screen.getByRole('button', { name: /关闭对话框|Close dialog/ }));
  await act(async () => finish({ release, digest: 'a'.repeat(64), revision: 1 }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
