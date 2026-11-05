import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ApprovalRules, type RulePolicy } from './approval-rules.js';
import { Commands } from './commands.js';
import { Interactions } from './interactions.js';

test('restart and unavailable rules preserve original receipts without dispatching another effect', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-policy-recovery-'));
  const scope = { kind: 'bot' as const, bot: 'mock-bot' };
  const file = path.join(root, 'rules.sqlite');
  let rules = new ApprovalRules(file);
  const run = {
    id: 'mock-run',
    bot: scope.bot,
    sessionId: 'mock-session',
    workdir: '/workspace/mock',
    abort: new AbortController(),
    task: { prompt: 'Synthetic read', approvalMode: 'full' as const },
  };
  const output = { content: [{ type: 'text' as const, text: 'SYNTHETIC-RESULT' }] };
  let effects = 0;
  const policy: RulePolicy = {
    review: (owner, selector, baseline) =>
      rules.evaluate({
        scope: { kind: 'bot', bot: owner.bot },
        selector,
        trigger: 'interactive',
        mode: 'full',
        baseline,
        allowEligible: false,
      }),
    assertCurrent: (_owner, decision) => rules.assertCurrent(decision),
  };
  const options = {
    file: path.join(root, 'commands.sqlite'),
    interactions: new Interactions(path.join(root, 'interactions')),
    policy,
  };
  let commands = new Commands(options);
  const dispatch = async () => {
    effects++;
    return output;
  };
  try {
    const edit = {
      requestId: 'mock-save',
      expectedRevision: 0,
      scope,
      action: 'save' as const,
      rule: {
        id: 'mock-rule',
        name: 'Synthetic unrelated restriction',
        enabled: true,
        effect: 'deny' as const,
        trigger: 'interactive' as const,
        selector: { kind: 'url' as const, url: 'https://example.test/mock' },
      },
    };
    const receipt = await rules.write(edit);
    assert.deepEqual(
      await commands.invoke(run, 'shell', { command: 'ls' }, 'mock-call', dispatch),
      output,
    );
    await commands.close();
    await rules.close();
    rules = new ApprovalRules(file);
    assert.deepEqual(await rules.receipt(scope, edit.requestId), receipt);
    assert.deepEqual(await rules.write(edit), receipt);
    await rules.close();
    await writeFile(file, 'synthetic corrupt policy');
    rules = new ApprovalRules(file);
    commands = new Commands(options);
    assert.deepEqual(
      await commands.invoke(run, 'shell', { command: 'ls' }, 'mock-call', dispatch),
      output,
    );
    assert.match(
      JSON.stringify(
        await commands.invoke(run, 'shell', { command: 'ls -a' }, 'mock-call', dispatch),
      ),
      /COMMAND_CALL_ID_REUSED/,
    );
    assert.match(
      JSON.stringify(
        await commands.invoke(run, 'shell', { command: 'ls' }, 'mock-new-call', dispatch),
      ),
      /APPROVAL_RULES_UNAVAILABLE/,
    );
    assert.equal(effects, 1);
  } finally {
    run.abort.abort();
    await commands.close();
    await rules.close();
    await rm(root, { recursive: true, force: true });
  }
});
