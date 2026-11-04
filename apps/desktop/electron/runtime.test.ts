import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { disconnected } from '@daban/protocol';
import { describe, expect, it, vi } from 'vitest';
import { parseCommand, trustedSender } from './ipc';
import { RuntimeClient } from './runtime';

it('validates the approval mode and refuses it before sending to a runtime without policy support', async () => {
  const task = {
    requestId: 'mock-approval-task',
    prompt: 'Synthetic task',
    approvalMode: 'full' as const,
  };
  expect(parseCommand({ type: 'task.start', bot: 'a', task })).toMatchObject({ task });
  expect(() =>
    parseCommand({ type: 'task.start', bot: 'a', task: { ...task, approvalMode: 'invalid' } }),
  ).toThrow('INVALID_COMMAND');
  const fetcher = vi.fn(async () => Response.json({}));
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  vi.spyOn(client, 'status').mockResolvedValue({ ...disconnected('ready'), protocolVersion: 43 });
  await expect(client.invoke({ type: 'task.start', bot: 'a', task })).rejects.toThrow(
    'RUNTIME_TOO_OLD',
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it('validates a continuation turn as a bounded reference to an existing retry', () => {
  const task = {
    requestId: 'mock-request',
    prompt: 'SYNTHETIC REQUEST',
    retryOf: 'mock-run',
    retryTurn: 'mock-turn',
  };
  expect(parseCommand({ type: 'task.start', bot: 'a', task })).toEqual({
    type: 'task.start',
    bot: 'a',
    task,
  });
  for (const invalid of [
    { ...task, retryOf: undefined },
    { ...task, retryTurn: '../foreign' },
  ]) {
    expect(() => parseCommand({ type: 'task.start', bot: 'a', task: invalid })).toThrow(
      'INVALID_COMMAND',
    );
  }
});

it('refuses a durable turn continuation before sending it to an older runtime', async () => {
  const fetcher = vi.fn(async () => Response.json({}));
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  vi.spyOn(client, 'status').mockResolvedValue({ ...disconnected('ready'), protocolVersion: 42 });
  await expect(
    client.invoke({
      type: 'task.start',
      bot: 'a',
      task: {
        requestId: 'mock-request',
        prompt: 'SYNTHETIC REQUEST',
        retryOf: 'mock-run',
        retryTurn: 'mock-turn',
      },
    }),
  ).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(fetcher).not.toHaveBeenCalled();
});

it('accepts only bounded model inspection commands and verifies matching public replies', async () => {
  const input = {
    kind: 'test',
    revision: 0,
    connection: { id: 'mock-provider', baseURL: 'https://models.example.test/v1' },
    apiKey: 'synthetic-key',
    model: 'mock-alpha',
  };
  expect(parseCommand({ type: 'model.inspect', input })).toEqual({ type: 'model.inspect', input });
  for (const invalid of [
    { ...input, kind: 'shell' },
    { ...input, model: '../bad' },
    { ...input, extra: true },
  ])
    expect(() => parseCommand({ type: 'model.inspect', input: invalid })).toThrow(
      'INVALID_COMMAND',
    );
  const settings = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    configured: true,
    revision: 0,
  };
  const valid = {
    kind: 'test',
    model: 'mock-alpha',
    revision: 0,
    latencyMs: 12,
    checkedAt: '2026-01-01T00:00:00.000Z',
  };
  let reply: unknown = valid;
  let supported = true;
  const posts: string[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url, init) => {
      if (url.endsWith('/api/model/settings')) return Response.json(settings);
      if (url.endsWith('/api/model/inspect')) {
        posts.push(String(init?.body));
        return Response.json(reply);
      }
      return Response.json({
        ...raw,
        clientProtocol: 13,
        model: { ...raw.model, ...settings, inspection: supported },
      });
    },
  });
  const command = parseCommand({ type: 'model.inspect', input });
  expect(await client.invoke(command)).toEqual(valid);
  for (const invalid of [
    { ...valid, apiKey: 'synthetic-must-not-return' },
    { ...valid, model: 'mock-other' },
    { ...valid, revision: 1 },
    { ...valid, latencyMs: -1 },
  ]) {
    reply = invalid;
    await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  }
  const metadata = parseCommand({ type: 'model.inspect', input: { ...input, kind: 'metadata' } });
  reply = {
    kind: 'metadata',
    revision: 0,
    model: { id: 'mock-other', name: 'Mock Other', capabilities: { input: ['text'] } },
  };
  await expect(client.invoke(metadata)).rejects.toThrow('INVALID_RUNTIME_STATE');
  const count = posts.length;
  supported = false;
  await expect(client.invoke(command)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posts).toHaveLength(count);
});

it('projects the key-free model catalog from the same revision and preserves custom task model references', async () => {
  const connection = {
    id: 'mock-provider',
    name: '合成供应商',
    baseURL: 'https://model.example.test/v1',
    models: [
      { id: 'mock-chat', name: '合成模型', vision: true, contextWindow: 64000, maxTokens: 4096 },
    ],
  };
  const settings = {
    provider: 'mock-provider',
    model: 'provider:mock-provider:mock-chat',
    configured: true,
    revision: 3,
  };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url) =>
      Response.json(
        url.endsWith('/api/model/settings')
          ? settings
          : {
              ...raw,
              clientProtocol: 17,
              mode: 'agent',
              computerError: 'COMPUTER_START_FAILED',
              bots: {},
              sharedLogin: false,
              model: {
                ...raw.model,
                ...settings,
                connections: [connection],
                bots: {
                  a: { ...raw.model.bots.a, model: settings.model },
                },
              },
            },
      ),
  });
  const state = await client.status();
  expect(state.phase).toBe('ready');
  expect(state.model.connections).toEqual([connection]);
  expect(state.agents.a.model).toBe(settings.model);
});

it('requires protocol31 for GIF/WebP while preserving protocol26 PNG/JPEG support', async () => {
  const data = Buffer.from('synthetic raster source').toString('base64');
  const fetcher = vi.fn(async () => Response.json({}));
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const state = disconnected('ready');
  state.protocolVersion = 30;
  vi.spyOn(client, 'status').mockImplementation(async () => state);
  for (const name of ['mock.gif', 'mock.webp']) {
    const file = { name, data };
    const command = { type: 'attachment.upload' as const, bot: 'a', file };
    expect(parseCommand(command)).toEqual(command);
    await expect(client.invoke(command)).rejects.toThrow('ATTACHMENT_RUNTIME_TOO_OLD');
    expect(fetcher).not.toHaveBeenCalled();
    state.protocolVersion = 31;
    const sha256 = createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
    const receipt = {
      bot: 'a',
      name,
      size: Buffer.from(data, 'base64').length,
      sha256,
      id: createHash('sha256').update(`${name}\0${sha256}`).digest('hex'),
      content: 'synthetic image',
    };
    fetcher.mockResolvedValueOnce(Response.json(receipt));
    expect(await client.invoke(command)).toEqual(receipt);
    state.protocolVersion = 30;
    fetcher.mockClear();
  }
});

