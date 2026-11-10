import { BrowserWindow, type Point, screen } from 'electron';

const size = 64;
const inset = 24;
const duration = 520;

function document(x: number, y: number) {
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  body { margin: 0; overflow: hidden; }
  svg { animation: fade ${duration}ms ease-in both; }
  circle { animation: ripple ${duration}ms ease-out both; }
  @keyframes fade { 55% { opacity: 1; } to { opacity: 0; } }
  @keyframes ripple { from { transform: scale(.35); } to { transform: scale(1); } }
  @media (prefers-reduced-motion: reduce) {
    svg, circle { animation: none; }
  }
</style>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
  <g transform="translate(${x} ${y})">
    <circle r="18" fill="none" stroke="#e67864" stroke-width="2" />
    <path d="M0 0 22 16 12 17 16 25 11 28 7 20 0 27Z"
      fill="#e67864" stroke="#fff" stroke-width="2" stroke-linejoin="round" />
  </g>
</svg>`;
}

export function windowPointer(platform: 'darwin' | 'win32') {
  let overlay: BrowserWindow | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function hide() {
    clearTimeout(timer);
    const previous = overlay;
    overlay = undefined;
    if (!previous || previous.isDestroyed()) return;
    // A window ordered relative to another app can remain composited briefly during removal.
    previous.setOpacity(0);
    previous.destroy();
  }

  async function show(target: number, point: Point) {
    hide();
    const pixels = { x: Math.round(point.x), y: Math.round(point.y) };
    const position = platform === 'win32' ? screen.screenToDipPoint(pixels) : pixels;
    const display = screen.getDisplayNearestPoint(position).bounds;
    const right = display.x + display.width;
    const bottom = display.y + display.height;
    if (
      position.x < display.x ||
      position.x >= right ||
      position.y < display.y ||
      position.y >= bottom
    )
      return;

    const window = new BrowserWindow({
      x: Math.max(display.x, Math.min(position.x - inset, right - size)),
      y: Math.max(display.y, Math.min(position.y - inset, bottom - size)),
      width: size,
      height: size,
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
      const x = position.x - bounds.x;
      const y = position.y - bounds.y;
      if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) {
        hide();
        return;
      }
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document(x, y))}`);
      if (overlay !== window || window.isDestroyed()) return;
      window.showInactive();
      // Keep covering windows above the pointer, including while it is being placed.
      window.moveAbove(`window:${target}:0`);
      const placed = window.getBounds();
      if (placed.x !== bounds.x || placed.y !== bounds.y) {
        hide();
        return;
      }
      window.setOpacity(1);
      timer = setTimeout(hide, duration);
    } catch (error) {
      // Pausing can destroy the window while loadURL is still pending.
      if (overlay !== window) return;
      hide();
      throw error;
    }
  }

  return { show, hide };
}
