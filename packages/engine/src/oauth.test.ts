import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { notionOAuth } from './app-catalog.js';
import { Integrations } from './integrations.js';
import { OAuth, type OAuthOptions } from './oauth.js';
import { secureDirectory } from './private-files.js';

const input = {
  bot: 'mock-a',
  connection: 'mock-notion',
  revision: 0,
  requestId: 'mock-start',
  app: 'notion',
  name: 'Synthetic Notion',
} as const;
const target = { bot: input.bot, connection: input.connection, revision: 0 };
async function fixture() {
  const root = await secureDirectory(await mkdtemp(path.join(tmpdir(), 'synthetic-oauth-')));
  const store = new Integrations(path.join(root, 'integrations.sqlite'));
  let registrations = 0,
    exchanges = 0,
    refreshes = 0;
  let challenge = '',
    refreshFailure = false,
    changedScope = false,
    exchangeFailure = false,
    badScope = false,
    oversizedToken = false,
    invalidGrant = false,
    badIssuer = false;
  let pauseRefresh: Promise<unknown> | undefined;
  const request: NonNullable<OAuthOptions['request']> = async (url, body) => {
    if (url === notionOAuth.resourceMetadata)
      return {
        status: 200,
        data: { resource: notionOAuth.issuer, authorization_servers: [notionOAuth.issuer] },
      };
    if (url === notionOAuth.metadata)
      return {
        status: 200,
        data: {
          issuer: badIssuer ? 'https://evil.example.test' : notionOAuth.issuer,
          authorization_endpoint: notionOAuth.authorize,
          token_endpoint: notionOAuth.token,
          registration_endpoint: notionOAuth.register,
          protected_resources: [notionOAuth.resource],
          code_challenge_methods_supported: ['S256'],
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        },
      };
    if (url === notionOAuth.register) {
      registrations++;
      expect(body).toMatchObject({ grant_types: ['authorization_code', 'refresh_token'] });
      return {
        status: 201,
        data: {
          client_id: 'mock-client',
          client_secret: 'synthetic-client-secret',
          token_endpoint_auth_method: 'client_secret_post',
        },
      };
    }
    if (!(body instanceof URLSearchParams)) throw new Error('synthetic form missing');
    expect(body.get('resource')).toBe(notionOAuth.resource);
    if (body.get('grant_type') === 'authorization_code') {
      exchanges++;
      if (exchangeFailure) throw new Error('synthetic exchange response lost');
      expect(body.get('code')).toBe('synthetic-code');
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
        challenge,
      );
    } else {
      refreshes++;
      await pauseRefresh;
      if (invalidGrant) return { status: 400, data: { error: 'invalid_grant' } };
      if (refreshFailure) throw new Error('synthetic response lost');
    }
    return {
      status: 200,
      data: {
        access_token: oversizedToken
          ? 'x'.repeat(4097)
          : `synthetic-access-${exchanges + refreshes}`,
        refresh_token: `synthetic-refresh-${exchanges + refreshes}`,
        token_type: 'Bearer',
        expires_in: refreshes ? 3600 : 1,
        scope: badScope ? 'default\nextra' : changedScope ? 'default extra' : 'default',
      },
    };
  };
  const oauth = new OAuth(store, { request });
  async function connect() {
    const reply = await oauth.start(input);
    const url = new URL(reply.authorize!.url);
    challenge = url.searchParams.get('code_challenge')!;
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({
      code: 'synthetic-code',
      state: url.searchParams.get('state')!,
      iss: notionOAuth.issuer,
    }).toString();
    return { reply, url, callback };
  }
  return {
    store,
    oauth,
    connect,
    counters: () => ({ registrations, exchanges, refreshes }),
    setExchangeFailure: () => { exchangeFailure = true; },
    setBadScope: () => {
      badScope = true;
    },
    setOversizedToken: () => {
      oversizedToken = true;
    },
    setInvalidGrant: () => {
      invalidGrant = true;
    },
    setBadIssuer: () => {
      badIssuer = true;
    },
    setRefreshFailure: () => {
      refreshFailure = true;
    },
    setScope: () => {
      changedScope = true;
    },
    pause: (value: Promise<unknown>) => {
      pauseRefresh = value;
    },
    close: async () => {
      await oauth.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('PKCE authorization is owner-bound, deduplicated, one-shot and requires a separate tool review', async () => {
  const f = await fixture();
  try {
    const { reply, url, callback } = await f.connect();
    expect(await f.oauth.start(input)).toEqual(reply);
    expect(url.searchParams.get('resource')).toBe(notionOAuth.resource);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect((await f.store.list(false, input.bot)).items).toEqual([]);
    const wrong = new URL(callback);
    wrong.searchParams.set('state', 'synthetic-wrong');
    expect((await fetch(wrong)).status).toBe(400);
    expect((await fetch(callback)).status).toBe(200);
    expect((await f.store.oauthAttempt(target, reply.receipt.attempt)).phase).toBe('connected');
    expect((await f.store.capture(input.bot)).connections).toEqual([]);
    await fetch(callback).catch(() => undefined);
    expect(f.counters()).toEqual({ registrations: 1, exchanges: 1, refreshes: 0 });
    expect(JSON.stringify(await f.store.oauthStates(input.bot))).not.toMatch(
      /synthetic-|clientId|secret/,
    );
  } finally {
    await f.close();
  }
});
test('refresh rotates atomically in a single flight without changing config revision; lost replies never retry', async () => {
  const f = await fixture();
  try {
    const { callback } = await f.connect();
    await fetch(callback);
    const tokens = await Promise.all([
      f.oauth.token(input.connection),
      f.oauth.token(input.connection),
    ]);
    expect(tokens).toEqual(['synthetic-access-2', 'synthetic-access-2']);
    expect(f.counters().refreshes).toBe(1);
    expect((await f.store.read(input.connection, input.bot)).revision).toBe(1);
    const grant = (await f.store.oauthGrant(input.connection))!;
    expect(grant.refreshToken).toBe('synthetic-refresh-2');
    await f.store.oauthRefreshBegin(input.connection, grant.epoch);
    await f.store.oauthRefreshCommit(input.connection, grant.epoch, {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken!,
      scope: grant.scope,
      expiresAt: 1,
    });
    f.setRefreshFailure();
    await expect(f.oauth.token(input.connection)).rejects.toMatchObject({
      code: 'OAUTH_RECONNECT_REQUIRED',
    });
    await expect(f.oauth.token(input.connection)).rejects.toMatchObject({
      code: 'OAUTH_RECONNECT_REQUIRED',
    });
    expect(f.counters().refreshes).toBe(2);
    expect((await f.store.oauthGrant(input.connection))?.refreshToken).toBe(null);
  } finally {
    await f.close();
  }
});
test('cancel closes only its own listener and prevents any callback from persisting a grant', async () => {
  const f = await fixture();
  try {
    const { reply, callback } = await f.connect();
    await expect(
      f.oauth.cancel({ ...target, bot: 'mock-b' }, reply.receipt.attempt, input.requestId),
    ).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_NOT_FOUND' });
    expect((await f.oauth.cancel(target, reply.receipt.attempt, input.requestId)).phase).toBe(
      'cancelled',
    );
    await fetch(callback).catch(() => undefined);
    expect(f.counters().exchanges).toBe(0);
    expect((await f.store.list(false, input.bot)).items).toEqual([]);
  } finally {
    await f.close();
  }
});

test('an uncertain code exchange is interrupted and the same start never registers or exchanges again', async () => {
  const f = await fixture();
  try {
    f.setExchangeFailure(); const { reply, callback } = await f.connect();
    expect((await fetch(callback)).status).toBe(400);
    expect((await f.store.oauthAttempt(target, reply.receipt.attempt)).phase).toBe('interrupted');
    const repeated = await f.oauth.start(input);
    expect(repeated.receipt.phase).toBe('interrupted'); expect(repeated.authorize).toBeUndefined();
    expect(f.counters()).toEqual({ registrations: 1, exchanges: 1, refreshes: 0 });
  } finally { await f.close(); }
});
test('expired callbacks cannot exchange a code or create an empty connection', async () => {
  const f = await fixture();
  const actual = Date.now;
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const { reply, callback } = await f.connect();
    clock = vi.spyOn(Date, 'now').mockImplementation(() => actual() + 700000);
    expect((await fetch(callback)).status).toBe(400);
    expect((await f.store.oauthAttempt(target, reply.receipt.attempt)).phase).toBe('expired');
    expect((await f.store.list(false, input.bot)).items).toEqual([]); expect(f.counters().exchanges).toBe(0);
  } finally { clock?.mockRestore(); await f.close(); }
});

test('untrusted issuer metadata fails before registering or opening an authorization page', async () => {
  const f = await fixture();
  try {
    f.setBadIssuer();
    const reply = await f.oauth.start(input);
    expect(reply.authorize).toBeUndefined();
    expect(reply.receipt.phase).toBe('failed');
    expect(reply.receipt.error).toBe('OAUTH_METADATA_REJECTED');
    expect(f.counters().registrations).toBe(0);
  } finally {
    await f.close();
  }
});
test('invalid_grant is terminal and never reuses the retired refresh token', async () => {
  const f = await fixture();
  try {
    const { callback } = await f.connect();
    await fetch(callback);
    f.setInvalidGrant();
    await expect(f.oauth.token(input.connection)).rejects.toMatchObject({
      code: 'OAUTH_RECONNECT_REQUIRED',
    });
    await expect(f.oauth.token(input.connection)).rejects.toMatchObject({
      code: 'OAUTH_RECONNECT_REQUIRED',
    });
    expect(f.counters().refreshes).toBe(1);
  } finally {
    await f.close();
  }
});

test('malformed token scopes cannot silently retain the old tool authority', async () => {
  const f = await fixture();
  try {
    const { callback } = await f.connect();
    await fetch(callback);
    f.setBadScope();
    await expect(f.oauth.token(input.connection)).rejects.toMatchObject({
      code: 'OAUTH_RECONNECT_REQUIRED',
    });
  } finally {
    await f.close();
  }
});
test('oversized access tokens cannot create an unusable connection or leave a grant behind', async () => {
  const f = await fixture();
  try {
    f.setOversizedToken();
    const { reply, callback } = await f.connect();
    expect((await fetch(callback)).status).toBe(400);
    expect((await f.store.oauthAttempt(target, reply.receipt.attempt)).phase).toBe('interrupted');
    expect((await f.store.list(false, input.bot)).items).toEqual([]);
  } finally {
    await f.close();
  }
});
test('scope expansion invalidates bindings and a concurrent disconnect defeats successful refresh', async () => {
  const f = await fixture();
  try {
    const { callback } = await f.connect();
    await fetch(callback);
    f.setScope();
    await f.oauth.token(input.connection);
    expect((await f.store.read(input.connection, input.bot)).revision).toBe(2);
    const grant = (await f.store.oauthGrant(input.connection))!;
    await f.store.oauthRefreshBegin(input.connection, grant.epoch);
    await f.store.oauthRefreshCommit(input.connection, grant.epoch, {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken!,
      scope: grant.scope,
      expiresAt: 1,
    });
    let release = () => {};
    f.pause(
      new Promise<unknown>((resolve) => {
        release = () => resolve(undefined);
      }),
    );
    const refreshing = f.oauth.token(input.connection);
    const failed = expect(refreshing).rejects.toMatchObject({ code: 'OAUTH_RECONNECT_REQUIRED' });
    for (let i = 0; f.counters().refreshes < 2 && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(f.counters().refreshes).toBe(2);
    await f.store.disconnectOAuth({ ...target, revision: 2 }, 'mock-disconnect');
    release();
    await failed;
    expect((await f.store.oauthGrant(input.connection))?.state).toBe('disconnected');
    expect((await f.store.oauthGrant(input.connection))?.accessToken).toBe('');
  } finally {
    await f.close();
  }
});
