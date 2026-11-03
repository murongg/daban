import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GroupPage, RuntimeFile, TaskRequest } from '@daban/protocol';
import type { ToolResult } from './computer-tools.js';
import { GroupTools } from './group-tools.js';
import { Groups } from './groups.js';
import { ModelRuns } from './model.js';
import { redact } from './redaction.js';
import { ModelSettings } from './settings.js';

const coordinator = 'mock-cedar';
const accountant = 'mock-oak';
const reviewer = 'mock-willow';
const artist = 'mock-iris';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const pause = () => new Promise((resolve) => setTimeout(resolve, 250));

// Manual paid-model test. Credentials are read from the configured client, never copied or saved.
export async function acceptGroupCreation(
  credentials: string,
  output: string,
  sdkFile = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client'),
) {
  const settings = new ModelSettings(path.resolve(credentials));
  const route = await settings.resolve();
  const credentialBefore = await stat(settings.file);
  const credentialHash = hash(await readFile(settings.file));
  const root = await mkdtemp(path.join(tmpdir(), 'daban-group-create-live-'));
  const workspace = path.join(root, 'workspace');
  const marker = `DM-ONLY-${randomBytes(6).toString('hex')}`;
  const privateRuns = new Map<string, string>();
  const privateSessions = new Map<string, string>();
  const calls: { bot: string; name: string; isError: boolean }[] = [];
  const creations: { bot: string; args: Record<string, unknown>; result: unknown }[] = [];
  const probes: { bot: string; historyDenied: boolean; nestedCreationDenied: boolean }[] = [];
  const stages: { bot: string; session: string | undefined; prompt: string; trace: unknown }[] = [];
  const report: Record<string, unknown> = { passed: false, model: route.apiModel };
  let models!: ModelRuns;
  let groups!: Groups;
  let sourceRun = '';
  let wire = 0;
  const server = createServer(async (request, response) => {
    try {
      const bot = request.url?.match(/^\/mcp\/(mock-[a-z]+)$/)?.[1];
      assert.ok(models && bot && request.method === 'POST');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert.ok(size <= 512 * 1024);
        chunks.push(Buffer.from(chunk));
      }
      const rpc: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const reply = await models.rpc(bot, request.headers.authorization, rpc);
      if (object(rpc) && rpc.method === 'tools/call' && object(rpc.params)) {
        const name = String(rpc.params.name);
        const result = reply && 'result' in reply ? (reply.result as ToolResult) : undefined;
        calls.push({ bot, name, isError: result?.isError === true });
        if (name === 'group_create' && object(rpc.params.arguments) && result) {
          const block = result.content[0];
          creations.push({
            bot,
            args: structuredClone(rpc.params.arguments),
            result: block?.type === 'text' && !result.isError ? JSON.parse(block.text) : result,
          });
        }
      }
      response.writeHead(reply === null ? 202 : 200, { 'content-type': 'application/json' });
      response.end(reply === null ? undefined : JSON.stringify(reply));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":"LIVE_ACCEPTANCE_RPC_FAILED"}');
    }
  });
  async function finish(bot: string) {
    const job = models.jobs.get(bot)!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        job.done,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('LIVE_ACCEPTANCE_TIMEOUT')), 240000);
        }),
      ]);
      assert.equal(job.phase, 'completed', job.error || `Task failed: ${bot}`);
      return job;
    } catch (error) {
      await models.stop(bot, 'live-acceptance-timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function open() {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    models = new ModelRuns({
      settings,
      sdkFile,
      workspace,
      dir: path.join(root, 'model'),
      origin: `http://127.0.0.1:${address.port}`,
    });
    await models.ready;
    groups = new Groups(
      path.join(root, 'groups.sqlite'),
      {
        member: (id) => models.profiles.get(id),
        directory: () => models.profiles.list(),
        source: (bot, runId) => models.groupSource(bot, runId),
        running: (bot) => models.running(bot),
        groupRunning: (id) => models.groupRunning(id),
        admit: (bot) => models.admit(bot),
        findRequest: (bot, id) => models.findRequest(bot, id),
        start: async (bot, task, scope) => {
          await models.start(bot, task, scope);
          const job = models.jobs.get(bot)!;
          const probe = async (name: string, args: Record<string, unknown>) => {
            const reply = await models.rpc(bot, `Bearer ${job.token}`, {
              id: `verifier-probe-${++wire}`,
              method: 'tools/call',
              params: { name, arguments: args },
            });
            assert.ok(reply && 'result' in reply);
            return reply.result as ToolResult;
          };
          // These are verifier probes, separate from the model's observed HTTP tool calls.
          const history = await probe('bot_history_read', {
            runId: privateRuns.get(bot) || privateRuns.get(accountant),
            field: 'prompt',
          });
          const nested = await probe('group_create', creations[0].args);
          probes.push({
            bot,
            historyDenied:
              history.isError === true && JSON.stringify(history).includes('HISTORY_NOT_FOUND'),
            nestedCreationDenied:
              nested.isError === true && JSON.stringify(nested).includes('GROUP_SOURCE_CLOSED'),
          });
        },
        stopRequest: (bot, id, group) => models.stopRequest(bot, id, group),
      },
      models.attachments,
    );
    await groups.ready;
    models.tools.groups = new GroupTools(groups);
    models.attachmentPinned = (owner, id) => groups.inputBusy(owner, id);
  }
  let page: GroupPage | undefined;
  try {
    await mkdir(workspace);
    await new Promise<unknown>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    await open();
    for (const [id, name, instructions] of [
      [
        coordinator,
        'Cedar',
        'Coordinate complementary specialists. In a group, summarize only after their work is ready.',
      ],
      [
        accountant,
        'Oak',
        'Ledger specialist. Compute and verify synthetic paid invoice counts and totals. In a group, read shared history and hand off the result file to the editorial reviewer.',
      ],
      [
        reviewer,
        'Willow',
        'Editorial reviewer. Inspect the ledger specialist’s actual file, check its figures, and write a concise review.',
      ],
      [
        artist,
        'Iris',
        'Visual artist. Create illustrations, color palettes and image compositions. Do not do ledger auditing.',
      ],
    ])
      await models.profiles.register({ id, name, instructions, memory: '', color: 'mint' });
    for (const bot of [coordinator, accountant]) {
      await models.start(bot, {
        requestId: `mock-private-${bot}`,
        prompt: `Synthetic private conversation. Remember this private marker: ${marker}-${bot}. Reply with that marker only. Do not call tools. This marker is unrelated to future tasks.`,
      });
      const job = await finish(bot);
      assert.ok(job.result.includes(`${marker}-${bot}`));
      privateRuns.set(bot, job.id);
      privateSessions.set(bot, job.sessionId!);
    }
    console.log('Private synthetic sessions prepared; starting role selection.');
    const task: TaskRequest = {
      requestId: 'mock-create-collaboration',
      prompt:
        'This synthetic task needs ledger calculation and editorial review. Find suitable existing Bots by their roles and create a group with only the necessary specialists. A visual artist is unnecessary. Share this task and assignments only, without earlier private conversations or the attached isolation file. Data: invoice MOCK-A is paid, amount 7; MOCK-B is paid, amount 11; MOCK-C is cancelled, amount 100. The ledger specialist must read group history, calculate paid_count and paid_total, write calculation.json with these fields and marker MOCK-CALC-18, then use the group handoff tool to give its exact /shared file path to the editorial reviewer and finish. The reviewer must read group history and that actual file, verify the figures, and write review.md containing MOCK-REVIEW-18. You coordinate, then run last in the group: read both actual files and write final.md containing MOCK-FINAL-18, paid_count=2 and paid_total=18; finish with MOCK-GROUP-DONE-18. Each member performs only its own assignment. No web, GUI, shell, external messages, extra Bots or extra groups. After creating the group, replay the exact same creation arguments once to test transport retry, then finish this private reply with the group name. Do not execute the specialists’ work in this private conversation.',
      files: [{ name: 'private-isolation.txt', content: `ATTACHMENT-ONLY-${marker}` }],
    };
    await models.start(coordinator, task);
    const source = await finish(coordinator);
    sourceRun = source.id;
    assert.equal(source.sessionId, privateSessions.get(coordinator));
    const status = await groups.status();
    assert.equal(status.items.length, 1, 'The model must create exactly one group.');
    const group = status.items[0];
    assert.deepEqual(new Set(group.members), new Set([coordinator, accountant, reviewer]));
    assert.ok(
      calls.some(
        (call) => call.bot === coordinator && call.name === 'group_directory' && !call.isError,
      ),
    );
    assert.ok(creations.length >= 2, 'The model must replay its creation call once.');
    assert.ok(object(creations[0].result) && creations[0].result.reused === false);
    assert.ok(object(creations[1].result) && creations[1].result.reused === true);
    assert.deepEqual(creations[0].args, creations[1].args);
    page = await groups.read(group.id);
    assert.equal(page.messages[0].role, 'bot');
    assert.equal(page.messages[0].author, coordinator);
    assert.equal(page.deliveries.length, 3);
    assert.equal(page.deliveries.at(-1)!.bot, coordinator);
    assert.ok(!JSON.stringify(page).includes(marker));
    assert.ok(!JSON.stringify(page).includes('private-isolation.txt'));
    console.log('Role selection and creation replay passed; executing group stages.');
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      await groups.tick();
      page = await groups.read(group.id);
      for (const delivery of page.deliveries) {
        if (!delivery.runId || stages.some((stage) => stage.bot === delivery.bot)) continue;
        const job = models.jobs.get(delivery.bot);
        if (!job || job.running) continue;
        await finish(delivery.bot);
        assert.notEqual(job.sessionId, privateSessions.get(delivery.bot));
        assert.ok(!(job.prompt || '').includes(marker));
        stages.push({
          bot: job.bot,
          session: job.sessionId,
          prompt: job.prompt || '',
          trace: job.trace,
        });
      }
      assert.equal(
        (await models.interactions.list()).filter((item) => item.status === 'pending').length,
        0,
        'The complete synthetic task should need no human question or external approval.',
      );
      if (
        page.deliveries.every((item) =>
          ['completed', 'failed', 'interrupted', 'cancelled'].includes(item.state),
        )
      )
        break;
      await pause();
    }
    assert.ok(page);
    assert.deepEqual(
      page.deliveries.map((item) => item.state),
      ['completed', 'completed', 'completed'],
    );
    assert.equal(probes.length, 3);
    assert.ok(probes.every((probe) => probe.historyDenied && probe.nestedCreationDenied));
    assert.ok(
      calls.some(
        (call) => call.bot === accountant && call.name === 'group_handoff' && !call.isError,
      ),
    );
    assert.ok(
      calls.some((call) => call.bot === reviewer && call.name === 'read_file' && !call.isError),
    );
    assert.ok(!models.jobs.has(artist));
    assert.ok(!JSON.stringify(page).includes(marker));
    const outputs: Record<string, string> = {};
    const artifactDirectory = `${path.resolve(output)}.files`;
    await mkdir(artifactDirectory, { recursive: true });
    const canonicalWorkspace = await realpath(workspace);
    for (const name of ['calculation.json', 'review.md', 'final.md']) {
      const file: RuntimeFile | undefined = page.messages
        .flatMap((message) => message.files || [])
        .find((file) => file.name === name);
      assert.ok(file, `Missing actual output: ${name}`);
      const actual: string = await realpath(path.join(workspace, file.path));
      assert.ok(actual.startsWith(canonicalWorkspace + path.sep));
      outputs[name] = await readFile(actual, 'utf8');
      assert.ok(!outputs[name].includes(marker));
      await writeFile(path.join(artifactDirectory, name), outputs[name], { mode: 0o600 });
    }
    const calculation: unknown = JSON.parse(outputs['calculation.json']);
    assert.ok(object(calculation) && calculation.paid_count === 2 && calculation.paid_total === 18);
    assert.ok(outputs['review.md'].includes('MOCK-REVIEW-18'));
    assert.ok(outputs['final.md'].includes('MOCK-FINAL-18'));
    assert.match(models.jobs.get(coordinator)!.result, /MOCK-GROUP-DONE-18/);
    for (const bot of [coordinator, accountant]) {
      await models.start(bot, {
        requestId: `mock-resume-${bot}`,
        prompt:
          'Reply with the private marker from this private conversation only. Do not call tools or refer to a group.',
      });
      const job = await finish(bot);
      assert.equal(job.sessionId, privateSessions.get(bot));
      assert.ok(job.result.includes(`${marker}-${bot}`));
    }
    const beforeRetry = await groups.read(group.id);
    const creationsBeforeRetry = creations.length;
    console.log('Group artifacts and context isolation passed; restarting before task retry.');
    await groups.close();
    await models.close();
    await open();
    await models.start(coordinator, {
      requestId: 'mock-retry-collaboration',
      retryOf: sourceRun,
      prompt: `Retry the same task’s accepted group creation only. Call group_create once with these exact original arguments, then explain that the existing group was reused. Do not dispatch or repeat completed work. Arguments: ${JSON.stringify(creations[0].args)}`,
    });
    await finish(coordinator);
    assert.equal(creations.length, creationsBeforeRetry + 1);
    const retryResult = creations.at(-1)!.result;
    assert.ok(object(retryResult) && retryResult.reused === true);
    assert.equal((await groups.status()).items.length, 1);
    assert.deepEqual((await groups.read(group.id)).deliveries, beforeRetry.deliveries);
    assert.deepEqual((await groups.read(group.id)).messages, beforeRetry.messages);
    const after = await stat(settings.file);
    assert.equal(hash(await readFile(settings.file)), credentialHash);
    assert.deepEqual(
      [after.ino, after.size, after.mtimeMs, after.mode],
      [
        credentialBefore.ino,
        credentialBefore.size,
        credentialBefore.mtimeMs,
        credentialBefore.mode,
      ],
    );
    Object.assign(report, {
      passed: true,
      selectedRoles: ['ledger specialist', 'editorial reviewer'],
      group: page,
      modelCalls: calls,
      creations,
      verifierProbes: probes,
      stages,
      outputs,
      dmResumed: true,
      credentialUnchanged: true,
      restartRetryDeduplicated: true,
    });
    return { passed: true, model: route.apiModel, group: group.id, stages: page.deliveries.length };
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'LIVE_GROUP_ACCEPTANCE_FAILED';
    Object.assign(report, {
      group: page,
      modelCalls: calls,
      creations,
      verifierProbes: probes,
      stages,
    });
    throw error;
  } finally {
    await groups?.close();
    await models?.close();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(
      path.resolve(output),
      `${JSON.stringify(
        report,
        (_key, value: unknown) =>
          typeof value === 'string' ? redact(value, route.secrets) : value,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [credentials, output, sdkFile] = process.argv.slice(2);
  if (!credentials || !output) {
    console.error(
      'Usage: group-create.acceptance.js <credentials.json> <evidence.json> [sdk-file]',
    );
    process.exitCode = 1;
  } else {
    acceptGroupCreation(credentials, output, sdkFile).then(
      (result) => console.log(JSON.stringify(result)),
      () => {
        console.error(
          'Live group acceptance failed; see the redacted evidence file if initialization completed.',
        );
        process.exitCode = 1;
      },
    );
  }
}
