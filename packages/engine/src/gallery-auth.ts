import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import type { GallerySession } from '@daban/protocol';
import { galleryOrigin } from '@daban/protocol';
import { APIError } from 'better-auth/api';
import { betterAuth } from 'better-auth/minimal';
import type { drizzle } from 'drizzle-orm/d1';
import { Fault } from './control.js';
import type { Database } from './database.js';
import { readBody } from './gallery-http.js';
import {
  galleryAccounts,
  galleryAuthSessions,
  galleryRateLimits,
  galleryUsers,
  galleryVerifications,
} from './gallery-schema.js';

export interface GalleryAuthConfig {
  clientId: string;
  clientSecret: string;
  secret: string;
  adminIds?: readonly string[];
  allowedIds?: readonly string[];
}
interface GalleryAuthEnvironment {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  GALLERY_GITHUB_ADMIN_IDS?: string;
  GALLERY_GITHUB_ALLOWED_IDS?: string;
}
export interface GalleryAuth {
  hasSession(request: Request): boolean;
  session(request: Request): Promise<GallerySession | undefined>;
  handle(request: Request, address: string): Promise<Response>;
  logout(request: Request): Promise<Response>;
}
export const githubId = (value: string) => /^[1-9][0-9]{0,19}$/.test(value);
export function galleryAuthConfig(env: GalleryAuthEnvironment): GalleryAuthConfig | undefined {
  const values = [env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, env.BETTER_AUTH_SECRET];
  if (
    values.every((value) => !value) &&
    !env.GALLERY_GITHUB_ADMIN_IDS &&
    !env.GALLERY_GITHUB_ALLOWED_IDS
  )
    return;
  if (values.some((value) => !value)) throw new Fault('INVALID_GITHUB_CONFIG', 400);
  const ids = (value: string | undefined) =>
    value?.trim() ? [...new Set(value.split(',').map((id) => id.trim()))] : undefined;
  const config = {
    clientId: env.GITHUB_CLIENT_ID!,
    clientSecret: env.GITHUB_CLIENT_SECRET!,
    secret: env.BETTER_AUTH_SECRET!,
    adminIds: ids(env.GALLERY_GITHUB_ADMIN_IDS),
    allowedIds: ids(env.GALLERY_GITHUB_ALLOWED_IDS),
  };
  validate(config);
  return config;
}
function validate(config: GalleryAuthConfig) {
  if (
    !config.clientId ||
    !config.clientSecret ||
    config.secret.length < 32 ||
    [...(config.adminIds ?? []), ...(config.allowedIds ?? [])].some((id) => !githubId(id))
  )
    throw new Fault('INVALID_GITHUB_CONFIG', 400);
}
export function githubAllowed(config: GalleryAuthConfig, id: string, publicGallery: boolean) {
  return (
    githubId(id) &&
    (config.adminIds?.includes(id) ||
      config.allowedIds?.includes(id) ||
      (publicGallery && config.allowedIds === undefined))
  );
}
export function githubScopes(config: GalleryAuthConfig, id: string) {
  return config.adminIds?.includes(id)
    ? (['admin'] as const)
    : (['catalog:read', 'templates:write', 'releases:write'] as const);
}
export function createGalleryAuth(
  database: Database | ReturnType<typeof drizzle>,
  config: GalleryAuthConfig,
  origin: string,
  publicGallery: boolean,
  resolve: (id: string, csrfToken: string) => GallerySession | Promise<GallerySession>,
  revoke: (id: string) => unknown | Promise<unknown>,
): GalleryAuth {
  validate(config);
  if (!galleryOrigin(origin, true)) throw new Fault('INVALID_GITHUB_CONFIG', 400);
  const cookiePrefix = 'daban_gallery_auth';
  const sessionName = `${origin.startsWith('https:') ? '__Secure-' : ''}${cookiePrefix}.session_token`;
  const auth = betterAuth({
    baseURL: origin,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [origin],
    database: drizzleAdapter(database, {
      provider: 'sqlite',
      // D1 batches and Node's synchronous SQLite transactions cannot wrap async adapter callbacks.
      transaction: false,
      schema: {
        user: galleryUsers,
        session: galleryAuthSessions,
        account: galleryAccounts,
        verification: galleryVerifications,
        rateLimit: galleryRateLimits,
      },
    }),
    advanced: {
      cookiePrefix,
      useSecureCookies: origin.startsWith('https:'),
      ipAddress: { ipAddressHeaders: ['x-daban-client-ip'] },
      database: { generateId: 'uuid' },
    },
    session: { expiresIn: 43200, disableSessionRefresh: true, cookieCache: { enabled: false } },
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    emailAndPassword: { enabled: false },
    rateLimit: { enabled: true, storage: 'database' },
    onAPIError: { errorURL: `${origin}/?auth_error=1` },
    socialProviders: {
      github: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        mapProfileToUser: (profile) => {
          const id = String(profile.id);
          if (!githubAllowed(config, id, publicGallery))
            throw new APIError('FORBIDDEN', { message: 'GITHUB_ACCESS_DENIED' });
          return {};
        },
      },
    },
  });
  const current = (request: Request) => auth.api.getSession({ headers: request.headers });
  const logout = async (request: Request) => {
    const value = await current(request);
    // Better Auth's sign-out can log deletion failures; our business revocation must fail closed.
    if (value) await revoke(value.session.id);
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    return auth.handler(
      new Request(`${origin}/api/auth/sign-out`, { method: 'POST', headers, body: '{}' }),
    );
  };
  return {
    // Match Better Auth's scheme-specific cookie so an unrelated HTTP cookie cannot shadow HTTPS.
    hasSession: (request) =>
      !!request.headers
        .get('cookie')
        ?.split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${sessionName}=`) && part.length > sessionName.length + 1),
    session: async (request) => {
      const value = await current(request);
      if (!value) return;
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(config.secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signed = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`gallery-csrf:${value.session.token}`),
      );
      const csrf = Array.from(new Uint8Array(signed), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      return resolve(value.session.id, csrf);
    },
    logout,
    handle: async (request, address) => {
      const url = new URL(request.url),
        route = url.pathname.slice('/api/auth'.length);
      const error = (status: number) =>
        Response.json(
          { code: 'INVALID_AUTH_REQUEST', message: 'INVALID_AUTH_REQUEST' },
          { status },
        );
      if (
        !(
          (request.method === 'POST' && ['/sign-in/social', '/sign-out'].includes(route)) ||
          (request.method === 'GET' && route === '/callback/github')
        )
      )
        return error(404);
      if (request.method === 'POST' && request.headers.get('origin') !== origin) return error(403);
      if (route === '/sign-out') return logout(request);
      let body: string | undefined;
      if (route === '/sign-in/social') {
        const text = await readBody(request, 8192);
        let input: unknown;
        try {
          input = JSON.parse(text);
        } catch {
          return error(400);
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return error(400);
        const fields = input as Record<string, unknown>;
        if (
          fields.provider !== 'github' ||
          Object.keys(fields).some(
            (key) => !['provider', 'callbackURL', 'errorCallbackURL'].includes(key),
          )
        )
          return error(400);
        for (const key of ['callbackURL', 'errorCallbackURL'])
          if (fields[key] !== undefined) {
            if (typeof fields[key] !== 'string') return error(400);
            try {
              const target = new URL(fields[key], origin);
              if (target.origin !== origin || target.username || target.password) return error(400);
            } catch {
              return error(400);
            }
          }
        body = JSON.stringify(fields);
      }
      const headers = new Headers(request.headers);
      headers.set('x-daban-client-ip', address);
      if (body !== undefined) headers.delete('content-length');
      try {
        const response = await auth.handler(
          new Request(request.url, { method: request.method, headers, body }),
        );
        if (route === '/callback/github' && response.status >= 400)
          return Response.redirect(`${origin}/?auth_error=1`, 302);
        return response;
      } catch (error) {
        if (route !== '/callback/github') throw error;
        console.error(
          'GITHUB_OAUTH_CALLBACK_FAILED',
          error instanceof Error ? error.name : 'UnknownAuthError',
        );
        return Response.redirect(`${origin}/?auth_error=1`, 302);
      }
    },
  };
}
