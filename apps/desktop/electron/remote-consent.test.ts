import type { LocalComputerSession, RemoteIdentity } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { nativeMediaCurrent, RemoteConsent } from './remote-consent';

const device: RemoteIdentity = {
  id: 'a'.repeat(64),
  publicKey: 'A'.repeat(59),
  name: 'Synthetic controller',
};
const session: LocalComputerSession = {
  id: 'synthetic-desktop',
  bot: 'synthetic-bot',
  model: 'synthetic-model',
  modelRevision: 1,
  revision: 1,
  owner: 'agent',
};
const connect = {
  type: 'local.connect' as const,
  id: 'synthetic-consent',
  bot: session.bot,
  model: session.model,
  modelRevision: 1,
};

it('ends viewing when the bound Bot/model changes, while allowing human ownership transfers', () => {
  const request = {
    surface: 'native' as const,
    bot: session.bot,
    session: session.id,
    revision: 1,
  };
  const scope = { bot: session.bot, model: session.model, modelRevision: 1 };
  expect(nativeMediaCurrent(request, { ...session, owner: 'human', revision: 2 }, scope)).toBe(
    true,
  );
  expect(nativeMediaCurrent(request, session, { ...scope, modelRevision: 2 })).toBe(false);
  expect(nativeMediaCurrent(request, session, { ...scope, model: 'synthetic-new-model' })).toBe(
    false,
  );
  expect(nativeMediaCurrent(request, undefined, scope)).toBe(false);
});

it('keeps native desktop consent separate from pairing and binds it to device, Bot and model', async () => {
  const review = vi.fn(async () => true);
  let current: LocalComputerSession | undefined;
  const consent = new RemoteConsent(() => current, review);
  await consent.authorize(device, connect);
  current = { ...session };
  consent.granted(device.id, current);
  await consent.authorize(device, { type: 'local.preview', session: session.id, revision: 1 });
  expect(review).toHaveBeenCalledOnce();
  await consent.authorize(
    { ...device, id: 'b'.repeat(64) },
    { type: 'local.preview', session: session.id, revision: 1 },
  );
  expect(review).toHaveBeenCalledTimes(2);
  current = { ...session, modelRevision: 2 };
  await consent.authorize(device, { type: 'local.preview', session: session.id, revision: 1 });
  expect(review).toHaveBeenCalledTimes(3);
});

it('requires fresh local approval after an emergency pause and identifies the grant owner on revocation', async () => {
  const review = vi.fn(async () => true);
  const consent = new RemoteConsent(() => session, review);
  await consent.authorize(device, connect);
  consent.granted(device.id, session);
  consent.pause();
  review.mockResolvedValue(false);
  await expect(
    consent.authorize(device, { type: 'local.resume', session: session.id, revision: 1 }),
  ).rejects.toThrow('REMOTE_NATIVE_REFUSED');
  expect(consent.revoke('b'.repeat(64))).toBe(false);
  expect(consent.revoke(device.id)).toBe(true);
});
