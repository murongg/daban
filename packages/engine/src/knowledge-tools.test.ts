import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { Knowledge } from './knowledge.js';
import { KnowledgeTools } from './knowledge-tools.js';

function value<T>(result: ToolResult): T {
  expect(result.isError, JSON.stringify(result)).toBe(undefined);
  const item = result.content[0];
  expect(item.type).toBe('text');
  return JSON.parse(item.type === 'text' ? item.text : '') as T;
}
test('knowledge tools search and patch owned documents, export safe copies and retain restorable history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-knowledge-tools-'));
  const store = new Knowledge(path.join(root, 'knowledge.sqlite'));
  try {
    const workdir = path.join(root, 'workspace');
    await mkdir(workdir);
    const tools = new AgentTools(
      undefined,
      new (await import('./workspace.js')).WorkspaceFiles(workdir),
    );
    tools.knowledge = new KnowledgeTools(store, (run, name, content) =>
      tools.writeText(run, name, content, true),
    );
    const run: AgentToolRun = {
      id: 'mock-knowledge-run',
      bot: 'mock-alpha',
      abort: new AbortController(),
      toolCount: 0,
      limit: 30,
      seen: {},
      trace: [],
      workdir,
      canonicalRoot: await realpath(workdir),
    };
    const first = value<{ id: string; revision: number }>(
      await tools.invoke(run, 'bot_knowledge_write', {
        path: '合成规范.md',
        revision: 0,
        content: '保留的段落\n报价上限 47\n',
      }),
    );
    const found = value<{ files: { id: string; preview: { content: string } }[] }>(
      await tools.invoke(run, 'bot_knowledge_search', { query: '报价' }),
    );
    expect(found.files[0].id).toBe(first.id);
    expect(found.files[0].preview.content).toMatch(/47/);
    expect(
      value<{ content: string }>(await tools.invoke(run, 'bot_knowledge_read', { id: first.id }))
        .content,
    ).toBe('保留的段落\n报价上限 47\n');
    const edited = value<{ revision: number }>(
      await tools.invoke(run, 'bot_knowledge_edit', {
        id: first.id,
        revision: 1,
        oldText: '47',
        newText: '53',
      }),
    );
    expect((await store.read(run.bot, first.id)).content).toBe('保留的段落\n报价上限 53\n');
    await tools.invoke(run, 'bot_knowledge_export', {
      id: first.id,
      revision: edited.revision,
      target: 'copy.md',
    });
    expect(await readFile(path.join(workdir, 'copy.md'), 'utf8')).toBe('保留的段落\n报价上限 53\n');
    await writeFile(path.join(workdir, 'protected.md'), 'existing synthetic input');
    expect(
      (
        await tools.invoke(run, 'bot_knowledge_export', {
          id: first.id,
          revision: edited.revision,
          target: 'protected.md',
        })
      ).isError,
    ).toBe(true);
    expect(await readFile(path.join(workdir, 'protected.md'), 'utf8')).toBe(
      'existing synthetic input',
    );
    await symlink(path.join(root, 'outside.md'), path.join(workdir, 'escape.md'));
    expect(
      (
        await tools.invoke(run, 'bot_knowledge_export', {
          id: first.id,
          revision: edited.revision,
          target: 'escape.md',
        })
      ).isError,
    ).toBe(true);
    const deleted = value<{ revision: number }>(
      await tools.invoke(run, 'bot_knowledge_delete', { id: first.id, revision: edited.revision }),
    );
    expect(
      value<{ files: unknown[] }>(await tools.invoke(run, 'bot_knowledge_search')).files.length,
    ).toBe(0);
    expect(
      value<{ files: unknown[] }>(
        await tools.invoke(run, 'bot_knowledge_search', { includeDeleted: true }),
      ).files.length,
    ).toBe(1);
    const restored = value<{ revision: number }>(
      await tools.invoke(run, 'bot_knowledge_restore', {
        id: first.id,
        revision: deleted.revision,
        targetRevision: 1,
      }),
    );
    expect((await store.read(run.bot, first.id)).content).toBe('保留的段落\n报价上限 47\n');
    expect.assert(restored.revision > deleted.revision);
    expect(
      (await tools.invoke({ ...run, bot: 'mock-beta' }, 'bot_knowledge_read', { id: first.id }))
        .isError,
    ).toBe(true);
    expect(
      (await tools.invoke(run, 'bot_knowledge_read', { id: first.id, bot: 'mock-beta' })).isError,
    ).toBe(true);
    const limited = { ...run, toolCount: 0, limit: 1 };
    await tools.invoke(limited, 'bot_knowledge_search');
    expect(
      JSON.stringify(
        await tools.invoke(limited, 'bot_knowledge_delete', {
          id: first.id,
          revision: restored.revision,
        }),
      ),
    ).toMatch(/TOOL_LIMIT/);
    expect.assert(run.trace.every((item) => item.surface === 'knowledge'));
    expect(JSON.stringify(run.trace).includes('报价')).toBe(false);
    await tools.drain(run);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
