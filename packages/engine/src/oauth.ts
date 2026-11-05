import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  type AppConnect,
  type AppOAuthPhase,
  type AppOAuthReceipt,
  type AppProvider,
  type AppTarget,
  appProvider,
  isAppConnect,
} from '@daban/protocol';
import { startAuthorization } from '@modelcontextprotocol/client';
import { Fault } from './control.js';
import type { Integrations, OAuthGrant } from './integrations.js';
import { OAuthFetch } from './oauth-fetch.js';
export interface OAuthPrivateReply {
  receipt: AppOAuthReceipt;
  authorize?: { url: string; expiresAt: number };
}
export interface OAuthOptions {
  request?: (
    url: string,
    body?: URLSearchParams | Record<string, unknown>,
  ) => Promise<{ status: number; data: unknown }>;
  assertOwner?: (bot: string) => unknown | Promise<unknown>;
}
interface Pending {
  application: Readonly<AppProvider>;
  requireIssuer: boolean;
  target: AppTarget;
  receipt: AppOAuthReceipt;
  server: Server;
  state: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  consumed: boolean;
  clientId?: string;
  clientSecret?: string;
  url?: string;
  timer?: ReturnType<typeof setTimeout>;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const secret = (v: unknown): v is string =>
  typeof v === 'string' && /^[\x21-\x7e]{1,8192}$/.test(v);
const same = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
function scope(v: unknown, fallback: string) {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || v.length > 4096 || !/^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/.test(v))
    throw new Fault('OAUTH_TOKEN_REJECTED');
  return [...new Set(v.trim().split(/ +/).filter(Boolean))].sort().join(' ');
}
export class OAuth {
  private readonly active = new Map<string, Pending>();
  private readonly starting = new Map<string, Promise<OAuthPrivateReply>>();
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly callbacks = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<unknown>;
  constructor(
    readonly store: Integrations,
    readonly options: OAuthOptions = {},
  ) {}
  private request(
    application: Readonly<AppProvider>,
    url: string,
    body?: URLSearchParams | Record<string, unknown>,
  ) {
    if (this.options.request) return this.options.request(url, body);
    return new OAuthFetch([
      application.resourceMetadata,
      application.metadata,
      application.register,
      application.token,
    ]).request(url, body);
  }
  async start(input: AppConnect): Promise<OAuthPrivateReply> {
    if (this.closed) throw new Fault('OAUTH_CLOSED');
    if (!isAppConnect(input)) throw new Fault('OAUTH_INVALID_REQUEST', 400);
    const application = appProvider(input.app)!;
    await this.options.assertOwner?.(input.bot);
    const receipt = await this.store.beginOAuth(input, Date.now() + 600000);
    const underway = this.starting.get(receipt.attempt);
    if (underway) return underway;
    const pending = this.active.get(receipt.attempt);
    if (pending) return this.reply(pending);
    if (receipt.phase !== 'preparing') return { receipt };
    const result = this.prepare(receipt, application).finally(() =>
      this.starting.delete(receipt.attempt),
    );
    this.starting.set(receipt.attempt, result);
    return result;
  }
  private async reply(pending: Pending): Promise<OAuthPrivateReply> {
    const receipt = await this.store.oauthAttempt(pending.target, pending.receipt.attempt);
    return {
      receipt,
      ...(receipt.phase === 'waiting' && pending.url
        ? { authorize: { url: pending.url, expiresAt: pending.expiresAt } }
        : {}),
    };
  }
  private async prepare(
    receipt: AppOAuthReceipt,
    application: Readonly<AppProvider>,
  ): Promise<OAuthPrivateReply> {
    const target = { bot: receipt.bot, connection: receipt.connection, revision: receipt.revision };
    const existing = await this.store.oauthGrant(receipt.connection);
    const previous =
      existing?.app === application.id && existing.state !== 'disconnected'
        ? existing
        : await this.store.oauthRegistration(target, application.id);
    const oldUri = previous ? new URL(previous.redirectUri) : undefined;
    const server = createServer((req, res) => {
      const callback = this.callback(receipt.attempt, req, res)
        .catch(() => {
          if (!res.writableEnded) {
            res.writeHead(400);
            res.end('Authorization rejected.');
          }
        })
        .finally(() => this.callbacks.delete(callback));
      this.callbacks.add(callback);
    });
    const pending: Pending = {
      application,
      requireIssuer: application.issuerRequired,
      target,
      receipt,
      server,
      state: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
      redirectUri: '',
      expiresAt: Date.now() + 600000,
      consumed: false,
    };
    this.active.set(receipt.attempt, pending);
    try {
      await new Promise<unknown>((resolve, reject) => {
        const fail = () => reject(new Fault('OAUTH_CALLBACK_UNAVAILABLE'));
        server.once('error', fail);
        server.listen(oldUri ? Number(oldUri.port) : 0, '127.0.0.1', () => {
          server.off('error', fail);
          resolve(undefined);
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Fault('OAUTH_CALLBACK_UNAVAILABLE');
      pending.redirectUri = `http://127.0.0.1:${address.port}${oldUri?.pathname ?? `/oauth/${randomBytes(24).toString('hex')}`}`;
      const resource = await this.request(application, application.resourceMetadata);
      await this.options.assertOwner?.(target.bot);
      const metadata = await this.request(application, application.metadata);
      await this.options.assertOwner?.(target.bot);
      const r = resource.data,
        m = metadata.data;
      // Only the existing Notion contract permits its published root resource. New providers bind exactly to the reviewed resource.
      if (
        resource.status !== 200 ||
        metadata.status !== 200 ||
        !object(r) ||
        (r.resource !== application.resource &&
          !(application.id === 'notion' && r.resource === application.issuer)) ||
        !Array.isArray(r.authorization_servers) ||
        r.authorization_servers.length !== 1 ||
        r.authorization_servers[0] !== application.issuer ||
        !object(m) ||
        m.issuer !== application.issuer ||
        m.authorization_endpoint !== application.authorize ||
        m.token_endpoint !== application.token ||
        m.registration_endpoint !== application.register ||
        !Array.isArray(m.code_challenge_methods_supported) ||
        !m.code_challenge_methods_supported.includes('S256') ||
        !Array.isArray(m.response_types_supported) ||
        !m.response_types_supported.includes('code') ||
        !Array.isArray(m.grant_types_supported) ||
        !['authorization_code', 'refresh_token'].every((x) =>
          (m.grant_types_supported as unknown[]).includes(x),
        ) ||
        (r.resource !== application.resource &&
          (!Array.isArray(m.protected_resources) ||
            !m.protected_resources.includes(application.resource)))
      )
        throw new Fault('OAUTH_METADATA_REJECTED');
      pending.requireIssuer ||= m.authorization_response_iss_parameter_supported === true;
      if (previous) {
        pending.clientId = previous.clientId;
        pending.clientSecret = previous.clientSecret ?? undefined;
      } else {
        const registration = await this.request(application, application.register, {
          client_name: 'Daban',
          redirect_uris: [pending.redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: application.clientAuthentication,
        });
        const client = registration.data;
        if (
          ![200, 201].includes(registration.status) ||
          !object(client) ||
          !secret(client.client_id) ||
          (client.client_secret !== undefined && !secret(client.client_secret)) ||
          (client.token_endpoint_auth_method !== undefined &&
            !['none', 'client_secret_post'].includes(String(client.token_endpoint_auth_method))) ||
          (client.token_endpoint_auth_method !== undefined &&
            application.id !== 'notion' &&
            client.token_endpoint_auth_method !== application.clientAuthentication) ||
          (client.token_endpoint_auth_method === 'client_secret_post' &&
            !secret(client.client_secret))
        )
          throw new Fault('OAUTH_CLIENT_REJECTED');
        pending.clientId = client.client_id;
        pending.clientSecret =
          typeof client.client_secret === 'string' ? client.client_secret : undefined;
      }
      if (this.closed || this.active.get(receipt.attempt) !== pending)
        throw new Fault('OAUTH_ATTEMPT_INACTIVE');
      await this.options.assertOwner?.(target.bot);
      await this.store.rememberOAuthRegistration(target, receipt.attempt, {
        clientId: pending.clientId!,
        clientSecret: pending.clientSecret,
        redirectUri: pending.redirectUri,
      });
      const { authorizationUrl, codeVerifier } = await startAuthorization(application.issuer, {
        metadata: {
          issuer: application.issuer,
          authorization_endpoint: application.authorize,
          token_endpoint: application.token,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        },
        clientInformation: { client_id: pending.clientId! },
        redirectUrl: pending.redirectUri,
        state: pending.state,
        scope: application.scope || undefined,
        resource: application.resource,
      });
      pending.verifier = codeVerifier;
      pending.url = authorizationUrl.href;
      await this.options.assertOwner?.(target.bot);
      if (this.closed) throw new Fault('OAUTH_CLOSED');
      const phase = await this.store.oauthPhase(target, receipt.attempt, 'waiting');
      if (phase.phase !== 'waiting') throw new Fault('OAUTH_ATTEMPT_INACTIVE');
      pending.timer = setTimeout(
        () => {
          this.end(pending, 'expired', 'OAUTH_EXPIRED').catch(() => {});
        },
        Math.max(1, pending.expiresAt - Date.now()),
      );
      pending.timer.unref();
      return await this.reply(pending);
    } catch (error) {
      const code =
        error instanceof Fault && /^OAUTH_[A-Z_]+$/.test(error.code)
          ? error.code
          : 'OAUTH_PREPARATION_FAILED';
      await this.end(pending, 'failed', code);
      return { receipt: await this.store.oauthAttempt(target, receipt.attempt) };
    }
  }
  private async callback(attempt: string, req: IncomingMessage, res: ServerResponse) {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    const pending = this.active.get(attempt);
    if (
      !pending ||
      pending.consumed ||
      req.method !== 'GET' ||
      !req.url ||
      req.url.length > 8192 ||
      Date.now() >= pending.expiresAt ||
      req.headers.host !== new URL(pending.redirectUri).host
    ) {
      res.writeHead(400);
      res.end('Authorization rejected.');
      return;
    }
    const application = pending.application;
    const url = new URL(req.url, pending.redirectUri),
      params = url.searchParams;
    if (
      url.pathname !== new URL(pending.redirectUri).pathname ||
      [...params.keys()].some(
        (k) =>
          !['code', 'state', 'iss', 'error', 'error_description', 'error_uri'].includes(k) ||
          params.getAll(k).length !== 1,
      ) ||
      !same(params.get('state') ?? '', pending.state) ||
      (params.has('iss') ? params.get('iss') !== application.issuer : pending.requireIssuer) ||
      (!params.has('error') && !secret(params.get('code')))
    ) {
      res.writeHead(400);
      res.end('Authorization rejected.');
      return;
    }
    // Consume before awaiting anything: two callbacks must never exchange the one-time code twice.
    pending.consumed = true;
    if (params.has('error')) {
      await this.end(pending, 'cancelled', 'OAUTH_DENIED');
      res.end('Authorization cancelled. Return to Daban.');
      return;
    }
    try {
      const phase = await this.store.oauthPhase(pending.target, attempt, 'exchanging');
      if (phase.phase !== 'exchanging' || this.closed) throw new Fault('OAUTH_ATTEMPT_INACTIVE');
      await this.options.assertOwner?.(pending.target.bot);
      if (this.closed || this.active.get(attempt) !== pending)
        throw new Fault('OAUTH_ATTEMPT_INACTIVE');
      const response = await this.request(
        application,
        application.token,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: params.get('code')!,
          code_verifier: pending.verifier,
          client_id: pending.clientId!,
          ...(pending.clientSecret ? { client_secret: pending.clientSecret } : {}),
          redirect_uri: pending.redirectUri,
          resource: application.resource,
        }),
      );
      const tokens = this.tokens(response, application.scope, application, [
        pending.clientId,
        pending.clientSecret,
      ]);
      await this.options.assertOwner?.(pending.target.bot);
      if (this.closed) throw new Fault('OAUTH_CLOSED');
      const data = object(response.data) ? response.data : {};
      const identity = [data.user_id, data.workspace_id, data.bot_id]
        .filter((x) => typeof x === 'string')
        .join(':');
      await this.store.oauthCommit(pending.target, attempt, {
        ...tokens,
        issuer: application.issuer,
        resource: application.resource,
        tokenEndpoint: application.token,
        clientId: pending.clientId!,
        clientSecret: pending.clientSecret,
        redirectUri: pending.redirectUri,
        ...(identity ? { identity: createHash('sha256').update(identity).digest('hex') } : {}),
      });
      res.end('Authorization saved. Return to Daban to inspect and select tools.');
    } catch {
      await this.store.oauthPhase(
        pending.target,
        attempt,
        'interrupted',
        'OAUTH_EXCHANGE_INTERRUPTED',
      );
      res.writeHead(400);
      res.end('Authorization was not confirmed. Start a new authorization in Daban.');
    } finally {
      this.dispose(pending);
    }
  }
  private tokens(
    response: { status: number; data: unknown },
    previousScope: string,
    application: Readonly<AppProvider>,
    privateValues: (string | undefined | null)[] = [],
  ): Pick<OAuthGrant, 'accessToken' | 'refreshToken' | 'expiresAt' | 'scope'> {
    const data = response.data;
    if (
      response.status !== 200 ||
      !object(data) ||
      !secret(data.access_token) ||
      data.access_token.length > 4096 ||
      data.token_type?.toString().toLowerCase() !== 'bearer' ||
      (data.expires_in === undefined
        ? application.expirationRequired
        : !Number.isSafeInteger(data.expires_in) ||
          Number(data.expires_in) <= 0 ||
          !Number.isSafeInteger(Date.now() + Number(data.expires_in) * 1000)) ||
      (data.refresh_token !== undefined && !secret(data.refresh_token))
    )
      throw new Fault('OAUTH_TOKEN_REJECTED');
    const granted = scope(data.scope, previousScope);
    if (
      [data.access_token, data.refresh_token, ...privateValues].some(
        (value) =>
          typeof value === 'string' &&
          value.length > 0 &&
          (granted.split(' ').includes(value) || (value.length >= 8 && granted.includes(value))),
      )
    )
      throw new Fault('OAUTH_TOKEN_REJECTED');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token as string | undefined,
      ...(data.expires_in === undefined
        ? {}
        : { expiresAt: Date.now() + Number(data.expires_in) * 1000 }),
      scope: granted,
    };
  }
  async cancel(target: AppTarget, attempt: string, requestId: string): Promise<AppOAuthReceipt> {
    const receipt = await this.store.oauthAttempt(target, attempt);
    if (receipt.requestId !== requestId) throw new Fault('OAUTH_REQUEST_ID_REUSED');
    const pending = this.active.get(attempt);
    if (pending) await this.end(pending, 'cancelled', 'OAUTH_CANCELLED');
    else await this.store.oauthPhase(target, attempt, 'cancelled', 'OAUTH_CANCELLED');
    return this.store.oauthAttempt(target, attempt);
  }
  async token(connection: string): Promise<string> {
    if (this.closed) throw new Fault('OAUTH_CLOSED');
    const active = this.refreshing.get(connection);
    if (active) return active;
    const grant = await this.store.oauthGrant(connection);
    const concurrent = this.refreshing.get(connection);
    if (concurrent) return concurrent;
    if (grant?.state !== 'connected') throw new Fault('OAUTH_RECONNECT_REQUIRED');
    if (grant.expiresAt === null || grant.expiresAt > Date.now() + 30000) return grant.accessToken;
    const promise = this.refresh(connection, grant).finally(() =>
      this.refreshing.delete(connection),
    );
    this.refreshing.set(connection, promise);
    return promise;
  }
  private async refresh(
    connection: string,
    grant: NonNullable<Awaited<ReturnType<Integrations['oauthGrant']>>>,
  ) {
    const application = appProvider(grant.app);
    try {
      if (
        !application ||
        !grant.refreshToken ||
        grant.issuer !== application.issuer ||
        grant.resource !== application.resource ||
        grant.tokenEndpoint !== application.token
      )
        throw new Fault('OAUTH_RECONNECT_REQUIRED');
      // Persist uncertainty before sending a rotating refresh token; a crash cannot make it replayable.
      await this.store.oauthRefreshBegin(connection, grant.epoch);
      const response = await this.request(
        application,
        grant.tokenEndpoint,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: grant.refreshToken,
          client_id: grant.clientId,
          ...(grant.clientSecret ? { client_secret: grant.clientSecret } : {}),
          resource: grant.resource,
        }),
      );
      const tokens = this.tokens(response, grant.scope, application, [
        grant.clientId,
        grant.clientSecret,
      ]);
      if (this.closed) throw new Fault('OAUTH_CLOSED');
      await this.store.oauthRefreshCommit(connection, grant.epoch, {
        ...tokens,
        refreshToken: tokens.refreshToken ?? grant.refreshToken,
      });
      return tokens.accessToken;
    } catch {
      await this.store.oauthReconnectRequired(connection, grant.epoch);
      throw new Fault('OAUTH_RECONNECT_REQUIRED');
    }
  }
  private dispose(pending: Pending) {
    clearTimeout(pending.timer);
    this.active.delete(pending.receipt.attempt);
    pending.verifier = '';
    pending.state = '';
    pending.url = undefined;
    pending.clientSecret = undefined;
    pending.server.close();
    pending.server.closeIdleConnections();
  }
  private async end(pending: Pending, phase: AppOAuthPhase, error: string) {
    try {
      await this.store.oauthPhase(pending.target, pending.receipt.attempt, phase, error);
    } finally {
      this.dispose(pending);
    }
  }
  close() {
    // Every caller must wait for the same drain before closing the shared SQLite owner.
    this.closing ??= this.drain();
    return this.closing;
  }
  private async drain() {
    this.closed = true;
    await Promise.allSettled(
      [...this.active.values()].map((p) => this.end(p, 'interrupted', 'OAUTH_INTERRUPTED')),
    );
    // Code exchanges may still be awaiting HTTPS after cancellation; their store must remain open until they settle.
    await Promise.allSettled([
      ...this.starting.values(),
      ...this.refreshing.values(),
      ...this.callbacks,
    ]);
  }
}
