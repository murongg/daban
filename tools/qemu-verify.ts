import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readVmConnection } from '@daban/engine/host';
import type { ComputerAck } from '@daban/protocol';

interface ToolResult {
  isError?: boolean;
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
}

const repository = fileURLToPath(new URL('..', import.meta.url));
const { QemuLink }: typeof import('../apps/agent/src/qemu.ts') = await import(
  pathToFileURL(path.join(repository, 'dist-agent/qemu.js')).href
);
const { ExecutionConnection }: typeof import('../apps/agent/src/connection.ts') = await import(
  pathToFileURL(path.join(repository, 'dist-agent/connection.js')).href
);
const [action, data, output, configuration] = process.argv.slice(2);
assert.ok(
  ['start', 'resume'].includes(action) && data && output,
  'Usage: qemu-verify.ts start|resume <agent-directory> <report-directory> [vm-config-file]',
);
const root = path.resolve(data),
  reports = path.resolve(output);
await mkdir(reports, { recursive: true });
const config = await readVmConnection(
  configuration ? path.resolve(configuration) : path.join(root, 'runtime.json'),
);
assert.ok(config && config.provider === 'qemu');
const owner = new QemuLink(config, root);
const client = new ExecutionConnection(owner);
const snapshot = await client.ready;
const checks: Record<string, unknown>[] = [];
const check = (name: string, detail: Record<string, unknown> = {}) => {
  checks.push({ name, passed: true, ...detail });
  console.log(name);
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  if (action === 'start') {
    assert.equal(snapshot.computer.environment?.platform, 'linux');
    assert.equal(snapshot.computer.environment?.arch, 'x64');
    check('linux-execution', { environment: snapshot.computer.environment });
    const id = `qemu-${randomUUID()}`,
      bot = 'qemu-synthetic';
    const directory = await client.call<{ path: string; canonical: string; handleId: string }>(
      'workspace.create',
      { parts: [id, bot] },
    );
    await client.call('workspace.write', {
      handleId: directory.handleId,
      name: 'input.txt',
      data: Buffer.from('SYNTHETIC 中文 QEMU').toString('base64'),
    });
    assert.equal(
      (await client.call<{ content: string }>('workspace.read', { path: `${id}/${bot}/input.txt` }))
        .content,
      'SYNTHETIC 中文 QEMU',
    );
    check('guest-file-roundtrip');
    let computer = snapshot.status.items.find((item) => item.bot === bot);
    if (computer?.phase !== 'connected') {
      const requestId = `${id}-desktop`;
      let connected: ComputerAck | undefined;
      try {
        connected = await client.call<ComputerAck>('computer.request', {
          method: 'POST',
          path: '/api/computers/action',
          body: { id: requestId, bot, action: 'connect', revision: computer?.revision ?? 0 },
        });
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'EXECUTION_OUTCOME_UNKNOWN'
        )
          throw error;
        // A cold TCG desktop can outlive the HTTP deadline. Observe its original receipt; never issue another connect.
        const end = Date.now() + 180000;
        while (Date.now() < end) {
          connected = await client.call<ComputerAck>('computer.request', {
            method: 'POST',
            path: '/api/computers/receipt',
            body: { id: requestId, bot },
          });
          if (connected.receipt.phase === 'settled') break;
          await delay(500);
        }
      }
      assert.ok(connected);
      computer = connected.state;
    }
    assert.equal(computer.phase, 'connected', JSON.stringify(computer));
    await client.call('tools.open', {
      id,
      bot,
      workdir: directory.path,
      canonicalRoot: directory.canonical,
      prompt: 'Verify the synthetic Linux desktop, browser and background task',
      limit: 30,
    });
    const tool = async (name: string, args: Record<string, unknown>) => {
      const operationId = `op-${randomUUID()}`;
      await client.call('tools.invoke', { runId: id, operationId, name, args });
      const end = Date.now() + 90000;
      while (Date.now() < end) {
        const value = await client.call<{ phase: string; result?: ToolResult }>('tools.poll', {
          runId: id,
          operationId,
        });
        if (value.phase === 'settled' && value.result) {
          assert.equal(
            value.result.isError,
            undefined,
            JSON.stringify(value.result.content.filter((part) => part.type === 'text')),
          );
          return value.result;
        }
        await delay(200);
      }
      throw Error('QEMU_VERIFY_TOOL_TIMEOUT');
    };
    const before = await tool('screenshot', { surface: 'desktop' });
    const image = before.content.find((part) => part.type === 'image');
    assert.ok(image && image.type === 'image' && Buffer.from(image.data, 'base64').length > 5000);
    await writeFile(path.join(reports, 'desktop-before.jpg'), Buffer.from(image.data, 'base64'));
    await tool('open_app', { app: 'terminal' });
    await tool('act', {
      surface: 'desktop',
      actions: [
        { type: 'text', text: `printf 'SYNTHETIC-DESKTOP' > '${directory.path}/desktop.txt'` },
        { type: 'key', key: 'Return' },
      ],
    });
    await delay(500);
    assert.equal(
      (
        await client.call<{ content: string }>('workspace.read', {
          path: `${id}/${bot}/desktop.txt`,
        })
      ).content,
      'SYNTHETIC-DESKTOP',
    );
    const after = await tool('screenshot', { surface: 'desktop' });
    const frame = after.content.find((part) => part.type === 'image');
    assert.ok(frame && frame.type === 'image' && frame.data !== image.data);
    await writeFile(path.join(reports, 'desktop-after.jpg'), Buffer.from(frame.data, 'base64'));
    check('desktop-agent-screenshot-terminal-keyboard-and-file');
    await tool('open_app', { app: 'browser' });
    const browser = await tool('browser_snapshot', {});
    assert.ok(browser.content.some((part) => part.type === 'text' && part.text.length > 20));
    check('shared-browser-through-executor');
    const current = await client.refresh();
    const lease = current.computer.bots[bot];
    assert.ok(lease && computer.instance);
    const human = await client.call<{ epoch: number }>('computer.request', {
      method: 'POST',
      path: `/api/bots/${bot}/control`,
      body: { instance: computer.instance, epoch: lease.epoch, owner: 'human' },
    });
    await assert.rejects(
      client.call('computer.request', {
        method: 'POST',
        path: `/api/bots/${bot}/input`,
        body: {
          instance: computer.instance,
          epoch: lease.epoch,
          input: { type: 'key', key: 'Return' },
        },
      }),
      { code: 'STALE_CONTROL' },
    );
    await client.call('computer.request', {
      method: 'POST',
      path: `/api/bots/${bot}/control`,
      body: { instance: computer.instance, epoch: human.epoch, owner: 'agent' },
    });
    check('control-handoff-rejects-stale-input');
    const processId = `background-${randomUUID()}`;
    await client.call('process.start', {
      id: processId,
      command: 'sleep 12; printf QEMU-CONTINUES >> background.txt; printf BACKGROUND-DONE',
      cwd: directory.path,
    });
    await writeFile(
      path.join(reports, 'pending.json'),
      JSON.stringify({
        id,
        bot,
        processId,
        directory,
        boot: snapshot.boot,
        nonce: snapshot.nonce,
        vmId: config.vmId,
        checks,
      }),
    );
    check('accepted-background-process');
  } else {
    const pending = JSON.parse(await readFile(path.join(reports, 'pending.json'), 'utf8')) as {
      id: string;
      bot: string;
      processId: string;
      boot: string;
      nonce: string;
      vmId: string;
      directory: { handleId: string };
      checks: Record<string, unknown>[];
    };
    assert.equal(snapshot.boot, pending.boot);
    assert.equal(snapshot.nonce, pending.nonce);
    assert.equal(config.vmId, pending.vmId);
    let state: { phase: string; stdout?: string; exitCode?: number } = { phase: '' };
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      state = await client.call('process.poll', { id: pending.processId });
      if (state.phase === 'exited') break;
      await delay(500);
    }
    assert.equal(state.phase, 'exited');
    assert.equal(state.exitCode, 0);
    assert.equal(state.stdout, 'BACKGROUND-DONE');
    const content = await client.call<{ content: string }>('workspace.read', {
      path: `${pending.id}/${pending.bot}/background.txt`,
    });
    assert.equal(content.content, 'QEMU-CONTINUES');
    check('background-survives-owner-process-exit-without-replay');
    const refreshed = await client.refresh();
    assert.equal(
      refreshed.status.items.find((item) => item.bot === pending.bot)?.phase,
      'connected',
    );
    check('desktop-survives-owner-process-exit');
    await client.call('tools.drain', { runId: pending.id });
    await client.call('workspace.close', { handleId: pending.directory.handleId });
    const stateFile = JSON.parse(await readFile(path.join(root, 'qemu/machine.json'), 'utf8')) as {
      acceleration: string;
    };
    await writeFile(
      path.join(reports, 'result.json'),
      JSON.stringify(
        {
          platform: 'win32',
          acceleration: stateFile.acceleration,
          vmId: config.vmId,
          snapshot: { boot: snapshot.boot, environment: snapshot.computer.environment },
          checks: [...pending.checks, ...checks],
        },
        null,
        2,
      ),
    );
  }
} finally {
  await client.close();
}
