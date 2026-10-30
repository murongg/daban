import { webcrypto } from 'node:crypto';
import { type BotBundle, botBundleText } from '@daban/protocol';
import { expect, it } from 'vitest';
import { demoState as initialState } from './fixtures';
import { bundleFile, bundleHeader } from './portable';
import { reduce } from './state';
import { restore, serialize } from './storage';

const bundle: BotBundle = {
  format: 'daban.bot',
  version: 1,
  profile: { name: '合成模板', instructions: 'SYNTHETIC', color: 'mint' },
  preferences: 'SYNTHETIC PREF',
  skills: [],
  knowledge: [],
};
it('decodes only bounded UTF-8 packages and fingerprints the canonical content', async () => {
  const bytes = new TextEncoder().encode(botBundleText(bundle));
  const file = { size: bytes.length, arrayBuffer: async () => bytes.buffer } as File;
  expect(await bundleFile(file)).toEqual(bundle);
  const subtle = webcrypto.subtle;
  const header = await bundleHeader(bundle, 'mock-import', subtle as SubtleCrypto);
  expect(header.id).toBe('mock-import');
  expect(header.sha256).toHaveLength(64);
  expect(header.size).toBe(bytes.length);
  await expect(bundleFile({ size: 101 * 1024 ** 2 } as File)).rejects.toThrow('BOT_BUNDLE_LIMIT');
  await expect(
    bundleFile({ size: 1, arrayBuffer: async () => new Uint8Array([255]).buffer } as File),
  ).rejects.toThrow('FILE_ENCODING');
});
it('persists only a scoped import reference, retains cancel intent and ignores late clears from another operation', () => {
  const header = {
    id: 'mock-import',
    sha256: 'a'.repeat(64),
    size: 100,
    name: '合成模板',
    selection: { memory: false, skills: false, knowledge: true },
  };
  let state = initialState();
  state.drafts.research = 'SYNTHETIC RETAINED DRAFT';
  state = reduce(state, { type: 'bot-import-pending', reference: header });
  state = reduce(state, { type: 'bot-import-cancel', id: header.id, sha256: header.sha256 });
  expect(state.botImport?.cancelRequested).toBe(true);
  state = reduce(state, { type: 'bot-import-pending', reference: header });
  expect(state.botImport?.cancelRequested).toBe(true);
  state = reduce(state, { type: 'bot-import-clear', id: 'mock-other', sha256: header.sha256 });
  expect(state.botImport?.id).toBe(header.id);
  const saved = serialize(state),
    reopened = restore(saved);
  expect(reopened.botImport).toEqual(state.botImport);
  expect(reopened.drafts.research).toBe('SYNTHETIC RETAINED DRAFT');
  expect(saved).not.toContain('SYNTHETIC PREF');
  expect(
    reduce(reopened, { type: 'bot-import-clear', id: header.id, sha256: header.sha256 }).botImport,
  ).toBeUndefined();
});
