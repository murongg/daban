import { expect, it } from 'vitest';
import { LocalComputer, type LocalDriver, type WindowDriver } from './local-computer';

function fixture() {
  const actions: unknown[] = [];
  const driver: LocalDriver = {
    supported: true,
    platform: 'darwin',
    permissions: () => ({ screen: true, accessibility: true }),
    capture: async () => ({
      image: 'data:image/jpeg;base64,AA==',
      width: 800,
      height: 600,
      context: 'mock-window',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    }),
    context: async () => 'mock-window',
    input: async (input) => {
      actions.push(input);
    },
    openApp: async (app) => {
      actions.push(app);
    },
    release: async () => {},
    hide: async () => {},
  };
  return { controller: new LocalComputer(driver, true), driver, actions };
}
const connect = {
  type: 'local.connect' as const,
  id: 'mock-consent',
  bot: 'mock-a',
  model: 'mock-model',
  modelRevision: 1,
};
const bound = { bot: 'mock-a', runId: 'mock-run', model: 'mock-model', modelRevision: 1 };
const binding = (controller: LocalComputer) => ({
  ...bound,
  session: controller.status().session?.id || 'mock-missing-session',
});
it('limits an automatic window grant to the approving run and revokes it at task end', async () => {
  const { controller, driver } = fixture();
  driver.appWindow = async () => 'mock-window';
  driver.forWindow = () => ({
    name: 'Synthetic editor',
    capture: driver.capture,
    context: driver.context,
    input: driver.input,
  });
  const { session } = await controller.connectApp(
    bound,
    'test.synthetic.editor',
    new AbortController().signal,
  );
  expect(session?.window).toBe('Synthetic editor');
  await expect(controller.capture({ ...binding(controller), runId: 'mock-other' })).rejects.toThrow(
    'LOCAL_RUN_STALE',
  );
  expect(await controller.capture(binding(controller))).toMatchObject({ width: 800, height: 600 });
  await controller.pause(session!.id, session!.revision);
  await expect(controller.capture(binding(controller))).rejects.toThrow('LOCAL_PAUSED');
  await controller.cancel(bound.runId, session!.id);
  expect(controller.status().session).toBeUndefined();
});
it('requires explicit consent, enforces a single Bot, and rejects model changes or stale observations', async () => {
  const { controller, actions } = fixture();
  await expect(controller.capture(binding(controller))).rejects.toThrow('LOCAL_NOT_CONNECTED');
  const status = await controller.connect(connect);
  await expect(controller.connect({ ...connect, id: 'mock-b', bot: 'mock-b' })).rejects.toThrow(
    'LOCAL_COMPUTER_BUSY',
  );
  await expect(controller.capture({ ...binding(controller), modelRevision: 2 })).rejects.toThrow(
    'LOCAL_MODEL_CHANGED',
  );
  expect(controller.status().session).toBeUndefined();
  await controller.connect({ ...connect, id: 'mock-renewed-consent' });
  const frame = await controller.capture(binding(controller));
  await controller.act({
    ...binding(controller),
    observation: frame.observation,
    actions: [{ type: 'click', x: 20, y: 30 }],
  });
  await expect(
    controller.act({
      ...binding(controller),
      observation: frame.observation,
      actions: [{ type: 'click', x: 20, y: 30 }],
    }),
  ).rejects.toThrow('LOCAL_OBSERVATION_STALE');
  expect(actions).toHaveLength(1);
  const current = controller.status().session!;
  await controller.pause(current.id, current.revision);
  await expect(controller.capture(binding(controller))).rejects.toThrow('LOCAL_PAUSED');
  expect(status.session?.bot).toBe('mock-a');
});
it('disconnect fences queued actions, and a late cancellation cannot cancel a newer run', async () => {
  const { controller, driver, actions } = fixture();
  await controller.connect(connect);
  const first = await controller.capture(binding(controller));
  const newer = await controller.capture({ ...binding(controller), runId: 'mock-new-run' });
  await controller.cancel(bound.runId);
  await controller.act({
    ...binding(controller),
    runId: 'mock-new-run',
    observation: newer.observation,
    actions: [{ type: 'text', text: 'SYNTHETIC TEXT' }],
  });
  expect(actions).toHaveLength(1);
  await expect(
    controller.act({
      ...binding(controller),
      observation: first.observation,
      actions: [{ type: 'text', text: 'OLD TEXT' }],
    }),
  ).rejects.toThrow();
  driver.permissions = () => ({ screen: false, accessibility: true });
  await expect(controller.capture(binding(controller))).rejects.toThrow('LOCAL_SCREEN_PERMISSION');
  expect(controller.status().session).toBeUndefined();
});
it('revokes queued input before waiting for a slow native action to settle', async () => {
  const { controller, driver } = fixture();
  let finish: () => unknown = () => {};
  let started: () => unknown = () => {};
  const entered = new Promise((resolve) => {
    started = () => resolve(undefined);
  });
  const blocked = new Promise((resolve) => {
    finish = () => resolve(undefined);
  });
  let count = 0;
  driver.input = async (_input, _frame, check) => {
    count++;
    started();
    await blocked;
    check();
  };
  const state = await controller.connect(connect);
  const frame = await controller.capture(binding(controller));
  const action = controller.act({
    ...binding(controller),
    observation: frame.observation,
    actions: [
      { type: 'click', x: 10, y: 10 },
      { type: 'text', text: 'MUST NOT TYPE' },
    ],
  });
  const rejected = expect(action).rejects.toThrow('LOCAL_NOT_CONNECTED');
  await entered;
  const closing = controller.disconnect(state.session!.id, state.session!.revision);
  finish();
  await rejected;
  await closing;
  expect(count).toBe(1);
});
it('a stale request cannot revoke a newer consent for the same Bot', async () => {
  const { controller } = fixture();
  const first = await controller.connect(connect);
  await controller.disconnect(first.session!.id, first.session!.revision);
  const second = await controller.connect({
    ...connect,
    id: 'mock-second-consent',
    modelRevision: 2,
  });
  await expect(controller.capture({ ...bound, session: first.session!.id })).rejects.toThrow(
    'LOCAL_SESSION_STALE',
  );
  expect(controller.status().session?.id).toBe(second.session!.id);
});
it('stopping during a capture discards its late image and observation', async () => {
  const { controller, driver } = fixture();
  let finish: () => unknown = () => {};
  let began: () => unknown = () => {};
  const entered = new Promise((resolve) => {
    began = () => resolve(undefined);
  });
  const blocked = new Promise((resolve) => {
    finish = () => resolve(undefined);
  });
  const original = driver.capture;
  driver.capture = async () => {
    began();
    await blocked;
    return original();
  };
  const status = await controller.connect(connect);
  const pending = controller.capture(binding(controller));
  await entered;
  const discarded = expect(pending).rejects.toThrow('LOCAL_RUN_STALE');
  const cancel = controller.cancel(bound.runId, status.session!.id);
  finish();
  await discarded;
  await cancel;
  expect(controller.preview(status.session!.id, status.session!.revision)).toBeUndefined();
});

