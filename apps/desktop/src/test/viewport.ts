import { vi } from 'vitest';

export function mockViewport() {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(80);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return (
      Number.parseFloat(
        this.querySelector<HTMLElement>('.transcript-content')?.style.height || '80000',
      ) + 47
    );
  });
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: function (this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Math.max(
        0,
        Math.min(options.top || 0, this.scrollHeight - this.clientHeight),
      );
      this.dispatchEvent(new Event('scroll'));
    },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = this.getAttribute('role') === 'log' ? 400 : 80;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: height,
      right: 800,
      width: 800,
      height,
      toJSON: () => ({}),
    };
  });
  return () => {
    vi.restoreAllMocks();
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollTo', original);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  };
}