const token = 'synthetic-runtime-capability';
it('gates image uploads at protocol26 and keeps knowledge imports and binary identity checks strict', async () => {
  const file = {
    name: 'mock.png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  };
  const sha256 = createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex');
  const id = createHash('sha256').update(`${file.name}\0${sha256}`).digest('hex');
  let returned: unknown = {
    id,
    bot: 'a',
    name: file.name,
    size: Buffer.from(file.data, 'base64').length,
    sha256,
    content: 'image/png',
  };
  const fetcher = vi.fn(async () => Response.json(returned));
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 25;
  vi.spyOn(client, 'status').mockImplementation(async () => snapshot);
  const upload = { type: 'attachment.upload' as const, bot: 'a', file };
  expect(parseCommand(upload)).toEqual(upload);
  expect(() => parseCommand({ type: 'knowledge.import', bot: 'a', file })).toThrow(
    'INVALID_COMMAND',
  );
  await expect(client.invoke(upload)).rejects.toThrow('ATTACHMENT_RUNTIME_TOO_OLD');
  expect(fetcher).not.toHaveBeenCalled();
  snapshot.protocolVersion = 26;
  expect(await client.invoke(upload)).toEqual(returned);
  returned = { id, bot: 'a', file, sha256 };
  expect(await client.invoke({ type: 'attachment.source', bot: 'a', id })).toEqual(returned);
  returned = {
    id,
    bot: 'a',
    file: { ...file, data: Buffer.from('mock changed bytes').toString('base64') },
    sha256,
  };
  await expect(client.invoke({ type: 'attachment.source', bot: 'a', id })).rejects.toThrow(
    'INVALID_RUNTIME_STATE',
  );
});
it('keeps the Agent bridge ready without a computer only for explicit versioned unavailable state', async () => {
  let state: Record<string, unknown> = {
    ...raw,
    clientProtocol: 17,
    mode: 'agent',
    computerError: 'COMPUTER_START_FAILED',
    sharedLogin: false,
    bots: {},
    model: { ...raw.model, bots: { a: { ...raw.model.bots.a, result: 'SYNTHETIC-ANSWER-47' } } },
  };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url) => {
      if (url.endsWith('/'))
        return new Response(`<meta name="prototype-token" content="${token}">`);
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          configured: true,
          revision: 0,
        });
      return Response.json(state);
    },
  });
  const ready = await client.status();
  expect(ready.phase).toBe('ready');
  expect(ready.bots).toEqual({});
  expect(ready).toMatchObject({
    computerError: 'COMPUTER_START_FAILED',
    model: { configured: true },
  });
  expect(ready.agents.a).toMatchObject({ result: 'SYNTHETIC-ANSWER-47' });
  const valid = state;
  for (const wrong of [
    { ...valid, clientProtocol: 16 },
    { ...valid, clientProtocol: '17' },
    { ...valid, clientProtocol: 17.5 },
    { ...valid, computerError: undefined },
    { ...valid, computerError: 'untrusted detail /private/synthetic' },
    { ...valid, bots: raw.bots },
    { ...valid, sharedLogin: true },
    { ...valid, browsers: { a: {} } },
    { ...valid, mode: 'desktop' },
  ]) {
    state = wrong;
    expect((await client.status()).phase).toBe('offline');
  }
});

