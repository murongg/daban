import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isContextView, isTranscriptContent } from '@daban/protocol';
import { expect, test } from 'vitest';
import { captureContext, contextSources, emptyContextArchive } from './context-inspector.js';
import { secureDirectory } from './private-files.js';
import { startPrototype } from './server.js';

test('context reads require exact ownership and a retained capture before reading visible source pages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-context-api-'));
  // Match the real Host's ACL-validated root registration before publishing its control token.
  await secureDirectory(root);
  const app = await startPrototype({
    port: 0,
    computers: true,
    profileDir: path.join(root, 'profile'),
  });
  const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
  const previous = { ...scope, runId: 'mock-previous' };
  const ref = { scope: previous, seq: 1 };
  const text = '合成😀可见原文\n'.repeat(6000);
  const post = (action: string, query: unknown, authorized = true) =>
    fetch(`${app.url}/api/context/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorized ? { 'x-prototype-token': app.token } : {}),
      },
      body: JSON.stringify(query),
    });
  try {
    expect.assert(app.models);
    const sources = contextSources({ request: 'SYNTHETIC REQUEST' });
    sources[7].refs = [ref, { scope: previous, seq: 2 }];
    sources[7].savedCharacters = text.length;
    const archive = captureContext(emptyContextArchive(), {
      at: '2026-01-01T00:00:00.000Z',
      reason: 'settled',
      coverage: 'partial',
      turnId: 'mock-turn',
      estimator: 'daban-text-v1',
      configuredWindow: 16384,
      configuredOutput: 1024,
      sources,
      gaps: ['sdk-envelope'],
    });
    for (const target of [scope, previous])
      await app.models.journal.put({
        ...target,
        kind: 'chat',
        phase: 'completed',
        running: false,
        prompt: 'SYNTHETIC REQUEST',
        result: 'SYNTHETIC RESULT',
        error: '',
        trace: [],
        ...(target === scope ? { contextCaptures: archive } : {}),
      });
    app.models.transcripts.begin(previous);
    app.models.transcripts.append(previous, {
      source: 'mock-result',
      kind: 'result',
      at: '2026-01-01T00:00:00Z',
      text,
    });
    app.models.transcripts.append(previous, {
      source: 'mock-thinking',
      kind: 'thinking',
      at: '2026-01-01T00:00:00Z',
      text: 'SYNTHETIC HIDDEN THOUGHT',
    });
    app.models.transcripts.finish(previous);
    expect((await post('inspect', { scope }, false)).status).toBe(403);
    const response = await post('inspect', { scope });
    expect(response.status).toBe(200);
    const view: unknown = await response.json();
    expect(isContextView(view)).toBe(true);
    expect(view).toMatchObject({ state: 'captured', selected: { revision: 1 }, revisions: [1] });
    expect((await post('inspect', { scope, revision: 2 })).status).toBe(409);
    expect((await post('inspect', { scope: { ...scope, bot: 'mock-foreign' } })).status).toBe(404);
    expect((await post('inspect', { scope, prompt: 'SYNTHETIC EXTRA' })).status).toBe(400);
    expect(await (await post('inspect', { scope: previous })).json()).toMatchObject({
      state: 'unavailable',
      reason: 'legacy',
    });
    let output = '',
      offset = 0;
    for (;;) {
      const response = await post('source', { scope, revision: 1, ref, offset });
      expect(response.status).toBe(200);
      const part: unknown = await response.json();
      expect.assert(isTranscriptContent(part));
      expect(part.runId).toBe(previous.runId);
      output += part.text;
      if (part.nextOffset === undefined) break;
      offset = part.nextOffset;
    }
    expect(output).toBe(text);
    for (const seq of [2, 3])
      expect(
        (await post('source', { scope, revision: 1, ref: { scope: previous, seq } })).status,
      ).toBe(404);
    expect((await post('source', { scope, revision: 1, ref }, false)).status).toBe(403);
    expect((await post('source', { scope, revision: 1, ref, offset: -1 })).status).toBe(400);
    expect((await post('source', { scope, revision: 2, ref })).status).toBe(409);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
