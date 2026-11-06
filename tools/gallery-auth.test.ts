import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { afterEach, expect, test, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { configure, migrate } from '../packages/engine/src/database';
import { GalleryStore } from '../packages/engine/src/gallery';
import { createGalleryAuth, galleryAuthConfig } from '../packages/engine/src/gallery-auth';
import { CloudflareGallery } from '../packages/engine/src/gallery-cloudflare';
import { createGalleryHandler } from '../packages/engine/src/gallery-http';
import { migrations } from '../packages/engine/src/gallery-migrations';
import { galleryAccounts, galleryTokens } from '../packages/engine/src/gallery-schema';
import { startGallery } from '../packages/engine/src/gallery-server';
import { releaseHash } from '../packages/engine/src/releases';

const realFetch = globalThis.fetch;
afterEach(() => vi.restoreAllMocks());
const configuration = {
  clientId: 'mock-github-client',
  clientSecret: 'mock-github-secret',
  secret: 'SYNTHETIC AUTH SECRET FOR TESTS ONLY 1234567890',
  adminIds: ['999'],
};
function mockGitHub() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') {
      const text = String(init?.body ?? '');
      const body = text.startsWith('{')
        ? (JSON.parse(text) as { code: string })
        : Object.fromEntries(new URLSearchParams(text));
      return Response.json({
        access_token: `mock-token-${String(body.code).replace('mock-code-', '')}`,
        token_type: 'bearer',
        scope: 'read:user,user:email',
      });
    }
    if (url.hostname === 'api.github.com') {
      const token = new Headers(init?.headers).get('authorization') ?? '';
      const id = Number(token.split('-').at(-1));
      if (url.pathname === '/user')
        return Response.json({
          id,
          login: `mock-login-${id}`,
          name: `Mock GitHub user ${id}`,
          email: null,
          avatar_url: null,
        });
      if (url.pathname === '/user/emails')
        return Response.json([{ email: `mock-${id}@example.test`, primary: true, verified: true }]);
      throw Error('UNEXPECTED_GITHUB_API');
    }
    return realFetch(input, init);
  });
}
function cookies(response: Response, previous = new Map<string, string>()) {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0],
      index = pair.indexOf('=');
    const name = pair.slice(0, index),
      value = pair.slice(index + 1);
    if (value) previous.set(name, value);
    else previous.delete(name);
  }
  return previous;
}
const cookieHeader = (jar: Map<string, string>) =>
  [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
async function signIn(url: string, id: number, send: typeof fetch = realFetch) {
  const begin = await send(`${url}/api/auth/sign-in/social`, {
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'github',
      callbackURL: `${url}/`,
      errorCallbackURL: `${url}/?auth_error=1`,
    }),
  });
  expect(begin.status).toBe(200);
  const authorization = new URL(((await begin.json()) as { url: string }).url);
  expect(authorization.origin).toBe('https://github.com');
  expect(new Set(authorization.searchParams.get('scope')!.split(/[ ,]+/))).toEqual(
    new Set(['read:user', 'user:email']),
  );
  const jar = cookies(begin);
  const callback = await send(
    `${url}/api/auth/callback/github?code=mock-code-${id}&state=${encodeURIComponent(authorization.searchParams.get('state')!)}`,
    { redirect: 'manual', headers: { Cookie: cookieHeader(jar) } },
  );
  cookies(callback, jar);
  return { response: callback, headers: { Cookie: cookieHeader(jar) }, jar };
}
test('GitHub first sign-in registers a scoped account while keeping legacy namespace ownership', async () => {
  mockGitHub();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mock-gallery-auth-'));
  const file = path.join(directory, 'gallery.sqlite');
  const client = new DatabaseSync(file);
  configure(client, { foreignKeys: true });
  const old = migrate(client, migrations.slice(0, -1));
  const legacy = { token: 'SYNTHETIC LEGACY TOKEN' };
  old
    .insert(galleryTokens)
    .values({
      id: randomUUID(),
      hash: releaseHash(legacy.token),
      principal: JSON.stringify({
        principalId: 'mock-legacy',
        namespaces: ['gh-101'],
        scopes: ['templates:write', 'releases:write'],
      }),
    })
    .run();
  client.close();
  await chmod(file, 0o600);
  const gallery = await startGallery({
    directory,
    host: '127.0.0.1',
    port: 0,
    origin: 'http://127.0.0.1',
    readMode: 'public',
    auth: configuration,
  });
  try {
    const methods = await realFetch(`${gallery.url}/api/v1/auth`);
    expect(methods.status).toBe(200);
    expect(await methods.json()).toMatchObject({ github: true });
    const first = await signIn(gallery.url, 101);
    expect(first.response.headers.get('location')).toBe(`${gallery.url}/`);
    const current = await realFetch(`${gallery.url}/api/v1/sessions/current`, {
      headers: first.headers,
    });
    expect(current.status).toBe(200);
    const user = (await current.json()) as {
      principalId: string;
      namespaces: string[];
      scopes: string[];
      csrfToken: string;
      user: { name: string };
    };
    expect(user.user.name).toBe('Mock GitHub user 101');
    expect(user.namespaces).toHaveLength(1);
    expect(user.namespaces[0]).not.toBe('gh-101');
    expect(user.scopes).not.toContain('admin');
    const account = gallery.store.db.select().from(galleryAccounts).get()!;
    expect(account.accessToken).toBeTruthy();
    expect(account.accessToken).not.toBe('mock-token-101');
    const create = (namespace: string, headers: HeadersInit) =>
      realFetch(`${gallery.url}/api/v1/templates`, {
        method: 'POST',
        headers: {
          ...headers,
          Origin: gallery.url,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          id: randomUUID(),
          namespace,
          slug: 'mock-bot',
          name: 'SYNTHETIC BOT',
          summary: '',
          tags: [],
          visibility: 'private',
        }),
      });
    expect(
      (await create('gh-101', { ...first.headers, 'X-CSRF-Token': user.csrfToken })).status,
    ).toBe(403);
    expect(
      (await create(user.namespaces[0], { ...first.headers, 'X-CSRF-Token': user.csrfToken }))
        .status,
    ).toBe(201);
    expect((await create(user.namespaces[0], first.headers)).status).toBe(403);
    const second = await signIn(gallery.url, 101);
    const same = (await realFetch(`${gallery.url}/api/v1/sessions/current`, {
      headers: second.headers,
    }).then((response) => response.json())) as typeof user;
    expect(same.principalId).toBe(user.principalId);
    expect(same.namespaces).toEqual(user.namespaces);
    expect(
      (
        await realFetch(`${gallery.url}/api/v1/templates`, {
          headers: { Authorization: `Bearer ${legacy.token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await realFetch(`${gallery.url}/api/v1/sessions/current`, {
          method: 'DELETE',
          headers: { ...second.headers, Origin: gallery.url, 'X-CSRF-Token': same.csrfToken },
        })
      ).status,
    ).toBe(204);
    expect(
      (await realFetch(`${gallery.url}/api/v1/sessions/current`, { headers: second.headers }))
        .status,
    ).toBe(401);
  } finally {
    await gallery.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the same GitHub registration and revocable session work on D1', async () => {
  const platform = await getPlatformProxy<{ DB: D1Database; PACKAGES: R2Bucket }>({
    configPath: fileURLToPath(new URL('../apps/gallery/wrangler.jsonc', import.meta.url)),
    persist: false,
  });
  mockGitHub();
  try {
    for (const migration of migrations)
      for (const statement of migration.sql)
        if (statement.trim()) await platform.env.DB.prepare(statement).run();
    const backend = new CloudflareGallery({ ...platform.env, readMode: 'public' });
    await backend.ready;
    const origin = 'https://mock-gallery.example.test';
    const auth = backend.authentication(origin, configuration);
    const handle = createGalleryHandler(backend, { origin, auth });
    const send: typeof fetch = async (input, init) => handle(new Request(input, init));
    const loggedIn = await signIn(origin, 101, send);
    expect(loggedIn.response.headers.get('location')).toBe(`${origin}/`);
    const current = await send(`${origin}/api/v1/sessions/current`, { headers: loggedIn.headers });
    expect(current.status).toBe(200);
    const session = (await current.json()) as { namespaces: string[]; csrfToken: string };
    expect(session.namespaces).toEqual(['gh-101']);
    const captured = await auth.session(
      new Request(`${origin}/api/v1/sessions/current`, { headers: loggedIn.headers }),
    );
    const create = await send(`${origin}/api/v1/templates`, {
      method: 'POST',
      headers: {
        ...loggedIn.headers,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrfToken,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        id: randomUUID(),
        namespace: session.namespaces[0],
        slug: 'mock-bot',
        name: 'SYNTHETIC D1 BOT',
        summary: '',
        tags: [],
        visibility: 'private',
      }),
    });
    expect(create.status).toBe(201);
    expect(
      (
        await send(`${origin}/api/v1/sessions/current`, {
          method: 'DELETE',
          headers: { ...loggedIn.headers, Origin: origin, 'X-CSRF-Token': session.csrfToken },
        })
      ).status,
    ).toBe(204);
    expect(
      (await send(`${origin}/api/v1/sessions/current`, { headers: loggedIn.headers })).status,
    ).toBe(401);
    await expect(
      backend.authorize(captured, session.namespaces[0], 'templates:write'),
    ).rejects.toThrow('INVALID_CREDENTIAL');
  } finally {
    await platform.dispose();
  }
});

test('OAuth state, callback origins and unsupported account endpoints cannot bypass GitHub', async () => {
  mockGitHub();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mock-gallery-state-'));
  const gallery = await startGallery({
    directory,
    host: '127.0.0.1',
    port: 0,
    origin: 'http://127.0.0.1',
    readMode: 'public',
    auth: configuration,
  });
  try {
    const begin = await realFetch(`${gallery.url}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { Origin: gallery.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github', callbackURL: '/' }),
    });
    const state = new URL(((await begin.json()) as { url: string }).url).searchParams.get('state')!;
    const jar = cookies(begin);
    const bad = await realFetch(
      `${gallery.url}/api/auth/callback/github?state=mock-invalid&code=mock-code-101`,
      { redirect: 'manual', headers: { Cookie: cookieHeader(jar) } },
    );
    expect(bad.headers.get('location')).toContain('auth_error');
    const absent = await realFetch(
      `${gallery.url}/api/auth/callback/github?state=${encodeURIComponent(state)}&code=mock-code-101`,
      { redirect: 'manual' },
    );
    expect(absent.headers.get('location')).toContain('auth_error');
    expect(
      (
        await realFetch(`${gallery.url}/api/v1/sessions/current`, {
          headers: { Cookie: cookieHeader(jar) },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await realFetch(`${gallery.url}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { Origin: gallery.url, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await realFetch(`${gallery.url}/api/auth/get-access-token`, {
          method: 'POST',
          headers: { Origin: gallery.url, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
    const redirect = await realFetch(`${gallery.url}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { Origin: gallery.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'github',
        callbackURL: 'https://mock-attacker.example.test',
      }),
    });
    expect(redirect.status).toBe(400);
  } finally {
    await gallery.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('logout storage failures propagate and revoked OAuth cookies cannot elevate through a legacy session', async () => {
  mockGitHub();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mock-gallery-auth-switch-'));
  const gallery = await startGallery({
    directory,
    host: '127.0.0.1',
    port: 0,
    origin: 'http://127.0.0.1',
    readMode: 'public',
    auth: configuration,
  });
  try {
    const signed = await signIn(gallery.url, 101);
    const failing = createGalleryAuth(
      gallery.store.db,
      configuration,
      gallery.url,
      true,
      () => {
        throw Error('UNEXPECTED_RESOLVE');
      },
      () => {
        throw Error('SYNTHETIC DELETE FAILURE');
      },
    );
    await expect(
      failing.logout(
        new Request(`${gallery.url}/api/auth/sign-out`, {
          method: 'POST',
          headers: { ...signed.headers, Origin: gallery.url },
        }),
      ),
    ).rejects.toThrow('SYNTHETIC DELETE FAILURE');
    const active = await realFetch(`${gallery.url}/api/v1/sessions/current`, {
      headers: signed.headers,
    });
    expect(active.status).toBe(200);
    const user = (await active.json()) as { csrfToken: string };
    await realFetch(`${gallery.url}/api/v1/sessions/current`, {
      method: 'DELETE',
      headers: { ...signed.headers, Origin: gallery.url, 'X-CSRF-Token': user.csrfToken },
    });
    const key = gallery.store.createToken({
      principalId: 'mock-legacy-admin',
      namespaces: [],
      scopes: ['admin'],
    });
    const legacy = gallery.store.session(key.token);
    const mixed = { Cookie: `${signed.headers.Cookie}; daban_gallery_session=${legacy.secret}` };
    expect(
      (await realFetch(`${gallery.url}/api/v1/sessions/current`, { headers: mixed })).status,
    ).toBe(401);
    const switchMode = await realFetch(`${gallery.url}/api/v1/sessions`, {
      method: 'POST',
      headers: { ...mixed, Origin: gallery.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: key.token }),
    });
    expect(switchMode.status).toBe(200);
    const restored = cookies(
      switchMode,
      new Map(
        mixed.Cookie.split('; ').map((pair) => {
          const at = pair.indexOf('=');
          return [pair.slice(0, at), pair.slice(at + 1)];
        }),
      ),
    );
    const current = (await realFetch(`${gallery.url}/api/v1/sessions/current`, {
      headers: { Cookie: cookieHeader(restored) },
    }).then((response) => response.json())) as { principalId: string };
    expect(current.principalId).toBe('mock-legacy-admin');
  } finally {
    await gallery.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a wrong-scheme OAuth cookie does not shadow a valid token session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mock-gallery-cookie-origin-'));
  const store = new GalleryStore({ directory, readMode: 'public' });
  await store.ready;
  try {
    const key = store.createToken({
      principalId: 'mock-legacy',
      namespaces: ['mock-team'],
      scopes: ['catalog:read'],
    });
    const session = store.session(key.token);
    const origin = 'https://mock-gallery.example.test';
    const handle = createGalleryHandler(store, {
      origin,
      auth: store.authentication(origin, configuration),
    });
    const response = await handle(
      new Request(`${origin}/api/v1/sessions/current`, {
        headers: {
          Cookie: `daban_gallery_auth.session_token=mock-invalid; daban_gallery_session=${session.secret}`,
        },
      }),
    );
    expect(response.status).toBe(200);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub configuration is optional as a whole and rejects partial or unsafe policies', () => {
  expect(galleryAuthConfig({})).toBeUndefined();
  expect(() => galleryAuthConfig({ GITHUB_CLIENT_ID: 'mock-client' })).toThrow(
    'INVALID_GITHUB_CONFIG',
  );
  const env = {
    GITHUB_CLIENT_ID: configuration.clientId,
    GITHUB_CLIENT_SECRET: configuration.clientSecret,
    BETTER_AUTH_SECRET: configuration.secret,
  };
  expect(() => galleryAuthConfig({ ...env, BETTER_AUTH_SECRET: 'too-short' })).toThrow(
    'INVALID_GITHUB_CONFIG',
  );
  expect(() => galleryAuthConfig({ ...env, GALLERY_GITHUB_ADMIN_IDS: 'mock-login' })).toThrow(
    'INVALID_GITHUB_CONFIG',
  );
  expect(
    galleryAuthConfig({ ...env, GALLERY_GITHUB_ALLOWED_IDS: '101, 202,101' })?.allowedIds,
  ).toEqual(['101', '202']);
});

test('private GitHub access is explicit and social sign-in cannot request repository permissions', async () => {
  mockGitHub();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mock-gallery-private-auth-'));
  const gallery = await startGallery({
    directory,
    host: '127.0.0.1',
    port: 0,
    origin: 'http://127.0.0.1',
    readMode: 'private',
    auth: { ...configuration, allowedIds: ['101'] },
  });
  try {
    const forbidden = await signIn(gallery.url, 202);
    expect(forbidden.response.headers.get('location')).toContain('auth_error');
    expect(
      (await realFetch(`${gallery.url}/api/v1/sessions/current`, { headers: forbidden.headers }))
        .status,
    ).toBe(401);
    const admin = await signIn(gallery.url, 999);
    const current = (await realFetch(`${gallery.url}/api/v1/sessions/current`, {
      headers: admin.headers,
    }).then((response) => response.json())) as { scopes: string[] };
    expect(current.scopes).toContain('admin');
    const scope = await realFetch(`${gallery.url}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { Origin: gallery.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github', scopes: ['repo'] }),
    });
    expect(scope.status).toBe(400);
    const csrf = await realFetch(`${gallery.url}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { Origin: 'https://mock-attacker.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github' }),
    });
    expect(csrf.status).toBe(403);
  } finally {
    await gallery.close();
    await rm(directory, { recursive: true, force: true });
  }
});
