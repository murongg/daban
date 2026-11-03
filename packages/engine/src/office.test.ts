import { expect, test } from 'vitest';
import { sdkPatch } from './model.js';

test('Office is offered only with a Linux execution workspace and does not enable host shell or raw filesystem tools', () => {
  const args = [
    'http://127.0.0.1:12345',
    'mock-bot',
    'mock-capability',
    { requestId: 'mock-office', prompt: 'Synthetic document' },
    60,
    'deepseek-flash',
    { available: true, key: '', skills: [] },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  const patch = Reflect.apply(sdkPatch, undefined, [...args, true]) as {
    id?: string;
    disabled?: boolean;
    insert?: { id: string }[];
  }[];
  expect(patch.flatMap((row) => row.insert ?? []).some((row) => row.id === 'daban-office')).toBe(
    true,
  );
  expect(patch.find((row) => row.id === 'persistent-bash')?.disabled).toBe(true);
  expect(patch.find((row) => row.id === 'tool-fs')?.disabled).toBe(true);
  const native = Reflect.apply(sdkPatch, undefined, [...args, false]) as typeof patch;
  expect(native.flatMap((row) => row.insert ?? []).some((row) => row.id === 'daban-office')).toBe(
    false,
  );
});

test('synthetic Office provider keeps instruction bodies and hides host resource paths', async () => {
  const { adaptOffice } = await import(new URL('./office.js', import.meta.url).href);
  const candidate = {
    name: 'office-docx',
    path: '/mock-host/private/SKILL.md',
    resourceBase: { kind: 'directory', path: '/mock-host/private' },
    locator: 'mock-handle',
  };
  const provider = adaptOffice({
    name: 'mock-office',
    list: async () => [candidate],
    get: async () => ({ ...candidate, content: 'SYNTHETIC AUTHORING INSTRUCTIONS' }),
  });
  const [listed] = await provider.list();
  expect(listed.resourceBase).toMatchObject({ kind: 'opaque' });
  expect(listed.path).toBeUndefined();
  const skill = await provider.get(listed, { signal: new AbortController().signal });
  expect(skill.content).toContain('SYNTHETIC AUTHORING INSTRUCTIONS');
  expect(skill.content).toContain('software_install');
  expect(skill.resourceBase).toMatchObject({ kind: 'opaque' });
  expect(skill.path).toBeUndefined();
  expect(skill.locator).toBeUndefined();
});
