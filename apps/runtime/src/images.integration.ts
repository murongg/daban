import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  type AttachmentReceipt,
  type DocumentUpload,
  isAttachmentOriginal,
  isAttachmentReceipt,
} from '@daban/protocol';
import {
  syntheticAlphaWebp,
  syntheticAnimatedWebp,
  syntheticGif,
  syntheticLossyWebp,
  syntheticPng,
  syntheticWebp,
} from './images.fixture.js';
import { startPrototype } from './server.js';

test('authenticated four-format uploads retain exact scoped originals across restart without model or document work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-raster-api-'));
  const options = { port: 0, computers: true as const, profileDir: path.join(root, 'profile') };
  let app: Awaited<ReturnType<typeof startPrototype>> | undefined = await startPrototype(options);
  async function post(action: string, value: object, authenticated = true) {
    assert.ok(app);
    return fetch(`${app.url}/api/attachments/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticated ? { 'x-prototype-token': app.token } : {}),
      },
      body: JSON.stringify(value),
    });
  }
  const saved: { file: DocumentUpload; receipt: AttachmentReceipt }[] = [];
  try {
    assert.equal(
      (await post('upload', { bot: 'mock-raster', file: syntheticGif }, false)).status,
      403,
    );
    for (const file of [
      syntheticPng,
      syntheticGif,
      syntheticWebp,
      syntheticLossyWebp,
      syntheticAlphaWebp,
      syntheticAnimatedWebp,
    ]) {
      const response = await post('upload', { bot: 'mock-raster', file });
      assert.equal(response.status, 200);
      const receipt: unknown = await response.json();
      assert.ok(isAttachmentReceipt(receipt));
      assert.equal(receipt.name, file.name);
      assert.equal(JSON.stringify(receipt).includes(file.data), false);
      saved.push({ file, receipt });
      const foreign = await post('source', { bot: 'mock-other', id: receipt.id });
      assert.equal(foreign.status, 404);
    }
    assert.equal(
      (await post('upload', { bot: 'mock-raster', file: { ...syntheticPng, name: 'spoof.gif' } }))
        .status,
      400,
    );
    assert.equal(
      (await post('upload', { bot: 'mock-raster', file: { ...syntheticWebp, extra: 'untrusted' } }))
        .status,
      400,
    );
    await app.close();
    app = undefined;
    app = await startPrototype(options);
    for (const { file, receipt } of saved) {
      const response = await post('source', { bot: 'mock-raster', id: receipt.id });
      assert.equal(response.status, 200);
      const original: unknown = await response.json();
      assert.ok(isAttachmentOriginal(original));
      assert.deepEqual(original.file, file);
      assert.equal(original.sha256, receipt.sha256);
    }
    const status = await (
      await fetch(app.url + '/api/state', { headers: { 'x-prototype-token': app.token } })
    ).json();
    assert.equal(status.clientProtocol, 32);
    assert.equal(status.model.configured, false);
    for (const job of Object.values(status.model.bots)) {
      assert.ok(
        job &&
          typeof job === 'object' &&
          'running' in job &&
          'toolCount' in job &&
          'history' in job,
      );
      assert.equal(job.running, false);
      assert.equal(job.toolCount, 0);
      assert.deepEqual(job.history, []);
    }
    assert.ok(app.models);
    assert.equal(app.models.jobs.size, 0);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
