import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type ExecutionSnapshot, executionCapabilities } from '@daban/protocol';
import { readStartupPolicy, saveExecutionSnapshot } from './startup.js';

const snapshot: ExecutionSnapshot = {
  role: 'executor',
  version: 1,
  boot: 'mock-boot',
  nonce: 'mock-nonce',
  capabilities: [...executionCapabilities],
  computer: {
    mode: 'agent',
    sharedLogin: false,
    viewport: { width: 1280, height: 800 },
    environment: {
      platform: 'linux',
      arch: 'arm64',
      kernel: 'mock-kernel',
      node: 'mock-node',
      browser: 'mock-browser',
    },
    events: [],
    bots: {},
  },
  status: { available: true, limit: 2, revision: 0, items: [] },
};
const target = 'a'.repeat(64);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-agent-startup-'));
  return {
    root,
    target,
    cacheFile: path.join(root, 'execution-snapshot.json'),
    powerFile: path.join(root, 'host-recovery.json'),
  };
}

test('pending host power recovery uses only a validated VM-bound cached snapshot', async () => {
  const f = await fixture();
  try {
    await saveExecutionSnapshot({
      file: f.cacheFile,
      target,
      snapshot,
      workspaceRoot: '/mock-guest/workspace',
    });
    const review = {
      boot: 'mock-boot',
      instance: 'mock-instance',
      revision: 0,
      computersRevision: 0,
      digest: 'b'.repeat(64),
      screens: [],
      running: [],
      changing: false,
    };
    await writeFile(
      f.powerFile,
      JSON.stringify({
        version: 1,
        revision: 1,
        target,
        operation: { id: 'mock-power', stage: 'preparing', review },
      }),
      { mode: 0o600 },
    );
    const policy = await readStartupPolicy(f);
    assert.equal(policy.attachOnly, true);
    assert.deepEqual(policy.initialSnapshot, snapshot);
    assert.equal(policy.workspaceRoot, '/mock-guest/workspace');
    assert.ok(!JSON.stringify(JSON.parse(await readFile(f.cacheFile, 'utf8'))).includes('apiKey'));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('foreign targets, corrupt snapshots and relative workspace roots fail closed', async () => {
  const f = await fixture();
  try {
    await saveExecutionSnapshot({
      file: f.cacheFile,
      target,
      snapshot,
      workspaceRoot: '/mock-guest/workspace',
    });
    await assert.rejects(
      readStartupPolicy({ ...f, target: 'c'.repeat(64) }),
      /AGENT_EXECUTION_CACHE_INVALID/,
    );
    await assert.rejects(
      saveExecutionSnapshot({ file: f.cacheFile, target, snapshot, workspaceRoot: '../mock' }),
      /AGENT_EXECUTION_CACHE_INVALID/,
    );
    const saved = JSON.parse(await readFile(f.cacheFile, 'utf8'));
    saved.snapshot.computer.model = { apiKey: 'synthetic-forged-guest-key' };
    await writeFile(f.cacheFile, JSON.stringify(saved), { mode: 0o600 });
    await assert.rejects(readStartupPolicy(f), /AGENT_EXECUTION_CACHE_INVALID/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
