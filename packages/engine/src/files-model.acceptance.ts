import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { TranscriptItem } from '@daban/protocol';
import { startNativeAgent } from './host-server.js';
import { ModelSettings } from './settings.js';

// Manual paid acceptance. Read the saved credential into memory and use a fresh native agent.
const request =
  '把附件里的两份订单表合并成 orders.csv，按订单号去重，重复的以第一份为准，保留原表头。交付前核对导出的订单数和金额合计，并把这两个数字告诉我。';
const inputs = [
  { name: '01-orders.csv', content: 'order_id,amount\nT-001,12.50\nT-002,37.25\n' },
  { name: '02-orders.csv', content: 'order_id,amount\nT-002,91.00\nT-003,9.75\n' },
];
const scenario = process.argv[3] ?? 'success';
assert.ok(['success', 'missing', 'collision'].includes(scenario));
const original = { name: 'orders.csv', content: 'order_id,amount\nT-KEEP,80.00\n' };
const files =
  scenario === 'missing'
    ? inputs.slice(0, 1)
    : scenario === 'collision'
      ? [...inputs, original]
      : inputs;
const prompt =
  scenario === 'collision'
    ? `${request} 随附的 orders.csv 是现有文件，须原样保留。如果交付文件同名，请先问我是否可以另存。`
    : request;