it('gates per-Bot model writes and validates the owner and actual model in task metadata and receipts', async () => {
  const input = {
    id: 'mock-model-bot',
    name: '合成模型 Bot',
    instructions: '',
    memory: '',
    color: 'mint' as const,
    model: 'deepseek-v4-pro' as const,
  };
  const profile = {
    ...input,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  let protocol = 13;
  let returned: unknown = profile;
  const posted: unknown[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response(`<meta name="prototype-token" content="${token}">`);
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          configured: true,
          revision: 0,
        });
      if (init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return Response.json(returned);
      }
      return Response.json({
        ...raw,
        clientProtocol: protocol,
        model: { ...raw.model, bots: { a: { ...raw.model.bots.a, model: 'deepseek-v4-pro' } } },
      });
    },
  });
  const create = parseCommand({ type: 'bot.register', profile: input });
  await expect(client.invoke(create)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posted).toHaveLength(0);
  protocol = 14;
  expect((await client.status()).agents.a.model).toBe('deepseek-v4-pro');
  expect(await client.invoke(create)).toEqual(profile);
  returned = { ...profile, id: 'mock-wrong-owner' };
  await expect(client.invoke(create)).rejects.toThrow('INVALID_RUNTIME_STATE');
  const clear = parseCommand({
    type: 'bot.update',
    bot: input.id,
    revision: 1,
    patch: { model: null },
  });
  returned = profile;
  await expect(client.invoke(clear)).rejects.toThrow('INVALID_RUNTIME_STATE');
  const { model: _model, ...inherited } = profile;
  returned = { ...inherited, revision: 2 };
  expect(await client.invoke(clear)).toEqual(returned);
});
it('gates model settings commands, preserves the write identity and rejects secret-bearing or mismatched responses', async () => {
  const input = {
    model: 'deepseek-v4-pro' as const,
    apiKey: 'synthetic-native-config-key',
    revision: 0,
    requestId: 'mock-model-config',
  };
  const command = parseCommand({ type: 'model.configure', input });
  expect(command).toEqual({ type: 'model.configure', input });
  for (const wrong of [
    { ...input, apiKey: 'bad\ncredential' },
    { ...input, model: 'unknown' },
    { ...input, baseUrl: 'https://example.test' },
    { ...input, revision: -1 },
  ])
    expect(() => parseCommand({ type: 'model.configure', input: wrong })).toThrow(
      'INVALID_COMMAND',
    );
  let protocol = 12;
  const status = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    configured: true,
    revision: 1,
    requestId: input.requestId,
  };
  let result: unknown = status;
  const posts: { url: string; body: unknown }[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response(`<meta name="prototype-token" content="${token}">`);
      if (url.endsWith('/api/model/settings')) return Response.json(status);
      if (url.endsWith('/api/model/configure') || url.endsWith('/api/model/check')) {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        return Response.json(result);
      }
      return Response.json({ ...raw, clientProtocol: protocol });
    },
  });
  await expect(client.invoke(command)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posts).toHaveLength(0);
  protocol = 13;
  expect((await client.status()).model).toMatchObject({ model: 'deepseek-v4-pro', revision: 1 });
  expect(await client.invoke(command)).toEqual(status);
  expect(posts[0].body).toEqual(input);
  for (const invalid of [
    { ...status, apiKey: input.apiKey },
    { ...status, requestId: 'other-write' },
    { ...status, model: 'deepseek-flash' },
  ]) {
    result = invalid;
    await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  }
  result = { model: 'deepseek-v4-pro', revision: 1, checkedAt: '2026-01-01T00:00:00Z' };
  const check = parseCommand({ type: 'model.check', revision: 1 });
  expect(await client.invoke(check)).toEqual(result);
  result = { ...(result as object), revision: 2 };
  await expect(client.invoke(check)).rejects.toThrow('INVALID_RUNTIME_STATE');
});
it('gates retention commands and validates the reviewed subject, state and purge receipt', async () => {
  const sha256 = 'b'.repeat(64),
    name = 'mock.pdf',
    id = createHash('sha256').update(`${name}\0${sha256}`).digest('hex');
  const version = '00000000-0000-4000-8000-000000000001';
  const entry = { id, bot: 'a', name, size: 20, sha256, textSize: 7, version, deleted: false };
  let protocol = 11,
    returned: unknown = { items: [entry], originalBytes: 20, textBytes: 7 };
  const list = { type: 'attachment.list' as const, bot: 'a', query: {} };
  const purge = { type: 'attachment.purge' as const, bot: 'a', id, version, confirmation: name };
  expect(parseCommand(list)).toEqual(list);
  expect(parseCommand(purge)).toEqual(purge);
  for (const wrong of [
    { ...purge, version: 2 },
    { ...purge, authority: 'model' },
    { ...purge, confirmation: '../escape.pdf' },
    { ...list, query: { trash: 'yes' } },
  ])
    expect(() => parseCommand(wrong)).toThrow('INVALID_COMMAND');
  const posts: string[] = [];
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/')) return new Response(`<meta name="prototype-token" content="${token}">`);
    if (url.endsWith('/api/model/settings')) return Response.json({ configured: true });
    if (url.includes('/api/attachments/')) {
      posts.push(url);
      return Response.json(returned);
    }
    return Response.json({ ...raw, clientProtocol: protocol });
  });
  const client = new RuntimeClient({ origin: 'http://127.0.0.1:18766', fetcher });
  await expect(client.invoke(list)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posts).toHaveLength(0);
  protocol = 12;
  expect(await client.invoke(list)).toEqual(returned);
  returned = { items: [{ ...entry, bot: 'b' }], originalBytes: 20, textBytes: 7 };
  await expect(client.invoke(list)).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = { ...entry, deleted: true };
  expect(await client.invoke({ type: 'attachment.trash', bot: 'a', id, version })).toEqual(
    returned,
  );
  returned = { id, bot: 'a', version, purged: true, checkpointed: true };
  expect(await client.invoke(purge)).toEqual(returned);
  returned = {
    id,
    bot: 'a',
    version: '00000000-0000-4000-8000-000000000002',
    purged: true,
    checkpointed: true,
  };
  await expect(client.invoke(purge)).rejects.toThrow('INVALID_RUNTIME_STATE');
});
it('verifies binary workspace download paths and checksums before returning bytes to the renderer', async () => {
  const bytes = Buffer.from([0, 255, 128, 1]);
  const file = {
    path: 'mock/task/file.pdf',
    name: 'file.pdf',
    size: bytes.length,
    modified: '2026-01-01',
    data: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  let returned: unknown = file;
  const command = { type: 'files.download' as const, path: file.path };
  expect(parseCommand(command)).toEqual(command);
  expect(() => parseCommand({ ...command, path: '../private/key' })).toThrow('INVALID_COMMAND');
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/')) return new Response(`<meta name="prototype-token" content="${token}">`);
    if (url.endsWith('/api/model/settings')) return Response.json({ configured: true });
    if (url.endsWith('/api/files/download')) return Response.json(returned);
    return Response.json({ ...raw, clientProtocol: 11 });
  });
  const client = new RuntimeClient({ origin: 'http://127.0.0.1:18766', fetcher });
  expect(await client.invoke(command)).toEqual(file);
  for (const wrong of [
    { ...file, path: 'other/file.pdf' },
    { ...file, sha256: '0'.repeat(64) },
    { ...file, data: 'malformed!' },
    { ...file, size: 1 },
    { ...file, authority: '/private/key' },
  ]) {
    returned = wrong;
    await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  }
});
it('gates staged attachments and checks the exact owner, content identity and original download', async () => {
  const upload = { name: 'mock.pdf', data: Buffer.from('%PDF-1.7\nsynthetic').toString('base64') };
  const sha256 = createHash('sha256').update(Buffer.from(upload.data, 'base64')).digest('hex');
  const id = createHash('sha256').update(`${upload.name}\0${sha256}`).digest('hex');
  let protocol = 10;
  let returned: unknown = {
    id,
    bot: 'a',
    name: upload.name,
    size: Buffer.from(upload.data, 'base64').length,
    sha256,
    content: 'MOCK-47',
  };
  const command = { type: 'attachment.upload' as const, bot: 'a', file: upload };
  expect(parseCommand(command)).toEqual(command);
  const paths: string[] = [];
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/')) return new Response(`<meta name="prototype-token" content="${token}">`);
    if (url.endsWith('/api/model/settings')) return Response.json({ configured: true });
    if (url.includes('/api/attachments/')) {
      paths.push(new URL(url).pathname);
      return Response.json(returned);
    }
    return Response.json({ ...raw, clientProtocol: protocol });
  });
  const client = new RuntimeClient({ origin: 'http://127.0.0.1:18766', fetcher });
  await expect(client.invoke(command)).rejects.toThrow('RUNTIME_TOO_OLD');
  await expect(
    client.invoke({
      type: 'task.start',
      bot: 'a',
      task: {
        requestId: 'mock-old-file-reference',
        prompt: 'read',
        files: [{ name: upload.name, attachmentId: id }],
      },
    }),
  ).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(paths).toHaveLength(0);
  protocol = 11;
  expect(await client.invoke(command)).toEqual(returned);
  expect(await client.invoke({ type: 'attachment.read', bot: 'a', id })).toEqual(returned);
  returned = { ...(returned as object), id: 'b'.repeat(64) };
  await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = { id, bot: 'a', file: upload, sha256 };
  expect(await client.invoke({ type: 'attachment.source', bot: 'a', id })).toEqual(returned);
  returned = { id, bot: 'b', file: upload, sha256 };
  await expect(client.invoke({ type: 'attachment.source', bot: 'a', id })).rejects.toThrow(
    'INVALID_RUNTIME_STATE',
  );
});
it('accepts document attachment references but rejects forged file authorities and mixed payloads', () => {
  const file = { name: 'mock.pdf', attachmentId: 'a'.repeat(64) };
  const task = { requestId: 'mock-files', prompt: 'read the synthetic document', files: [file] };
  expect(parseCommand({ type: 'task.start', bot: 'a', task })).toEqual({
    type: 'task.start',
    bot: 'a',
    task,
  });
  for (const invalid of [
    { ...file, name: '../escape.pdf' },
    { ...file, attachmentId: 'not-an-immutable-reference' },
    { ...file, content: 'forged extraction' },
    { ...file, path: '/private/key' },
    { ...file, bot: 'b' },
    { ...file, name: `${'甲'.repeat(100)}.pdf` },
  ])
    expect(() =>
      parseCommand({ type: 'task.start', bot: 'a', task: { ...task, files: [invalid] } }),
    ).toThrow('INVALID_COMMAND');
});
it('accepts bounded document import commands and rejects paths, unknown fields and malformed data', () => {
  const command = {
    type: 'knowledge.import',
    bot: 'a',
    file: { name: 'synthetic.pdf', data: 'JVBERi0xLjcK' },
  };
  expect(parseCommand(command)).toEqual(command);
  for (const file of [
    { ...command.file, name: '../escape.pdf' },
    { ...command.file, name: 'legacy.doc' },
    { ...command.file, name: '.secret.pdf' },
    { ...command.file, data: 'not base64!' },
    { ...command.file, data: '' },
    { ...command.file, data: 'A'.repeat(7 * 1024 * 1024) },
    { ...command.file, path: '/private/key' },
  ])
    expect(() => parseCommand({ ...command, file })).toThrow('INVALID_COMMAND');
  expect(() => parseCommand({ ...command, actor: 'bot' })).toThrow('INVALID_COMMAND');
});
it('gates document imports and validates original ownership, checksum and the import source reply', async () => {
  let protocol = 9;
  const upload = {
    name: 'synthetic.pdf',
    data: Buffer.from('%PDF-1.7\nsynthetic').toString('base64'),
  };
  const sha256 = createHash('sha256').update(Buffer.from(upload.data, 'base64')).digest('hex');
  const doc = {
    id: 'mock-doc',
    bot: 'a',
    path: `${upload.name}.txt`,
    revision: 1,
    size: 4,
    content: 'mock',
    deleted: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    source: { name: upload.name, size: Buffer.from(upload.data, 'base64').length, sha256 },
  };
  let returned: unknown = doc;
  const posts: string[] = [];
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/')) return new Response(`<meta name="prototype-token" content="${token}">`);
    if (url.endsWith('/api/model/settings')) return Response.json({ configured: true });
    if (url.includes('/api/knowledge/')) {
      posts.push(new URL(url).pathname);
      return Response.json(returned);
    }
    return Response.json({ ...raw, clientProtocol: protocol, knowledge: { available: true } });
  });
  const client = new RuntimeClient({ origin: 'http://127.0.0.1:18766', fetcher });
  const command = { type: 'knowledge.import' as const, bot: 'a', file: upload };
  await expect(client.invoke(command)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posts).toHaveLength(0);
  protocol = 10;
  expect(await client.invoke(command)).toEqual(doc);
  returned = { ...doc, source: { ...doc.source, sha256: '0'.repeat(64) } };
  await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = { id: doc.id, bot: 'a', file: upload, sha256 };
  expect(await client.invoke({ type: 'knowledge.source', bot: 'a', id: doc.id })).toEqual(returned);
  for (const wrong of [
    { id: doc.id, bot: 'b', file: upload, sha256 },
    { id: 'wrong', bot: 'a', file: upload, sha256 },
    { id: doc.id, bot: 'a', file: upload, sha256: '0'.repeat(64) },
  ]) {
    returned = wrong;
    await expect(client.invoke({ type: 'knowledge.source', bot: 'a', id: doc.id })).rejects.toThrow(
      'INVALID_RUNTIME_STATE',
    );
  }
});
it('validates owned knowledge commands and routes documents without exposing a filesystem authority', async () => {
  const file = {
    id: 'mock-doc',
    bot: 'a',
    path: '合成规范.md',
    revision: 1,
    size: 6,
    deleted: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const input = { path: file.path, revision: 0, content: '合成' };
  const command = { type: 'knowledge.write' as const, bot: 'a', document: input };
  expect(parseCommand(command)).toEqual(command);
  expect(() => parseCommand({ ...command, document: { ...input, path: '../escape.md' } })).toThrow(
    'INVALID_COMMAND',
  );
  expect(() => parseCommand({ ...command, actor: 'bot' })).toThrow('INVALID_COMMAND');
  const posts: unknown[] = [];
  let returned = { ...file, content: '合成' };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/')) return new Response(`<meta name="prototype-token" content="${token}">`);
    if (url.endsWith('/api/model/settings')) return Response.json({ configured: true });
    if (url.endsWith('/api/knowledge/write')) {
      posts.push(JSON.parse(String(init?.body)));
      return Response.json(returned);
    }
    return Response.json({ ...raw, clientProtocol: 9, knowledge: { available: true } });
  });
  const client = new RuntimeClient({ origin: 'http://127.0.0.1:18766', fetcher });
  expect((await client.status()).knowledge?.available).toBe(true);
  expect(await client.invoke(command)).toMatchObject({ id: file.id, content: '合成' });
  expect(posts).toEqual([{ bot: 'a', document: input }]);
  returned = { ...returned, id: 'mock-wrong-doc' };
  await expect(
    client.invoke({
      type: 'knowledge.write',
      bot: 'a',
      document: { ...input, id: file.id, revision: 1 },
    }),
  ).rejects.toThrow('INVALID_RUNTIME_STATE');
});
it('validates schedule IPC and carries the real backend catalog and revision to the correct routes', async () => {
  const input = {
    id: 'mock-schedule',
    bot: 'mock-bot',
    title: '合成日程',
    prompt: '只处理合成数据',
    rule: { kind: 'daily' as const, time: '09:00', timeZone: 'Asia/Shanghai' },
  };
  const record = {
    ...input,
    revision: 1,
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    history: [],
  };
  expect(parseCommand({ type: 'schedule.create', input })).toEqual({
    type: 'schedule.create',
    input,
  });
  expect(() =>
    parseCommand({ type: 'schedule.create', input: { ...input, bot: '../escape' } }),
  ).toThrow('INVALID_COMMAND');
  expect(() =>
    parseCommand({ type: 'schedule.update', id: input.id, revision: 0, patch: { enabled: false } }),
  ).toThrow('INVALID_COMMAND');
  const posts: { path: string; data: unknown }[] = [];
  let returned: unknown = record;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/')) return new Response(`<meta name="prototype-token" content="${token}">`);
    if (url.endsWith('/api/model/settings')) return Response.json({ configured: true });
    if (init?.body) {
      posts.push({ path: new URL(url).pathname, data: JSON.parse(String(init.body)) });
      return Response.json(returned);
    }
    return Response.json({
      ...raw,
      clientProtocol: 5,
      schedules: { available: true, items: [returned] },
    });
  });
  const client = new RuntimeClient({ origin: 'http://127.0.0.1:12345', fetcher });
  expect((await client.status()).schedules?.items).toEqual([record]);
  await client.invoke({ type: 'schedule.create', input });
  expect(posts).toContainEqual({ path: '/api/schedules/create', data: input });
  await expect(
    client.invoke({ type: 'schedule.update', id: input.id, revision: 1, patch: { locked: true } }),
  ).rejects.toThrow('RUNTIME_TOO_OLD');
  await expect(
    client.invoke({ type: 'schedule.create', input: { ...input, locked: false } }),
  ).rejects.toThrow('RUNTIME_TOO_OLD');
  returned = { ...record, id: 'mock-wrong-receipt' };
  await expect(client.invoke({ type: 'schedule.create', input })).rejects.toThrow(
    'INVALID_RUNTIME_STATE',
  );
  returned = {
    ...record,
    history: [
      {
        id: 'mock-fire',
        requestId: 'mock-request',
        state: 'completed',
        occurrenceAt: record.createdAt,
        createdAt: record.createdAt,
        apiKey: 'mock-private',
      },
    ],
  };
  expect((await client.status()).schedules?.available).toBe(false);
  expect(JSON.stringify(await client.status())).not.toContain('mock-private');
  await expect(client.invoke({ type: 'schedule.preview', rule: input.rule })).rejects.toThrow(
    'INVALID_RUNTIME_STATE',
  );
});
const raw = {
  clientProtocol: 1,
  mode: 'desktop',
  viewport: { width: 1280, height: 800 },
  sharedLogin: true,
  environment: { platform: 'linux', arch: 'arm64' },
  bots: { a: { owner: 'agent', epoch: 3 }, b: { owner: 'human', epoch: 8 } },
  model: {
    available: true,
    provider: 'deepseek-official',
    model: 'synthetic-model',
    bots: {
      a: { phase: 'idle', running: false },
      b: { phase: 'running', running: true, runId: 'mock-run' },
    },
  },
};
const liveRequest = {
  id: 'mock-question',
  sessionId: 'mock-session',
  bot: 'mock-bot',
  runId: 'mock-run',
  kind: 'question',
  questions: [{ id: 'format', question: '合成格式？' }],
  status: 'pending',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
it('validates interaction IPC and routes exact replies without exposing runtime credentials', async () => {
  const reply = {
    kind: 'answer' as const,
    answers: [{ id: 'format', selected: [], custom: '合成回复' }],
  };
  const command = {
    type: 'interaction.reply' as const,
    bot: 'mock-bot',
    runId: 'mock-run',
    id: 'mock-question',
    reply,
  };
  expect(parseCommand(command)).toEqual(command);
  expect(() => parseCommand({ ...command, origin: 'https://untrusted.test/' })).toThrow(
    'INVALID_COMMAND',
  );
  expect(() => parseCommand({ ...command, reply: { ...reply, apiKey: 'mock-private' } })).toThrow(
    'INVALID_COMMAND',
  );
  const posts: unknown[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/')) return new Response(`<meta name="prototype-token" content="${token}">`);
    if (url.endsWith('/api/model/settings')) return Response.json({ configured: true });
    if (url.endsWith('/api/bots/mock-bot/reply')) {
      posts.push(JSON.parse(String(init?.body)));
      return Response.json({ ...liveRequest, status: 'resolved', reply });
    }
    return Response.json({
      ...raw,
      clientProtocol: 4,
      interactions: [liveRequest, { ...liveRequest, id: 'mock-leak', apiKey: 'mock-private' }],
    });
  });
  const client = new RuntimeClient({ origin: 'http://127.0.0.1:18766', fetcher });
  expect((await client.status()).interactions).toEqual([liveRequest]);
  expect(await client.invoke(command)).toMatchObject({
    id: 'mock-question',
    status: 'resolved',
    reply,
  });
  expect(posts).toEqual([{ id: 'mock-question', runId: 'mock-run', reply }]);
  expect(JSON.stringify(posts)).not.toContain(token);
});
it('whitelists current and interrupted-history response snapshots without forwarding SDK internals', async () => {
  const response = {
    revision: 3,
    text: '合成增量回复',
    state: 'streaming',
    thinking: { id: '1:1', text: '合成思考' },
  };
  const fetcher = async (url: string) =>
    url.endsWith('/')
      ? new Response(`<meta name="prototype-token" content="${token}">`)
      : url.endsWith('/api/model/settings')
        ? Response.json({ configured: true })
        : Response.json({
            ...raw,
            model: {
              ...raw.model,
              bots: {
                a: {
                  phase: 'running',
                  running: true,
                  response,
                  elapsedMs: 12000,
                  history: [
                    {
                      runId: 'mock-old',
                      requestId: 'mock-old-request',
                      phase: 'interrupted',
                      prompt: '合成旧请求',
                      result: '',
                      error: '',
                      response,
                      elapsedMs: 18000,
                      privateToken: 'mock-private',
                    },
                  ],
                },
                b: {
                  phase: 'running',
                  running: true,
                  response: { ...response, privateToken: 'mock-private' },
                },
              },
            },
          });
  const state = await new RuntimeClient({ origin: 'http://127.0.0.1:18766', fetcher }).status();
  expect(state.agents.a.response).toEqual(response);
  expect(state.agents.a.history[0].response).toEqual(response);
  expect(state.agents.a.elapsedMs).toBe(12000);
  expect(state.agents.a.history[0].elapsedMs).toBe(18000);
  expect(state.agents.b.response).toBeUndefined();
  expect(JSON.stringify(state)).not.toContain('mock-private');
});
function transport() {
  const calls: { url: string; headers: Headers }[] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    calls.push({ url, headers: new Headers(options?.headers) });
    if (url.endsWith('/')) return new Response(`<meta name="prototype-token" content="${token}">`);
    if (url.endsWith('/api/model/settings')) return Response.json({ configured: true });
    return Response.json(raw);
  });
  return { fetcher, calls };
}
describe('scoped runtime connection', () => {
  it('preserves explicit parser capability without treating a working knowledge store as parser support', async () => {
    const base = transport();
    const client = new RuntimeClient({
      origin: 'http://127.0.0.1:18766',
      fetcher: async (url, options) =>
        url.endsWith('/api/state')
          ? Response.json({
              ...raw,
              clientProtocol: 10,
              knowledge: { available: true, documentParsing: false },
            })
          : base.fetcher(url, options),
    });
    expect((await client.status()).knowledge).toMatchObject({
      available: true,
      documentParsing: false,
    });
  });
  it('connects to the real API shape without exposing its private capability or legacy notes', async () => {
    const t = transport(),
      client = new RuntimeClient({ origin: 'http://127.0.0.1:18766', fetcher: t.fetcher });
    const state = await client.status();
    expect(state.phase).toBe('ready');
    expect(state.model.configured).toBe(true);
    expect(state.bots.b?.owner).toBe('human');
    expect(
      t.calls.find((c) => c.url.endsWith('/api/state'))?.headers.get('x-prototype-token'),
    ).toBe(token);
    expect(JSON.stringify(state)).not.toContain(token);
    expect(JSON.stringify(state)).not.toContain('note');
  });
  it('reports a disconnected runtime instead of returning a ready demo', async () => {
    const client = new RuntimeClient({
      origin: 'http://127.0.0.1:18766',
      fetcher: vi.fn().mockRejectedValue(new Error('synthetic private error')),
    });
    const state = await client.status();
    expect(state.phase).toBe('offline');
    expect(state.error).not.toContain('private');
  });
  it('refreshes a stale capability once after the runtime restarts', async () => {
    let auth = 0,
      states = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/')) {
        auth++;
        return new Response(`<meta name="prototype-token" content="${token}-${auth}">`);
      }
      if (url.endsWith('/api/state') && ++states === 1)
        return Response.json({ error: 'UNAUTHORIZED' }, { status: 403 });
      if (url.endsWith('/api/model/settings')) return Response.json({ configured: true });
      return Response.json(raw);
    });
    const client = new RuntimeClient({ origin: 'http://127.0.0.1:18766', fetcher });
    expect((await client.status()).phase).toBe('ready');
    expect(auth).toBe(2);
  });
  it('never sends a freeform task to an older preset-only runtime', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('/')
        ? new Response(`<meta name="prototype-token" content="${token}">`)
        : Response.json(
            url.endsWith('/api/model/settings')
              ? { configured: true }
              : { ...raw, clientProtocol: 0 },
          ),
    );
    const client = new RuntimeClient({ origin: 'http://127.0.0.1:18766', fetcher });
    await expect(
      client.invoke({
        type: 'task.start',
        bot: 'a',
        task: { requestId: 'synthetic-1', prompt: '合成任务' },
      }),
    ).rejects.toThrow('RUNTIME_TOO_OLD');
    expect(fetcher.mock.calls.some((c) => c[0].endsWith('/model'))).toBe(false);
  });
  it('preserves the guest Host check when SSH uses a different local port', async () => {
    const t = transport();
    const client = new RuntimeClient({
      origin: 'http://127.0.0.1:18767',
      serverOrigin: 'http://127.0.0.1:8766',
      fetcher: t.fetcher,
    });
    await client.status();
    expect(t.calls.every((call) => call.headers.get('host') === '127.0.0.1:8766')).toBe(true);
  });
  it('uses a transport that actually sends the canonical Host to a real synthetic HTTP server', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.headers.host !== '127.0.0.1:8766') {
        response.writeHead(403);
        response.end(JSON.stringify({ error: 'INVALID_HOST' }));
        return;
      }
      response.end(
        request.url === '/'
          ? `<meta name="prototype-token" content="${token}">`
          : JSON.stringify(request.url === '/api/model/settings' ? { configured: true } : raw),
      );
    });
    await new Promise<undefined>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('synthetic listener missing');
      const client = new RuntimeClient({
        origin: `http://127.0.0.1:${address.port}`,
        serverOrigin: 'http://127.0.0.1:8766',
      });
      expect((await client.status()).phase).toBe('ready');
    } finally {
      server.closeAllConnections();
      await new Promise<undefined>((resolve) => server.close(() => resolve(undefined)));
    }
  });
  it('rejects non-loopback origins at construction', () => {
    expect(() => new RuntimeClient({ origin: 'https://example.test', fetcher: vi.fn() })).toThrow();
  });
});
describe('Electron IPC boundary', () => {
  it('accepts only the app main frame and exact local renderer URL', () => {
    const expected = 'file:///synthetic/daban/dist/index.html';
    expect(trustedSender({ url: expected, mainFrame: true, owned: true }, expected)).toBe(true);
    for (const sender of [
      { url: 'https://example.test', mainFrame: true, owned: true },
      { url: expected, mainFrame: false, owned: true },
      { url: expected, mainFrame: true, owned: false },
    ])
      expect(trustedSender(sender, expected)).toBe(false);
  });
  it('validates target Bot, epoch and input shape before any transport action', () => {
    expect(parseCommand({ type: 'control', bot: 'a', epoch: 4, owner: 'human' })).toEqual({
      type: 'control',
      bot: 'a',
      epoch: 4,
      owner: 'human',
    });
    for (const bad of [
      { type: 'task.stop' },
      { type: 'task.start', task: { requestId: 'synthetic', prompt: 'synthetic' } },
      { type: 'shell', command: 'synthetic' },
      { type: 'control', bot: '../missing', epoch: 1, owner: 'human' },
      { type: 'control', bot: 'a', epoch: -1, owner: 'human' },
      { type: 'input', bot: 'b', epoch: 2, input: { type: 'click', x: 9999, y: 1 } },
      { type: 'files.read', path: '../credentials.json' },
    ])
      expect(() => parseCommand(bad)).toThrow();
  });
});

