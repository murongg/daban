import {
  disconnected,
  isPeerEvent,
  isRemoteCommand,
  isRemoteIdentity,
  isRemoteMediaRequest,
  isRemoteRpcRequest,
  isRemoteSignal,
  isRemoteSnapshot,
  parseRemoteInvitation,
  remoteInvitation,
} from '@daban/protocol';
import { describe, expect, it } from 'vitest';

const identity = {
  id: 'a'.repeat(64),
  publicKey: 'A'.repeat(59),
  name: 'Synthetic workstation',
};

describe('remote wire boundary', () => {
  it('binds media to an explicit native session or Linux desktop instance', () => {
    const view = {
      type: 'view',
      host: identity.id,
      request: {
        surface: 'native',
        bot: 'synthetic-bot',
        session: 'synthetic-native',
        revision: 1,
      },
    };
    expect(isRemoteCommand(view)).toBe(true);
    expect(
      isRemoteSignal({
        type: 'signal',
        to: identity.id,
        session: 'synthetic-session',
        payload: view,
      }),
    ).toBe(false);
    expect(
      isRemoteMediaRequest({
        surface: 'native',
        bot: 'synthetic-bot',
        session: 'synthetic-native',
        revision: 1,
      }),
    ).toBe(true);
    expect(
      isRemoteMediaRequest({
        surface: 'desktop',
        bot: 'synthetic-bot',
        instance: 'synthetic-instance',
        epoch: 2,
      }),
    ).toBe(true);
    expect(
      isRemoteMediaRequest({
        surface: 'native',
        bot: 'synthetic-bot',
        session: 'synthetic-native',
        revision: 1,
        source: 'other-screen',
      }),
    ).toBe(false);
    expect(
      isRemoteMediaRequest({
        surface: 'desktop',
        bot: 'synthetic-bot',
        instance: '../other',
        epoch: 2,
      }),
    ).toBe(false);
  });
  it('rejects malformed snapshots and leases before they enter a remote workspace', () => {
    const snapshot = disconnected('ready');
    expect(isRemoteSnapshot(snapshot)).toBe(true);
    expect(isRemoteSnapshot({ ...snapshot, profiles: [null] })).toBe(false);
    expect(
      isRemoteSnapshot({ ...snapshot, model: { ...snapshot.model, apiKey: 'synthetic-secret' } }),
    ).toBe(false);
    expect(isRemoteSnapshot({ ...snapshot, viewport: { width: -1, height: 800 } })).toBe(false);
    expect(
      isRemoteSnapshot({
        ...snapshot,
        bots: { 'synthetic-bot': { owner: 'human', epoch: -1, task: {} } },
      }),
    ).toBe(false);
  });
  it('validates browser peer events before the main process signs or dispatches them', () => {
    expect(
      isPeerEvent({
        type: 'signal',
        session: 'synthetic-session',
        payload: { type: 'offer', sdp: 'v=0' },
      }),
    ).toBe(true);
    expect(
      isPeerEvent({ type: 'signal', session: '../other', payload: { type: 'offer', sdp: 'v=0' } }),
    ).toBe(false);
    expect(
      isPeerEvent({
        type: 'message',
        session: 'synthetic-session',
        data: 'synthetic',
        url: 'http://127.0.0.1/private',
      }),
    ).toBe(false);
    expect(
      isPeerEvent({ type: 'result', id: 'synthetic-id', ok: true, privateKey: 'synthetic' }),
    ).toBe(false);
  });
  it('does not accept private fields or an unbounded device identity', () => {
    expect(isRemoteIdentity(identity)).toBe(true);
    expect(isRemoteIdentity({ ...identity, privateKey: 'synthetic-private' })).toBe(false);
    expect(isRemoteIdentity({ ...identity, name: 'x'.repeat(161) })).toBe(false);
    expect(isRemoteIdentity({ ...identity, id: '../other-device' })).toBe(false);
  });

  it('roundtrips an invitation without depending on the relay to supply the host key', () => {
    const invitation = {
      version: 1 as const,
      host: identity,
      server: 'https://connect.example.test',
      code: 'synthetic-pairing-secret-0123456789',
      expiresAt: 1_900_000_300_000,
    };
    expect(parseRemoteInvitation(remoteInvitation(invitation), 1_900_000_000_000)).toEqual(
      invitation,
    );
    expect(() =>
      parseRemoteInvitation(remoteInvitation(invitation), invitation.expiresAt),
    ).toThrow();
  });

  it('requires encrypted signaling except for explicit loopback development', () => {
    const invitation = {
      version: 1 as const,
      host: identity,
      server: 'http://connect.example.test',
      code: 'synthetic-pairing-secret-0123456789',
      expiresAt: 1_900_000_300_000,
    };
    expect(() => remoteInvitation(invitation)).toThrow();
    expect(() =>
      remoteInvitation({ ...invitation, server: 'http://127.0.0.1:12345' }),
    ).not.toThrow();
    expect(() =>
      remoteInvitation({ ...invitation, server: 'https://user:secret@example.test' }),
    ).toThrow();
  });

  it('only routes known bounded signaling messages to a specific peer and session', () => {
    const signal = {
      type: 'signal',
      to: identity.id,
      session: 'synthetic-session',
      payload: { type: 'offer', sdp: 'v=0\r\n', signature: 'A'.repeat(86) },
    };
    expect(isRemoteSignal(signal)).toBe(true);
    expect(isRemoteSignal({ ...signal, url: 'http://127.0.0.1/private' })).toBe(false);
    expect(isRemoteSignal({ ...signal, payload: { type: 'execute', command: 'synthetic' } })).toBe(
      false,
    );
    expect(isRemoteSignal({ ...signal, payload: { type: 'offer', sdp: 'x'.repeat(131073) } })).toBe(
      false,
    );
  });

  it('keeps request ownership explicit and rejects remote administrative and local effects', () => {
    const request = {
      type: 'request',
      id: 'synthetic-request',
      host: identity.id,
      workspace: 'synthetic-workspace',
      method: 'status',
      params: {},
    };
    expect(isRemoteRpcRequest(request)).toBe(true);
    for (const method of [
      'clipboard.write',
      'link.open',
      'agent.upgrade',
      'setup.start',
      'vm.set',
      '/agent/update',
    ]) {
      expect(isRemoteRpcRequest({ ...request, method })).toBe(false);
    }
    expect(isRemoteRpcRequest({ ...request, host: '' })).toBe(false);
    expect(isRemoteRpcRequest({ ...request, params: [], signature: 'unexpected' })).toBe(false);
    expect(
      isRemoteRpcRequest({
        ...request,
        method: 'task.start',
        params: { bot: '../other', task: { prompt: 'synthetic' } },
      }),
    ).toBe(false);
    expect(
      isRemoteRpcRequest({ ...request, params: { type: 'agent.upgrade', confirmed: true } }),
    ).toBe(false);
  });

  it('requires a signed session description before exposing a peer connection', () => {
    const signal = {
      type: 'signal',
      to: identity.id,
      session: 'synthetic-session',
      payload: { type: 'offer', sdp: 'v=0\r\n' },
    };
    expect(isRemoteSignal(signal)).toBe(false);
    expect(
      isRemoteSignal({ ...signal, payload: { ...signal.payload, signature: 'A'.repeat(86) } }),
    ).toBe(true);
  });
});
