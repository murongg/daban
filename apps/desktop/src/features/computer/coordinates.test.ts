import { describe, expect, it } from 'vitest';
import { desktopPoint } from './coordinates';

describe('native screen coordinates', () => {
  it('maps displayed pixels to the Linux surface without depending on the selected conversation', () => {
    expect(desktopPoint({ left: 20, top: 50, width: 640, height: 400 }, 340, 250)).toEqual({
      x: 640,
      y: 400,
    });
    expect(desktopPoint({ left: 20, top: 50, width: 640, height: 400 }, 10000, -3)).toEqual({
      x: 1279,
      y: 0,
    });
  });
  it('rejects a hidden or not-yet-laid-out screen', () => {
    expect(desktopPoint({ left: 0, top: 0, width: 0, height: 0 }, 1, 1)).toBeNull();
  });
});
