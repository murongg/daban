import { type Control, Fault } from './control.js';
import type { Screens } from './desktop.js';

const dimensions = { width: 1280, height: 800 };
export function nativeInput(value: unknown): string[] | { text: string } {
  const input = value as {
    type?: string;
    text?: string;
    key?: string;
    deltaY?: number;
    x?: number;
    y?: number;
    button?: number;
    phase?: string;
  };
  if (!input || typeof input !== 'object') throw new Fault('INVALID_INPUT', 400);
  if (input.type === 'release')
    return [
      'mouseup',
      '1',
      'mouseup',
      '2',
      'mouseup',
      '3',
      'keyup',
      'ctrl',
      'keyup',
      'alt',
      'keyup',
      'shift',
      'keyup',
      'Super_L',
    ];
  if (input.type === 'text') {
    if (typeof input.text !== 'string' || input.text.length > 2000 || input.text.includes('\0'))
      throw new Fault('INVALID_INPUT', 400);
    return { text: input.text };
  }
  if (input.type === 'key') {
    const names: Record<string, string> = {
      Enter: 'Return',
      Backspace: 'BackSpace',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      'ControlOrMeta+A': 'ctrl+a',
    };
    const key = typeof input.key === 'string' ? names[input.key] || input.key : undefined;
    if (
      typeof key !== 'string' ||
      !/^(?:(?:ctrl|alt|shift|super)\+)*(?:[a-zA-Z0-9]|F(?:[1-9]|1[0-2])|Return|Tab|BackSpace|Delete|Up|Down|Left|Right|Escape|Home|End|Page_Up|Page_Down|Insert|space)$/.test(
        key,
      )
    )
      throw new Fault('INVALID_INPUT', 400);
    return ['key', '--clearmodifiers', key];
  }
  if (input.type === 'scroll') {
    if (!Number.isFinite(input.deltaY)) throw new Fault('INVALID_INPUT', 400);
    return [
      'click',
      '--repeat',
      String(Math.min(10, Math.max(1, Math.ceil(Math.abs(input.deltaY!) / 80)))),
      '--delay',
      '15',
      input.deltaY! > 0 ? '5' : '4',
    ];
  }
  if (
    !['click', 'pointer'].includes(input.type || '') ||
    !Number.isFinite(input.x) ||
    !Number.isFinite(input.y) ||
    input.x! < 0 ||
    input.x! >= dimensions.width ||
    input.y! < 0 ||
    input.y! >= dimensions.height
  )
    throw new Fault('INVALID_INPUT', 400);
  const button = input.button ?? 1;
  if (![1, 2, 3].includes(button)) throw new Fault('INVALID_INPUT', 400);
  // --sync can wait forever when mouse-up repeats the last pointer coordinates.
  const move = ['mousemove', String(Math.floor(input.x!)), String(Math.floor(input.y!))];
  if (input.type === 'click') return [...move, 'click', String(button)];
  if (!['down', 'up', 'move'].includes(input.phase || '')) throw new Fault('INVALID_INPUT', 400);
  return input.phase === 'move'
    ? move
    : [...move, input.phase === 'down' ? 'mousedown' : 'mouseup', String(button)];
}

export class Native {
  readonly frames = new Set<Promise<Buffer>>();
  constructor(
    readonly control: Control,
    readonly screens: Screens,
  ) {}
  assertInstance(id: string, instance: unknown) {
    if (this.screens.instance(id) !== instance) throw new Fault('DESKTOP_VIEW_STALE');
  }
  async input(id: string, epoch: number, input: unknown, instance?: string) {
    nativeInput(input);
    this.assertInstance(id, instance);
    return this.control.execute(id, 'human', epoch, () => {
      this.assertInstance(id, instance);
      return this.screens.input(id, input);
    });
  }
  async openApp(id: string, epoch: number, app: string, instance?: string) {
    this.assertInstance(id, instance);
    return this.control.execute(id, 'human', epoch, () => {
      this.assertInstance(id, instance);
      return this.screens.openApp(id, app);
    });
  }
  frame(id: string, instance = this.screens.instance(id), epoch = this.control.state(id).epoch) {
    this.control.state(id);
    const check = () => {
      this.assertInstance(id, instance);
      if (this.control.state(id).epoch !== epoch) throw new Fault('STALE_CONTROL');
    };
    check();
    // Track captures for shutdown, but never reuse a pre-action capture as a post-action observation.
    const pending = this.screens
      .frame(id)
      .then((image) => {
        check();
        return image;
      })
      .finally(() => this.frames.delete(pending));
    this.frames.add(pending);
    return pending;
  }
  async close() {
    await Promise.allSettled(this.frames);
    await this.screens.close();
  }
}
