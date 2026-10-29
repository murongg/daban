import {
  isRecoveryReceipt,
  isRecoveryRequest,
  isRecoveryReview,
  isRecoveryStatus,
  type RecoveryReview,
  recoveryBlocked,
} from '@daban/protocol';
import { expect, it } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const review: RecoveryReview = {
  boot: 'mock-boot-one',
  instance: 'mock-runtime-one',
  revision: 0,
  computersRevision: 0,
  digest: 'a'.repeat(64),
  screens: [],
  running: [],
  changing: false,
};
it('treats either owned-host uncertainty or a pending guest intent as a global effect fence', () => {
  expect(recoveryBlocked({})).toBe(false);
  expect(
    recoveryBlocked({
      recovery: {
        available: true,
        revision: 1,
        operation: { id: 'mock-global', revision: 1, phase: 'prepared', review },
      },
    }),
  ).toBe(true);
  expect(
    recoveryBlocked({ reboot: { available: false, error: 'RECOVERY_HOST_STORE_UNAVAILABLE' } }),
  ).toBe(true);
  expect(
    recoveryBlocked({ reboot: { available: true, revision: 0, busy: false, vm: 'unknown' } }),
  ).toBe(false);
});
it('exposes human recovery intent and read-only inspection but never a bare backend claim or arbitrary VM command', () => {
  const request = {
    id: 'mock-ui-recovery',
    revision: 0,
    review: review.digest,
    confirmation: 'restart-all-apps',
  };
  expect(parseCommand({ type: 'recovery.restart', request })).toEqual({
    type: 'recovery.restart',
    request,
  });
  for (const type of ['recovery.status', 'recovery.review'])
    expect(parseCommand({ type })).toEqual({ type });
  for (const type of ['recovery.inspect', 'recovery.cancel', 'recovery.start'])
    expect(parseCommand({ type, id: 'mock-owned' })).toEqual({ type, id: 'mock-owned' });
  for (const value of [
    { type: 'recovery.claim', id: 'mock-owned' },
    { type: 'recovery.restart', request: { ...request, confirmation: undefined } },
    { type: 'recovery.start', id: 'mock-owned', vm: 'another-vm' },
    { type: 'recovery.inspect', id: '../private' },
    { type: 'recovery.status', path: '/mock/private' },
  ])
    expect(() => parseCommand(value)).toThrow('INVALID_COMMAND');
});
it('closes reviewed whole-runtime recovery to exact resources, ownership and explicit human intent', () => {
  expect(isRecoveryReview(review)).toBe(true);
  const request = {
    id: 'mock-recovery',
    revision: 0,
    review: review.digest,
    confirmation: 'restart-all-apps',
  };
  expect(isRecoveryRequest(request)).toBe(true);
  for (const bad of [
    { ...request, confirmation: undefined },
    { ...request, force: true },
    { ...request, program: 'synthetic' },
    { ...request, revision: -1 },
  ])
    expect(isRecoveryRequest(bad)).toBe(false);
  for (const bad of [
    { ...review, screens: new Array(1) },
    { ...review, running: ['mock-a', 'mock-a'] },
    { ...review, credentials: 'SYNTHETIC-PRIVATE' },
    { ...review, digest: 'invalid' },
    { ...review, changing: 'true' },
  ])
    expect(isRecoveryReview(bad)).toBe(false);
  const receipt = { id: request.id, revision: 1, phase: 'prepared', review };
  expect(isRecoveryStatus({ available: true, revision: 1, operation: receipt })).toBe(true);
  expect(isRecoveryStatus({ available: true, revision: 0, operation: receipt })).toBe(false);
  expect(isRecoveryStatus({ available: false, error: 'SYNTHETIC-PRIVATE' })).toBe(false);
  expect(isRecoveryReceipt(receipt)).toBe(true);
  expect(isRecoveryReceipt({ ...receipt, phase: 'complete' })).toBe(false);
  expect(
    isRecoveryReceipt({
      ...receipt,
      phase: 'complete',
      revision: 3,
      boot: 'mock-boot-two',
      instance: 'mock-runtime-two',
    }),
  ).toBe(true);
  expect(
    isRecoveryReceipt({
      ...receipt,
      phase: 'complete',
      revision: 3,
      boot: review.boot,
      instance: 'mock-runtime-two',
    }),
  ).toBe(false);
});

it('retains strict24 recovery metadata and binds internal recovery transport to its exact reviewed operation', async () => {
  let recovery: unknown = { available: true, revision: 0 };
  let result: unknown = review;
  const routes: { path: string; body: unknown }[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      const route = new URL(url).pathname;
      if (route === '/')
        return new Response('<meta name="prototype-token" content="mock-recovery-token">');
      if (route === '/api/model/settings')
        return Response.json({
          configured: true,
          revision: 0,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
        });
      if (route === '/api/state')
        return Response.json({
          clientProtocol: 24,
          mode: 'agent',
          sharedLogin: false,
          bots: {},
          computers: { available: true, revision: 0, limit: 2, items: [] },
          skills: { available: true, revision: 0 },
          mcp: { available: true, revision: 0 },
          profiles: [],
          model: { available: true, bots: {} },
          recovery,
        });
      routes.push({ path: route, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json(result);
    },
  });
  expect((await client.status()).recovery).toEqual(recovery);
  recovery = { available: true, revision: 0, private: 'SYNTHETIC-PRIVATE' };
  expect((await client.status()).phase).toBe('offline');
  recovery = { available: true, revision: 0 };
  expect(await client.recoveryReview()).toEqual(review);
  const request = {
    id: 'mock-transport',
    revision: 0,
    review: review.digest,
    confirmation: 'restart-all-apps' as const,
  };
  result = { id: request.id, revision: 1, phase: 'prepared', review };
  expect(await client.prepareRecovery(request)).toEqual(result);
  result = { id: 'mock-foreign', revision: 1, phase: 'prepared', review };
  await expect(client.prepareRecovery(request)).rejects.toThrow('INVALID_RUNTIME_STATE');
  expect(routes.map((row) => row.path)).toEqual([
    '/api/recovery/review',
    '/api/recovery/prepare',
    '/api/recovery/prepare',
  ]);
});
