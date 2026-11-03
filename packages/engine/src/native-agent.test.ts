import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { startNativeAgent } from './host-server.js';
import { privateClientOptions } from './private-channel.js';

test('native-only agent starts without a Linux executor or VM and reports its real capability boundary', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-native-agent-'));
  const root = path.join(temporary, 'private');
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\daban-agent-${createHash('sha256').update(root).digest('hex').slice(0, 24)}`
      : path.join(root, 'a.sock');
  const agent = await startNativeAgent({
    dataRoot: root,
    nativeWorkspace: path.join(root, 'workspace'),
    socketPath,
    sdkFile: fileURLToPath(import.meta.url),
    scope: createHash('sha256').update(root).digest('hex'),
  });
  try {
    const token = (await readFile(path.join(root, 'model/control-token'), 'utf8')).trim();
    const tls = await privateClientOptions(path.join(root, 'model/control-certificate.pem'));
    const raw = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const send = process.platform === 'win32' ? httpsRequest : httpRequest;
      const call = send(
        {
          ...tls,
          socketPath,
          path: '/api/state',
          headers: { host: '127.0.0.1:8766', 'x-prototype-token': token },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      call.on('error', reject);
      call.end();
    });
    expect(raw.agent).toStrictEqual({
      location: 'host',
      execution: 'local-workspace',
      privilege: 'workspace',
      approvals: 'host',
    });
    expect(
      (raw.knowledge as { documentParsing?: boolean }).documentParsing,
      'document parser support must be reported separately from a working knowledge store',
    ).toBe(process.platform === 'linux');
  } finally {
    await agent.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
