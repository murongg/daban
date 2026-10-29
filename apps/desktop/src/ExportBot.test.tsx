import type { SkillCatalog } from '@daban/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ExportBot } from './ExportBot';

const mocks = vi.hoisted(() => ({ command: vi.fn(), download: vi.fn() }));
vi.mock('./files', () => ({ downloadBlob: mocks.download }));
vi.mock('./Runtime', () => ({
  runtimeError: (error: Error) => error.message,
  useRuntime: () => ({
    enabled: true,
    snapshot: {
      phase: 'ready',
      protocolVersion: 27,
      profiles: [
        {
          id: 'mock-source',
          name: '合成导出',
          instructions: 'SYNTHETIC ROLE',
          memory: 'SYNTHETIC PREF',
          color: 'mint',
          revision: 1,
        },
      ],
    },
    command: mocks.command,
  }),
}));
it('exports authoritative selected content, makes originals opt-in and captures the source identity', async () => {
  const user = userEvent.setup();
  mocks.command.mockImplementation(async (value) => {
    if (value.type === 'skill.list') return { revision: 0, items: [] } satisfies SkillCatalog;
    if (value.type === 'knowledge.list') return [];
    if (value.type === 'bot.export')
      return {
        format: 'daban.bot',
        version: 1,
        profile: { name: '合成导出', instructions: 'SYNTHETIC ROLE', color: 'mint' },
        preferences: '',
        skills: [],
        knowledge: [],
      };
    throw new Error('UNEXPECTED MOCK COMMAND');
  });
  const close = vi.fn();
  render(<ExportBot bot="mock-source" close={close} notify={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '下载导出包' })).toBeEnabled());
  expect(screen.getByLabelText('包含资料原件')).not.toBeChecked();
  await user.click(screen.getByLabelText('包含工作偏好'));
  await user.click(screen.getByRole('button', { name: '下载导出包' }));
  expect(mocks.command).toHaveBeenCalledWith({
    type: 'bot.export',
    input: {
      bot: 'mock-source',
      revision: 1,
      memory: false,
      originals: false,
      skills: [],
      knowledge: [],
    },
  });
  expect(mocks.download).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalled();
});
