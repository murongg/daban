import { expect, it, vi } from 'vitest';
import { UpdateSave } from './update-save';

it('requires the owned renderer to acknowledge the exact save nonce before proceeding', async () => {
  let message: { type: string; id: string } | undefined;
  const save = new UpdateSave(
    () => ({
      id: 7,
      send: (value) => {
        message = value;
      },
    }),
    1000,
  );
  const pending = save.request();
  expect(message?.type).toBe('prepare');
  expect(() => save.ack(message!.id, true, 8)).toThrow('UPDATE_SAVE_FAILED');
  expect(() => save.ack('0'.repeat(48), true, 7)).toThrow('UPDATE_SAVE_FAILED');
  save.ack(message!.id, true, 7);
  await expect(pending).resolves.toBeUndefined();
});
it('refuses update when storage fails, the renderer disappears, or it never replies', async () => {
  vi.useFakeTimers();
  try {
    let id = '';
    const save = new UpdateSave(
      () => ({
        id: 7,
        send: (value) => {
          id = value.id;
        },
      }),
      1000,
    );
    const pending = save.request();
    const denied = expect(pending).rejects.toThrow('UPDATE_SAVE_FAILED');
    save.ack(id, false, 7);
    await denied;
    const waiting = save.request();
    const timeout = expect(waiting).rejects.toThrow('UPDATE_SAVE_FAILED');
    await vi.advanceTimersByTimeAsync(1000);
    await timeout;
    const gone = new UpdateSave(() => undefined, 1000);
    await expect(gone.request()).rejects.toThrow('UPDATE_SAVE_FAILED');
  } finally {
    vi.useRealTimers();
  }
});
