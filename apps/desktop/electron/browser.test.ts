import { expect, it } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

it('validates human browser answers with bounded local bytes and no file paths or implicit dialog consent', () => {
  const request = {
    type: 'browser.answer',
    bot: 'a',
    id: 'mock-human',
    epoch: 3,
    binding: { instance: 'mock-browser', tab: 'mock-tab', generation: 2 },
    prompt: 'mock-prompt',
    kind: 'dialog',
    accept: false,
  };
  expect(parseCommand(request)).toEqual(request);
  for (const value of [
    { ...request, accept: undefined },
    { ...request, accept: false, text: 'secret' },
    {
      ...request,
      kind: 'files',
      accept: undefined,
      files: [{ name: '../private.txt', data: 'eA==' }],
    },
    { ...request, binding: { ...request.binding, generation: undefined } },
  ])
    expect(() => parseCommand(value)).toThrow('INVALID_COMMAND');
  const file = {
    type: 'browser.answer',
    bot: 'a',
    id: 'mock-files',
    epoch: 3,
    binding: request.binding,
    prompt: 'mock-prompt',
    kind: 'files',
    files: [{ name: 'synthetic.txt', data: 'eA==' }],
  };
  expect(parseCommand(file)).toEqual(file);
  expect(() =>
    parseCommand({ ...file, files: [{ ...file.files[0], path: '/private/file' }] }),
  ).toThrow('INVALID_COMMAND');
});

const state = {
  bot: 'a',
  available: true,
  instance: 'mock-browser',
  revision: 1,
  active: 'mock-tab',
  tabs: [{ id: 'mock-tab', url: 'https://example.test/', title: 'Synthetic site', generation: 2 }],
};
it('validates browser command syntax, extra fields and missing target identity before transport', () => {
  const command = {
    type: 'browser.command',
    bot: 'a',
    epoch: 3,
    instance: state.instance,
    id: 'mock-command',
    action: 'navigate',
    tab: 'mock-tab',
    url: 'https://example.test/',
  };
  expect(parseCommand(command)).toEqual(command);
  for (const value of [
    { ...command, bot: '../other' },
    { ...command, instance: undefined },
    { ...command, id: undefined },
    { ...command, action: 'execute', code: 'process.env' },
    { ...command, url: 'file:///etc/passwd' },
    { ...command, author: 'a' },
    {
      type: 'browser.input',
      bot: 'a',
      epoch: 3,
      binding: { instance: 'mock-browser', tab: 'mock-tab', generation: 2 },
      input: { type: 'click', x: 1, y: 2 },
      extra: true,
    },
  ])
    expect(() => parseCommand(value)).toThrow('INVALID_COMMAND');
});
it('rejects nonnumeric browser buttons and invalid image coordinates before transport', () => {
  const base = {
    type: 'browser.input',
    bot: 'a',
    epoch: 3,
    binding: { instance: 'mock-browser', tab: 'mock-tab', generation: 2 },
  };
  for (const input of [
    { type: 'click', x: 1, y: 2, button: '1' },
    { type: 'pointer', phase: 'down', x: 1, y: 2, button: null },
    { type: 'click', x: 960, y: 2 },
    { type: 'click', x: 1, y: 640 },
    { type: 'click', x: 1, y: 2, phase: 'down' },
  ])
    expect(() => parseCommand({ ...base, input })).toThrow('INVALID_COMMAND');
});
it('gates the new browser transport and validates exact owned state, frame bindings and command acknowledgements', async () => {
  let protocol = 15;
  let response: unknown = state;
  const posts: unknown[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="synthetic-browser-token">');
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          configured: true,
          revision: 0,
        });
      if (url.endsWith('/api/state'))
        return Response.json({
          mode: 'desktop',
          clientProtocol: protocol,
          bots: { a: { owner: 'human', epoch: 3 }, b: { owner: 'agent', epoch: 0 } },
          model: { available: true, bots: {} },
          browsers: { a: state },
        });
      if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
      return Response.json(response);
    },
  });
  const read = parseCommand({ type: 'browser.state', bot: 'a' });
  await expect(client.invoke(read)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posts).toHaveLength(0);
  protocol = 16;
  expect(await client.invoke(read)).toEqual(state);
  response = { ...state, bot: 'b' };
  await expect(client.invoke(read)).rejects.toThrow('INVALID_RUNTIME_STATE');
  const command = parseCommand({
    type: 'browser.command',
    bot: 'a',
    epoch: 3,
    instance: state.instance,
    id: 'mock-command',
    action: 'new',
  });
  response = { id: 'mock-command', state };
  expect(await client.invoke(command)).toEqual(response);
  response = { id: 'wrong-command', state };
  await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  const frame = parseCommand({ type: 'browser.view', bot: 'a' });
  response = {
    bot: 'a',
    epoch: 3,
    binding: { instance: 'mock-browser', tab: 'mock-tab', generation: 2 },
    image: 'data:image/jpeg;base64,c3ludGhldGlj',
    width: 960,
    height: 640,
  };
  expect(await client.invoke(frame)).toEqual(response);
  response = { ...(response as object), binding: { instance: 'mock-browser', tab: 'mock-tab' } };
  await expect(client.invoke(frame)).rejects.toThrow('INVALID_RUNTIME_STATE');
});
