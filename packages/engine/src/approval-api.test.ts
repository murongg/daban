import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { approvalRulesCapability } from '@daban/protocol';
import { expect, test } from 'vitest';
import { secureDirectory } from './private-files.js';
import { startPrototype } from './server.js';

test('authenticated rule editing and preview never start a task; lost save replies use the exact receipt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-rules-api-'));
  // Windows Authority requires the same ACL-validated root registration as the real host.
  await secureDirectory(root);
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const scope = { kind: 'bot', bot: 'mock-bot' };
  const call = async (type: string, fields: object, modern = true, token = app.token) => {
    const response = await fetch(`${app.url}/api/approval-rules/${type}`, {
      method: 'POST',
      headers: {
        'x-prototype-token': token,
        'content-type': 'application/json',
        ...(modern ? { 'x-daban-approval-rules': approvalRulesCapability } : {}),
      },
      body: JSON.stringify({ type: `approval.rules.${type}`, ...fields }),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    await app.models!.profiles.register({
      id: scope.bot,
      name: 'Synthetic Bot',
      color: 'mint',
      instructions: '',
      memory: '',
    });
    expect((await call('list', { scope }, true, 'mock-denied')).status).toBe(403);
    const listed = await call('list', { scope });
    expect(listed).toMatchObject({ status: 200, value: { scope, revision: 0, rules: [] } });
    const selector = { kind: 'url', url: 'https://example.test/mock' };
    expect(
      (await call('preview', { scope, selector, trigger: 'interactive', mode: 'full' })).value,
    ).toMatchObject({ effect: 'allow', source: 'mode' });
    const rule = {
      id: 'mock-rule',
      name: 'Synthetic exact URL',
      enabled: true,
      effect: 'deny',
      trigger: 'interactive',
      selector,
    };
    const preview = await call('preview', {
      scope,
      selector,
      trigger: 'interactive',
      mode: 'full',
      rule,
    });
    expect(preview.value).toMatchObject({
      effect: 'deny',
      source: 'rule',
      matchedRules: [{ id: rule.id }],
    });
    expect((await call('list', { scope })).value.rules).toHaveLength(0);
    const request = { requestId: 'mock-save', expectedRevision: 0, scope, action: 'save', rule };
    const saved = await call('write', { request });
    expect(saved).toMatchObject({ status: 200, value: { revision: 1 } });
    expect((await call('receipt', { scope, requestId: request.requestId })).value).toEqual(
      saved.value,
    );
    expect((await call('write', { request })).value).toEqual(saved.value);
    expect(
      (await call('write', { request: { ...request, rule: { ...rule, effect: 'allow' } } })).status,
    ).toBe(409);
    expect(app.models!.jobs.size).toBe(0);
    const modern = await fetch(`${app.url}/api/state`, {
      headers: {
        'x-prototype-token': app.token,
        'x-daban-approval-rules': approvalRulesCapability,
      },
    });
    expect((await modern.json()).approvalRules).toMatchObject({
      capability: approvalRulesCapability,
      available: true,
      revision: 1,
    });
    const legacy = await fetch(`${app.url}/api/state`, {
      headers: { 'x-prototype-token': app.token },
    });
    expect((await legacy.json()).approvalRules).toBeUndefined();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
