import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createFetcher } from './web.js';

const provider = '/opt/bot-prototype/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js';
test('the installed DSH fetch provider rejects private, credentialed and non-HTTP destinations', {
  skip: !existsSync(provider) && process.env.REQUIRE_LINUX !== '1',
}, async () => {
  const { HttpFetchProvider } = await import(pathToFileURL(provider).href);
  const http = new HttpFetchProvider({
    maxResponseBytes: 1000000,
    maxBodyChars: 40000,
    timeoutMs: 30000,
    maxRedirects: 5,
    userAgent: 'daban-integration',
  });
  for (const url of [
    'http://127.0.0.1:8766/api/state',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'file:///etc/passwd',
    'https://mock-user:mock-password@example.test/',
  ]) {
    await assert.rejects(
      http.fetch({ url }),
      (error: unknown) =>
        !!error &&
        typeof error === 'object' &&
        'code' in error &&
        ['WEB_BLOCKED_URL', 'WEB_INVALID_URL'].includes(String(error.code)),
      url,
    );
  }
  const ipaddr = createRequire(provider)('ipaddr.js');
  const safe = createFetcher(
    HttpFetchProvider,
    {
      maxResponseBytes: 1000,
      maxBodyChars: 1000,
      timeoutMs: 1000,
      maxRedirects: 1,
      userAgent: 'mock',
    },
    (ip) => ipaddr.parse(ip).range() === 'unicast',
  );
  await assert.rejects(
    safe.fetch({ url: 'http://127.0.0.1/' }),
    (error: unknown) =>
      !!error && typeof error === 'object' && 'code' in error && error.code === 'WEB_BLOCKED_URL',
  );
});
