import { type ModelConnection, managedProtocol } from '@daban/protocol';
import { expect, it } from 'vitest';
import { modelConnections, modelPreview } from './models';
import { previewSnapshot } from './runtime';

it('uses current protocol metadata by default and keeps explicit legacy payloads', () => {
  const current = previewSnapshot();
  expect(current.protocolVersion).toBe(managedProtocol);
  expect(current.model.connections?.length).toBeGreaterThan(0);
  expect(previewSnapshot(29).model.connections).toBeUndefined();
  expect(previewSnapshot(29).protocolVersion).toBe(29);
  const records = modelConnections();
  records[0].name = 'SYNTHETIC EDIT';
  expect(modelConnections()[0].name).not.toBe('SYNTHETIC EDIT');
});
it('shares model changes, preserves provider order, rejects stale revisions and never retains keys', async () => {
  const { snapshot, bridge } = modelPreview();
  const first = snapshot.model.connections![0];
  const update = {
    model: snapshot.model.model,
    revision: 0,
    requestId: 'mock-save',
    apiKey: 'SYNTHETIC-KEY-NOT-RETAINED',
    connection: { ...first, name: 'SYNTHETIC UPDATED' },
  };
  expect((await bridge.invoke({ type: 'model.configure', input: update })).ok).toBe(true);
  expect(snapshot.model.connections![0].name).toBe('SYNTHETIC UPDATED');
  expect(JSON.stringify(snapshot)).not.toContain(update.apiKey);
  expect(await bridge.invoke({ type: 'model.configure', input: update })).toEqual({
    ok: false,
    error: 'MODEL_SETTINGS_CONFLICT',
  });
  expect(await bridge.invoke({ type: 'files.list' })).toEqual({
    ok: false,
    error: 'SYNTHETIC_PREVIEW_ONLY',
  });
  const invalid: ModelConnection = {
    id: 'mock-invalid',
    name: 'SYNTHETIC INVALID',
    baseURL: 'http://localhost',
    models: [],
  };
  expect(
    (
      await bridge.invoke({
        type: 'model.configure',
        input: { ...update, revision: 1, connection: invalid },
      })
    ).ok,
  ).toBe(false);
  expect(snapshot.model.revision).toBe(1);
});
it('keeps the empty provider scenario available', () => {
  const { snapshot } = modelPreview(true);
  expect(snapshot.model.configured).toBe(false);
  expect(snapshot.model.connections).toEqual([]);
});
