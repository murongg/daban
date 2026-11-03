import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { secureDirectory } from '@daban/engine/local-computer';
import type { VmConnection } from '@daban/protocol';
import { expect, type TestContext, test } from 'vitest';
import { openExecutorTunnel } from './ssh.js';

class SyntheticSsh extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = 0;
  kill() {
    this.killed++;
    this.exitCode = 0;
    this.emit('close', 0);
    return true;
  }
}

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-ssh-link-'));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const directory = await secureDirectory(path.join(temporary, 'private 电脑'));
  const identityFile = path.join(directory, 'id_ed25519');
  await writeFile(identityFile, 'SYNTHETIC PRIVATE KEY', { mode: 0o600 });
  const connection: VmConnection = {
    provider: 'qemu',
    enabled: true,
    vmId: '11111111-2222-4333-8444-555555555555',
    host: '127.0.0.1',
    sshPort: 22,
    user: 'mock-bot',
    identityFile,
    hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
  return { directory, connection };
}

test('SSH pins the selected host key, binds forwarding to loopback, filters the environment and closes only its own child', async (t) => {
  const f = await fixture(t),
    child = new SyntheticSsh();
  const cancellation = new AbortController();
  let parserFailure: unknown;
  const pending = openExecutorTunnel(f.connection, f.directory, 23456, true, cancellation.signal, {
    spawn: (program, args, options) => {
      expect.assert(args.includes('127.0.0.1'));
      expect.assert(args.includes('StrictHostKeyChecking=yes'));
      expect.assert(args.includes('ForwardAgent=no'));
      expect.assert(args.includes('IdentityAgent=none'));
      expect.assert(args.includes('127.0.0.1:23456:127.0.0.1:8766'));
      expect(options.env?.SSH_AUTH_SOCK).toBe(undefined);
      expect(options.env?.DEEPSEEK_API_KEY).toBe(undefined);
      const file = args.find((value) => value.startsWith('UserKnownHostsFile='))!;
      const known = JSON.parse(file.slice(file.indexOf('=') + 1)) as string;
      Promise.all([
        readFile(known, 'utf8'),
        promisify(execFile)(program, ['-G', ...args], {
          env: options.env,
          windowsHide: true,
          timeout: 5000,
        }),
      ])
        .then(([text, parsed]) => {
          expect.assert(text.endsWith(f.connection.hostKey + '\n'));
          expect(parsed.stdout).toMatch(/^stricthostkeychecking true$/m);
          expect(parsed.stdout).toMatch(/^forwardagent no$/m);
          expect(parsed.stdout).toMatch(/^identityagent none$/m);
          child.stdout.write(`DABAN_EXECUTOR:${'a'.repeat(64)}\n`);
        })
        .catch((error: unknown) => {
          parserFailure = error;
          child.emit('error', error);
        });
      return child;
    },
  });
  f.connection.host = '-oProxyCommand=mock';
  const tunnel = await pending.catch((error: unknown) => {
    throw parserFailure ?? error;
  });
  expect(tunnel.connection.origin).toBe('http://127.0.0.1:23456');
  expect(tunnel.connection.token).toBe('a'.repeat(64));
  expect(tunnel.alive).toBe(true);
  await tunnel.close();
  expect(tunnel.alive).toBe(false);
  expect(child.killed).toBe(1);
});

test('SSH rejects untrusted handshakes, host-key failures and cancellation without publishing credentials', async (t) => {
  const f = await fixture(t);
  for (const kind of ['invalid', 'host-key', 'abort']) {
    const child = new SyntheticSsh(),
      cancellation = new AbortController();
    const pending = openExecutorTunnel(
      f.connection,
      f.directory,
      23457,
      false,
      cancellation.signal,
      {
        spawn: (_program, args) => {
          expect.assert(!args.at(-1)?.includes('systemctl start'));
          queueMicrotask(() => {
            if (kind === 'invalid') child.stdout.write('SYNTHETIC UNEXPECTED OUTPUT\n');
            if (kind === 'host-key') {
              child.stderr.write('Host key verification failed.');
              child.exitCode = 255;
              child.emit('close', 255);
            }
            if (kind === 'abort') cancellation.abort();
          });
          return child;
        },
      },
    );
    await expect(pending).rejects.toThrow(
      new RegExp(
        kind === 'host-key'
          ? 'EXECUTOR_SSH_HOST_KEY'
          : kind === 'abort'
            ? 'EXECUTOR_LINK_CLOSED'
            : 'EXECUTOR_AUTH_UNAVAILABLE',
      ),
    );
    expect.assert(child.killed <= 1);
  }
});
