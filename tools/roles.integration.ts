import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { moduleGraph } from './roles.ts';

test('compiled Linux executor networking has no host SDK loader or credential-bearing modules', async () => {
  const graph = await moduleGraph(path.resolve('packages/engine/dist'), ['executor.js']);
  for (const host of ['dsh.js', 'web.js', 'model.js', 'settings.js', 'schedule-domain.js'])
    assert.equal(graph.includes(host), false, `guest graph imports host module ${host}`);
});
