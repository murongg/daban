import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

// Manual paid-model acceptance, separate from unit tests; all business data is synthetic.
export async function acceptProfiles(output = '/tmp/daban-persona-evidence.json') {
  assert.equal(process.platform, 'linux', 'Run this acceptance inside the provisioned Linux host.');
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-persona-acceptance-'));
  let models: ModelRuns | undefined;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) throw new Error('request too large');
        chunks.push(Buffer.from(chunk));
      }
      if (!models) throw new Error('not ready');
      const result = await models.rpc(
        'probe',
        request.headers.authorization,
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      response.writeHead(result === null ? 202 : 200, { 'content-type': 'application/json' });
      response.end(result === null ? undefined : JSON.stringify(result));
    } catch {
      response.writeHead(400);
      response.end('{}');
    }
  });
  try {
    await new Promise<unknown>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    const options = {
      settings: new ModelSettings('/var/lib/bot-prototype/model/credentials.json'),
      workspace,
      dir: path.join(directory, 'model'),
      origin: `http://127.0.0.1:${address.port}`,
    };
    models = new ModelRuns(options);
    await models.ready;
    await models.profiles.register({
      id: 'probe',
      name: '验证助手甲',
      instructions: '用中文简洁回答。',
      memory: '合成项目代号是 MOCK-ORION。',
      color: 'mint',
    });
    const turns: Record<string, unknown>[] = [];
    async function turn(requestId: string, prompt: string, name: string, code = 'MOCK-ORION') {
      assert.ok(models);
      await models.start('probe', { requestId, prompt });
      await models.jobs.get('probe')!.done;
      const result = models.status().bots.probe;
      assert.equal(result.phase, 'completed', result.error || 'Model turn did not complete');
      assert.equal(result.toolCount, 0);
      assert.ok(result.result?.includes(name), result.result || 'Missing persona response');
      assert.ok(result.result?.includes(code), result.result || 'Missing memory response');
      turns.push({
        phase: result.phase,
        sessionId: result.sessionId,
        toolCount: result.toolCount,
        result: result.result,
      });
      return result.sessionId;
    }
    await turn('persona-alpha', '请用一行原样给出你的名字和记忆中的合成项目代号。', '验证助手甲');
    await models.profiles.update('probe', 1, {
      name: '验证助手乙',
      instructions: '只用一句话回答。',
    });
    const second = await turn(
      'persona-beta',
      '请用一行原样给出你现在的名字和合成项目代号。',
      '验证助手乙',
    );
    assert.notEqual(turns[0].sessionId, second, 'a changed persona needs a fresh system context');
    await models.profiles.update('probe', 2, { memory: '合成项目代号已更新为 MOCK-VEGA。' });
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    const third = await turn(
      'persona-restart',
      '请用一行原样给出你的名字和当前合成项目代号。',
      '验证助手乙',
      'MOCK-VEGA',
    );
    assert.equal(third, second, 'the unchanged persona should retain DSH continuity after restart');
    const profile = await models.profiles.get('probe');
    assert.equal(profile?.memory, '合成项目代号已更新为 MOCK-VEGA。');
    const evidence = { computerAttached: false, profile, turns, verified: true };
    await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    return evidence;
  } finally {
    await models?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await acceptProfiles(process.argv[2]);
  console.log(
    JSON.stringify({
      verified: result.verified,
      turns: result.turns.length,
      computerAttached: false,
    }),
  );
}
