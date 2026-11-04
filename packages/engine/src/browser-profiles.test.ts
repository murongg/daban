import { expect, test } from 'vitest';
import { BrowserProfiles } from './browser-profiles.js';
import { Control } from './control.js';
import type { Browser } from './runtime.js';

test('profile identity owns exactly one context, shares only that identity and closes after its final Bot', async () => {
  const opened: string[] = [],
    closed: string[] = [];
  const profiles = new BrowserProfiles(async (profile) => {
    opened.push(profile);
    await Promise.resolve();
    return {
      attach: async () => {},
      detach: async () => {},
      close: async () => {
        closed.push(profile);
      },
    } as unknown as Browser;
  });
  const control = new Control(['mock-a', 'mock-b']);
  const [first, second] = await Promise.all([
    profiles.acquire('mock-shared', 'mock-a', control),
    profiles.acquire('mock-shared', 'mock-b', control),
  ]);
  expect(first).toBe(second);
  expect(opened).toStrictEqual(['mock-shared']);
  expect(await profiles.acquire('mock-private', 'mock-a', control)).not.toBe(first);
  await profiles.release('mock-shared', 'mock-a');
  expect(closed).toStrictEqual([]);
  await profiles.release('mock-shared', 'mock-b');
  expect(closed).toStrictEqual(['mock-shared']);
  await profiles.close();
  expect(closed).toStrictEqual(['mock-shared', 'mock-private']);
});

test('a locked profile never acquires another identity and remains retryable', async () => {
  let locked = true;
  const attempts: string[] = [];
  const profiles = new BrowserProfiles(async (profile) => {
    attempts.push(profile);
    if (locked) throw Error('MOCK PROFILE LOCK');
    return {
      attach: async () => {},
      detach: async () => {},
      close: async () => {},
    } as unknown as Browser;
  });
  const control = new Control(['mock-a']);
  await expect(profiles.acquire('mock-private', 'mock-a', control)).rejects.toThrow(
    'MOCK PROFILE LOCK',
  );
  locked = false;
  await profiles.acquire('mock-private', 'mock-a', control);
  expect(attempts).toStrictEqual(['mock-private', 'mock-private']);
  await profiles.close();
});
