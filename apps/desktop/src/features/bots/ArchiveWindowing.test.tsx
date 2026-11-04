import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { demoState } from '../../test/fixtures';
import { mockViewport } from '../../test/viewport';
import { ArchiveList } from './Archive';

it('bounds archived Bots without removing restore and history actions', async () => {
  const restore = mockViewport();
  try {
    const state = demoState();
    state.bots = Array.from({ length: 1000 }, (_, index) => ({
      ...state.bots[0]!,
      id: `mock-archived-${index}`,
      name: `SYNTHETIC ARCHIVED ${index}`,
      archived: true,
    }));
    render(
      <div style={{ height: 400, overflow: 'auto' }}>
        <ArchiveList state={state} dispatch={vi.fn()} onAction={vi.fn()} />
      </div>,
    );
    await screen.findByRole('button', { name: '查看历史 SYNTHETIC ARCHIVED 0' });
    await waitFor(() =>
      expect(screen.queryAllByText(/^SYNTHETIC ARCHIVED/).length).toBeLessThan(80),
    );
  } finally {
    restore();
  }
});
