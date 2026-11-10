import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useNavigation } from './navigation';
import type { View } from './state';

it('skips deleted destinations and does not record repeated pages or background selection changes', () => {
  const bots = [{ id: 'mock-one' }, { id: 'mock-two' }];
  const initial = { view: 'chat' as View, selected: 'mock-one', bots };
  const { result, rerender } = renderHook(
    ({ view, selected, bots }) => useNavigation(view, selected, bots),
    { initialProps: initial },
  );
  rerender({ ...initial, selected: 'mock-two' });
  rerender({ ...initial, view: 'tasks' });
  rerender({ ...initial, view: 'tasks', selected: 'mock-two' });
  rerender({ ...initial, view: 'tasks', bots: [{ id: 'mock-one' }] });
  let target: ReturnType<typeof result.current.back>;
  act(() => {
    target = result.current.back();
  });
  expect(target).toEqual({ view: 'chat', bot: 'mock-one' });
  rerender({ ...initial, bots: [{ id: 'mock-one' }] });
  expect(result.current.canBack).toBe(false);
  expect(result.current.canForward).toBe(true);
});
