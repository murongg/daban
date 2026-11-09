import {
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { LiveDesktop } from './LiveDesktop';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
it('hides old native frames on instance replacement and releases a held pointer only against its captured screen', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 18;
  snapshot.bots.a = {
    owner: 'human',
    epoch: 4,
    instance: 'mock-native-old',
    task: {
      running: false,
      phase: 'idle',
      prompt: '',
      result: '',
      error: '',
      files: [],
      toolCount: 0,
      executedCount: 0,
      trace: [],
      history: [],
    },
  };
  let publish!: (value: RuntimeSnapshot) => unknown, finish!: (value: unknown) => unknown;
  const next = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const invoke = vi.fn(async (command: RuntimeCommand) => ({
    ok: true,
    value:
      command.type === 'status'
        ? snapshot
        : command.type === 'frame'
          ? command.instance === 'mock-native-new'
            ? await next
            : 'data:image/jpeg;base64,b2xk'
          : { ok: true },
  }));
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: (value: RuntimeSnapshot) => unknown) => {
          publish = listener;
          return () => {};
        },
      } as unknown as RuntimeBridge,
    },
  });
  render(
    <RuntimeProvider>
      <LiveDesktop bot="a" name="合成屏幕" owner="human" epoch={4} notify={vi.fn()} />
    </RuntimeProvider>,
  );
  const image = await screen.findByRole('img');
  image.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 640,
    height: 400,
    right: 640,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  fireEvent.pointerDown(screen.getByRole('application'), {
    clientX: 30,
    clientY: 30,
    button: 0,
    pointerId: 7,
  });
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([c]) => c.type === 'input' && c.input.type === 'pointer' && c.input.phase === 'down',
      ),
    ).toBe(true),
  );
  const replaced = structuredClone(snapshot);
  replaced.bots.a!.instance = 'mock-native-new';
  act(() => {
    publish(replaced);
  });
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByRole('application')).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('textbox', { name: '发送文字到 Linux 桌面' })).toBeDisabled();
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([c]) =>
          c.type === 'input' &&
          c.input.type === 'pointer' &&
          c.input.phase === 'up' &&
          c.instance === 'mock-native-old',
      ),
    ).toBe(true),
  );
  await act(async () => {
    finish('data:image/jpeg;base64,bmV3');
    await next;
  });
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'data:image/jpeg;base64,bmV3');
  expect(screen.getByRole('application')).toHaveAttribute('aria-busy', 'false');
  expect(
    invoke.mock.calls.some(
      ([c]) => c.type === 'frame' && c.instance === 'mock-native-new' && c.epoch === 4,
    ),
  ).toBe(true);
});
describe('actual desktop viewer', () => {
  it('sends coordinates to the captured Bot/epoch and releases a held pointer when the viewer closes', async () => {
    const snapshot = disconnected('ready');
    snapshot.protocolVersion = 1;
    const invoke = vi.fn(async (command: RuntimeCommand) => ({
      ok: true as const,
      value:
        command.type === 'status'
          ? snapshot
          : command.type === 'frame'
            ? 'data:image/jpeg;base64,c3ludGhldGlj'
            : { ok: true },
    }));
    const bridge = { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge;
    Object.defineProperty(window, 'daban', {
      value: { platform: 'darwin', runtime: bridge },
      configurable: true,
    });
    const app = render(
      <RuntimeProvider>
        <LiveDesktop bot="a" name="合成 Bot" owner="human" epoch={5} notify={() => undefined} />
      </RuntimeProvider>,
    );
    const image = await screen.findByRole('img', { name: '合成 Bot的 Linux 桌面' });
    await waitFor(() => expect(image.getAttribute('src')).toContain('data:image/jpeg'));
    image.getBoundingClientRect = () => ({
      left: 20,
      top: 50,
      width: 640,
      height: 400,
      right: 660,
      bottom: 450,
      x: 20,
      y: 50,
      toJSON: () => ({}),
    });
    const down = new MouseEvent('pointerdown', {
      bubbles: true,
      clientX: 340,
      clientY: 250,
      button: 0,
    });
    Object.defineProperty(down, 'pointerId', { value: 1 });
    fireEvent(image, down);
    await waitFor(() =>
      expect(
        invoke.mock.calls.some(
          ([c]) =>
            c.type === 'input' &&
            c.bot === 'a' &&
            c.epoch === 5 &&
            c.input.type === 'pointer' &&
            c.input.phase === 'down' &&
            c.input.x === 640 &&
            c.input.y === 400,
        ),
      ).toBe(true),
    );
    app.unmount();
    await waitFor(() =>
      expect(
        invoke.mock.calls.some(
          ([c]) =>
            c.type === 'input' &&
            c.bot === 'a' &&
            c.epoch === 5 &&
            c.input.type === 'pointer' &&
            c.input.phase === 'up',
        ),
      ).toBe(true),
    );
  });
});
it('provides an Escape exit from the native keyboard surface while preserving remote Escape and reverse Tab', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 1;
  const invoke = vi.fn(async (command: RuntimeCommand) => ({
    ok: true as const,
    value:
      command.type === 'status'
        ? snapshot
        : command.type === 'frame'
          ? 'data:image/jpeg;base64,c3ludGhldGlj'
          : {},
  }));
  Object.defineProperty(window, 'daban', {
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge,
    },
    configurable: true,
  });
  render(
    <RuntimeProvider>
      <LiveDesktop bot="a" name="合成 Bot" owner="human" epoch={5} notify={() => undefined} />
    </RuntimeProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole('img').getAttribute('src')).toContain('data:image/jpeg'),
  );
  const surface = screen.getByRole('application');
  surface.focus();
  fireEvent.keyDown(surface, { key: 'Escape' });
  expect(screen.getByRole('textbox', { name: '发送文字到 Linux 桌面' })).toHaveFocus();
  expect(
    invoke.mock.calls.some(
      ([c]) => c.type === 'input' && c.input.type === 'key' && c.input.key === 'Escape',
    ),
  ).toBe(false);
  surface.focus();
  fireEvent.keyDown(surface, { key: 'Escape', altKey: true });
  fireEvent.keyDown(surface, { key: 'Tab', shiftKey: true });
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([c]) => c.type === 'input' && c.input.type === 'key' && c.input.key === 'shift+Tab',
      ),
    ).toBe(true),
  );
  expect(
    invoke.mock.calls.some(
      ([c]) => c.type === 'input' && c.input.type === 'key' && c.input.key === 'Escape',
    ),
  ).toBe(true);
  expect(screen.getByText(/Esc 退出画面/)).toBeVisible();
});
