import type { Executor } from '@daban/engine/agent';
import { type ExecutionSnapshot, executionCapabilities } from '@daban/protocol';
import { expect, test } from 'vitest';
import { ExecutionConnection } from './connection.js';

const initial: ExecutionSnapshot = {
  role: 'executor',
  version: 1,
  boot: 'mock-boot',
  nonce: 'mock-nonce',
  capabilities: [...executionCapabilities],
  computer: {
    mode: 'agent',
    sharedLogin: false,
    viewport: { width: 1280, height: 800 },
    environment: { platform: 'linux', arch: 'arm64', kernel: 'mock', node: 'v24', browser: '' },
    events: [],
    bots: {},
  },
  status: { available: true, limit: 2, revision: 0, items: [] },
};
function peer(
  snapshot: ExecutionSnapshot,
  call: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
): Executor {
  return {
    ready: Promise.resolve(snapshot),
    snapshot,
    refresh: async () => snapshot,
    call: async <T>(method: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      (await call(method, params, signal)) as T,
  };
}
test('a guest restart rebuilds only the connection and never replays an uncertain mutation', async () => {
  let links = 0,
    effects = 0;
  const next = { ...initial, nonce: 'mock-next' };
  const connection = new ExecutionConnection(
    {
      ensure: async () => ({ origin: 'http://127.0.0.1:12345', token: 'mock-token' }),
      close: async () => {},
    },
    {
      create: () =>
        ++links === 1
          ? peer(initial, async () => {
              effects++;
              throw Object.assign(new Error('EXECUTION_GUEST_RESTARTED'), {
                code: 'EXECUTION_GUEST_RESTARTED',
              });
            })
          : peer(next, async () => ({ ok: true })),
    },
  );
  await connection.ready;
  await expect(connection.call('tools.invoke', { runId: 'mock-run' })).rejects.toThrowError(
    /EXECUTION_GUEST_RESTARTED/,
  );
  expect(effects).toBe(1);
  expect(links).toBe(2);
  expect((await connection.refresh()).nonce).toBe('mock-next');
  await connection.close();
});
test('close during connection setup cannot publish or dispatch late guest work', async () => {
  let finish: (value: { origin: string; token: string }) => unknown = () => undefined,
    dispatch = 0;
  const wait = new Promise<{ origin: string; token: string }>((resolve) => {
    finish = resolve;
  });
  const connection = new ExecutionConnection(
    { ensure: () => wait, close: async () => {} },
    {
      create: () =>
        peer(initial, async () => {
          dispatch++;
          return {};
        }),
    },
  );
  const ready = connection.ready.catch((error) => error);
  await connection.close();
  finish({ origin: 'http://127.0.0.1:12345', token: 'mock-token' });
  expect(String(await ready)).toMatch(/EXECUTION_CONNECTION_CLOSED/);
  expect(dispatch).toBe(0);
});

test('automatic rebind refreshes the execution token through attach-only reconnect without replaying a mutation', async () => {
  let ensures = 0,
    reconnects = 0,
    effects = 0;
  const tokens: string[] = [];
  const connection = new ExecutionConnection(
    {
      ensure: async () => {
        ensures++;
        return { origin: 'http://127.0.0.1:12345', token: 'mock-old' };
      },
      reconnect: async () => {
        reconnects++;
        return { origin: 'http://127.0.0.1:12346', token: 'mock-new' };
      },
      close: async () => {},
    },
    {
      create: (value) => {
        tokens.push(value.token);
        return peer({ ...initial, nonce: value.token }, async () => {
          effects++;
          throw Object.assign(new Error('EXECUTION_UNAUTHORIZED'), {
            code: 'EXECUTION_UNAUTHORIZED',
          });
        });
      },
    },
  );
  try {
    await connection.ready;
    await expect(connection.call('tools.invoke', {})).rejects.toThrowError(
      /EXECUTION_UNAUTHORIZED/,
    );
    expect(effects).toBe(1);
    expect(ensures).toBe(1);
    expect(reconnects).toBe(1);
    expect(tokens).toStrictEqual(['mock-old', 'mock-new']);
  } finally {
    await connection.close();
  }
});

test('an explicit power connection waits for an older connection attempt and still wins', async () => {
  let release: (value: { origin: string; token: string }) => unknown = () => {};
  const pending = new Promise<{ origin: string; token: string }>((done) => {
    release = done;
  });
  const tokens: string[] = [];
  const connection = new ExecutionConnection(
    { ensure: () => pending, close: async () => {} },
    {
      create: (value) => {
        tokens.push(value.token);
        return peer({ ...initial, nonce: value.token }, async () => ({}));
      },
    },
  );
  try {
    const explicit = connection.rebind({
      origin: 'http://127.0.0.1:12346',
      token: 'mock-power-new',
    });
    release({ origin: 'http://127.0.0.1:12345', token: 'mock-old' });
    await connection.ready;
    expect((await explicit).nonce).toBe('mock-power-new');
    expect(tokens).toStrictEqual(['mock-old', 'mock-power-new']);
    expect(connection.snapshot?.nonce).toBe('mock-power-new');
  } finally {
    release({ origin: 'http://127.0.0.1:12345', token: 'mock-old' });
    await connection.close();
  }
});

test('attach-only startup serves validated cached metadata offline and never starts a stopped VM', async () => {
  let ensures = 0,
    reconnects = 0,
    calls = 0;
  const connection = new ExecutionConnection(
    {
      ensure: async () => {
        ensures++;
        throw new Error('MUST_NOT_START');
      },
      reconnect: async () => {
        reconnects++;
        throw new Error('EXECUTOR_OFFLINE');
      },
      close: async () => {},
    },
    {
      attachOnly: true,
      initialSnapshot: initial,
      create: () =>
        peer({ ...initial, nonce: 'mock-started' }, async () => {
          calls++;
          return { accepted: true };
        }),
    },
  );
  try {
    expect(await connection.ready).toStrictEqual(initial);
    expect(connection.connected).toBe(false);
    expect(ensures).toBe(0);
    expect(reconnects).toBe(0);
    await expect(connection.call('tools.invoke', {})).rejects.toThrowError(/EXECUTION_UNAVAILABLE/);
    await expect(connection.refresh()).rejects.toThrowError(/EXECUTOR_OFFLINE/);
    expect(ensures).toBe(0);
    await connection.rebind({ origin: 'http://127.0.0.1:12345', token: 'mock-explicit-start' });
    expect(connection.connected).toBe(true);
    expect(await connection.call('tools.invoke', {})).toStrictEqual({ accepted: true });
    expect(calls).toBe(1);
  } finally {
    await connection.close();
  }
});

test('a late refresh cannot return or persist metadata from the peer replaced by explicit power rebind', async () => {
  let release: (value: ExecutionSnapshot) => unknown = () => {};
  const pending = new Promise<ExecutionSnapshot>((done) => {
    release = done;
  });
  const connection = new ExecutionConnection(
    {
      ensure: async () => ({ origin: 'http://127.0.0.1:12345', token: 'mock-old' }),
      close: async () => {},
    },
    {
      create: (value) => ({
        ...peer({ ...initial, nonce: value.token }, async () => ({})),
        refresh:
          value.token === 'mock-old'
            ? () => pending
            : async () => ({ ...initial, nonce: value.token }),
      }),
    },
  );
  try {
    await connection.ready;
    const reading = connection.refresh();
    await Promise.resolve();
    await connection.rebind({ origin: 'http://127.0.0.1:12346', token: 'mock-new' });
    release(initial);
    expect((await reading).nonce).toBe('mock-new');
    expect(connection.snapshot?.nonce).toBe('mock-new');
  } finally {
    release(initial);
    await connection.close();
  }
});

test('a late refresh cannot advertise cached metadata as live after the replacement connection fails', async () => {
  let release: (value: ExecutionSnapshot) => unknown = () => {};
  const pending = new Promise<ExecutionSnapshot>((done) => {
    release = done;
  });
  const connection = new ExecutionConnection(
    {
      ensure: async () => ({ origin: 'http://127.0.0.1:12345', token: 'mock-old' }),
      close: async () => {},
    },
    {
      create: (value) =>
        value.token === 'mock-old'
          ? { ...peer(initial, async () => ({})), refresh: () => pending }
          : {
              ...peer(initial, async () => ({})),
              ready: Promise.reject(new Error('EXECUTION_UNAVAILABLE')),
            },
    },
  );
  try {
    await connection.ready;
    const reading = connection.refresh();
    await Promise.resolve();
    await expect(
      connection.rebind({ origin: 'http://127.0.0.1:12346', token: 'mock-failed' }),
    ).rejects.toThrowError(/EXECUTION_UNAVAILABLE/);
    release(initial);
    await expect(reading).rejects.toThrowError(/EXECUTION_UNAVAILABLE/);
    expect(connection.connected).toBe(false);
  } finally {
    release(initial);
    await connection.close();
  }
});