it('reports a human pause before a capture error that raced the pause', async () => {
  const { controller, driver } = fixture();
  await controller.connect(connect);
  let entered!: () => unknown;
  let fail!: (error: Error) => unknown;
  const capturing = new Promise((resolve) => {
    entered = () => resolve(undefined);
  });
  driver.capture = () =>
    new Promise((_resolve, reject) => {
      fail = reject;
      entered();
    });
  const pending = controller.capture(binding(controller));
  const rejected = expect(pending).rejects.toThrow('LOCAL_PAUSED');
  await capturing;
  const session = controller.status().session!;
  const paused = controller.pause(session.id, session.revision);
  fail(new Error('LOCAL_SCREEN_CHANGED'));
  await rejected;
  await paused;
  expect(controller.status().session?.owner).toBe('human');
});

it('reports a pause that races a foreground-window change before input', async () => {
  const { controller, driver, actions } = fixture();
  await controller.connect(connect);
  const frame = await controller.capture(binding(controller));
  let paused: Promise<unknown> = Promise.resolve();
  driver.context = async () => {
    paused = controller.interrupt();
    return 'mock-new-window';
  };
  await expect(
    controller.act({
      ...binding(controller),
      observation: frame.observation,
      actions: [{ type: 'text', text: 'SYNTHETIC INPUT' }],
    }),
  ).rejects.toThrow('LOCAL_PAUSED');
  await paused;
  expect(actions).toHaveLength(0);
});

