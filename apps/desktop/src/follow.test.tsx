import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useFollow } from './follow';

function Transcript({ scope = 'mock-a:0', request = '' }) {
  const scroll = useFollow(scope, request);
  return (
    <>
      <div ref={scroll.viewport} onScroll={scroll.onScroll} role="log">
        <div ref={scroll.content}>
          <div ref={scroll.attention}>Synthetic question</div>
        </div>
      </div>
      <button type="button" onClick={scroll.resume}>
        Send synthetic message
      </button>
    </>
  );
}
function geometry() {
  const log = screen.getByRole('log');
  Object.defineProperties(log, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, writable: true, value: 600 },
  });
  fireEvent.scroll(log);
  log.scrollTop = 100;
  fireEvent.scroll(log);
  return log;
}
it('resumes following when sending from history or switching Bot or conversation', () => {
  const view = render(<Transcript />);
  const log = geometry();
  view.rerender(<Transcript />);
  expect(log.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole('button'));
  expect(log.scrollTop).toBe(1000);
  log.scrollTop = 100;
  fireEvent.scroll(log);
  view.rerender(<Transcript scope="mock-b:0" />);
  expect(log.scrollTop).toBe(1000);
  log.scrollTop = 100;
  fireEvent.scroll(log);
  view.rerender(<Transcript scope="mock-b:1" />);
  expect(log.scrollTop).toBe(1000);
});
it('reveals a new human request once, allows history reading, then follows the continued reply', () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const reveal = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: reveal,
  });
  try {
    const view = render(<Transcript />);
    const log = geometry();
    view.rerender(<Transcript request="mock-question" />);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith({ block: 'start' });
    view.rerender(<Transcript request="mock-question" />);
    expect(log.scrollTop).toBe(100);
    expect(reveal).toHaveBeenCalledTimes(1);
    view.rerender(<Transcript />);
    expect(log.scrollTop).toBe(1000);
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});
