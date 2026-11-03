import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { publicAddress } from './network.js';
import { apply, createFetcher, fallbackLookup } from './web.js';

test('mixed public answers and known proxy IPv6 can be re-resolved, but private answers cannot', async () => {
  const fake = { address: '2001:2::9', family: 6 };
  let calls = 0;
  const query = async () => {
    calls++;
    return Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] });
  };
  const mixed = [{ address: '8.8.8.8', family: 4 }, fake];
  expect(
    await Reflect.apply(fallbackLookup, undefined, [
      'mock-public.example.test',
      new AbortController().signal,
      async () => mixed,
      query,
      publicAddress,
    ]),
  ).toStrictEqual([{ address: '1.1.1.1', family: 4 }]);
  const privateMixed = [{ address: '192.168.1.9', family: 4 }, fake];
  expect(
    await Reflect.apply(fallbackLookup, undefined, [
      'mock-private.example.test',
      new AbortController().signal,
      async () => privateMixed,
      query,
      publicAddress,
    ]),
  ).toStrictEqual(privateMixed);
  expect(calls).toBe(1);
});

test('host web plugin registers its HTTP provider and retains private-address protection', async () => {
  let provider: ReturnType<typeof createFetcher> | undefined;
  const limits = {
    maxResponseBytes: 1000,
    maxBodyChars: 1000,
    timeoutMs: 1000,
    maxRedirects: 1,
    sdkFile: createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client'),
  };
  await apply(
    {
      web: {
        registerFetchProvider: (value) => {
          provider = value as typeof provider;
        },
      },
    },
    limits,
  );
  expect.assert(provider);
  expect(provider.id).toBe('http');
  expect(provider.available()).toBe(true);
  await expect(provider.fetch({ url: 'http://127.0.0.1/' })).rejects.toMatchObject({
    code: 'WEB_BLOCKED_URL',
  });
});

test('fake-IP DNS uses the fixed TLS resolver and returns its actual addresses for pinning', async () => {
  const requests: string[] = [];
  const result = await fallbackLookup(
    'mock.example.test',
    new AbortController().signal,
    async () => [{ address: '198.18.0.9', family: 4 }],
    async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] }));
    },
  );
  expect(result).toStrictEqual([{ address: '1.1.1.1', family: 4 }]);
  expect(requests).toStrictEqual(['https://223.5.5.5/resolve?name=mock.example.test&type=A']);
});
test('ordinary and private DNS answers are left to the native public-address policy with no fallback', async () => {
  for (const address of ['1.1.1.1', '127.0.0.1', '192.168.1.1']) {
    const result = await fallbackLookup(
      'mock.example.test',
      new AbortController().signal,
      async () => [{ address, family: 4 }],
      async () => {
        throw new Error('fallback must not run');
      },
    );
    expect(result).toStrictEqual([{ address, family: 4 }]);
  }
});
test('dual-stack proxy fake IPs are resolved again without treating private IPv6 as proxy DNS', async () => {
  const fake = [
    { address: '198.19.1.8', family: 4 },
    { address: '2001:0002:0000:0002::8', family: 6 },
  ];
  const request = async () =>
    new Response(
      JSON.stringify({
        Status: 0,
        Answer: [{ type: 1, data: '1.1.1.1' }],
      }),
    );
  expect(
    await fallbackLookup(
      'mock.example.test',
      new AbortController().signal,
      async () => fake,
      request,
    ),
  ).toStrictEqual([{ address: '1.1.1.1', family: 4 }]);
  for (const address of ['::1', 'fd00::8', 'fe80::8', '2001:db8::8']) {
    const mixed = [fake[0], { address, family: 6 }];
    expect(
      await fallbackLookup(
        'mock.example.test',
        new AbortController().signal,
        async () => mixed,
        async () => {
          throw new Error('private DNS must not use the fallback');
        },
      ),
    ).toStrictEqual(mixed);
  }
});
test('fallback DNS rejects bad status, malformed addresses, oversized responses and cancellation', async () => {
  const lookup = async () => [{ address: '198.19.0.8', family: 4 }];
  for (const response of [
    new Response(JSON.stringify({ Status: 3 })),
    new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: 'not-an-ip' }] })),
    new Response('x'.repeat(17000)),
    new Response('{}', { status: 503 }),
  ])
    await expect(
      fallbackLookup(
        'mock.example.test',
        new AbortController().signal,
        lookup,
        async () => response,
      ),
    ).rejects.toThrowError();
  const abort = new AbortController();
  abort.abort();
  await expect(
    fallbackLookup('mock.example.test', abort.signal, lookup, async () => {
      throw new Error('should not fetch');
    }),
  ).rejects.toThrowError();
});

test('fallback fetch keeps the native transport, refuses private resolver answers and pins only the original host', async () => {
  const blocked = Object.assign(new Error('mock fake IP'), { code: 'WEB_BLOCKED_URL' });
  const limits = {
    maxResponseBytes: 1000,
    maxBodyChars: 1000,
    timeoutMs: 1000,
    maxRedirects: 1,
    userAgent: 'mock',
  };
  class Provider {
    id = 'http';
    constructor(
      _limits: typeof limits,
      readonly resolve?: (
        host: string,
        signal: AbortSignal,
      ) => Promise<{ address: string; family: number }[]>,
    ) {}
    available() {
      return true;
    }
    async fetch(input: { url: string }, signal = new AbortController().signal) {
      if (!this.resolve) throw blocked;
      return this.resolve(new URL(input.url).hostname, signal);
    }
  }
  const publicIp = (value: string) => value === '1.1.1.1';
  const resolver = async () => [{ address: '198.18.0.8', family: 4 }];
  const create = (address: string) =>
    createFetcher(
      Provider,
      limits,
      publicIp,
      resolver,
      async () => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: address }] })),
    );
  expect(await create('1.1.1.1').fetch({ url: 'https://mock.example.test/' })).toStrictEqual([
    { address: '1.1.1.1', family: 4 },
  ]);
  await expect(
    create('127.0.0.1').fetch({ url: 'https://mock.example.test/' }),
  ).rejects.toMatchObject({
    code: 'WEB_BLOCKED_URL',
  });
  await expect(create('1.1.1.1').fetch({ url: 'http://127.0.0.1/' })).rejects.toMatchObject({
    code: 'WEB_BLOCKED_URL',
  });
});
test('cancellation stops waiting for a non-cancellable OS DNS lookup', async () => {
  const abort = new AbortController();
  const pending = fallbackLookup(
    'mock.example.test',
    abort.signal,
    async () => new Promise(() => {}),
  );
  abort.abort();
  const observed = await Promise.race([
    pending.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.name : 'unknown'),
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 15)),
  ]);
  expect(observed).toBe('AbortError');
});
