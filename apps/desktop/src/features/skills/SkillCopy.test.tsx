import { disconnected, type RuntimeCommand, type RuntimeReply } from '@daban/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { SkillCopy } from './SkillCopy';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
it('explicitly adds an independent installation to the selected other Bot', async () => {
  const bots: Bot[] = ['mock-alpha', 'mock-beta'].map((id) => ({
    id,
    name: id,
    role: '',
    color: 'mint',
    preview: '',
    time: '',
  }));
  const snapshot = disconnected('ready');
  snapshot.botCapabilities = true;
  snapshot.protocolVersion = 41;
  snapshot.profiles = bots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    instructions: '',
    memory: '',
    color: 'mint',
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
  const invoke = vi.fn(
    async (command: RuntimeCommand): Promise<RuntimeReply> => ({
      ok: true,
      value: command.type === 'status' ? snapshot : {},
    }),
  );
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { runtime: { invoke, subscribe: () => () => {} } },
  });
  const copied = vi.fn();
  render(
    <RuntimeProvider>
      <SkillCopy
        bot={bots[0]}
        bots={bots}
        entry={{
          id: 'mock-skill',
          ownerBot: 'mock-alpha',
          name: 'synthetic-recipe',
          description: 'Synthetic recipe',
          revision: 2,
          size: 100,
          deleted: false,
          invocation: { userInvocable: true, modelInvocable: true },
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          enabled: true,
          bindingRevision: 1,
        }}
        onClose={() => {}}
        onCopied={copied}
      />
    </RuntimeProvider>,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: '添加并启用' })).toBeEnabled());
  expect(invoke.mock.calls.some(([command]) => command.type === 'skill.copy')).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: '添加并启用' }));
  await waitFor(() => expect(copied).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledWith({
    type: 'skill.copy',
    bot: 'mock-alpha',
    id: 'mock-skill',
    revision: 2,
    targetBot: 'mock-beta',
  });
});
