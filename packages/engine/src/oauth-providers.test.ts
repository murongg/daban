import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appProviders, isAppAuthorizeUrl } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { Integrations } from './integrations.js';
import { OAuth, type OAuthOptions } from './oauth.js';
import { secureDirectory } from './private-files.js';

const providers = appProviders.filter((provider) => provider.id !== 'notion');
async function fixture(provider: (typeof appProviders)[number]) {
  const root = await secureDirectory(await mkdtemp(path.join(tmpdir(), 'synthetic-provider-')));
  const file = path.join(root, 'integrations.sqlite');
  let store = new Integrations(file);
  let registrations = 0;
  let exchanges = 0;
  let refreshes = 0;
  let verifier = '';
  let noExpiry = false;
  let shortExpiry = false;
  let lostRefresh = false;
  let wrongResource = false;
  let lostExchange = false;
  let leakScope = false;
  let owner = true;
  let pauseExchange = false;
  let release!: () => unknown;
  let arrived!: () => unknown;
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const waiting = new Promise<unknown>((resolve) => {
    arrived = () => resolve(undefined);
  });
  const request: NonNullable<OAuthOptions['request']> = async (url, body) => {
    if (url === provider.resourceMetadata)
      return {
        status: 200,
        data: {
          resource: wrongResource ? provider.issuer : provider.resource,
          authorization_servers: [provider.issuer],
        },
      };
    if (url === provider.metadata)
      return {
        status: 200,
        data: {
          issuer: provider.issuer,
          protected_resources: [provider.resource],
          authorization_endpoint: provider.authorize,
          token_endpoint: provider.token,
          registration_endpoint: provider.register,
          code_challenge_methods_supported: ['S256'],
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: [provider.clientAuthentication],
        },
      };
    if (url === provider.register) {
      registrations++;
      expect(body).toMatchObject({ token_endpoint_auth_method: provider.clientAuthentication });
      return {
        status: 201,
        data: {
          client_id: 'mock-client',
          ...(provider.clientAuthentication === 'client_secret_post'
            ? { client_secret: 'synthetic-client-secret' }
            : {}),
          token_endpoint_auth_method: provider.clientAuthentication,
        },
      };
    }
    expect(url).toBe(provider.token);
    if (!(body instanceof URLSearchParams)) throw Error('SYNTHETIC_FORM_REQUIRED');
    expect(body.get('resource')).toBe(provider.resource);
    if (body.get('grant_type') === 'authorization_code') {
      exchanges++;
      if (pauseExchange) {
        arrived();
        await gate;
      }
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
        verifier,
      );
      if (lostExchange) throw Error('SYNTHETIC_REPLY_LOST');
    } else {
      refreshes++;
      if (lostRefresh) throw Error('SYNTHETIC_REFRESH_REPLY_LOST');
    }
    return {
      status: 200,
      data: {
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        token_type: 'Bearer',
        scope: leakScope ? 'synthetic-access' : provider.scope,
        ...(noExpiry
          ? {}
          : {
              expires_in: shortExpiry && body.get('grant_type') === 'authorization_code' ? 1 : 3600,
            }),
      },
    };
  };
  const assertOwner = () => {
    if (!owner) throw Error('SYNTHETIC_OWNER_REVOKED');
  };
  let oauth = new OAuth(store, { request, assertOwner });
  const input = {
    app: provider.id,
    bot: 'mock-bot',
    connection: 'mock-app',
    revision: 0,
    requestId: 'mock-start',
    name: 'Synthetic account',
  };
  const target = { bot: input.bot, connection: input.connection, revision: 0 };
  const open = async (requestId = input.requestId) => {
    const reply = await oauth.start({ ...input, requestId });
    expect(reply.receipt.phase).toBe('waiting');
    expect(isAppAuthorizeUrl(reply.authorize?.url, provider.id)).toBe(true);
    const url = new URL(reply.authorize!.url);
    verifier = url.searchParams.get('code_challenge')!;
    return { reply, url };
  };
  const callback = async (url: URL, issuer = provider.issuer) => {
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'synthetic-code');
    callback.searchParams.set('state', url.searchParams.get('state')!);
    if (provider.issuerRequired || issuer !== provider.issuer)
      callback.searchParams.set('iss', issuer);
    return fetch(callback, { redirect: 'error' });
  };
  return {
    file,
    get store() {
      return store;
    },
    get oauth() {
      return oauth;
    },
    input,
    target,
    open,
    callback,
    get counts() {
      return { registrations, exchanges, refreshes };
    },
    changeMetadataResource() {
      wrongResource = true;
    },
    expireSoon() {
      shortExpiry = true;
    },
    loseRefresh() {
      lostRefresh = true;
    },
    noExpiry() {
      noExpiry = true;
    },
    loseExchange() {
      lostExchange = true;
    },
    leakScope() {
      leakScope = true;
    },
    revokeOwner() {
      owner = false;
    },
    pauseExchange() {
      pauseExchange = true;
    },
    waiting,
    releaseExchange: () => release(),
    async reopen() {
      await oauth.close();
      await store.close();
      store = new Integrations(file);
      oauth = new OAuth(store, { request, assertOwner });
      await store.ready;
    },
    async close() {
      release();
      await oauth.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.each(providers)(
  '$id completes its own PKCE flow and retains private provider identity on reopen',
  async (provider) => {
    const f = await fixture(provider);
    try {
      const { reply, url } = await f.open();
      expect(await f.oauth.start(f.input)).toEqual(reply);
      expect((await f.callback(url)).status).toBe(200);
      expect((await f.store.oauthGrant(f.input.connection))?.issuer).toBe(provider.issuer);
      expect(await f.oauth.token(f.input.connection)).toBe('synthetic-access');
      expect(f.counts).toEqual({ registrations: 1, exchanges: 1, refreshes: 0 });
      await f.reopen();
      expect((await f.store.oauthGrant(f.input.connection))?.app).toBe(provider.id);
      expect((await f.store.read(f.input.connection, f.input.bot)).origin).toBe(
        new URL(provider.resource).origin,
      );
      const publicData = JSON.stringify(await f.store.oauthStates(f.input.bot, true));
      expect(publicData).not.toMatch(
        /synthetic-access|synthetic-refresh|synthetic-client-secret|mock-client/,
      );
      await expect(
        f.oauth.start({
          ...f.input,
          app: provider.id === 'linear' ? 'miro' : 'linear',
          revision: 1,
          name: undefined,
          requestId: 'mock-other-provider',
        }),
      ).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_MISMATCH' });
    } finally {
      await f.close();
    }
  },
);

test.each(providers)(
  '$id rejects another issuer before exchanging a code, then consumes the valid callback once',
  async (provider) => {
    const f = await fixture(provider);
    try {
      const { url } = await f.open();
      expect((await f.callback(url, 'https://other.example.test')).status).toBe(400);
      expect(f.counts.exchanges).toBe(0);
      expect((await f.callback(url)).status).toBe(200);
      expect(f.counts.exchanges).toBe(1);
    } finally {
      await f.close();
    }
  },
);

test.each(providers)(
  '$id interrupted authorization reuses its registered redirect without reusing state or PKCE',
  async (provider) => {
    const f = await fixture(provider);
    try {
      const first = await f.open();
      await f.reopen();
      const second = await f.open('mock-retry');
      expect(second.url.searchParams.get('client_id')).toBe(
        first.url.searchParams.get('client_id'),
      );
      expect(second.url.searchParams.get('redirect_uri')).toBe(
        first.url.searchParams.get('redirect_uri'),
      );
      expect(second.url.searchParams.get('state')).not.toBe(first.url.searchParams.get('state'));
      expect(second.url.searchParams.get('code_challenge')).not.toBe(
        first.url.searchParams.get('code_challenge'),
      );
      expect(f.counts.registrations).toBe(1);
      expect((await f.callback(first.url)).status).toBe(400);
      expect((await f.callback(second.url)).status).toBe(200);
    } finally {
      await f.close();
    }
  },
);

test.each(providers)(
  '$id accepts an honestly absent expiry and does not fabricate an expiry or refresh',
  async (provider) => {
    const f = await fixture(provider);
    try {
      f.noExpiry();
      const { url } = await f.open();
      expect((await f.callback(url)).status).toBe(200);
      expect((await f.store.oauthGrant(f.input.connection))?.expiresAt).toBeNull();
      expect((await f.store.oauthStates(f.input.bot, true))[0]).not.toHaveProperty('expiresAt');
      expect(await f.oauth.token(f.input.connection)).toBe('synthetic-access');
      expect(f.counts.refreshes).toBe(0);
    } finally {
      await f.close();
    }
  },
);

test.each(providers)('$id does not replay an exchange after a lost reply', async (provider) => {
  const f = await fixture(provider);
  try {
    const { reply, url } = await f.open();
    f.loseExchange();
    expect((await f.callback(url)).status).toBe(400);
    expect((await f.oauth.start(f.input)).receipt.phase).toBe('interrupted');
    expect((await f.store.oauthAttempt(f.target, reply.receipt.attempt)).phase).toBe('interrupted');
    expect(f.counts.exchanges).toBe(1);
    expect(await f.store.oauthGrant(f.input.connection)).toBeUndefined();
  } finally {
    await f.close();
  }
});

test.each(providers)('$id never publishes a token echoed as a granted scope', async (provider) => {
  const f = await fixture(provider);
  try {
    const { url } = await f.open();
    f.leakScope();
    expect((await f.callback(url)).status).toBe(400);
    expect(await f.store.oauthGrant(f.input.connection)).toBeUndefined();
    expect(JSON.stringify(await f.store.oauthStates(f.input.bot, true))).not.toContain(
      'synthetic-access',
    );
  } finally {
    await f.close();
  }
});

test.each(providers)(
  '$id checks its original owner before consuming a callback code',
  async (provider) => {
    const f = await fixture(provider);
    try {
      const { url } = await f.open();
      f.revokeOwner();
      expect((await f.callback(url)).status).toBe(400);
      expect(f.counts.exchanges).toBe(0);
      expect(await f.store.oauthGrant(f.input.connection)).toBeUndefined();
    } finally {
      await f.close();
    }
  },
);

test('close drains an in-flight exchange before its SQLite owner can close', async () => {
  const f = await fixture(providers[0]);
  try {
    f.pauseExchange();
    const { url } = await f.open();
    const callback = f.callback(url);
    await f.waiting;
    let closed = false;
    const closing = f.oauth.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    f.releaseExchange();
    expect((await callback).status).toBe(400);
    await closing;
    expect(await f.store.oauthGrant(f.input.connection)).toBeUndefined();
  } finally {
    await f.close();
  }
});

test.each(providers)(
  '$id cancels the original attempt and never exchanges a later callback',
  async (provider) => {
    const f = await fixture(provider);
    try {
      const { url, reply } = await f.open();
      expect((await f.oauth.cancel(f.target, reply.receipt.attempt, f.input.requestId)).phase).toBe(
        'cancelled',
      );
      await expect(f.callback(url)).rejects.toThrow();
      expect(f.counts.exchanges).toBe(0);
      expect(await f.store.oauthGrant(f.input.connection)).toBeUndefined();
    } finally {
      await f.close();
    }
  },
);
test.each(providers)(
  '$id singleflights an expired grant refresh and preserves provider identity after restart',
  async (provider) => {
    const f = await fixture(provider);
    try {
      f.expireSoon();
      const { url } = await f.open();
      expect((await f.callback(url)).status).toBe(200);
      expect(
        await Promise.all([f.oauth.token(f.input.connection), f.oauth.token(f.input.connection)]),
      ).toEqual(['synthetic-access', 'synthetic-access']);
      expect(f.counts.refreshes).toBe(1);
      await f.reopen();
      expect(await f.oauth.token(f.input.connection)).toBe('synthetic-access');
      expect((await f.store.oauthGrant(f.input.connection))?.app).toBe(provider.id);
      expect(f.counts.refreshes).toBe(1);
    } finally {
      await f.close();
    }
  },
);
test.each(providers)(
  '$id retains unknown refresh outcome without replay after restart or disconnect',
  async (provider) => {
    const f = await fixture(provider);
    try {
      f.expireSoon();
      const { url } = await f.open();
      expect((await f.callback(url)).status).toBe(200);
      f.loseRefresh();
      await expect(f.oauth.token(f.input.connection)).rejects.toMatchObject({
        code: 'OAUTH_RECONNECT_REQUIRED',
      });
      await f.reopen();
      await expect(f.oauth.token(f.input.connection)).rejects.toMatchObject({
        code: 'OAUTH_RECONNECT_REQUIRED',
      });
      expect(f.counts.refreshes).toBe(1);
      await f.store.disconnectOAuth({ ...f.target, revision: 1 }, 'mock-disconnect');
      expect(
        await f.store.oauthRegistration({ ...f.target, revision: 1 }, provider.id),
      ).toBeUndefined();
      await expect(f.oauth.token(f.input.connection)).rejects.toMatchObject({
        code: 'OAUTH_RECONNECT_REQUIRED',
      });
      expect(f.counts.refreshes).toBe(1);
    } finally {
      await f.close();
    }
  },
);

test.each(providers)(
  '$id denial cancels only the original authorization without exchanging a code',
  async (provider) => {
    const f = await fixture(provider);
    try {
      const { url, reply } = await f.open();
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      callback.searchParams.set('iss', provider.issuer);
      callback.searchParams.set('error', 'access_denied');
      expect((await fetch(callback)).status).toBe(200);
      expect(await f.store.oauthAttempt(f.target, reply.receipt.attempt)).toMatchObject({
        phase: 'cancelled',
        error: 'OAUTH_DENIED',
      });
      expect(f.counts.exchanges).toBe(0);
      expect(await f.store.oauthGrant(f.input.connection)).toBeUndefined();
    } finally {
      await f.close();
    }
  },
);
test.each(providers)(
  '$id rejects an expired callback and preserves the expired receipt',
  async (provider) => {
    const f = await fixture(provider);
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const { url, reply } = await f.open();
      const expired = Date.now() + 601000;
      clock = vi.spyOn(Date, 'now').mockReturnValue(expired);
      expect((await f.callback(url)).status).toBe(400);
      expect((await f.store.oauthAttempt(f.target, reply.receipt.attempt)).phase).toBe('expired');
      expect(f.counts.exchanges).toBe(0);
    } finally {
      clock?.mockRestore();
      await f.close();
    }
  },
);

test.each(providers.filter((provider) => provider.resource !== provider.issuer))(
  '$id requires its exact reviewed protected resource, even if metadata lists that resource',
  async (provider) => {
    const f = await fixture(provider);
    try {
      f.changeMetadataResource();
      expect((await f.oauth.start(f.input)).receipt).toMatchObject({
        phase: 'failed',
        error: 'OAUTH_METADATA_REJECTED',
      });
      expect(f.counts).toEqual({ registrations: 0, exchanges: 0, refreshes: 0 });
    } finally {
      await f.close();
    }
  },
);
