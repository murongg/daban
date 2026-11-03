import { expect, test } from 'vitest';
import { syncDirectory } from './durability.js';

test('directory flush is skipped only on Windows; supported platforms retain flush errors', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let calls = 0;
  const directory = {
    sync: async () => {
      calls++;
      throw new Error('MOCK_FLUSH_FAILURE');
    },
  };
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await syncDirectory(directory);
    expect(calls).toBe(0);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    await expect(syncDirectory(directory)).rejects.toThrowError(/MOCK_FLUSH_FAILURE/);
    expect(calls).toBe(1);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});
