import { remoteMessageLimit } from '@daban/protocol';
import type { PeerBridge, PeerCommand, PeerDescription, PeerEvent } from '../../shared/peer';
import { RemoteFrames, remoteFrames, remoteTransferLimit } from '../../shared/remote-frames';

interface Connection {
  pc: RTCPeerConnection;
  channels: Map<string, RTCDataChannel>;
  incoming: RemoteFrames;
  candidates: RTCIceCandidateInit[];
  makingOffer: boolean;
  polite: boolean;
  ignored: boolean;
  media: boolean;
  sending: Promise<unknown>;
  capture?: MediaStream;
}
const streams = new Map<string, MediaStream>();
export function peerStream(session: string) {
  return streams.get(session);
}

export class PeerRuntime {
  private readonly peers = new Map<string, Connection>();
  private reserved = 0;
  constructor(
    private readonly emit: (event: PeerEvent) => unknown,
    private readonly create: (configuration: RTCConfiguration) => RTCPeerConnection = (
      configuration,
    ) => new RTCPeerConnection(configuration),
  ) {}
  async command(command: PeerCommand) {
    const id = command.session;
    if (command.type === 'open') {
      if (this.peers.has(id)) throw Error('REMOTE_DUPLICATE_SESSION');
      if (this.peers.size >= 16) throw Error('REMOTE_SESSION_LIMIT');
      const pc = this.create({ iceServers: command.ice, bundlePolicy: 'max-bundle' });
      const connection: Connection = {
        pc,
        channels: new Map(),
        candidates: [],
        makingOffer: false,
        polite: !command.initiator,
        ignored: false,
        media: command.media === true,
        sending: Promise.resolve(),
        incoming: new RemoteFrames((bytes) => {
          if (this.reserved + bytes > remoteTransferLimit) throw Error('REMOTE_TRANSFER_LIMIT');
          this.reserved += bytes;
          return () => {
            this.reserved -= bytes;
          };
        }),
      };
      this.peers.set(id, connection);
      pc.onicecandidate = (event) => {
        if (event.candidate)
          this.emit({
            type: 'signal',
            session: id,
            payload: {
              type: 'candidate',
              candidate: event.candidate.candidate,
              mid: event.candidate.sdpMid,
              line: event.candidate.sdpMLineIndex,
            },
          });
      };
      pc.ondatachannel = (event) => this.channel(id, connection, event.channel);
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (connection.media && state === 'connected') {
          this.transport(pc)
            .then((transport) =>
              this.emit({ type: 'state', session: id, state: 'connected', transport }),
            )
            .catch(() => this.emit({ type: 'state', session: id, state: 'connected' }));
          return;
        }
        if (state === 'closed') {
          this.emit({ type: 'state', session: id, state: 'closed' });
          return;
        }
        if (!['failed', 'disconnected'].includes(state)) return;
        const failed = () =>
          this.emit({
            type: 'state',
            session: id,
            state: 'failed',
            error: state === 'disconnected' ? 'REMOTE_ICE_DISCONNECTED' : 'REMOTE_ICE_FAILED',
          });
        pc.getStats()
          .then((stats) => {
            const rows: Record<string, unknown>[] = [];
            stats.forEach((item) => {
              if (
                ['candidate-pair', 'local-candidate', 'remote-candidate', 'transport'].includes(
                  item.type,
                )
              )
                rows.push({
                  type: item.type,
                  state: item.state,
                  protocol: item.protocol,
                  candidateType: item.candidateType,
                  nominated: item.nominated,
                  requestsSent: item.requestsSent,
                  responsesReceived: item.responsesReceived,
                  dtlsState: item.dtlsState,
                });
            });
            console.info(
              'DABAN_RTC_DIAGNOSTIC',
              JSON.stringify({ state, ice: pc.iceConnectionState, rows }),
            );
            failed();
          })
          .catch(failed);
      };
      pc.ontrack = (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        streams.set(id, stream);
        window.dispatchEvent(
          new CustomEvent('daban:remote-track', { detail: { session: id, stream } }),
        );
        this.emit({ type: 'track', session: id });
      };
      pc.onnegotiationneeded = () => {
        this.offer(id, connection).catch(() =>
          this.emit({ type: 'state', session: id, state: 'failed', error: 'REMOTE_OFFER_FAILED' }),
        );
      };
      if (command.initiator) {
        if (connection.media) pc.addTransceiver('video', { direction: 'recvonly' });
        else
          for (const label of ['rpc', 'events', 'files'])
            this.channel(id, connection, pc.createDataChannel(label, { ordered: true }));
        await this.offer(id, connection);
      }
      return;
    }
    if (command.type === 'close') {
      this.remove(id);
      return;
    }
    const connection = this.peers.get(id);
    if (!connection) throw Error('REMOTE_SESSION_CLOSED');
    if (command.type === 'signal') return this.signal(id, connection, command.payload);
    if (command.type === 'capture') {
      if (connection.capture) return;
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1280 } },
      });
      if (this.peers.get(id) !== connection) {
        for (const track of stream.getTracks()) track.stop();
        throw Error('REMOTE_SESSION_CLOSED');
      }
      connection.capture = stream;
      for (const track of stream.getVideoTracks()) {
        track.contentHint = 'detail';
        connection.pc.addTrack(track, stream);
        track.onended = () => this.emit({ type: 'state', session: id, state: 'closed' });
      }
      return;
    }
    // Bulk messages stay contiguous, while stop/takeover requests use an independent channel.
    if (new TextEncoder().encode(command.data).byteLength <= 48 * 1024)
      return this.send(connection, command.data, command.channel);
    const next = connection.sending.then(() => this.send(connection, command.data));
    connection.sending = next.catch(() => {});
    await next;
  }
  private async offer(id: string, connection: Connection) {
    if (connection.makingOffer || connection.pc.signalingState !== 'stable') return;
    connection.makingOffer = true;
    try {
      const offer = await connection.pc.createOffer();
      await connection.pc.setLocalDescription(offer);
      this.emit({ type: 'signal', session: id, payload: { type: 'offer', sdp: offer.sdp ?? '' } });
    } finally {
      connection.makingOffer = false;
    }
  }
  private async signal(id: string, connection: Connection, payload: PeerDescription) {
    const pc = connection.pc;
    if (payload.type === 'candidate') {
      const candidate = {
        candidate: payload.candidate,
        sdpMid: payload.mid,
        sdpMLineIndex: payload.line,
      };
      if (!pc.remoteDescription) {
        connection.candidates.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        if (!connection.ignored) throw error;
      }
      return;
    }
    const collision =
      payload.type === 'offer' && (connection.makingOffer || pc.signalingState !== 'stable');
    connection.ignored = collision && !connection.polite;
    if (connection.ignored) return;
    await pc.setRemoteDescription(payload);
    for (const candidate of connection.candidates.splice(0)) await pc.addIceCandidate(candidate);
    if (payload.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.emit({
        type: 'signal',
        session: id,
        payload: { type: 'answer', sdp: answer.sdp ?? '' },
      });
    }
  }
  private channel(id: string, connection: Connection, channel: RTCDataChannel) {
    if (connection.media) {
      channel.close();
      this.emit({
        type: 'state',
        session: id,
        state: 'failed',
        error: 'REMOTE_MEDIA_CHANNEL_FORBIDDEN',
      });
      return;
    }
    if (
      !['rpc', 'events', 'files'].includes(channel.label) ||
      connection.channels.has(channel.label)
    ) {
      channel.close();
      this.emit({ type: 'state', session: id, state: 'failed', error: 'REMOTE_CHANNEL_DUPLICATE' });
      return;
    }
    connection.channels.set(channel.label, channel);
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 128 * 1024;
    channel.onopen = () => {
      if (
        connection.channels.size === 3 &&
        [...connection.channels.values()].every((item) => item.readyState === 'open')
      ) {
        this.transport(connection.pc)
          .then((transport) =>
            this.emit({ type: 'state', session: id, state: 'connected', transport }),
          )
          .catch(() =>
            this.emit({ type: 'state', session: id, state: 'connected', transport: 'direct' }),
          );
      }
    };
    channel.onclose = () => this.emit({ type: 'state', session: id, state: 'closed' });
    channel.onmessage = (event) => {
      try {
        if (channel.label === 'files' && event.data instanceof ArrayBuffer) {
          const result = connection.incoming.push(event.data);
          if (result !== undefined) this.emit({ type: 'message', session: id, data: result });
        } else if (
          channel.label !== 'files' &&
          typeof event.data === 'string' &&
          new TextEncoder().encode(event.data).byteLength <= remoteMessageLimit
        ) {
          this.emit({ type: 'message', session: id, data: event.data });
        } else throw Error('REMOTE_INVALID_FRAME');
      } catch {
        this.emit({ type: 'state', session: id, state: 'failed', error: 'REMOTE_INVALID_FRAME' });
      }
    };
  }
  private async send(connection: Connection, data: string, label: 'rpc' | 'events' = 'rpc') {
    if (new TextEncoder().encode(data).byteLength <= 48 * 1024) {
      const channel = connection.channels.get(label);
      if (channel?.readyState !== 'open') throw Error('REMOTE_SESSION_CLOSED');
      await this.drain(channel);
      channel.send(data);
      return;
    }
    const channel = connection.channels.get('files');
    if (channel?.readyState !== 'open') throw Error('REMOTE_SESSION_CLOSED');
    const chunk = Math.min(48 * 1024, (connection.pc.sctp?.maxMessageSize ?? 64 * 1024) - 16);
    for (const frame of remoteFrames(data, chunk)) {
      await this.drain(channel);
      channel.send(frame.buffer as ArrayBuffer);
    }
  }
  private async drain(channel: RTCDataChannel) {
    if (channel.bufferedAmount < 256 * 1024) return;
    await new Promise<undefined>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        channel.removeEventListener('bufferedamountlow', ready);
        channel.removeEventListener('close', closed);
        error ? reject(error) : resolve(undefined);
      };
      const ready = () => finish();
      const closed = () => finish(Error('REMOTE_SESSION_CLOSED'));
      const timer = setTimeout(() => finish(Error('REMOTE_BACKPRESSURE')), 15_000);
      channel.addEventListener('bufferedamountlow', ready, { once: true });
      channel.addEventListener('close', closed, { once: true });
      if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) ready();
    });
  }
  private async transport(pc: RTCPeerConnection): Promise<'direct' | 'relay'> {
    const stats = await pc.getStats();
    let selected: RTCStats | undefined;
    stats.forEach((item) => {
      if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated)
        selected = item;
    });
    if (selected) {
      const pair = selected as RTCStats & { localCandidateId?: string; remoteCandidateId?: string };
      for (const key of [pair.localCandidateId, pair.remoteCandidateId])
        if (key && stats.get(key)?.candidateType === 'relay') return 'relay';
    }
    return 'direct';
  }
  private remove(id: string) {
    const connection = this.peers.get(id);
    if (!connection) return;
    this.peers.delete(id);
    connection.incoming.close();
    for (const track of connection.capture?.getTracks() ?? []) track.stop();
    connection.pc.onconnectionstatechange = null;
    for (const channel of connection.channels.values()) channel.onclose = null;
    connection.pc.close();
    streams.delete(id);
    window.dispatchEvent(new CustomEvent('daban:remote-track', { detail: id }));
  }
  close() {
    for (const id of [...this.peers.keys()]) this.remove(id);
  }
}

export function installPeer(bridge: PeerBridge) {
  const runtime = new PeerRuntime((event) => bridge.emit(event));
  bridge.subscribe((command) => {
    runtime.command(command).then(
      () => bridge.emit({ type: 'result', id: command.id, ok: true }),
      (error: unknown) =>
        bridge.emit({
          type: 'result',
          id: command.id,
          ok: false,
          error:
            error instanceof Error && /^[A-Z_]+$/.test(error.message)
              ? error.message
              : error instanceof Error && /^[A-Za-z]+Error$/.test(error.name)
                ? `REMOTE_PEER_${error.name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`
                : 'REMOTE_PEER_FAILED',
        }),
    );
  });
  window.addEventListener('unload', () => runtime.close(), { once: true });
}
