import { disconnected, type RuntimeCommand } from '@daban/protocol';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { bots } from '../../test/fixtures';
import { ChatHistory } from './ChatHistory';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
it('keeps a trashed topic out of the normal history reader and continuation flow', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 47;
  const invoke = vi.fn(async (command: RuntimeCommand) =>
    command.type === 'status'
      ? { ok: true, value: snapshot }
      : { ok: true, value: { bot: 'a', revision: 0, items: [] } },
  );
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { runtime: { invoke, subscribe: () => () => {} } },
  });
  render(
    <RuntimeProvider>
      <ChatHistory
        bot={bots[1]}
        revision={1}
        trashedRevisions={[0]}
        close={vi.fn()}
        notify={vi.fn()}
        preview={vi.fn()}
        onContinue={vi.fn()}
      />
    </RuntimeProvider>,
  );
  expect(await screen.findByText('这段对话已移到回收站，恢复后可继续。')).toBeVisible();
  expect(invoke.mock.calls.some(([command]) => command.type === 'chat.history')).toBe(false);
  expect(screen.queryByRole('button', { name: '继续这段对话' })).not.toBeInTheDocument();
});
