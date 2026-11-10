import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import { externalizeNextHTML } from './gallery-web';

test('static Next bootstrap scripts become same-origin assets under the existing strict CSP', () => {
  const code = 'self.__next_f=self.__next_f||[];self.__next_f.push([1,"SYNTHETIC"]);';
  const result = externalizeNextHTML(
    `<html><script src="/_next/static/chunk.js" async></script><script>${code}</script><script>${code}</script><script type="application/json">{"mock":true}</script></html>`,
  );
  expect(result.html).toContain('src="/_next/static/chunk.js" async');
  expect(result.html).not.toContain(`<script>${code}`);
  expect(result.html).toContain('<script type="application/json">{"mock":true}</script>');
  expect(result.assets).toHaveLength(1);
  expect(result.assets[0].content).toBe(code);
  expect(result.assets[0].path).toMatch(/^_next\/static\/bootstrap\/[a-f0-9]{64}\.js$/);
  expect(result.html.match(/src="\/_next\/static\/bootstrap\//g)).toHaveLength(2);
});

test('theme preference is restored by a same-origin script before styles and hydration', () => {
  const result = externalizeNextHTML(
    '<html><head><link rel="stylesheet" href="/mock.css"></head><body></body></html>',
  );
  expect(result.html).toMatch(
    /<head><script src="\/_next\/static\/bootstrap\/[a-f0-9]{64}\.js"><\/script><link/,
  );
  expect(result.assets).toHaveLength(1);
  const root = { dataset: {} as Record<string, string> };
  runInNewContext(result.assets[0].content, {
    window: { localStorage: { getItem: () => 'dark' }, matchMedia: () => ({ matches: false }) },
    document: { documentElement: root },
  });
  expect(root.dataset.theme).toBe('dark');
});
