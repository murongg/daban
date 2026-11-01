import { expect, it } from 'vitest';
import { isMessageKey, translate } from '../locale';

it('uses Chinese by default, translates chrome and keeps inserted content literal', () => {
  expect(translate('zh-CN', 'settings.title')).toBe('设置');
  expect(translate('en', 'settings.title')).toBe('Settings');
  expect(translate('en', 'app.about', { 0: 'SYNTHETIC {1} $& <tag>' })).toBe(
    'About SYNTHETIC {1} $& <tag>',
  );
  expect(translate('zh-CN', 'app.about', { 0: 'SYNTHETIC {1} $& <tag>' })).toBe(
    '关于 SYNTHETIC {1} $& <tag>',
  );
  expect(translate('en', 'SYNTHETIC UNKNOWN COPY')).toBe('SYNTHETIC UNKNOWN COPY');
  expect(translate('en', 'errors.runtimeConnectionUnavailable')).toBe(
    'Could not connect to the local execution environment. Try connecting again.',
  );
});

it('retains all interpolation slots and supplies English for every catalog message', async () => {
  const { english } = await import('../locales/en');
  const { chinese } = await import('../locales/zh-CN');
  expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
  for (const [key, translated] of Object.entries(english)) {
    const slots = (value: string) =>
      [...value.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
    expect(key).toMatch(/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/);
    const original = chinese[key as keyof typeof chinese];
    expect(slots(translated), key).toEqual(slots(original));
    expect(translated.trim(), key).not.toBe('');
    expect(original.trim(), key).not.toBe('');
    expect(/\p{Script=Han}/u.test(translated), key).toBe(false);
  }
});

it('does not mistake inherited property names for translation entries', () => {
  expect(isMessageKey('settings.title')).toBe(true);
  expect(isMessageKey('synthetic.unknown')).toBe(false);
  expect(isMessageKey('__proto__')).toBe(false);
  expect(translate('en', '__proto__')).toBe('__proto__');
  expect(translate('en', 'toString')).toBe('toString');
});

it('uses the selected language for privacy-preserving desktop notification copy', async () => {
  const { noticeCopy } = await import('../notifications');
  expect(noticeCopy({ kind: 'settings' }, 'en')).toEqual({
    title: 'Daban · Test notification',
    body: 'Notification submitted. Click to return to settings.',
  });
  expect(
    noticeCopy({ kind: 'approval', id: 'mock-request', bot: 'mock-bot', runId: 'mock-run' }, 'en'),
  ).toEqual({
    title: 'Daban · Needs your approval',
    body: 'A permission request needs attention. Click to view.',
  });
});
