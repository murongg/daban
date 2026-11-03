import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { syntheticPng } from './images.fixture.js';
import { WorkspaceFiles } from './workspace.js';

test('Office previews read real synthetic raster bytes through workspace checks and refuse text models and links', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-office-preview-')));
  const workdir = path.join(root, 'task');
  await mkdir(workdir);
  const run: AgentToolRun = {
    id: 'mock-image-run',
    bot: 'mock-bot',
    vision: true,
    abort: new AbortController(),
    toolCount: 0,
    limit: 20,
    seen: {},
    trace: [],
    workdir,
    canonicalRoot: workdir,
  };
  const tools = new AgentTools(undefined, new WorkspaceFiles(root));
  try {
    await writeFile(path.join(workdir, 'preview.png'), Buffer.from(syntheticPng.data, 'base64'));
    const result = await tools.invoke(run, 'read_image', { path: '/workspace/preview.png' });
    expect(result).toStrictEqual({
      content: [{ type: 'image', mimeType: 'image/png', data: syntheticPng.data }],
    });
    const textRun = { ...run, vision: false };
    expect(
      tools.list(run.bot, undefined, undefined, textRun).some((tool) => tool.name === 'read_image'),
    ).toBe(false);
    expect((await tools.invoke(textRun, 'read_image', { path: 'preview.png' })).isError).toBe(true);
    await symlink(path.join(workdir, 'preview.png'), path.join(workdir, 'linked.png'));
    expect((await tools.invoke(run, 'read_image', { path: 'linked.png' })).isError).toBe(true);
    expect((await tools.invoke(run, 'read_image', { path: '/etc/passwd' })).isError).toBe(true);
    run.abort.abort();
    expect((await tools.invoke(run, 'read_image', { path: 'preview.png' })).isError).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