it('viewer cleanup releases only human-owned desktop inputs under their captured leases', async () => {
  const calls: { url: string; data: unknown }[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      calls.push({ url, data: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/'))
        return new Response(`<meta name="prototype-token" content="${token}">`);
      return Response.json(url.endsWith('/api/model/settings') ? { configured: true } : raw);
    },
  });
  await client.releaseInputs();
  const mutations = calls.filter((call) => call.data);
  expect(mutations).toEqual([
    {
      url: 'http://127.0.0.1:18766/api/bots/b/input',
      data: { epoch: 8, input: { type: 'release' } },
    },
  ]);
  expect(
    parseCommand({ type: 'input', bot: 'b', epoch: 8, input: { type: 'release' } }),
  ).toBeDefined();
});
it('reports offline before a task mutation when health cannot be read', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('synthetic network loss'));
  const client = new RuntimeClient({ origin: 'http://127.0.0.1:18766', fetcher });
  await expect(
    client.invoke({
      type: 'task.start',
      bot: 'a',
      task: { requestId: 'mock-offline', prompt: '合成任务' },
    }),
  ).rejects.toThrow('RUNTIME_OFFLINE');
  expect(fetcher.mock.calls.some((call) => String(call[0]).endsWith('/model'))).toBe(false);
});
it('accepts logical Agent and computer target syntax while leaving connected ownership to the runtime', () => {
  expect(
    parseCommand({
      type: 'task.start',
      bot: 'mock-new-agent',
      task: { requestId: 'mock-request', prompt: '合成问候' },
    }),
  ).toMatchObject({ bot: 'mock-new-agent' });
  expect(
    parseCommand({ type: 'control', bot: 'mock-new-agent', epoch: 0, owner: 'human' }),
  ).toMatchObject({ bot: 'mock-new-agent' });
  for (const bot of ['../escape', '/absolute', '__proto__', ''])
    expect(() => parseCommand({ type: 'task.stop', bot })).toThrow('INVALID_COMMAND');
});
it('hydrates unbound agent history separately from the two computer leases', async () => {
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url) => {
      if (url.endsWith('/'))
        return new Response(`<meta name="prototype-token" content="${token}">`);
      return Response.json(
        url.endsWith('/api/model/settings')
          ? { configured: true }
          : {
              ...raw,
              clientProtocol: 2,
              model: {
                ...raw.model,
                bots: {
                  ...raw.model.bots,
                  chief: {
                    phase: 'completed',
                    running: false,
                    runId: 'mock-chief',
                    requestId: 'mock-chief-request',
                    prompt: '合成问候',
                    result: '你好',
                    history: [],
                  },
                },
              },
            },
      );
    },
  });
  const state = await client.status();
  expect(state.phase).toBe('ready');
  expect(state.agents.chief.result).toBe('你好');
  expect('chief' in state.bots).toBe(false);
  expect(state.bots.b?.owner).toBe('human');
});
it('does not confuse an ordinary agent ID with inherited object properties', async () => {
  const { agentId, agentTask, disconnected } = await import('@daban/protocol');
  expect(agentId('constructor')).toBe('constructor');
  expect(agentTask(disconnected('ready'), 'constructor')).toBeUndefined();
});
it('accepts scoped profile commands and refuses credentials or computer permissions in a profile patch', () => {
  const profile = {
    id: 'mock-persona',
    name: '合成助手',
    instructions: '合成职责',
    memory: '合成偏好',
    color: 'mint',
  };
  expect(parseCommand({ type: 'bot.register', profile })).toMatchObject({ type: 'bot.register' });
  expect(
    parseCommand({
      type: 'bot.update',
      bot: 'mock-persona',
      revision: 1,
      patch: { memory: '新偏好' },
    }),
  ).toMatchObject({ type: 'bot.update' });
  for (const patch of [
    { apiKey: 'synthetic-private' },
    { computer: 'a' },
    { origin: 'https://example.test' },
    { name: '' },
  ])
    expect(() =>
      parseCommand({ type: 'bot.update', bot: 'mock-persona', revision: 1, patch }),
    ).toThrow('INVALID_COMMAND');
});
it('validates profile responses before allowing any extra private field into the renderer', async () => {
  const profile = {
    id: 'mock-profile',
    name: '合成助手',
    instructions: '合成职责',
    memory: '合成偏好',
    color: 'mint' as const,
  };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url) => {
      if (url.endsWith('/'))
        return new Response(`<meta name="prototype-token" content="${token}">`);
      if (url.endsWith('/api/bots'))
        return Response.json({
          ...profile,
          revision: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          apiKey: 'synthetic-private-field',
        });
      return Response.json(
        url.endsWith('/api/model/settings')
          ? { configured: true }
          : { ...raw, clientProtocol: 3, profiles: [] },
      );
    },
  });
  await expect(client.invoke({ type: 'bot.register', profile })).rejects.toThrow(
    'INVALID_RUNTIME_STATE',
  );
});

