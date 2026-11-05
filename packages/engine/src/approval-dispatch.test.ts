import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { AgentTools } from './agent-tools.js';
import { Commands } from './commands.js';
import { Fault } from './control.js';
import { Interactions } from './interactions.js';
import { WorkspaceFiles } from './workspace.js';

test.each(['authority', 'attempt'] as const)(
  'a changed %s during guest preparation cannot send the approved command',
  async (change) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-approval-dispatch-'));
    const cards = new Interactions(path.join(root, 'interactions'));
    const run = {
      id: 'mock-run',
      bot: 'mock-bot',
      sessionId: 'mock-session',
      executionId: 'mock-execution-before',
      workdir: '/workspace/mock',
      canonicalRoot: '/workspace/mock',
      abort: new AbortController(),
      task: { requestId: 'mock-task', prompt: 'Synthetic task', approvalMode: 'full' as const },
      toolCount: 0,
      limit: 10,
      seen: {},
      trace: [],
    };
    let effects = 0;
    let revoked = false;
    const execution = {
      snapshot: { capabilities: [] },
      call: async (method: string) => {
        if (method === 'tools.open') {
          if (change === 'authority') revoked = true;
          else run.executionId = 'mock-execution-after';
          return {
            tools: [
              { name: 'shell', description: 'Synthetic shell', inputSchema: { type: 'object' } },
            ],
          };
        }
        if (method === 'tools.invoke') {
          effects++;
          return { phase: 'settled', result: { content: [{ type: 'text', text: 'SYNTHETIC' }] } };
        }
        return undefined;
      },
    };
    const tools = new AgentTools(undefined, new WorkspaceFiles(root), { execution });
    const commands = new Commands({
      file: path.join(root, 'commands.sqlite'),
      interactions: cards,
      assertLive: () => {
        if (revoked) throw new Fault('COMMAND_AUTHORITY_CHANGED');
      },
    });
    tools.executeRemote = commands.invoke.bind(commands);
    try {
      const result = await tools.invoke(run, 'shell', { command: 'ls' }, 'mock-call');
      expect(result.isError).toBe(true);
      expect(effects).toBe(0);
    } finally {
      run.abort.abort();
      await commands.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
