import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { Knowledge } from './knowledge.js';
import { KnowledgeTools } from './knowledge-tools.js';

function value<T>(result: ToolResult): T {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const item = result.content[0];
  assert.equal(item.type, 'text');
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
    assert.equal(found.files[0].id, first.id);
    assert.match(found.files[0].preview.content, /47/);
    assert.equal(
      value<{ content: string }>(await tools.invoke(run, 'bot_knowledge_read', { id: first.id }))
        .content,
      '保留的段落\n报价上限 47\n',
    );
    const edited = value<{ revision: number }>(
      await tools.invoke(run, 'bot_knowledge_edit', {
        id: first.id,
        revision: 1,
        oldText: '47',
        newText: '53',
      }),
    );
    assert.equal((await store.read(run.bot, first.id)).content, '保留的段落\n报价上限 53\n');
    await tools.invoke(run, 'bot_knowledge_export', {
      id: first.id,
      revision: edited.revision,
      target: 'copy.md',
    });
    assert.equal(
      await readFile(path.join(workdir, 'copy.md'), 'utf8'),
      '保留的段落\n报价上限 53\n',
    );
    await writeFile(path.join(workdir, 'protected.md'), 'existing synthetic input');
    assert.equal(
      (
        await tools.invoke(run, 'bot_knowledge_export', {
          id: first.id,
          revision: edited.revision,
          target: 'protected.md',
        })
      ).isError,
      true,
    );
    assert.equal(
      await readFile(path.join(workdir, 'protected.md'), 'utf8'),
      'existing synthetic input',
    );
    await symlink(path.join(root, 'outside.md'), path.join(workdir, 'escape.md'));
    assert.equal(
      (
        await tools.invoke(run, 'bot_knowledge_export', {
          id: first.id,
          revision: edited.revision,
          target: 'escape.md',
        })
      ).isError,
      true,
    );
    const deleted = value<{ revision: number }>(
      await tools.invoke(run, 'bot_knowledge_delete', { id: first.id, revision: edited.revision }),
    );
    assert.equal(
      value<{ files: unknown[] }>(await tools.invoke(run, 'bot_knowledge_search')).files.length,
      0,
    );
    assert.equal(
      value<{ files: unknown[] }>(
        await tools.invoke(run, 'bot_knowledge_search', { includeDeleted: true }),
      ).files.length,
      1,
    );
    const restored = value<{ revision: number }>(
      await tools.invoke(run, 'bot_knowledge_restore', {
        id: first.id,
        revision: deleted.revision,
        targetRevision: 1,
      }),
    );
    assert.equal((await store.read(run.bot, first.id)).content, '保留的段落\n报价上限 47\n');
    assert.ok(restored.revision > deleted.revision);
    assert.equal(
      (await tools.invoke({ ...run, bot: 'mock-beta' }, 'bot_knowledge_read', { id: first.id }))
        .isError,
      true,
    );
    assert.equal(
      (await tools.invoke(run, 'bot_knowledge_read', { id: first.id, bot: 'mock-beta' })).isError,
      true,
    );
    const limited = { ...run, toolCount: 0, limit: 1 };
    await tools.invoke(limited, 'bot_knowledge_search');
    assert.match(
      JSON.stringify(
        await tools.invoke(limited, 'bot_knowledge_delete', {
          id: first.id,
          revision: restored.revision,
        }),
      ),
      /TOOL_LIMIT/,
    );
    assert.ok(run.trace.every((item) => item.surface === 'knowledge'));
    assert.equal(JSON.stringify(run.trace).includes('报价'), false);
    await tools.drain(run);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
