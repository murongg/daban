import { expect, it, vi } from 'vitest';
import type { PeerEvent } from '../../shared/peer';
import { PeerRuntime } from './peer';

function fixture() {
  const events: PeerEvent[] = [];
  const peer = {
    remoteDescription: null as RTCSessionDescriptionInit | null,
    localDescription: null as RTCSessionDescriptionInit | null,
    signalingState: 'stable',
    ondatachannel: null as ((event: { channel: RTCDataChannel }) => unknown) | null,
    setRemoteDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
      peer.remoteDescription = description;
    }),
    createAnswer: vi.fn(async () => ({ type: 'answer' as const, sdp: 'synthetic-answer' })),
    setLocalDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
      peer.localDescription = description;
    }),
    addIceCandidate: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const runtime = new PeerRuntime(
    (event) => events.push(event),
    () => peer as unknown as RTCPeerConnection,
  );
  return { runtime, peer, events };
}

it('keeps cancellation and state delivery responsive while a file transfer is backpressured', async () => {
  const f = fixture();
  await f.runtime.command({
    id: 'synthetic-open',
    type: 'open',
    session: 'synthetic-session',
    initiator: false,
    ice: [],
  });
  const handlers = new Map<string, () => unknown>();
  function channel(label: string, bufferedAmount = 0) {
    const value = {
      label,
      readyState: 'open',
      bufferedAmount,
      bufferedAmountLowThreshold: 0,
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: (name: string, listener: () => unknown) => handlers.set(name, listener),
      removeEventListener: (name: string) => handlers.delete(name),
    };
    f.peer.ondatachannel?.({ channel: value as unknown as RTCDataChannel });
    return value;
  }
  const files = channel('files', 300 * 1024);
  const rpc = channel('rpc');
  const events = channel('events');
  const transfer = f.runtime.command({
    id: 'synthetic-file',
    type: 'send',
    session: 'synthetic-session',
    data: 'S'.repeat(100000),
  });
  try {
    const cancel = f.runtime.command({
      id: 'synthetic-cancel',
      type: 'send',
      session: 'synthetic-session',
      data: '{"type":"request","method":"task.stop"}',
    });
    expect(
      await Promise.race([
        cancel.then(() => 'sent'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 20)),
      ]),
    ).toBe('sent');
    await f.runtime.command({
      id: 'synthetic-state',
      type: 'send',
      session: 'synthetic-session',
      data: '{"type":"snapshot"}',
      channel: 'events',
    });
    expect(rpc.send).toHaveBeenCalledOnce();
    expect(events.send).toHaveBeenCalledWith('{"type":"snapshot"}');
  } finally {
    files.bufferedAmount = 0;
    handlers.get('bufferedamountlow')?.();
    await transfer;
    f.runtime.close();
  }
});

it('buffers early ICE candidates until the authenticated session description is installed', async () => {
  const f = fixture();
  await f.runtime.command({
    id: 'synthetic-open',
    type: 'open',
    session: 'synthetic-session',
    initiator: false,
    ice: [],
  });
  await f.runtime.command({
    id: 'synthetic-ice',
    type: 'signal',
    session: 'synthetic-session',
    payload: { type: 'candidate', candidate: 'synthetic-candidate', mid: '0', line: 0 },
  });
  expect(f.peer.addIceCandidate).not.toHaveBeenCalled();
  await f.runtime.command({
    id: 'synthetic-offer',
    type: 'signal',
    session: 'synthetic-session',
    payload: { type: 'offer', sdp: 'synthetic-offer' },
  });
  expect(f.peer.addIceCandidate).toHaveBeenCalledOnce();
  expect(f.events).toContainEqual({
    type: 'signal',
    session: 'synthetic-session',
    payload: { type: 'answer', sdp: 'synthetic-answer' },
  });
  f.runtime.close();
});

it('does not replace a live connection or send commands to a nonexistent session', async () => {
  const f = fixture();
  await f.runtime.command({
    id: 'synthetic-open',
    type: 'open',
    session: 'synthetic-session',
    initiator: false,
    ice: [],
  });
  await expect(
    f.runtime.command({
      id: 'synthetic-duplicate',
      type: 'open',
      session: 'synthetic-session',
      initiator: false,
      ice: [],
    }),
  ).rejects.toThrow('REMOTE_DUPLICATE_SESSION');
  await expect(
    f.runtime.command({
      id: 'synthetic-send',
      type: 'send',
      session: 'missing-session',
      data: 'synthetic',
    }),
  ).rejects.toThrow('REMOTE_SESSION_CLOSED');
  expect(f.peer.close).not.toHaveBeenCalled();
  f.runtime.close();
  expect(f.peer.close).toHaveBeenCalledOnce();
});
