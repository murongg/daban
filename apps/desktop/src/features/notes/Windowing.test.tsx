import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { demoState } from '../../test/fixtures';
import { mockViewport } from '../../test/viewport';
import { Notes } from './Notes';

vi.mock('./note-controller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./note-controller')>();
  return {
    ...actual,
    useNotes: (...args: Parameters<typeof actual.useNotes>) => ({
      ...actual.useNotes(...args),
      available: true,
      loaded: true,
      items: Array.from({ length: 1000 }, (_, index) => ({
        bot: 'a',
        id: `mock-note-${index}`,
        title: `SYNTHETIC NOTE ${index}`,
        body: 'MOCK NOTE BODY',
        status: 'open' as const,
        bodyTruncated: false,
        revision: 1,
        deleted: false,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        createdBy: { kind: 'human' as const },
        updatedBy: { kind: 'human' as const },
      })),
    }),
  };
});
let restore = () => {};
beforeEach(() => {
  restore = mockViewport();
});
afterEach(() => restore());
it('bounds accumulated notes inside the existing workspace scroll pane', async () => {
  const state = demoState();
  render(
    <div style={{ height: 400, overflow: 'auto' }}>
      <Notes state={state} bot={state.bots[0]!} dispatch={vi.fn()} notify={vi.fn()} />
    </div>,
  );
  await screen.findByRole('button', { name: '查看便笺 SYNTHETIC NOTE 0' });
  await waitFor(() =>
    expect(
      screen.queryAllByRole('button', { name: /^查看便笺 SYNTHETIC NOTE/ }).length,
    ).toBeLessThan(80),
  );
});
