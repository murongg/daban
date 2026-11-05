import { disconnected, isRemoteSnapshot, remoteReplyFor } from '@daban/protocol';
import { expect, it } from 'vitest';
import { remoteAppSnapshot } from './apps';

it('keeps native App capability local without weakening the canonical closed remote snapshot', () => {
  const local = {
    ...disconnected('ready'),
    appConnections: { catalog: true, oauthLoopback: true },
  };
  const wire = remoteAppSnapshot(local);
  expect(isRemoteSnapshot(wire)).toBe(true);
  expect(remoteReplyFor('status', wire, {}, 2)).toEqual(disconnected('ready'));
  expect(local.appConnections.oauthLoopback).toBe(true);
  expect(() =>
    remoteReplyFor('status', remoteAppSnapshot({ ...local, privateField: 'synthetic' }), {}, 2),
  ).toThrow('REMOTE_INVALID_SNAPSHOT');
});
