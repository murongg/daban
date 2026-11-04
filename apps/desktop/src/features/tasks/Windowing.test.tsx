import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { demoState } from '../../test/fixtures';
import { mockViewport } from '../../test/viewport';
import { Tasks } from './Tasks';
import { useWork } from './work';
import { workInitial } from './work-state';

let restore = () => {};
beforeEach(() => {
  restore = mockViewport();
});
afterEach(() => restore());
function Fixture({ board = false }: { board?: boolean }) {
  const state = demoState();
  state.work = { ...workInitial(), mode: board ? 'board' : 'list' };
  const work = useWork(state, vi.fn(), vi.fn());
  const items = Array.from({ length: 1000 }, (_, index) => ({
    id: `mock-task-${index}`,
    title: `SYNTHETIC TASK ${index}`,
    status: 'todo' as const,
    progress: '',
    progressTruncated: false,
    revision: 1,
    deleted: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: { kind: 'human' as const },
    updatedBy: { kind: 'human' as const },
  }));
  return <Tasks state={state} dispatch={vi.fn()} work={{ ...work, available: true, items }} />;
}
it.each([false, true])(
  'bounds accumulated task cards in board=%s while preserving their native list semantics',
  async (board) => {
    render(<Fixture board={board} />);
    await screen.findByRole('button', { name: '查看 SYNTHETIC TASK 0' });
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: /^查看 SYNTHETIC TASK/ }).length).toBeLessThan(
        80,
      ),
    );
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('aria-setsize', '1000');
  },
);
