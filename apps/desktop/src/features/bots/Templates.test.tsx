import { disconnected } from '@daban/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
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
  render(<RemoteGallery />);
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
