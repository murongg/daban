import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isTranscriptContent,
  isTranscriptPage,
  managedProtocol,
  type TranscriptScope,
} from '@daban/protocol';
import { expect, test } from 'vitest';
import { startPrototype } from './server.js';

test('authenticated transcript reads bind exact run/Bot/private or group scope without granting work or revealing internal metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-transcript-api-'));
  const app = await startPrototype({
    port: 0,
    computers: true,
    profileDir: path.join(root, 'profile'),
  });
  const post = (action: string, value: unknown, authenticated = true) =>
    fetch(`${app.url}/api/transcripts/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticated ? { 'x-prototype-token': app.token } : {}),
      },
      body: JSON.stringify(value),
    });
  const scope = { bot: 'mock-api-bot', runId: 'mock-private-run', chatRevision: 0 };
  const group = { bot: scope.bot, runId: 'mock-group-run', conversationId: 'mock-group' };
  const original = '合成完整输出😀\n'.repeat(10000);
  try {
    expect.assert(app.models);
    for (const target of [scope, group]) {
      await app.models.journal.put({
        ...target,
        kind: 'chat',
        prompt: '合成保存请求',
        phase: 'completed',
        running: false,
        result: '合成保存回复',
        error: '',
        trace: [],
      });
      app.models.transcripts.begin(target);
      for (let seq = 1; seq <= 24; seq++)
        app.models.transcripts.append(target, {
          source: `mock-private-source-${seq}`,
          kind: 'result',
          callId: `mock-call-${seq}`,
          at: '2026-01-01T00:00:00Z',
          text: seq === 1 ? original : `合成事件 ${seq}`,
        });
      app.models.transcripts.finish(target);
    }
    expect((await post('list', { scope }, false)).status).toBe(403);
    expect((await post('content', { scope, seq: 1 }, false)).status).toBe(403);
    const response = await post('list', { scope });
    expect(response.status).toBe(200);
    const first: unknown = await response.json();
    expect.assert(isTranscriptPage(first));
    expect(first.items.length).toBe(20);
    expect(first.nextAfter).toBe(20);
    expect(first.items[0].characters).toBe(original.length);
    expect(JSON.stringify(first).includes('mock-private-source')).toBe(false);
    const next: unknown = await (await post('list', { scope, after: first.nextAfter })).json();
    expect.assert(isTranscriptPage(next));
    expect(next.items.map((item) => item.seq)).toStrictEqual([21, 22, 23, 24]);
    let offset = 0,
      text = '';
    for (;;) {
      const part: unknown = await (await post('content', { scope, seq: 1, offset })).json();
      expect.assert(isTranscriptContent(part));
      text += part.text;
      if (part.nextOffset === undefined) break;
      offset = part.nextOffset;
    }
    expect(text).toBe(original);
    const foreign: TranscriptScope[] = [
      { ...scope, bot: 'mock-other' },
      { ...scope, chatRevision: 1 },
      { bot: scope.bot, runId: scope.runId, conversationId: group.conversationId },
      { bot: group.bot, runId: group.runId, chatRevision: 0 },
      { ...group, conversationId: 'mock-other-group' },
    ];
    for (const scope of foreign) {
      expect((await post('list', { scope })).status).toBe(404);
      expect((await post('content', { scope, seq: 1 })).status).toBe(404);
    }
    const grouped: unknown = await (await post('list', { scope: group })).json();
    expect.assert(isTranscriptPage(grouped));
    expect(grouped.conversationId).toBe(group.conversationId);
    for (const invalid of [
      { scope, after: -1 },
      { scope: { ...scope, conversationId: 'mock-group' } },
      { scope, extra: true },
      { scope: { ...scope, source: 'mock-private' } },
    ])
      expect((await post('list', invalid)).status).toBe(400);
    for (const invalid of [
      { scope, seq: 0 },
      { scope, seq: 1, offset: -1 },
      { scope, seq: 1, offset: original.length + 1 },
    ])
      expect((await post('content', invalid)).status).toBe(400);
    expect((await post('content', { scope, seq: 25 })).status).toBe(404);
    const legacy = { ...scope, runId: 'mock-legacy-api-run' };
    await app.models.journal.put({
      ...legacy,
      kind: 'chat',
      prompt: '合成旧请求',
      phase: 'completed',
      running: false,
      result: '合成旧回复',
      error: '',
      trace: [],
    });
    const unavailable: unknown = await (await post('list', { scope: legacy })).json();
    expect.assert(isTranscriptPage(unavailable));
    expect(unavailable.state).toBe('unavailable');
    expect((await post('content', { scope: legacy, seq: 1 })).status).toBe(404);
    const acceptance = { ...legacy, runId: 'mock-internal-api-run' };
    await app.models.journal.put({
      ...acceptance,
      kind: 'acceptance',
      prompt: '合成内部请求',
      phase: 'completed',
      running: false,
      result: '合成内部回复',
      error: '',
      trace: [],
    });
    expect((await post('list', { scope: acceptance })).status).toBe(404);
    const state = await (
      await fetch(app.url + '/api/state', { headers: { 'x-prototype-token': app.token } })
    ).json();
    expect(state.clientProtocol).toBe(managedProtocol);
    expect(state.model.configured).toBe(false);
    expect(app.models.jobs.size).toBe(0);
    expect((await app.models.journal.read(scope.bot, scope.runId))?.result).toStrictEqual(
      '合成保存回复',
    );
    expect.assert(app.recovery);
    const review = await app.recovery.review();
    const prepared = await app.recovery.prepare({
      id: 'mock-transcript-recovery',
      revision: review.revision,
      review: review.digest,
      confirmation: 'restart-all-apps',
    });
    expect((await post('list', { scope })).status).toBe(200);
    expect((await post('content', { scope, seq: 1 })).status).toBe(200);
    await app.recovery.cancel(prepared.id, prepared.revision);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
