import { BrowserWindow, type Point, type Rectangle, screen } from 'electron';

const size = 64;
const inset = 24;
const pulseDuration = 520;
const glideDuration = 320;

function contains(bounds: Rectangle, point: Point) {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

function document(bounds: Rectangle, start: Point, end: Point, glide: number) {
  const { width, height } = bounds;
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  body { margin: 0; overflow: hidden; }
  svg { animation: fade ${pulseDuration}ms ${glide}ms ease-in both; }
  path { animation: glide ${glide}ms cubic-bezier(.4, 0, .2, 1) both; }
  circle { opacity: 0; animation: ripple ${pulseDuration}ms ${glide}ms ease-out forwards; }
  @keyframes glide {
    from { transform: translate(${start.x - end.x}px, ${start.y - end.y}px); }
    to { transform: translate(0, 0); }
  }
  @keyframes fade { 55% { opacity: 1; } to { opacity: 0; } }
  @keyframes ripple {
    from { opacity: 1; transform: scale(.35); }
    to { opacity: 0; transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    svg, path, circle { animation: none; }
    circle { opacity: 1; }
  }
</style>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
  <g transform="translate(${end.x - bounds.x} ${end.y - bounds.y})">
    <circle r="18" fill="none" stroke="#e67864" stroke-width="2" />
    <path d="M0 0 22 16 12 17 16 25 11 28 7 20 0 27Z"
      fill="#e67864" stroke="#fff" stroke-width="2" stroke-linejoin="round" />
  </g>
</svg>`;
}

export function windowPointer(platform: 'darwin' | 'win32') {
  let overlay: BrowserWindow | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: { context: string; position: Point } | undefined;

  function dismiss() {
    clearTimeout(timer);
    const previous = overlay;
    overlay = undefined;
    if (!previous || previous.isDestroyed()) return;
    // A window ordered relative to another app can remain composited briefly during removal.
    previous.setOpacity(0);
    previous.destroy();
  }

  function hide() {
    last = undefined;
    dismiss();
  }

  async function show(target: number, point: Point, context: string) {
    dismiss();
    const pixels = { x: Math.round(point.x), y: Math.round(point.y) };
    const position = platform === 'win32' ? screen.screenToDipPoint(pixels) : pixels;
    const display = screen.getDisplayNearestPoint(position).bounds;
    if (!contains(display, position)) {
      last = undefined;
      return;
    }
    // A stale start could point outside the authorized window or across a display boundary.
    const start =
      last?.context === context && contains(display, last.position) ? last.position : position;
    last = { context, position };

    const width = Math.min(display.width, size + Math.abs(position.x - start.x));
    const height = Math.min(display.height, size + Math.abs(position.y - start.y));
    const window = new BrowserWindow({
      x: Math.max(
        display.x,
        Math.min(Math.min(start.x, position.x) - inset, display.x + display.width - width),
      ),
      y: Math.max(
        display.y,
        Math.min(Math.min(start.y, position.y) - inset, display.y + display.height - height),
      ),
      width,
      height,
      show: false,
      frame: false,
      focusable: false,
      transparent: true,
      resizable: false,
      opacity: 0,
      hasShadow: false,
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    overlay = window;
    try {
      window.setIgnoreMouseEvents(true);
      const bounds = window.getBounds();
      if (!contains(bounds, position)) {
        dismiss();
        return;
      }
      const from = contains(bounds, start) ? start : position;
      const glide = from.x === position.x && from.y === position.y ? 0 : glideDuration;
      await window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(document(bounds, from, position, glide))}`,
      );
      if (overlay !== window || window.isDestroyed()) return;
      window.showInactive();
      // Keep covering windows above the pointer, including while it is being placed.
      window.moveAbove(`window:${target}:0`);
      const placed = window.getBounds();
      if (
        placed.x !== bounds.x ||
        placed.y !== bounds.y ||
        placed.width !== bounds.width ||
        placed.height !== bounds.height
      ) {
        dismiss();
        return;
      }
      window.setOpacity(1);
      timer = setTimeout(dismiss, glide + pulseDuration);
    } catch (error) {
      // Pausing can destroy the window while loadURL is still pending.
      if (overlay !== window) return;
      dismiss();
      throw error;
    }
  }

  return { show, hide };
}
