import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { executionAttemptId } from './agent-tools.js';
import { RemoteExecutor } from './execution.js';
import { startExecutor } from './executor.js';
import { ModelRuns } from './model.js';
import { RemoteWorkspace } from './remote-workspace.js';
import { ModelSettings } from './settings.js';

test.each([false])(
  'VM fallback keeps its logical task and fresh execution lease (project=%s)',
  async (scoped) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-executor-'));
    const service = await startExecutor({
      directory: path.join(root, 'guest'),
      port: 0,
      boot: 'mock-model-guest',
    });
    let models: ModelRuns | undefined;
    onTestFinished(async () => {
      await models?.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    });
    const frames: { method: string; params: Record<string, unknown> }[] = [];
    const drained: number[] = [];
    const client = new RemoteExecutor({
      url: `${service.origin}/exec`,
      token: (await readFile(path.join(root, 'guest/token'), 'utf8')).trim(),
      fetcher: async (url, init) => {
        const frame = JSON.parse(String(init?.body)) as {
          method: string;
          params: Record<string, unknown>;
        };
        frames.push(frame);
        if (
          frame.method === 'tools.open' &&
          frames.filter((entry) => entry.method === 'tools.open').length === 2
        ) {
          const job = models!.jobs.get('mock-bot')!;
          const saved = await models!.journal.read(job.bot, job.id);
          expect(saved?.attemptSummary?.at(-1)?.attemptId).toBe(job.attemptId);
          expect(saved?.intentId).toBe('mock-vm-root');
          expect((await models!.journal.recovery(job.bot, job.id))?.toolCount).toBe(57);
        }
        const response = await fetch(url, init);
        if (frame.method === 'tools.drain') {
          const reply = (await response.clone().json()) as {
            ok: boolean;
            value?: { toolCount?: number };
          };
          if (reply.ok && reply.value?.toolCount !== undefined) drained.push(reply.value.toolCount);
        }
        return response;
      },
    });
    await client.ready;
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
      Response.json({ data: [{ id: 'mock-primary' }, { id: 'mock-backup' }] }),
    );
    let oldToken = '';
    let oldSession = '';
    const limits: unknown[] = [];
    class Harness {
      constructor(readonly options: { model: string; patches: string[] }) {}
      async start() {
        const patch = JSON.parse(await readFile(this.options.patches[0], 'utf8')) as {
          insert?: { id?: string; config?: { limit?: number } }[];
        }[];
        limits.push(
          patch.flatMap((entry) => entry.insert ?? []).find((entry) => entry.id === 'daban-policy')
            ?.config?.limit,
        );
      }
      async close() {
        const job = models!.jobs.get('mock-bot')!;
        if (job.token && !job.abort.signal.aborted)
          await models!.rpc(job.bot, `Bearer ${job.token}`, {
            id: 'mock-closed',
            method: 'attempt.closed',
            params: { sessionId: job.sessionId, attemptId: job.attemptId, fence: 'clean' },
          });
      }
      session() {
        const id = `mock-${this.options.model}`;
        return {
          id,
          run: async () => {
            const job = models!.jobs.get('mock-bot')!;
            if (this.options.model === 'mock-primary') {
              oldToken = job.token;
              oldSession = id;
              return {
                sessionId: id,
                finalResponse: '',
                events: [
                  {
                    type: 'turn/end',
                    data: { reason: { kind: 'error', error: { code: 'AUTH' } } },
                  },
                ],
              };
            }
            await expect(
              models!.rpc(job.bot, `Bearer ${oldToken}`, {
                id: 'mock-stale',
                method: 'response.update',
                params: {
                  sessionId: oldSession,
                  revision: 1,
                  text: 'Synthetic stale output',
                  state: 'streaming',
                },
              }),
            ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
            const call = (request: string, name: string, args: Record<string, unknown>) =>
              models!.rpc(job.bot, `Bearer ${job.token}`, {
                id: request,
                method: 'tools/call',
                params: { name, arguments: args },
              });
            const input = await call('mock-read', 'read_file', { path: 'mock-input.txt' });
            expect(JSON.stringify(input)).toContain('Synthetic input bytes');
            const args = { path: 'result.txt', content: 'SYNTHETIC VM RESULT' };
            const written = await call('mock-write', 'write_file', args);
            expect(JSON.stringify(written)).not.toContain('isError');
            const denied = await call('mock-escape', 'write_file', {
              path: '/outside.txt',
              content: 'SYNTHETIC DENIED',
            });
            expect(JSON.stringify(denied)).toContain('isError');
            expect(JSON.stringify(denied)).toContain('INVALID_FILE');
            return { sessionId: id, finalResponse: 'Synthetic VM fallback complete' };
          },
        };
      }
      async resumeSession(): Promise<never> {
        throw new Error('A VM fallback must create its own SDK session');
      }
    }
    await settings.configure({
      model: 'provider:mock-vm:mock-primary',
      apiKey: 'synthetic-vm-key',
      revision: 0,
      requestId: 'mock-vm-config',
      connection: {
        id: 'mock-vm',
        name: 'Synthetic VM provider',
        baseURL: 'https://vm.example.test/v1',
        models: ['mock-primary', 'mock-backup'].map((id) => ({
          id,
          name: id,
          vision: id === 'mock-backup',
          contextWindow: 64000,
          maxTokens: 2048,
          capabilities: { toolCall: true },
        })),
      },
    });
    await settings.fallback({
      scope: (await settings.status(true)).modelAccess!.scope,
      revision: 1,
      requestId: 'mock-vm-fallback',
      model: 'provider:mock-vm:mock-backup',
    });
    const workspace = new RemoteWorkspace(client);
    models = new ModelRuns({
      settings,
      Harness,
      execution: client,
      workspace,
      dir: path.join(root, 'host'),
      origin: 'http://127.0.0.1:12345',
    });
    await models.ready;
    const conversation = { id: 'mock-group', context: 'Synthetic private group context' };
    const project = scoped ? { projectId: 'mock-vm-project', revision: 1 } : undefined;
    const priorWorkspace = workspace;
    const prior = await priorWorkspace.create(['model-runs', 'mock-vm-root', 'mock-bot']);
    await prior.write('mock-input.txt', Buffer.from('Synthetic input bytes'));
    await prior.close();
    await models.journal.put({
      bot: 'mock-bot',
      runId: 'mock-vm-root',
      ...(project ? { project } : {}),
      intentId: 'mock-vm-root',
      conversationId: conversation.id,
      prompt: 'Write the synthetic result.',
      phase: 'failed',
      running: false,
      result: '',
      error: '',
      trace: [],
      toolCount: 57,
      activeMs: 100,
      outputDirectory: prior.path,
      inputs: ['mock-input.txt'],
    });
    const input = {
      requestId: 'mock-vm-task',
      ...(project ? { project } : {}),
      prompt: 'Write the synthetic result.',
      retryOf: 'mock-vm-root',
    };
    const accepted = await models.start('mock-bot', input, conversation);
    const job = models.jobs.get('mock-bot')!;
    await job.done;
    expect(job.phase, job.error).toBe('completed');
    expect(job.id).toBe(accepted.runId);
    expect(job.intentId).toBe('mock-vm-root');
    expect(job.requestId).toBe(input.requestId);
    expect(job.conversationId).toBe(conversation.id);
    expect(job.toolCount).toBe(60);
    expect(limits).toEqual([3, 3]);
    expect(drained).toEqual([0, 3]);
    expect(job.attemptSummary).toHaveLength(2);
    expect(job.attemptSummary?.[0].fence).toBe('clean');
    const opens = frames.filter((frame) => frame.method === 'tools.open');
    expect(opens).toHaveLength(2);
    expect(opens.map((frame) => frame.params.id)).toEqual(
      job.attemptSummary!.map((attempt) => executionAttemptId(job.id, attempt.attemptId)),
    );
    expect(opens[1].params.id).not.toBe(opens[0].params.id);
    if (project) {
      expect(opens.map((frame) => frame.params.taskRunId)).toEqual([job.id, job.id]);
      await expect(
        client.call('tools.open', {
          ...opens[1].params,
          id: 'mock-forged-attempt',
          taskRunId: 'mock-foreign-task',
        }),
      ).rejects.toMatchObject({ code: 'EXECUTION_WORKSPACE_SCOPE' });
    }
    expect(opens.map((frame) => frame.params.model)).toEqual([
      'provider:mock-vm:mock-primary',
      'provider:mock-vm:mock-backup',
    ]);
    expect(opens.map((frame) => frame.params.vision)).toEqual([false, true]);
    expect(opens[1].params.workdir).toBe(opens[0].params.workdir);
    expect(opens[1].params.canonicalRoot).toBe(opens[0].params.canonicalRoot);
    for (const frame of opens)
      await expect(client.call('tools.open', frame.params)).rejects.toMatchObject({
        code: 'EXECUTION_RUN_CLOSED',
      });
    expect(frames.filter((frame) => frame.method === 'tools.invoke')).toHaveLength(3);
    expect(await readFile(path.join(job.workdir, 'result.txt'), 'utf8')).toBe(
      'SYNTHETIC VM RESULT',
    );
    expect(await readFile(path.join(job.workdir, 'mock-input.txt'), 'utf8')).toBe(
      'Synthetic input bytes',
    );
    expect(JSON.stringify(frames)).not.toContain('synthetic-vm-key');
    expect(JSON.stringify(frames)).not.toContain(conversation.context);
    const before = frames.length;
    expect((await models.start('mock-bot', input, conversation)).runId).toBe(job.id);
    expect(frames).toHaveLength(before);
    expect((await models.journal.recovery('mock-bot', job.id))?.toolCount).toBe(60);
    await expect(
      models.start('mock-bot', { ...input, requestId: 'mock-vm-exhausted' }, conversation),
    ).rejects.toMatchObject({ code: 'TOOL_LIMIT' });
    expect(frames).toHaveLength(before);
  },
);
