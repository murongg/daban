import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, StreamCollector, StreamPublisher } from './stream.js';

const start = (revision = 1, attemptId = 'mock-attempt') => ({
  type: 'start',
  attemptId,
  revision,
  turn: 1,
  step: 1,
});
const chunk = (revision: number, index: number, value: unknown, attemptId = 'mock-attempt') => ({
  type: 'chunk',
  attemptId,
  revision,
  index,
  time: 0,
  chunk: value,
});
const end = (
  revision: number,
  index: number,
  eventType = 'assistant/message',
  attemptId = 'mock-attempt',
) => ({
  type: 'end',
  attemptId,
  revision,
  index,
  outcome: { kind: 'committed', eventType, seq: 10 },
});
test('native streams expose visible text only and never reasoning or tool arguments', () => {
  const stream = new StreamCollector();
  stream.push(start());
  stream.push(chunk(2, 0, { type: 'block-start', index: 0, blockType: 'reasoning' }));
  assert.equal(
    stream.push(chunk(3, 1, { type: 'reasoning-delta', index: 0, text: 'mock-private-reasoning' })),
    undefined,
  );
  assert.equal(
    stream.push(
      chunk(4, 2, {
        type: 'tool-call-delta',
        index: 1,
        id: 'mock-call',
        argumentsDelta: 'mock-private-arguments',
      }),
    ),
    undefined,
  );
  stream.push(chunk(5, 3, { type: 'block-start', index: 2, blockType: 'text' }));
  assert.equal(
    stream.push(chunk(6, 4, { type: 'text-delta', index: 2, text: '合成回答甲' }))?.text,
    '合成回答甲',
  );
  assert.equal(
    stream.push(chunk(7, 5, { type: 'text-delta', index: 0, text: 'mock-private-reasoning' })),
    undefined,
  );
  assert.equal(
    stream.push(chunk(8, 6, { type: 'text-delta', index: 2, text: '乙' }))?.text,
    '合成回答甲乙',
  );
  assert.deepEqual(stream.push(end(9, 7)), { text: '合成回答甲乙', state: 'settled' });
});
test('duplicate, stale and missing chunks cannot duplicate or contaminate retries', () => {
  const stream = new StreamCollector();
  stream.push(start());
  stream.push(chunk(2, 0, { type: 'block-start', index: 0, blockType: 'text' }));
  const visible = chunk(3, 1, { type: 'text-delta', index: 0, text: '合成旧前缀' });
  assert.equal(stream.push(visible)?.text, '合成旧前缀');
  assert.equal(stream.push(visible), undefined);
  assert.deepEqual(stream.push(end(4, 2, 'assistant/attempt')), { text: '', state: 'streaming' });
  stream.push(start(5, 'mock-retry'));
  assert.equal(
    stream.push(chunk(6, 0, { type: 'text-delta', index: 0, text: 'bad' }, 'mock-attempt')),
    undefined,
  );
  stream.push(chunk(7, 0, { type: 'block-start', index: 0, blockType: 'text' }, 'mock-retry'));
  assert.equal(
    stream.push(chunk(8, 1, { type: 'text-delta', index: 0, text: '合成新回答' }, 'mock-retry'))
      ?.text,
    '合成新回答',
  );
  assert.deepEqual(
    stream.push(chunk(9, 3, { type: 'text-delta', index: 0, text: 'missing' }, 'mock-retry')),
    { text: '', state: 'streaming' },
  );
});
test('coalesced output retries the newest snapshot instead of replaying an old prefix', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: unknown[] = [];
  let calls = 0;
  const publisher = new StreamPublisher(async (snapshot) => {
    if (++calls === 1) throw new Error('mock connection loss');
    sent.push(snapshot);
  });
  publisher.push('mock-session', { text: '甲', state: 'streaming' });
  publisher.push('mock-session', { text: '甲乙', state: 'streaming' });
  t.mock.timers.tick(100);
  await new Promise(setImmediate);
  publisher.push('mock-session', { text: '甲乙丙', state: 'settled' });
  t.mock.timers.tick(100);
  await new Promise(setImmediate);
  await publisher.close();
  assert.deepEqual(sent, [
    { sessionId: 'mock-session', revision: 3, text: '甲乙丙', state: 'settled' },
  ]);
});
test('the native adapter publishes only its exact live root and keeps revisions monotone after agent replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: { sessionId: string; revision: number; text: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const rpc = JSON.parse(String(init?.body));
    sent.push(rpc.params);
    return Response.json({ result: { accepted: true } });
  });
  let root = { session: { id: 'mock-session' } };
  const child = { session: { id: 'mock-child' } };
  let handler: (payload: unknown) => unknown = () => undefined;
  let dispose: () => Promise<unknown> = async () => undefined;
  apply(
    {
      agents: { roots: () => [root] },
      on: (event, callback) => {
        assert.equal(event, 'agent/assistant-stream');
        handler = callback;
      },
      effect: (factory) => {
        dispose = factory();
      },
    },
    { url: 'http://127.0.0.1:12345/mcp/mock-bot', capability: 'mock-cap' },
  );
  const emit = (agent: unknown, frame: unknown) => handler({ agent, frame });
  emit(child, start());
  emit(child, chunk(2, 0, { type: 'block-start', index: 0, blockType: 'text' }));
  emit(child, chunk(3, 1, { type: 'text-delta', index: 0, text: 'mock-private-child' }));
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) root = { session: { id: 'mock-session' } };
    emit(root, start());
    emit(root, chunk(2, 0, { type: 'block-start', index: 0, blockType: 'text' }));
    emit(root, chunk(3, 1, { type: 'text-delta', index: 0, text: `合成回答${attempt}` }));
    t.mock.timers.tick(100);
    await new Promise(setImmediate);
  }
  await dispose();
  assert.deepEqual(
    sent.map((item) => item.text),
    ['合成回答0', '合成回答1'],
  );
  assert.ok(sent[1].revision > sent[0].revision);
});
