import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isComputerAck, isRecoveryReceipt, type RuntimeTask } from '@daban/protocol';
import { execute, ManagedHost, validateHost } from '../electron/host';
import type { RuntimeClient } from '../electron/runtime';

const [configuration, socket, output] = process.argv.slice(2);
assert.ok(configuration && socket && output);
const config = validateHost(JSON.parse(await readFile(configuration, 'utf8')));
// This destructive acceptance check may only operate the disposable verification VM.
assert.equal(config.limaHome, '/Users/murong/.local/share/daban/verify/r24');
assert.equal(config.vm, 'recovery');
assert.equal(config.port, 18769);
assert.equal(dirname(socket), '/Users/murong/.local/share/daban/verify/host24');
await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
let stops = 0;
const starts: string[] = [];
const make = () =>
  new ManagedHost(config, socket, {
    exec: async (program, args, options) => {
      if (program === config.limactl && args[0] === 'stop') stops++;
      if (program === config.limactl && args[0] === 'start') starts.push(config.vm);
      return execute(program, args, options);
    },
  });
let host = make();
const bot = 'mock-recovery-alpha';
const marker = `SYNTHETIC-REBOOT-${randomUUID()}`;
const turns: RuntimeTask[] = [];
async function turn(client: RuntimeClient, prompt: string) {
  const requestId = `mock-reboot-${randomUUID()}`;
  await client.invoke({ type: 'task.start', bot, task: { requestId, prompt } });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const state = await client.status();
    const task = state.agents[bot];
    if (task?.requestId === requestId && !task.running) {
      turns.push(task);
      assert.equal(task.phase, 'completed', task.error);
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await client.invoke({ type: 'task.stop', bot });
  throw new Error('SYNTHETIC_REBOOT_TASK_TIMEOUT');
}
try {
  let client = await host.connect();
  const initial = await client.status();
  assert.equal(initial.phase, 'ready');
  assert.equal(initial.protocolVersion, 24);
  assert.equal(initial.model.configured, true);
  assert.ok(initial.computers?.available);
  assert.ok(initial.profiles.some((profile) => profile.id === bot));
  const memory = initial.profiles.find((profile) => profile.id === bot)!.memory;
  assert.ok(memory.startsWith('SYNTHETIC-'));
  const first = await turn(
    client,
    `合成验收：请用 write_file 在工作区写 recovery-proof.txt，内容严格为 ${marker}。不要使用电脑、浏览器、网络或外部工具，写完只回复已保存。`,
  );
  assert.ok(first.sessionId);
  assert.ok(first.trace.some((row) => row.name === 'write_file' && row.phase === 'settled'));
  const file = first.files.find((row) => row.name === 'recovery-proof.txt');
  assert.ok(file, 'model-created workspace file');
  const retained = await client.invoke({ type: 'files.read', path: file.path });
  const before = await host.recoveryReview();
  assert.equal(before.running.length, 0);
  const instances = new Map<string, string>();
  for (const id of ['mock-recovery-alpha', 'mock-recovery-beta']) {
    const state = (await client.status()).computers!.items.find((row) => row.bot === id)!;
    const ack = await client.invoke({
      type: 'computer.action',
      request: {
        id: `mock-connect-${randomUUID()}`,
        bot: id,
        action: 'connect',
        revision: state.revision,
      },
    });
    assert.ok(isComputerAck(ack) && ack.state.phase === 'connected' && ack.state.instance);
    instances.set(id, ack.state.instance);
  }
  const review = await host.recoveryReview();
  assert.equal(review.screens.length, 2);
  const request = {
    id: `mock-product-reboot-${randomUUID()}`,
    revision: review.revision,
    review: review.digest,
    confirmation: 'restart-all-apps' as const,
  };
  const result = await host.recover(request);
  assert.ok(result.available, JSON.stringify(result));
  assert.equal(result.operation?.stage, 'complete', JSON.stringify(result));
  const receipt = result.operation.backend;
  assert.ok(isRecoveryReceipt(receipt) && receipt.phase === 'complete');
  assert.notEqual(receipt.boot, review.boot);
  assert.notEqual(receipt.instance, review.instance);
  assert.equal(stops, 1);
  assert.equal(starts.length, 2);
  assert.deepEqual(await host.recover(request), result);
  assert.equal(stops, 1);
  await host.close();
  host = make();
  const reopened = await host.recoveryStatus();
  assert.ok(reopened.available && reopened.operation?.stage === 'complete');
  assert.deepEqual(await host.inspectRecovery(request.id), reopened);
  assert.equal(stops, 1);
  client = await host.connect();
  const after = await client.status();
  assert.ok(after.computers?.available);
  assert.equal(after.computers.items.filter((row) => row.reserved).length, 0);
  assert.deepEqual(after.profiles, initial.profiles);
  assert.deepEqual(await client.invoke({ type: 'files.read', path: file.path }), retained);
  for (const [id, previous] of instances) {
    const computer = (await client.status()).computers!.items.find((row) => row.bot === id)!;
    const ack = await client.invoke({
      type: 'computer.action',
      request: {
        id: `mock-reconnect-${randomUUID()}`,
        bot: id,
        action: 'connect',
        revision: computer.revision,
      },
    });
    assert.ok(isComputerAck(ack) && ack.state.phase === 'connected');
    assert.notEqual(ack.state.instance, previous);
  }
  const second = await turn(
    client,
    `合成恢复验收：请用 read_file 读取 /shared/${file.path}，回复文件的完整标记和你保留的偏好标记。不要猜文件内容，不使用电脑、浏览器、网络或外部工具。`,
  );
  assert.equal(second.sessionId, first.sessionId);
  assert.ok(second.result.includes(marker));
  assert.ok(second.result.includes(memory));
  assert.ok(second.trace.some((row) => row.name === 'read_file' && row.phase === 'settled'));
  assert.deepEqual(await client.invoke({ type: 'files.read', path: file.path }), retained);
  await writeFile(
    output,
    `${JSON.stringify(
      {
        verified: true,
        scope:
          'Actual ManagedHost durable journal, fixed private VM stop/start and real DSH continuity; no original Electron or original-user preservation proof',
        originalVmOperated: false,
        wholeKernelChanged: true,
        runtimeInstanceChanged: true,
        durableJournalReopened: true,
        exactRetryStops: stops,
        explicitComputerReconnectNewInstances: true,
        sameNativeDshSession: first.sessionId === second.sessionId,
        filesAndPreferencesRetained: true,
        paidModelTaskTurns: turns.length,
        turns: turns.map((task) => ({
          phase: task.phase,
          tools: task.trace.map((row) => row.name),
          session: task.sessionId,
          result: task.result,
        })),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
} finally {
  await host.close();
}