it('private bootstrap bypasses the public page and never falls back on a credential-read error', async () => {
  const privateToken = 'a'.repeat(64);
  const reads: string[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => {
      return privateToken;
    },
    fetcher: async (url, init) => {
      reads.push(url);
      expect(new Headers(init?.headers).get('x-prototype-token')).toBe(privateToken);
      return Response.json(url.endsWith('/api/model/settings') ? { configured: true } : raw);
    },
  });
  expect((await client.status()).phase).toBe('ready');
  expect(reads.every((url) => !url.endsWith('/'))).toBe(true);
  const deniedReads: string[] = [];
  const denied = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => {
      throw new Error('SYNTHETIC_PRIVATE_READ_FAILED');
    },
    fetcher: async (url) => {
      deniedReads.push(url);
      return new Response(`<meta name="prototype-token" content="${token}">`);
    },
  });
  expect((await denied.status()).phase).toBe('offline');
  expect(deniedReads).toEqual([]);
});

it('a proven missing private file permits legacy services only, and malformed private tokens never downgrade', async () => {
  for (const version of [24, 25]) {
    const reads: string[] = [];
    const client = new RuntimeClient({
      origin: 'http://127.0.0.1:18766',
      tokenProvider: async () => undefined,
      fetcher: async (url) => {
        reads.push(url);
        if (url.endsWith('/'))
          return new Response(`<meta name="prototype-token" content="${token}">`);
        if (url.endsWith('/api/model/settings')) return Response.json({ configured: true });
        return Response.json({
          ...raw,
          clientProtocol: version,
          computers: { available: false, items: [] },
        });
      },
    });
    const state = await client.status();
    if (version === 25) {
      expect(state.phase).toBe('offline');
      expect(reads.some((url) => url.endsWith('/api/model/settings'))).toBe(false);
    } else {
      // The synthetic old snapshot is intentionally incomplete for managed metadata; authentication still reaches settings.
      expect(reads.some((url) => url.endsWith('/api/model/settings'))).toBe(true);
    }
  }
  const reads: string[] = [];
  const corrupt = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'SYNTHETIC-CORRUPT',
    fetcher: async (url) => {
      reads.push(url);
      return new Response('');
    },
  });
  expect((await corrupt.status()).phase).toBe('offline');
  expect(reads).toEqual([]);
});

