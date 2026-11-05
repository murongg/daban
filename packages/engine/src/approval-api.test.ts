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
    const mcpSelector = {
      kind: 'mcp' as const,
      connection: 'mock-connection',
      configRevision: 1,
      catalogDigest: 'a'.repeat(64),
      tool: 'synthetic_write',
      inputHash: 'b'.repeat(64),
    };
    const mcpDecision = await app.models!.approvalRules.evaluate({
      scope: { kind: 'bot', bot: scope.bot },
      selector: mcpSelector,
      trigger: 'interactive',
      mode: 'auto',
      baseline: 'ask',
      allowEligible: false,
    });
    await app.models!.interactions.open(
      scope.bot,
      'mock-api-run',
      {
        id: 'mock-api-card',
        sessionId: 'mock-api-session',
        kind: 'approval',
        tool: 'mcp_call',
        connection: mcpSelector.connection,
        configRevision: 1,
        catalogDigest: mcpSelector.catalogDigest,
        name: 'Synthetic connection',
        origin: 'https://mcp.example.test',
        operation: mcpSelector.tool,
        arguments: '{}',
        inputHash: mcpSelector.inputHash,
      },
      undefined,
      mcpDecision,
      { taskId: 'mock-api-task', turnId: 'mock-api-turn' },
    );
    const oldReply = await fetch(`${app.url}/api/bots/${scope.bot}/reply`, {
      method: 'POST',
      headers: {
        'x-prototype-token': app.token,
        'x-daban-approval-rules': 'approval-rules-v2',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'mock-api-card',
        runId: 'mock-api-run',
        reply: { kind: 'decision', allow: true, confirmPurpose: true },
      }),
    });
    expect(oldReply.status).toBe(400);
    const modern = await fetch(`${app.url}/api/state`, {
      headers: {
        'x-prototype-token': app.token,
        'x-daban-approval-rules': approvalRulesCapability,
      },
    });
    const modernState = await modern.json();
    expect(modernState.interactions[0].purposeScope).toEqual({
      taskId: 'mock-api-task',
      turnId: 'mock-api-turn',
    });
    expect(modernState.approvalRules).toMatchObject({
      capability: approvalRulesCapability,
      available: true,
      revision: 1,
    });
    const legacy = await fetch(`${app.url}/api/state`, {
      headers: { 'x-prototype-token': app.token, 'x-daban-approval-rules': 'approval-rules-v2' },
    });
    const legacyState = await legacy.json();
    expect(legacyState.approvalRules).toBeUndefined();
    expect(legacyState.interactions[0].purposeScope).toBeUndefined();
    expect(legacyState.interactions[0].policyDecision).toBeUndefined();
    const onceReply = await fetch(`${app.url}/api/bots/${scope.bot}/reply`, {
      method: 'POST',
      headers: {
        'x-prototype-token': app.token,
        'x-daban-approval-rules': 'approval-rules-v2',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'mock-api-card',
        runId: 'mock-api-run',
        reply: { kind: 'decision', allow: true },
      }),
    });
    expect(onceReply.status).toBe(200);
    const once = await onceReply.json();
    expect(once.reply).toEqual({ kind: 'decision', allow: true });
    expect(once.purposeScope).toBeUndefined();
    expect(once.policyDecision).toBeUndefined();
    await app.models!.projects.write({
      requestId: 'mock-project-create',
      action: 'create',
      projectId: 'mock-project',
      expectedRevision: 0,
      value: { name: 'Synthetic project', grants: [{ bot: scope.bot }] },
    });
    const projectScope = { kind: 'project', scope: { projectId: 'mock-project', revision: 1 } };
    const projectRequest = {
      requestId: 'mock-project-edit',
      expectedRevision: 1,
      action: 'save',
      scope: projectScope,
      rule: { ...rule, id: 'mock-project-rule' },
    };
    const projectSaved = await call('write', { request: projectRequest });
    expect(projectSaved).toMatchObject({
      status: 200,
      value: { scope: projectScope, revision: 2 },
    });
    expect((await call('list', { scope: projectScope })).value.rules).toMatchObject([
      { id: 'mock-project-rule', scope: projectScope },
    ]);
    expect(
      (
        await call('preview', {
          scope: projectScope,
          selector,
          trigger: 'interactive',
          mode: 'full',
        })
      ).value,
    ).toMatchObject({ effect: 'deny', scope: projectScope });
    await app.models!.projects.write({
      requestId: 'mock-project-archive',
      action: 'archive',
      projectId: 'mock-project',
      expectedRevision: 1,
    });
    expect(
      (await call('receipt', { scope: projectScope, requestId: projectRequest.requestId })).value,
    ).toEqual(projectSaved.value);
    expect((await call('write', { request: projectRequest })).value).toEqual(projectSaved.value);
    expect(
      (
        await call('write', {
          request: { ...projectRequest, requestId: 'mock-stale-new-edit', expectedRevision: 2 },
        })
      ).status,
    ).toBe(409);
    expect((await call('list', { scope: projectScope })).value.revision).toBe(2);
    expect(app.models!.jobs.size).toBe(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
