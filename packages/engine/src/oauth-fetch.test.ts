import { expect, test } from 'vitest';
import { OAuthFetch } from './oauth-fetch.js';
import { tlsFixture } from './tls.fixture.js';

test('OAuth sends bounded discovery and form requests only to pinned public endpoints without redirecting', async () => {
  let count = 0;
  const fixture = await tlsFixture((req, res) => {
    count++;
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { location: 'https://evil.example.test/token' });
      res.end();
      return;
    }
    if (req.url?.startsWith('/large')) {
      res.end('x'.repeat(300000));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, type: req.headers['content-type'] }));
  });
  const origin = new URL(fixture.endpoint).origin;
  const allowed = [
    `${origin}/metadata`,
    `${origin}/token`,
    `${origin}/redirect`,
    `${origin}/large`,
  ];
  try {
    const client = new OAuthFetch(allowed, fixture);
    expect((await client.request(allowed[0])).data).toEqual({ method: 'GET' });
    expect(
      (await client.request(allowed[1], new URLSearchParams({ code: 'synthetic-code' }))).data,
    ).toMatchObject({ method: 'POST', type: 'application/x-www-form-urlencoded' });
    await expect(client.request(`${origin}/foreign`)).rejects.toMatchObject({
      code: 'OAUTH_NETWORK_BLOCKED',
    });
    await expect(client.request(allowed[2])).rejects.toMatchObject({
      code: 'OAUTH_REDIRECT_REFUSED',
    });
    await expect(client.request(allowed[3])).rejects.toMatchObject({
      code: 'OAUTH_RESPONSE_TOO_LARGE',
    });
    const before = count;
    await expect(
      new OAuthFetch(allowed, {
        ...fixture,
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      }).request(allowed[0]),
    ).rejects.toMatchObject({ code: 'OAUTH_NETWORK_BLOCKED' });
    expect(count).toBe(before);
  } finally {
    await fixture.close();
  }
});
