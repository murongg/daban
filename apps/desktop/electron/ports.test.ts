import net from 'node:net';
import { expect, it } from 'vitest';
import { availablePort } from './ports';

it('keeps a free preferred port and selects another without contacting an occupied listener', async () => {
  const first = await availablePort();
  expect(await availablePort(first)).toBe(first);
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<unknown>((resolve, reject) => {
    server.once('error', reject);
    server.listen(first, '127.0.0.1', () => resolve(undefined));
  });
  try {
    const next = await availablePort(first);
    expect(next).not.toBe(first);
    expect(next).toBeGreaterThanOrEqual(1024);
    expect(connections).toBe(0);
    expect(server.listening).toBe(true);
  } finally {
    await new Promise<unknown>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
  }
});
