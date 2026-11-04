import { remoteFileChunk } from '@daban/protocol';

export const remoteTransferLimit = 144 * 1024 * 1024;
const magic = 0x44414231;
const header = 16;
export function* remoteFrames(text: string, chunk = remoteFileChunk) {
  const bytes = new TextEncoder().encode(text);
  if (
    !bytes.length ||
    bytes.length > remoteTransferLimit ||
    chunk < 1024 ||
    chunk > remoteFileChunk
  )
    throw Error('REMOTE_TRANSFER_LIMIT');
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const length = Math.min(chunk, bytes.length - offset);
    const frame = new Uint8Array(header + length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, magic);
    view.setUint32(4, bytes.length);
    view.setUint32(8, offset);
    view.setUint32(12, length);
    frame.set(bytes.subarray(offset, offset + length), header);
    yield frame;
  }
}

export class RemoteFrames {
  private buffer?: Uint8Array;
  private offset = 0;
  private release?: () => unknown;
  constructor(private readonly reserve: (size: number) => () => unknown = () => () => {}) {}
  push(value: ArrayBuffer | Uint8Array): string | undefined {
    try {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (bytes.byteLength < header || bytes.byteLength > header + remoteFileChunk)
        throw Error('REMOTE_INVALID_FRAME');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const total = view.getUint32(4),
        offset = view.getUint32(8),
        length = view.getUint32(12);
      if (
        view.getUint32(0) !== magic ||
        total < 1 ||
        total > remoteTransferLimit ||
        length !== bytes.length - header ||
        length < 1 ||
        offset !== this.offset ||
        offset + length > total
      )
        throw Error('REMOTE_INVALID_FRAME');
      if (!this.buffer) {
        this.release = this.reserve(total);
        this.buffer = new Uint8Array(total);
      }
      if (this.buffer.byteLength !== total) throw Error('REMOTE_INVALID_FRAME');
      this.buffer.set(bytes.subarray(header), offset);
      this.offset += length;
      if (this.offset !== total) return undefined;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer);
      this.close();
      return text;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    this.buffer = undefined;
    this.offset = 0;
    this.release?.();
    this.release = undefined;
  }
}
