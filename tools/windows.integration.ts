import assert from 'node:assert/strict';
import test from 'node:test';

const { WindowsHost }: typeof import('../apps/agent/src/windows.ts') = await import(
  new URL('../dist-agent/windows.js', import.meta.url).href
);

test('real Windows prerequisites can be observed without elevation or changing features', {
  timeout: 20000,
}, async () => {
  assert.equal(process.platform, 'win32');
  const value = await new WindowsHost().probe();
  assert.ok(['ready', 'disabled', 'restart', 'firmware', 'unsupported'].includes(value));
});