function deferred<T>() {
  let resolve!: (value: T) => unknown;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('binds input to the authorized window while keeping Daban available', async () => {
  const { controller, driver, actions } = fixture();
  driver.hide = async () => {
    throw new Error('Must leave Daban visible');
  };
  const received: unknown[] = [];
  driver.windows = () => [{ id: '11:22', name: 'Synthetic editor' }];
  driver.forWindow = async (id) => {
    expect(id).toBe('11:22');
    return {
      name: 'Synthetic editor',
      capture: driver.capture,
      context: driver.context,
      input: async (input) => {
        received.push(input);
      },
    };
  };
  expect(controller.windows()).toEqual([{ id: '11:22', name: 'Synthetic editor' }]);
  const status = await controller.connect({ ...connect, window: '11:22' });
  expect(status.session?.window).toBe('Synthetic editor');
  await controller.interruptForeground();
  const frame = await controller.capture(binding(controller));
  await expect(
    controller.openApp({ ...binding(controller), observation: frame.observation, app: 'files' }),
  ).rejects.toThrow('LOCAL_WINDOW_SCOPED');
  const input = { type: 'text', x: 20, y: 30, text: 'SYNTHETIC' };
  await controller.act({
    ...binding(controller),
    observation: frame.observation,
    actions: [input],
  });
  expect(received).toEqual([input]);
  expect(actions).toEqual([]);
  await controller.interrupt();
  const paused = controller.status().session!;
  expect(paused.owner).toBe('human');
  await controller.resume(paused.id, paused.revision);
});

it('invalidates a pending window authorization on revocation', async () => {
  const { controller, driver } = fixture();
  const lookup = deferred<WindowDriver>();
  const entered = deferred<undefined>();
  driver.forWindow = () => {
    entered.resolve(undefined);
    return lookup.promise;
  };
  const pending = controller.connect({ ...connect, window: '11:22' });
  const rejected = expect(pending).rejects.toThrow('LOCAL_CONSENT_EXPIRED');
  await entered.promise;
  const revoked = controller.revoke();
  lookup.resolve({
    name: 'Synthetic window',
    capture: driver.capture,
    context: driver.context,
    input: driver.input,
  });
  await rejected;
  await revoked;
  expect(controller.status().session).toBeUndefined();
});

it('interrupts in-flight window input before pause waits for the SDK', async () => {
  const { controller, driver } = fixture();
  const entered = deferred<undefined>();
  const blocked = deferred<undefined>();
  let interrupted = false;
  driver.forWindow = () => ({
    name: 'Synthetic window',
    capture: driver.capture,
    context: driver.context,
    input: async () => {
      entered.resolve(undefined);
      return blocked.promise;
    },
    interrupt: () => {
      interrupted = true;
      blocked.resolve(undefined);
    },
  });
  const state = await controller.connect({ ...connect, window: '11:22' });
  const frame = await controller.capture(binding(controller));
  const pending = controller.act({
    ...binding(controller),
    observation: frame.observation,
    actions: [{ type: 'click', x: 10, y: 10 }],
  });
  const rejected = expect(pending).rejects.toThrow('LOCAL_PAUSED');
  await entered.promise;
  const paused = controller.pause(state.session!.id, state.session!.revision);
  const interruptedBeforeDrain = interrupted;
  blocked.resolve(undefined);
  await rejected;
  await paused;
  expect(interruptedBeforeDrain).toBe(true);
});

it('refuses an unavailable window without granting foreground access', async () => {
  const { controller, driver } = fixture();
  driver.forWindow = async () => {
    throw new Error('LOCAL_WINDOW_UNAVAILABLE');
  };
  await expect(controller.connect({ ...connect, window: '11:22' })).rejects.toThrow(
    'LOCAL_WINDOW_UNAVAILABLE',
  );
  expect(controller.status().session).toBeUndefined();
});
