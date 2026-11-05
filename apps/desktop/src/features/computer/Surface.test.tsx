import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DesktopSurface } from './Surface';

it('maps native viewport coordinates and preserves Mac modifiers and the Escape exit', async () => {
  const send = vi.fn(async () => {});
  const view = render(
    <DesktopSurface
      name="Synthetic native"
      image="data:image/jpeg;base64,AA=="
      ready
      human
      kind="native"
      viewport={{ width: 800, height: 600 }}
      modifier="cmd"
      send={send}
      notify={vi.fn()}
    />,
  );
  const image = screen.getByRole('img');
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 150,
    right: 200,
    bottom: 150,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const surface = screen.getByRole('application');
  fireEvent.pointerDown(surface, { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith({
      type: 'pointer',
      phase: 'down',
      button: 1,
      x: 400,
      y: 200,
    }),
  );
  fireEvent.keyDown(surface, { key: 'a', metaKey: true });
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'key', key: 'cmd+a' }));
  fireEvent.keyDown(surface, { key: 'Escape' });
  expect(screen.getByRole('textbox')).toHaveFocus();
  view.unmount();
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith({ type: 'pointer', phase: 'up', button: 1, x: 400, y: 200 }),
  );
});
