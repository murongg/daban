import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Messages } from './Messages';
import { Theme } from './Theme';

let media: MediaQueryList;
let changes: Set<(event: MediaQueryListEvent) => unknown>;
beforeEach(() => {
  delete document.documentElement.dataset.theme;
  changes = new Set();
  media = {
    matches: false,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => unknown) =>
      changes.add(listener),
    removeEventListener: (_event: string, listener: (event: MediaQueryListEvent) => unknown) =>
      changes.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  } as MediaQueryList;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});
const show = () =>
  render(
    <Messages>
      <Theme />
    </Messages>,
  );
function system(dark: boolean) {
  Object.defineProperty(media, 'matches', { value: dark, configurable: true });
  act(() => {
    for (const listener of changes) listener({ matches: dark } as MediaQueryListEvent);
  });
}
test('follows system appearance until a manual choice, then persists that choice across remounts', () => {
  const first = show();
  expect(document.documentElement.dataset.theme).toBe('light');
  system(true);
  expect(document.documentElement.dataset.theme).toBe('dark');
  fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
  expect(document.documentElement.dataset.theme).toBe('light');
  system(false);
  system(true);
  expect(document.documentElement.dataset.theme).toBe('light');
  first.unmount();
  show();
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible();
});
test('uses the saved dark theme even when the system is light', () => {
  localStorage.setItem('daban.gallery.theme', 'dark');
  show();
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
});
test('storage restrictions do not prevent switching or let system changes override the choice', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw Error('SYNTHETIC STORAGE DENIED');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('SYNTHETIC STORAGE DENIED');
  });
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  system(false);
  expect(document.documentElement.dataset.theme).toBe('dark');
});
test('static rendering stays deterministic and does not access browser preferences', () => {
  const storage = vi.spyOn(Storage.prototype, 'getItem');
  expect(
    renderToString(
      <Messages>
        <Theme />
      </Messages>,
    ),
  ).toContain('<button');
  expect(storage).not.toHaveBeenCalled();
});
