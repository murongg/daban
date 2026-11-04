import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Agent, request } from 'node:http';
import { managedProtocol } from '@daban/protocol';

const [input]: unknown[] = await once(process, 'message');
assert.ok(input && typeof input === 'object');
assert.ok('socketPath' in input && typeof input.socketPath === 'string');
assert.ok('token' in input && typeof input.token === 'string');
assert.ok('path' in input && typeof input.path === 'string');
assert.ok('body' in input);
const { socketPath, token, path: route, body } = input;
const agent = new Agent({ keepAlive: true });
try {
  const response = await new Promise<{ status: number; value: unknown }>((resolve, reject) => {
    const send = request(
      {
        socketPath,
        path: route,
        method: 'POST',
        agent,
        headers: {
          host: '127.0.0.1:8766',
          'x-prototype-token': token,
          'x-daban-client-protocol': String(managedProtocol),
          'content-type': 'application/json',
        },
      },
      (reply) => {
        const chunks: Buffer[] = [];
        reply.on('data', (chunk: Buffer) => chunks.push(chunk));
        reply.once('error', reject);
        reply.once('end', () => {
          try {
            resolve({
              status: reply.statusCode ?? 0,
              value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    send.once('error', reject);
    send.end(JSON.stringify(body));
  });
  assert.ok(process.send);
  process.send(response);
  const [action] = await once(process, 'message');
  assert.equal(action, 'close');
} finally {
  agent.destroy();
  process.disconnect?.();
}
