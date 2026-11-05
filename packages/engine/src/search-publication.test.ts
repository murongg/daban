import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { ModelRuns } from './model.js';
import { SearchSettings } from './search-settings.js';
import { ModelSettings } from './settings.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-search-publication-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  await settings.save({ apiKey: 'synthetic-model-key' });
  const query = vi.fn(async () => ({
    sources: [{ url: 'https://source.example.test/original' }],
    truncated: false,
  }));
  const searches = new SearchSettings(path.join(root, 'search.json'), settings, { query });
  await searches.configure({
    requestId: 'mock-search-configure',
    revision: 0,
    provider: 'brave',
    enabled: true,
    key: 'synthetic-search-key',
  });
  let entered = () => {};
  const started = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  let release = () => {};
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  class Harness {
    async start() {}
    async close() {
      release();
    }
    session(id = 'mock-search-session') {
      return {
        id,
        run: async () => {
          entered();
          await gate;
          return { sessionId: id, finalResponse: 'SYNTHETIC COMPLETE' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const models = new ModelRuns({
    settings,
    search: searches,
    Harness,
    dir: path.join(root, 'model'),
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
  });
  await models.startHuman('mock-bot', {
    requestId: 'mock-search-task',
    prompt: 'Synthetic research.',
  });
  await started;
  const job = models.jobs.get('mock-bot');
  expect.assert(job?.sessionId && job.token);
  job.attemptToolCount = 1;
  const accepted = await models.rpc('mock-bot', `Bearer ${job.token}`, {
    id: 'mock-search-claim',
    method: 'search.claim',
    params: {
      toolCount: 1,
      modelAttemptId: job.attemptId,
      sessionId: job.sessionId,
      callId: 'mock-search-execution',
      search: { executionSessionId: job.sessionId, queries: ['synthetic'] },
    },
  });
  const claimId = (accepted as { result: { searchReceipt: { claimId: string } } }).result
    .searchReceipt.claimId;
  const original = models.journal.put.bind(models.journal);
  let held = () => {};
  const claimed = new Promise<undefined>((resolve) => {
    held = () => resolve(undefined);
  });
  let commit = () => {};
  const publication = new Promise<undefined>((resolve) => {
    commit = () => resolve(undefined);
  });
  let first = true;
  vi.spyOn(models.journal, 'put').mockImplementation(async (record) => {
    if (first && query.mock.calls.length === 1) {
      first = false;
      held();
      await publication;
    }
    return original(record);
  });
  const rpc = () =>
    models.rpc('mock-bot', `Bearer ${job.token}`, {
      jsonrpc: '2.0',
      id: 'mock-search-rpc',
      method: 'search.query',
      params: { claimId, query: 'synthetic' },
    });
  return {
    models,
    searches,
    query,
    job,
    rpc,
    claimed,
    commit,
    async close() {
      commit();
      release();
      await models.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('search revision changes during journal persistence suppress RPC source publication without redispatch', async () => {
  const f = await fixture();
  try {
    const response = f.rpc();
    await f.claimed;
    await f.searches.configure({
      requestId: 'mock-change-during-persistence',
      revision: 1,
      provider: 'brave',
      enabled: false,
    });
    f.commit();
    expect(await response).toMatchObject({ error: { message: 'SEARCH_CONFIG_CHANGED' } });
    expect(f.query).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test('session replacement during journal persistence suppresses the old RPC result without redispatch', async () => {
  const f = await fixture();
  try {
    const response = f.rpc();
    await f.claimed;
    f.job.sessionId = 'mock-replaced-session';
    f.commit();
    expect(await response).toMatchObject({ error: { message: 'UNAUTHORIZED' } });
    expect(f.query).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test('a replaced task capability cannot receive the old sources after journal persistence', async () => {
  const f = await fixture();
  try {
    const response = f.rpc();
    await f.claimed;
    f.job.token = 'synthetic-replaced-capability';
    f.commit();
    expect(await response).toMatchObject({ error: { message: 'UNAUTHORIZED' } });
    expect(f.query).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test('a replacement job cannot release sources owned by the previous job during journal persistence', async () => {
  const f = await fixture();
  try {
    const response = f.rpc();
    await f.claimed;
    f.models.jobs.set('mock-bot', { ...f.job, id: 'mock-replacement-run' });
    f.commit();
    expect(await response).toMatchObject({ error: { message: 'UNAUTHORIZED' } });
    expect(f.query).toHaveBeenCalledTimes(1);
  } finally {
    f.models.jobs.set('mock-bot', f.job);
    await f.close();
  }
});
