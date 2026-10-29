import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import type { ComputerFacade, ToolResult } from './computer-tools.js';
import { Control } from './control.js';
import { WorkspaceFiles } from './workspace.js';

function payload(result: ToolResult) {
  assert.ok(!result.isError, JSON.stringify(result));
  const part = result.content[0];
  return JSON.parse(part.type === 'text' ? part.text : '') as {
    exitCode: number;
    stdout: string;
    stderr: string;
  };
}
test('real Linux shell computes files without a desktop and cannot access private files, credentials or network', {
  skip: process.platform !== 'linux',
  timeout: 40000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-shell-'));
  const previous = process.env.DABAN_SYNTHETIC_SECRET;
  process.env.DABAN_SYNTHETIC_SECRET = 'synthetic-private-env';
  try {
    const workdir = path.join(root, 'work');
    await mkdir(workdir);
    await writeFile(path.join(root, 'private.txt'), 'synthetic-private-outside');
    await writeFile(path.join(workdir, 'input.csv'), 'item,amount\nMOCK-A,7\nMOCK-B,11\n');
    const forbidden = async (): Promise<never> => {
      throw new Error('desktop must stay unused');
    };
    const control = new Control(['a']);
    await control.transfer('a', 0, 'human');
    const computer: ComputerFacade = {
      control,
      frame: forbidden,
      screens: { input: forbidden, openApp: forbidden },
      browser: { frame: forbidden, input: forbidden },
    };
    const tools = new AgentTools(computer, new WorkspaceFiles(root));
    const run: AgentToolRun = {
      bot: 'a',
      abort: new AbortController(),
      toolCount: 0,
      limit: 12,
      seen: {},
      trace: [],
      workdir,
      canonicalRoot: await realpath(workdir),
    };
    const compute = payload(
      await tools.invoke(run, 'shell', {
        command: `python3 - <<'PY'
import csv, pathlib
rows=list(csv.DictReader(open('input.csv')))
total=sum(int(row['amount']) for row in rows)
pathlib.Path('summary.md').write_text('count='+str(len(rows))+' total='+str(total))
print(total)
PY`,
      }),
    );
    assert.equal(compute.exitCode, 0, compute.stderr);
    assert.equal(compute.stdout.trim(), '18');
    assert.equal(await readFile(path.join(workdir, 'summary.md'), 'utf8'), 'count=2 total=18');
    const reused = payload(
      await tools.invoke(run, 'shell', {
        command: `python3 - <<'PY'
import pathlib, os
source=pathlib.Path('/shared/work/input.csv')
assert source.read_text().startswith('item,amount')
pathlib.Path('/workspace/reused.txt').write_text(source.read_text())
try:
 source.write_text('forbidden')
except OSError:
 pass
else:
 raise AssertionError('shared mount was writable')
for fd in range(3,16):
 try:
  leaked=os.open('work/input.csv', os.O_WRONLY|os.O_TRUNC, dir_fd=fd)
 except OSError:
  continue
 else:
  os.close(leaked)
  raise AssertionError('shared directory descriptor leaked')
print('shared-readonly')
PY`,
      }),
    );
    assert.equal(reused.exitCode, 0, reused.stderr);
    assert.equal(reused.stdout.trim(), 'shared-readonly');
    assert.equal(
      await readFile(path.join(workdir, 'input.csv'), 'utf8'),
      'item,amount\nMOCK-A,7\nMOCK-B,11\n',
    );
    const isolation = payload(
      await tools.invoke(run, 'shell', {
        command: `python3 - <<'PY'
import os, pathlib, socket
assert os.environ.get('DEEPSEEK_API_KEY') is None
assert os.environ.get('DABAN_SYNTHETIC_SECRET') is None
assert not pathlib.Path(${JSON.stringify(path.join(root, 'private.txt'))}).exists()
assert not pathlib.Path('/var/lib/bot-prototype/model').exists()
try:
 socket.create_connection(('127.0.0.1',8766),timeout=.2)
except OSError:
 print('isolated')
else:
 raise AssertionError('network leaked')
PY`,
      }),
    );
    assert.equal(isolation.exitCode, 0, isolation.stderr);
    assert.equal(isolation.stdout.trim(), 'isolated');
    const failure = payload(
      await tools.invoke(run, 'shell', { command: 'printf synthetic-error >&2; exit 3' }),
    );
    assert.equal(failure.exitCode, 3);
    assert.match(failure.stderr, /synthetic-error/);
    const limited = await tools.invoke(run, 'shell', {
      command: 'python3 -c \'print("x"*100000)\'',
    });
    assert.equal(limited.isError, true);
    assert.ok(JSON.stringify(limited).includes('SHELL_LIMIT'));
    const pending = tools.invoke(run, 'shell', {
      command: 'sleep 30; printf forbidden > late.txt',
    });
    setTimeout(() => run.abort.abort(), 200);
    const cancelled = await pending;
    assert.equal(cancelled.isError, true);
    assert.ok(JSON.stringify(cancelled).includes('MODEL_CANCELLED'));
    await assert.rejects(readFile(path.join(workdir, 'late.txt')));
    assert.ok(run.trace.every((item) => item.surface === 'workspace'));
  } finally {
    if (previous === undefined) delete process.env.DABAN_SYNTHETIC_SECRET;
    else process.env.DABAN_SYNTHETIC_SECRET = previous;
    await rm(root, { recursive: true, force: true });
  }
});
