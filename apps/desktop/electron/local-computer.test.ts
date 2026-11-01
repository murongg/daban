import { expect, it } from 'vitest';
import { LocalComputer, type LocalDriver } from './local-computer';

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
