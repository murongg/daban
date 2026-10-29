import { expect, it } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const token = 'synthetic-native-token';
const raw = {
  clientProtocol: 18,
  mode: 'desktop',
  sharedLogin: false,
  bots: {
    a: { owner: 'human', epoch: 4, instance: 'mock-native-a' },
    b: { owner: 'agent', epoch: 0, instance: 'mock-native-b' },
  },
  model: { available: true, bots: {} },
};

it('validates captured native instance metadata and keeps legacy commands compatible', () => {
  const inputs = [
    { type: 'control', bot: 'a', epoch: 4, owner: 'agent', instance: 'mock-native-a' },
    {
      type: 'input',
      bot: 'a',
      epoch: 4,
      input: { type: 'text', text: 'SYNTHETIC-47' },
      instance: 'mock-native-a',
    },
    { type: 'app', bot: 'a', epoch: 4, app: 'terminal', instance: 'mock-native-a' },
    { type: 'frame', bot: 'a', surface: 'desktop', epoch: 4, instance: 'mock-native-a' },
  ];
  for (const input of inputs) {
    expect(parseCommand(input)).toEqual(input);
    expect(() => parseCommand({ ...input, instance: '../synthetic' })).toThrow('INVALID_COMMAND');
    expect(() => parseCommand({ ...input, extra: true })).toThrow('INVALID_COMMAND');
  }
  expect(() => parseCommand({ ...inputs[3], epoch: undefined })).toThrow('INVALID_COMMAND');
  expect(() => parseCommand({ ...inputs[3], instance: undefined })).toThrow('INVALID_COMMAND');
  expect(parseCommand({ type: 'frame', bot: 'a', surface: 'desktop' })).toEqual({
    type: 'frame',
    bot: 'a',
    surface: 'desktop',
  });
});

it('preserves distinct version18 computer instances and fails closed on missing or contradictory identities', async () => {
  let state: unknown = raw;
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url) => {
      if (url.endsWith('/'))
        return new Response(`<meta name="prototype-token" content="${token}">`);
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          configured: true,
          revision: 0,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
        });
      return Response.json(state);
    },
  });
  expect((await client.status()).bots.a).toHaveProperty('instance', 'mock-native-a');
  for (const instance of [undefined, '', '../invalid', 'mock-native-b']) {
    state = { ...raw, bots: { ...raw.bots, a: { ...raw.bots.a, instance } } };
    expect((await client.status()).phase).toBe('offline');
  }
  state = {
    ...raw,
    clientProtocol: 17,
    bots: { a: { owner: 'agent', epoch: 0 }, b: { owner: 'agent', epoch: 0 } },
  };
  expect((await client.status()).phase).toBe('ready');
});

it('forwards the captured native instance and epoch without repairing or retrying stale work', async () => {
  const posted: { route: string; body?: Record<string, unknown>; search: string }[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      const route = new URL(url);
      if (route.pathname === '/')
        return new Response(`<meta name="prototype-token" content="${token}">`);
      if (route.pathname === '/api/state') return Response.json(raw);
      if (route.pathname === '/api/model/settings')
        return Response.json({
          configured: true,
          revision: 0,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
        });
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      posted.push({ route: route.pathname, body, search: route.search });
      if (body?.instance === 'mock-retired')
        return Response.json({ error: 'DESKTOP_VIEW_STALE' }, { status: 409 });
      if (route.pathname.endsWith('/frame'))
        return new Response('SYNTHETIC-JPEG', { headers: { 'content-type': 'image/jpeg' } });
      return Response.json({ ok: true });
    },
  });
  await client.invoke(
    parseCommand({
      type: 'frame',
      bot: 'a',
      surface: 'desktop',
      epoch: 4,
      instance: 'mock-native-a',
    }),
  );
  const query = new URLSearchParams(posted[0].search);
  expect(query.get('instance')).toBe('mock-native-a');
  expect(query.get('epoch')).toBe('4');
  await client.releaseInputs();
  expect(posted.at(-1)?.body).toEqual({
    epoch: 4,
    input: { type: 'release' },
    instance: 'mock-native-a',
  });
  const before = posted.length;
  await expect(
    client.invoke(
      parseCommand({
        type: 'input',
        bot: 'a',
        epoch: 4,
        instance: 'mock-retired',
        input: { type: 'text', text: 'NEVER-TYPE' },
      }),
    ),
  ).rejects.toThrow('DESKTOP_VIEW_STALE');
  expect(posted.length).toBe(before + 1);
  expect(posted.at(-1)?.body?.instance).toBe('mock-retired');
});
