import { expect, it } from 'vitest';
import { translate } from '../locale';

it('uses Chinese by default, translates chrome and keeps inserted content literal', () => {
  expect(translate('zh-CN', '设置')).toBe('设置');
  expect(translate('en', '设置')).toBe('Settings');
  expect(translate('en', '关于 {0}', { 0: 'SYNTHETIC {1} $& <tag>' })).toBe(
    'About SYNTHETIC {1} $& <tag>',
  );
  expect(translate('en', 'SYNTHETIC UNKNOWN COPY')).toBe('SYNTHETIC UNKNOWN COPY');
});

it('retains all interpolation slots and supplies English for every catalog message', async () => {
  const { english } = await import('../locales/en');
  for (const [source, translated] of Object.entries(english)) {
    const slots = (value: string) =>
      [...value.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
    expect(slots(translated), source).toEqual(slots(source));
    expect(translated.trim(), source).not.toBe('');
    expect(/\p{Script=Han}/u.test(translated), source).toBe(false);
  }
});

it('does not mistake inherited property names for translation entries', () => {
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
