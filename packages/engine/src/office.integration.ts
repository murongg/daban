import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { type adaptOffice, apply } from './office.js';

test('installed DSH Office skills load through the guest adapter without host interpreter or resource paths', async () => {
  const sdkFile = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client');
  let provider!: ReturnType<typeof adaptOffice>;
  await apply(
    {
      skills: {
        registerProvider: (factory) => {
          provider = factory({});
        },
      },
    },
    { sdkFile },
  );
  const candidates = await provider.list();
  assert.deepEqual(
    candidates.map((item) => item.name),
    [
      'office',
      'office-docx',
      'office-pptx',
      'office-xlsx',
      'office-render',
      'office-recalculate',
      'office-export-pdf',
    ],
  );
  for (const candidate of candidates) {
    assert.equal(candidate.path, undefined);
    assert.equal((candidate.resourceBase as { kind: string }).kind, 'opaque');
    const skill = await provider.get(candidate, { signal: new AbortController().signal });
    assert(skill.content.includes('software_install'));
    assert(!skill.content.includes('Installed LibreOffice Kit'));
    assert(!skill.content.includes('sidecar setup'));
    assert(!skill.content.includes(process.cwd()));
  }
});
