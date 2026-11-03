import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mockViewport } from '../../test/viewport';
import { WindowList } from './WindowList';

let restore = () => {};
beforeEach(() => {
  restore = mockViewport();
});
afterEach(() => restore());
const items = Array.from({ length: 1000 }, (_, index) => ({
  id: `mock-item-${index}`,
  name: `SYNTHETIC ITEM ${index}`,
}));
it('keeps native list rows and renders only a window inside its existing scroll parent', async () => {
  render(
    <div style={{ height: 400, overflow: 'auto' }}>
      <WindowList
        scope="mock-list"
        tag="ul"
        items={items}
        getKey={(item) => item.id}
        renderItem={(item) => (
          <li key={item.id}>
            <button type="button">{item.name}</button>
          </li>
        )}
      />
    </div>,
  );
  await waitFor(() => expect(screen.getAllByRole('button').length).toBeLessThan(80));
  expect(screen.getByRole('list')).toBeVisible();
  expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('aria-setsize', '1000');
});
it('retains a focused row and keeps its draft while the surrounding range scrolls away', async () => {
  render(
    <div data-testid="mock-scroll" style={{ height: 400, overflow: 'auto' }}>
      <WindowList
        scope="mock-input-list"
        items={items}
        getKey={(item) => item.id}
        renderItem={(item) => (
          <div key={item.id}>
            <input aria-label={item.name} />
          </div>
        )}
      />
    </div>,
  );
  const input = await screen.findByRole('textbox', { name: 'SYNTHETIC ITEM 0' });
  await userEvent.type(input, 'mock retained draft');
  await act(async () => screen.getByTestId('mock-scroll').scrollTo({ top: 10000 }));
  expect(input).toHaveFocus();
  expect(input).toHaveValue('mock retained draft');
  expect(input).toBeInTheDocument();
});