it('reads an additive shared software capability without a version gate and isolates malformed status', async () => {
  let software: unknown = { available: true, items: [] };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url) =>
      Response.json(
        url.endsWith('/api/model/settings') ? { configured: true } : { ...raw, software },
      ),
  });
  expect((await client.status()).software).toEqual(software);
  software = {
    available: true,
    items: [{ phase: 'installed', plan: { command: 'mock-command' } }],
  };
  const state = await client.status();
  expect(state.phase).toBe('ready');
  expect(state.software?.available).toBe(false);
});

it('validates exact local-computer consent commands and accepts metadata only from the trusted host', async () => {
  const consent = {
    type: 'local.connect',
    id: 'mock-grant',
    bot: 'mock-bot',
    model: 'mock-model',
    modelRevision: 1,
  };
  expect(parseCommand(consent)).toEqual(consent);
  for (const invalid of [
    { ...consent, apiKey: 'SYNTHETIC-MUST-NOT-PASS' },
    { ...consent, modelRevision: -1 },
    { type: 'local.resume', session: '../other', revision: 1 },
    { type: 'local.status', extra: true },
  ])
    expect(() => parseCommand(invalid)).toThrow('INVALID_COMMAND');
  const status = {
    platform: 'darwin',
    available: true,
    permissions: { screen: true, accessibility: true },
    shortcut: true,
    session: {
      id: 'mock-session',
      bot: 'mock-bot',
      revision: 1,
      owner: 'agent',
      model: 'mock-model',
      modelRevision: 1,
    },
  };
  let metadata: unknown = status;
  const fetcher = async () =>
    Response.json({
      ...raw,
      reboot: { available: true, revision: 0, busy: false, vm: 'running' },
      localComputer: metadata,
    });
  const host = new RuntimeClient({
    agent: true,
    origin: 'http://127.0.0.1:8766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  expect((await host.status()).localComputer).toEqual(status);
  metadata = { ...status, session: { ...status.session, secret: 'SYNTHETIC-NOT-A-PUBLIC-FIELD' } };
  expect((await host.status()).phase).toBe('ready');
  expect((await host.status()).localComputer?.available).toBe(false);
  metadata = status;
  const guest = new RuntimeClient({
    origin: 'http://127.0.0.1:8766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  expect((await guest.status()).localComputer).toBeUndefined();
});

it('accepts a native-only host without a VM, reboot service, or connected Linux screens', async () => {
  const role = {
    location: 'host',
    execution: 'local-workspace',
    privilege: 'workspace',
    approvals: 'host',
  };
  const client = new RuntimeClient({
    agent: true,
    origin: 'http://127.0.0.1:8766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url) =>
      url.endsWith('/api/model/settings')
        ? Response.json({
            configured: true,
            provider: 'deepseek-official',
            model: 'deepseek-flash',
            revision: 0,
          })
        : Response.json({
            ...raw,
            clientProtocol: 39,
            mode: 'agent',
            sharedLogin: false,
            bots: {},
            computers: {
              available: false,
              revision: 0,
              limit: 1,
              items: [],
              error: 'LOCAL_VM_UNAVAILABLE',
            },
            chats: { available: true, revision: 1, items: [] },
            recovery: { available: true, revision: 1 },
            mcp: { available: true, revision: 1 },
            skills: { available: true, revision: 1 },
            agent: role,
          }),
  });
  const state = await client.status();
  expect(state.phase).toBe('ready');
  expect(state.agent).toEqual(role);
  expect(state.reboot).toBeUndefined();
});

it('accepts exact model access intents and rejects secrets or extra authority in receipt queries', () => {
  const scope = 'mock-model-host';
  const identity = {
    scope,
    requestId: 'mock-model-operation',
    revision: 2,
    connection: 'mock-provider',
    model: 'provider:mock-provider:mock-model',
  };
  const commands = [
    { type: 'model.saved', input: identity },
    {
      type: 'model.fallback.configure',
      input: { scope, requestId: 'mock-fallback', revision: 2, model: identity.model },
    },
    {
      type: 'model.fallback.configure',
      input: { scope, requestId: 'mock-disable-fallback', revision: 2, model: null },
    },
    {
      type: 'model.remove',
      input: {
        scope,
        requestId: 'mock-remove',
        revision: 2,
        connection: 'mock-provider',
        disconnect: true,
      },
    },
    {
      type: 'model.diagnose',
      input: {
        scope,
        requestId: 'mock-diagnose',
        revision: 2,
        probeRevision: 0,
        connection: { id: 'mock-provider', baseURL: 'https://models.example.test/v1' },
        model: 'mock-model',
        kind: 'inference',
      },
    },
  ];
  for (const command of commands) {
    expect(parseCommand(command)).toEqual(command);
    expect(() =>
      parseCommand({ ...command, input: { ...command.input, authority: 'model' } }),
    ).toThrow();
    expect(() => parseCommand({ ...command, input: { ...command.input, revision: -1 } })).toThrow();
  }
  expect(() =>
    parseCommand({ type: 'model.saved', input: { ...identity, apiKey: 'synthetic-private-key' } }),
  ).toThrow();
});

it('gates model access by capability and verifies the exact receipt identity and key-free current state', async () => {
  const input = {
    scope: 'mock-model-host',
    requestId: 'mock-saved',
    revision: 2,
    connection: 'mock-provider',
    model: 'provider:mock-provider:mock-model',
  };
  const current = { provider: 'mock-provider', model: input.model, revision: 2, configured: true };
  const valid = { ...input, kind: 'configure', phase: 'unknown', current };
  let reply: unknown = valid;
  const fetcher = vi.fn(async () => Response.json(reply));
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const state = disconnected('ready');
  vi.spyOn(client, 'status').mockImplementation(async () => structuredClone(state));
  const command = parseCommand({ type: 'model.saved', input });
  await expect(client.invoke(command)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(fetcher).not.toHaveBeenCalled();
  state.model.modelAccess = { scope: input.scope, fallback: true, diagnostics: true, cli: false };
  expect(await client.invoke(command)).toEqual(valid);
  for (const invalid of [
    { ...valid, scope: 'mock-other-host' },
    { ...valid, connection: 'mock-other-provider' },
    { ...valid, revision: 3 },
    { ...valid, current: { ...current, apiKey: 'synthetic-private-key' } },
  ]) {
    reply = invalid;
    await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  }
});

it('projects bounded model attempts and their logical root into live and historical task metadata', async () => {
  const attempt = {
    attemptId: 'mock-primary-attempt',
    model: 'deepseek-flash',
    phase: 'failed',
    fence: 'clean',
    failure: 'auth',
    createdAt: '2026-01-01T00:00:00.000Z',
    usage: 'unknown',
  };
  const settings = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    configured: true,
    revision: 1,
  };
  const history = {
    runId: 'mock-run',
    requestId: 'mock-request',
    rootRunId: 'mock-root',
    prompt: 'Synthetic input',
    phase: 'failed',
    result: '',
    error: '',
    attemptSummary: [attempt],
  };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url) =>
      Response.json(
        url.endsWith('/api/model/settings')
          ? settings
          : {
              ...raw,
              model: {
                ...raw.model,
                ...settings,
                bots: {
                  ...raw.model.bots,
                  a: {
                    ...raw.model.bots.a,
                    rootRunId: 'mock-root',
                    attemptSummary: [attempt],
                    history: [history],
                  },
                },
              },
            },
      ),
  });
  const state = await client.status();
  expect(state.phase).toBe('ready');
  expect(state.agents.a.attemptSummary).toEqual([attempt]);
  expect(state.agents.a.rootRunId).toBe('mock-root');
  expect(state.agents.a.history[0].attemptSummary).toEqual([attempt]);
});

it('recognizes only an absent Goal target endpoint as legacy service support', async () => {
  for (const [status, error] of [
    [404, 'NOT_FOUND'],
    [409, 'GOAL_TARGET_CHANGED'],
    [403, 'UNAUTHORIZED'],
  ] as const) {
    const client = new RuntimeClient({
      origin: 'http://127.0.0.1:18766',
      tokenProvider: async () => 'a'.repeat(64),
      fetcher: async () => Response.json({ error }, { status }),
    });
    const call = client.invoke({ type: 'budget.goal', owner: { bot: 'a', chatRevision: 0 } });
    if (error === 'NOT_FOUND') await expect(call).resolves.toBeNull();
    else await expect(call).rejects.toThrow();
  }
});
