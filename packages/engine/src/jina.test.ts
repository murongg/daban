import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { fetchJina, jinaEnabled, setJinaEnabled } from './jina.js';

const url = 'https://article.example.test/post';
const signal = () => new AbortController().signal;

test('a new Host starts disabled and remembers enabling and disabling Reader', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-reader-'));
  const file = path.join(directory, 'jina-reader.enabled');
  try {
    expect(await jinaEnabled(file)).toBe(false);
    expect(await setJinaEnabled(file, true)).toBe(true);
    expect(await setJinaEnabled(file, true)).toBe(true);
    expect(await jinaEnabled(file)).toBe(true);
    expect(await setJinaEnabled(file, false)).toBe(false);
    expect(await jinaEnabled(file)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('submits only the URL to the fixed Reader API and accepts verified Markdown', async () => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({
      code: 200,
      data: { url, finalUrl: url, httpStatus: 200, content: '# Synthetic article' },
    }),
  );
  expect(await fetchJina(url, signal(), request)).toStrictEqual({
    statusCode: 200,
    text: '# Synthetic article',
  });
  expect(request).toHaveBeenCalledExactlyOnceWith('https://r.jina.ai/', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', dnt: '1' },
    body: JSON.stringify({ url }),
    redirect: 'error',
    signal: expect.any(AbortSignal),
  });
});

test.each([
  { httpStatus: 403 },
  { finalUrl: 'https://other.example.test/' },
  { content: ' ' },
  { content: 'x'.repeat(2 * 1024 * 1024 + 1) },
])('rejects a failed, redirected, empty or oversized Reader response', async (override) => {
  const request: typeof fetch = async () =>
    Response.json({
      code: 200,
      data: { url, finalUrl: url, httpStatus: 200, content: 'Synthetic content', ...override },
    });
  await expect(fetchJina(url, signal(), request)).rejects.toMatchObject({
    code: 'JINA_INVALID_RESPONSE',
  });
});
