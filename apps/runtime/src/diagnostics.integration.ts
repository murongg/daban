import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDiagnosticReport } from '@daban/protocol';
import { startPrototype } from './server.js';

test('authenticated diagnostics is read-only, remains useful without optional stores, and exposes no data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-diagnostics-api-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const call = async (token = app.token, method = 'GET', search = '') => {
    const response = await fetch(`${app.url}/api/diagnostics${search}`, {
      method,
      headers: { 'x-prototype-token': token },
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.equal((await call('mock-invalid-token')).status, 403);
    assert.equal((await call(app.token, 'POST')).status, 405);
    assert.equal((await call(app.token, 'GET', '?command=synthetic')).status, 400);
    assert.ok(app.models);
    await app.models.profiles.register({
      id: 'mock-health-a',
      name: 'SYNTHETIC-PRIVATE-NAME',
      instructions: 'SYNTHETIC-PRIVATE-PROMPT',
      memory: 'SYNTHETIC-PRIVATE-MEMORY',
      color: 'mint',
    });
    const profileFile = path.join(app.models.profiles.directory, 'mock-health-a.json');
    const before = await readFile(profileFile, 'utf8');
    const healthy = await call();
    assert.equal(healthy.status, 200);
    assert.ok(isDiagnosticReport(healthy.value));
    assert.equal(healthy.value.scope, 'runtime');
    assert.equal(healthy.value.checks.find((row) => row.id === 'model')?.state, 'unconfigured');
    assert.equal(
      healthy.value.checks.find((row) => row.id === 'graphics')?.state,
      process.platform === 'linux' ? 'ready' : 'unsupported',
    );
    assert.equal(JSON.stringify(healthy.value).includes('SYNTHETIC-PRIVATE'), false);
    const status = app.models.skills.status;
    app.models.skills.status = async () => {
      throw new Error('SYNTHETIC-PRIVATE-ERROR');
    };
    try {
      const degraded = await call();
      assert.equal(degraded.status, 200);
      assert.ok(isDiagnosticReport(degraded.value));
      assert.equal(degraded.value.checks.find((row) => row.id === 'skills')?.state, 'unavailable');
      assert.equal(degraded.value.checks.find((row) => row.id === 'agent')?.state, 'ready');
      assert.equal(JSON.stringify(degraded.value).includes('SYNTHETIC-PRIVATE'), false);
    } finally {
      app.models.skills.status = status;
    }
    assert.equal(await readFile(profileFile, 'utf8'), before);
    assert.equal(app.runtime.status().items.length, 0);
    assert.equal(
      Object.values(app.models.status().bots).some((job) => job.running),
      false,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