const bot = 'mock-file-eval';
function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Tool errors can be plain text. Retain the original result in the report.
  }
  return {};
}
const credentials = process.argv[2];
assert.ok(credentials && path.isAbsolute(credentials), 'Pass an absolute model settings path.');
const config = await new ModelSettings(credentials).privateConfig();
assert.ok(config, 'A configured model is required.');
const sdk = createRequire(
  fileURLToPath(new URL('../../../apps/agent/package.json', import.meta.url)),
);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'daban-files-model-')));
let agent: Awaited<ReturnType<typeof startNativeAgent>> | undefined;
try {
  agent = await startNativeAgent({
    dataRoot: path.join(root, 'agent'),
    nativeWorkspace: path.join(root, 'workspace'),
    socketPath: path.join(root, 'agent.sock'),
    scope: randomBytes(32).toString('hex'),
    sdkFile: sdk.resolve('@deepseek-ai/dsh-sdk-client'),
  });
  const { models } = agent;
  models.settings.privateConfig = async () => ({
    ...config,
    fallbackModel: undefined,
    operations: undefined,
    probe: undefined,
  });
  await models.profiles.register({
    id: bot,
    name: '合成文件验收',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  await models.start(bot, { requestId: 'mock-file-task', prompt, files });
  const job = models.jobs.get(bot);
  assert.ok(job?.done && job.transcript);
  const scope = job.transcript;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const watch = new AbortController();
  let question = '';
  async function waitForQuestion() {
    while (job!.running && !watch.signal.aborted) {
      const requests = await models.interactions.list();
      const pending = requests.find(
        (item) =>
          item.bot === bot &&
          item.runId === job!.id &&
          item.status === 'pending' &&
          item.kind === 'question',
      );
      if (pending?.kind === 'question') {
        question = pending.questions.map((item) => item.question).join('\n');
        return true;
      }
      await delay(200);
    }
    return false;
  }
  try {
    await Promise.race([
      job.done,
      ...(scenario === 'success' ? [] : [waitForQuestion()]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('FILE_MODEL_TIMEOUT')), 90_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    watch.abort();
  }
  if (question) {
    await models.stop(bot);
    await job.done;
  }
  const entries: TranscriptItem[] = [];
  let after: number | undefined = 0;
  do {
    const page = await models.transcript(scope, after);
    entries.push(...page.items);
    after = page.nextAfter;
  } while (after !== undefined);
  const calls: {
    name?: string;
    arguments: string;
    outcome: 'missing' | 'error' | 'ok';
    result?: string;
    code?: string;
  }[] = [];
  for (const item of entries) {
    if (item.kind !== 'call') continue;
    const { text } = await models.transcriptContent(scope, item.seq);
    const result = entries.find((entry) => entry.kind === 'result' && entry.callId === item.callId);
    const response = result ? await models.transcriptContent(scope, result.seq) : undefined;
    calls.push({
      name: item.name?.replace(/^mcp__computer__/, ''),
      arguments: text.replaceAll(root, '<test-root>'),
      outcome: !result ? 'missing' : result.isError ? 'error' : 'ok',
      result: response?.text.replaceAll(root, '<test-root>'),
      ...(result?.code ? { code: result.code } : {}),
    });
  }
  const artifact = await readFile(path.join(job.workdir, 'orders.csv'), 'utf8').catch(() => '');
  const [header, ...rows] = artifact.trim().split(/\r?\n/);
  const outputCorrect =
    header === 'order_id,amount' &&
    rows.length === 3 &&
    JSON.stringify(
      rows
        .map((row) => row.split(','))
        .sort()
        .map(([id, amount]) => [id, Number(amount)]),
    ) ===
      JSON.stringify([
        ['T-001', 12.5],
        ['T-002', 37.25],
        ['T-003', 9.75],
      ]);
  const count = rows.length;
  const total = rows.reduce((sum, row) => sum + Number(row.split(',')[1]), 0);
  const matchesPath = (args: string, name: string) =>
    [
      name,
      `/workspace/${name}`,
      path.join(job.workdir, name).replaceAll(root, '<test-root>'),
    ].includes(String(parseObject(args).path));
  const saved = calls.findIndex(
    (call) =>
      call.name === 'write_file' &&
      call.outcome === 'ok' &&
      matchesPath(call.arguments, 'orders.csv'),
  );
  const readInputFiles =
    saved >= 0 &&
    files.every(({ name, content }) =>
      calls
        .slice(0, saved)
        .some(
          (call) =>
            call.name === 'read_file' &&
            call.outcome === 'ok' &&
            matchesPath(call.arguments, name) &&
            parseObject(call.result ?? '').content === content,
        ),
    );
  const verified =
    saved >= 0 &&
    calls
      .slice(saved + 1)
      .some(
        (call) =>
          call.name === 'verify_csv' &&
          call.outcome === 'ok' &&
          matchesPath(call.arguments, 'orders.csv') &&
          parseObject(call.result ?? '').passed === true,
      );
  const delivered = job.files.some((file) => file.name === 'orders.csv');
  const reportedTotals =
    /(?<!\d)3(?!\d)/.test(job.result ?? '') && /(?<!\d)59\.50?(?!\d)/.test(job.result ?? '');
  const inputsUnchanged = (
    await Promise.all(
      files.map(
        async ({ name, content }) =>
          (await readFile(path.join(job.workdir, name), 'utf8').catch(() => null)) === content,
      ),
    )
  ).every(Boolean);
  console.log(
    JSON.stringify(
      {
        scenario,
        prompt,
        model: job.route?.apiModel,
        phase: job.phase,
        error: job.error,
        elapsedMs: job.elapsedMs,
        calls,
        artifact: artifact || null,
        outputCorrect,
        inputsUnchanged,
        readInputFiles,
        runtimeCsvCheckPassed: verified && job.verification.passed,
        delivered,
        reportedTotals,
        count,
        total,
        reply: job.result?.replaceAll(root, '<test-root>'),
        ...(question ? { question } : {}),
      },
      null,
      2,
    ),
  );
  if (scenario !== 'success') {
    const followup = question || job.result || '';
    const asks = /[？?]|请.*(?:上传|补充|确认|提供)|能否|是否/.test(followup);
    const specific =
      scenario === 'missing'
        ? /第二|另一|剩余|缺少|还缺|少了/.test(followup)
        : /同名|覆盖|保留|另存|已有|已存在/.test(followup);
    assert.ok(
      question && asks && specific && inputsUnchanged && job.files.length === 0,
      'Expected a specific clarification and preserved inputs.',
    );
  } else if (
    job.phase !== 'completed' ||
    !outputCorrect ||
    !inputsUnchanged ||
    !readInputFiles ||
    !verified ||
    !job.verification.passed ||
    !delivered ||
    !reportedTotals
  )
    process.exitCode = 1;
} finally {
  try {
    await agent?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
