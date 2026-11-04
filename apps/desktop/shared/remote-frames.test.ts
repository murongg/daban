import { describe, expect, it } from 'vitest';
import { RemoteFrames, remoteFrames } from './remote-frames';

describe('bounded remote transfer framing', () => {
  it('reassembles split UTF-8 without truncating multibyte characters', () => {
    const text = JSON.stringify({ synthetic: '合成'.repeat(50000) });
    const receiver = new RemoteFrames();
    let result: string | undefined;
    const frames = [...remoteFrames(text)];
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) result = receiver.push(frame);
    expect(result).toBe(text);
  });
  it('rejects an out-of-order frame and releases the transfer reservation', () => {
    let reserved = 0;
    const receiver = new RemoteFrames((bytes) => {
      reserved += bytes;
      return () => {
        reserved -= bytes;
      };
    });
    const frames = [...remoteFrames('x'.repeat(100000))];
    receiver.push(frames[0]);
    expect(reserved).toBe(100000);
    expect(() => receiver.push(frames[0])).toThrow();
    expect(reserved).toBe(0);
    expect(receiver.push([...remoteFrames('synthetic')][0])).toBe('synthetic');
  });
  it('rejects an oversized declared length before reserving memory', () => {
    let reserved = false;
    const receiver = new RemoteFrames(() => {
      reserved = true;
      return () => {};
    });
    const frame = [...remoteFrames('synthetic')][0];
    new DataView(frame.buffer).setUint32(4, 0x7fffffff);
    expect(() => receiver.push(frame)).toThrow();
    expect(reserved).toBe(false);
  });
});
