import {
  type GalleryPrincipal,
  type GallerySession,
  galleryOrigin,
  parseReleaseJSON,
} from '@daban/protocol';
import { Fault } from './control.js';
import type { GalleryStore } from './gallery.js';

type Operation =
  | 'discovery'
  | 'authenticate'
  | 'session'
  | 'readSession'
  | 'logout'
  | 'checkCsrf'
  | 'allowed'
  | 'authorize'
  | 'template'
  | 'create'
  | 'patch'
  | 'releases'
  | 'release'
  | 'publish'
  | 'withdraw'
  | 'list'
  | 'download'
  | 'createToken'
  | 'revokeToken';
export type GalleryBackend = {
  [K in Operation]: (
    ...args: Parameters<GalleryStore[K]>
  ) => ReturnType<GalleryStore[K]> | Promise<Awaited<ReturnType<GalleryStore[K]>>>;
};
export interface GalleryHttpOptions {
  origin: string;
  assets?: (request: Request) => Promise<Response>;
}
export async function galleryHash(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function galleryRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function galleryRequestFields(
  value: Record<string, unknown>,
  allowed: string[],
  required: string[] = [],
) {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new Fault('INVALID_REQUEST', 400);
}
async function readBody(request: Request, limit: number) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
    throw new Fault('UNSUPPORTED_MEDIA_TYPE', 415);
  if (Number(request.headers.get('content-length')) > limit)
    throw new Fault('PACKAGE_TOO_LARGE', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new Fault('INVALID_REQUEST', 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > limit) {
      await reader.cancel();
      throw new Fault('PACKAGE_TOO_LARGE', 413);
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Fault('INVALID_REQUEST', 400);
  }
}
async function page<T>(items: T[], query: URLSearchParams, principal?: GalleryPrincipal) {
  const limit = Number(query.get('limit') ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Fault('INVALID_REQUEST', 400);
  const filters: [string, string][] = [];
  query.forEach((value, key) => {
    if (key !== 'cursor') filters.push([key, value]);
  });
  filters.sort(([a], [b]) => a.localeCompare(b));
  const fingerprint = await galleryHash(
    JSON.stringify([
      filters,
      principal?.principalId ?? null,
      principal?.namespaces ?? [],
      principal?.scopes ?? [],
    ]),
  );
  let offset = 0;
  if (query.has('cursor')) {
    try {
      const cursor = JSON.parse(atob(query.get('cursor')!.replace(/-/g, '+').replace(/_/g, '/')));
      if (cursor.query !== fingerprint || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
        throw Error();
      offset = cursor.offset;
    } catch {
      throw new Fault('INVALID_REQUEST', 400);
    }
  }
  return {
    items: items.slice(offset, offset + limit),
    nextCursor:
      offset + limit < items.length
        ? btoa(JSON.stringify({ query: fingerprint, offset: offset + limit }))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '')
        : null,
  };
}

export function createGalleryHandler(store: GalleryBackend, options: GalleryHttpOptions) {
  if (!galleryOrigin(options.origin, true)) throw new Fault('INVALID_GALLERY_CONFIG', 400);
  let uploads = 0;
  const attempts = new Map<string, { count: number; until: number }>();
  const cookieName = 'daban_gallery_session';
  const cookie = (request: Request) =>
    request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
  const authenticate = async (
    request: Request,
  ): Promise<{ principal?: GalleryPrincipal; session?: GallerySession; secret?: string }> => {
    const authorization = request.headers.get('authorization');
    if (authorization) {
      if (!authorization.startsWith('Bearer ')) throw new Fault('INVALID_CREDENTIAL', 401);
      return { principal: (await store.authenticate(authorization.slice(7))).principal };
    }
    const secret = cookie(request);
    if (secret) {
      const session = await store.readSession(secret);
      return { principal: session, session, secret };
    }
    return {};
  };
  return async (request: Request, address = 'unknown'): Promise<Response> => {
    const headers = new Headers({
      'Cache-Control': 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Request-Id': crypto.randomUUID(),
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    const json = (value: unknown, status = 200) => {
      headers.set('Content-Type', 'application/json; charset=utf-8');
      return new Response(JSON.stringify(value), { status, headers });
    };
    try {
      const url = new URL(request.url);
      const route = url.pathname;
      const method = request.method;
      const discovery = await store.discovery();
      if (route === '/healthz' || route === '/readyz') return json({ ok: !!discovery.sourceId });
      if (route === '/.well-known/daban-gallery.json' && method === 'GET') return json(discovery);
      if (!route.startsWith('/api/')) {
        if (method !== 'GET' || !options.assets) throw new Fault('NOT_FOUND', 404);
        const response = await options.assets(request);
        const result = new Response(response.body, response);
        headers.forEach((value, key) => {
          result.headers.set(key, value);
        });
        return result;
      }
      if (!route.startsWith('/api/v1/')) throw new Fault('NOT_FOUND', 404);
      const write = method !== 'GET' && method !== 'HEAD';
      const requestOrigin = request.headers.get('origin');
      if (write && requestOrigin && requestOrigin !== options.origin)
        throw new Fault('CSRF_REJECTED', 403);
      if (route === '/api/v1/sessions' && method === 'POST') {
        if (requestOrigin !== options.origin) throw new Fault('CSRF_REJECTED', 403);
        const previous = attempts.get(address);
        if (previous && previous.until > Date.now() && previous.count >= 10)
          throw new Fault('RATE_LIMITED', 429);
        if (!previous || previous.until <= Date.now()) {
          if (attempts.size > 10000) attempts.clear();
          attempts.set(address, { count: 1, until: Date.now() + 60000 });
        } else previous.count++;
        const input = parseReleaseJSON(await readBody(request, 8192));
        if (!galleryRecord(input) || typeof input.token !== 'string')
          throw new Fault('INVALID_REQUEST', 400);
        galleryRequestFields(input, ['token'], ['token']);
        const result = await store.session(input.token);
        headers.set(
          'Set-Cookie',
          `${cookieName}=${result.secret}; HttpOnly; SameSite=Lax; Path=/api/v1; Max-Age=43200${options.origin.startsWith('https:') ? '; Secure' : ''}`,
        );
        return json(result.session);
      }
      if (route === '/api/v1/sessions/current' && method === 'DELETE' && !cookie(request)) {
        if (requestOrigin !== options.origin) throw new Fault('CSRF_REJECTED', 403);
        return new Response(null, { status: 204, headers });
      }
      const auth = await authenticate(request);
      if (write && auth.session) {
        if (requestOrigin !== options.origin) throw new Fault('CSRF_REJECTED', 403);
        await store.checkCsrf(auth.session.csrfToken, request.headers.get('x-csrf-token') ?? '');
      }
      if (route === '/api/v1/sessions/current') {
        if (!auth.session) throw new Fault('AUTH_REQUIRED', 401);
        if (method === 'GET') return json(auth.session);
        if (method === 'DELETE') {
          await store.logout(auth.secret!);
          headers.set(
            'Set-Cookie',
            `${cookieName}=; HttpOnly; SameSite=Lax; Path=/api/v1; Max-Age=0${options.origin.startsWith('https:') ? '; Secure' : ''}`,
          );
          return new Response(null, { status: 204, headers });
        }
      }
      if ((write || discovery.readMode !== 'public') && !auth.principal)
        throw new Fault('AUTH_REQUIRED', 401);
      if (route === '/api/v1/admin/tokens' && method === 'POST') {
        if (!auth.principal?.scopes.includes('admin')) throw new Fault('PUBLISH_FORBIDDEN', 403);
        const input = parseReleaseJSON(await readBody(request, 8192));
        if (!galleryRecord(input)) throw new Fault('INVALID_REQUEST', 400);
        galleryRequestFields(
          input,
          ['principalId', 'namespaces', 'scopes'],
          ['principalId', 'namespaces', 'scopes'],
        );
        return json(await store.createToken(input as unknown as GalleryPrincipal), 201);
      }
      if (route.startsWith('/api/v1/admin/tokens/') && method === 'DELETE') {
        if (!auth.principal?.scopes.includes('admin')) throw new Fault('PUBLISH_FORBIDDEN', 403);
        await store.revokeToken(route.slice('/api/v1/admin/tokens/'.length));
        return new Response(null, { status: 204, headers });
      }
      if (route === '/api/v1/templates') {
        if (method === 'GET')
          return json(
            await page(
              await store.list(auth.principal, url.searchParams),
              url.searchParams,
              auth.principal,
            ),
          );
        if (method === 'POST')
          return json(
            await store.create(
              parseReleaseJSON(await readBody(request, 65536)),
              auth.principal!,
              request.headers.get('idempotency-key') ?? '',
            ),
            201,
          );
      }
      const match =
        /^\/api\/v1\/templates\/([0-9a-f-]+)(?:\/releases(?:\/([0-9.]+)(\/package)?)?)?$/.exec(
          route,
        );
      if (!match) throw new Fault('NOT_FOUND', 404);
      const [, id, version, packageRoute] = match;
      if (!route.includes('/releases')) {
        if (!['GET', 'PATCH'].includes(method)) throw new Fault('INVALID_REQUEST', 400);
        const item =
          method === 'PATCH'
            ? await store.patch(
                id,
                parseReleaseJSON(await readBody(request, 65536)),
                auth.principal!,
                request.headers.get('if-match') ?? undefined,
              )
            : await store.template(id, auth.principal);
        headers.set('ETag', `"template:${item.revision}"`);
        return json(item);
      }
      if (!version && method === 'GET')
        return json(
          await page(await store.releases(id, auth.principal), url.searchParams, auth.principal),
        );
      if (version && method === 'PUT' && !packageRoute) {
        const template = await store.template(id, auth.principal);
        await store.authorize(auth.principal, template.namespace, 'releases:write');
        if (uploads >= 2) throw new Fault('RATE_LIMITED', 429);
        uploads++;
        try {
          const text = await readBody(request, discovery.maxPackageBytes);
          const current = (await authenticate(request)).principal;
          if (!current) throw new Fault('AUTH_REQUIRED', 401);
          const result = await store.publish(
            id,
            version,
            text,
            request.headers.get('daban-package-sha256') ?? '',
            current,
          );
          return json(result.release, result.created ? 201 : 200);
        } finally {
          uploads--;
        }
      }
      if (version && packageRoute && method === 'GET') {
        const value = await store.download(id, version, auth.principal);
        const principal = (await authenticate(request)).principal;
        const current = await store.release(id, version, principal);
        const template = await store.template(id, principal);
        // Mutable access checks run again after storage I/O, before an ETag can yield 304.
        if (
          current.state === 'withdrawn' &&
          !(await store.allowed(principal, template.namespace, 'releases:write'))
        )
          throw new Fault('RELEASE_WITHDRAWN', 410);
        const etag = `"sha256:${value.release.digest}"`;
        headers.set('ETag', etag);
        headers.set('Daban-Package-SHA256', value.release.digest);
        if (request.headers.get('if-none-match') === etag)
          return new Response(null, { status: 304, headers });
        headers.set('Content-Type', 'application/json; charset=utf-8');
        headers.set('Content-Length', String(new TextEncoder().encode(value.text).length));
        headers.set('Content-Disposition', `attachment; filename="${id}-${version}.bot.json"`);
        return new Response(value.text, { headers });
      }
      if (version && !packageRoute && ['GET', 'PATCH'].includes(method)) {
        const value =
          method === 'PATCH'
            ? await store.withdraw(
                id,
                version,
                parseReleaseJSON(await readBody(request, 65536)),
                auth.principal!,
                request.headers.get('if-match') ?? undefined,
              )
            : await store.release(id, version, auth.principal);
        headers.set('ETag', `"release:${value.revision}"`);
        return json(value);
      }
      throw new Fault('NOT_FOUND', 404);
    } catch (error) {
      const known =
        error instanceof Fault
          ? error
          : error instanceof Error &&
              [
                'INVALID_PACKAGE',
                'NON_CANONICAL_PACKAGE',
                'PACKAGE_TOO_LARGE',
                'UNSUPPORTED_PACKAGE_VERSION',
              ].includes(error.message)
            ? new Fault(
                error.message,
                error.message === 'PACKAGE_TOO_LARGE'
                  ? 413
                  : error.message === 'UNSUPPORTED_PACKAGE_VERSION'
                    ? 422
                    : 400,
              )
            : new Fault('TEMPORARILY_UNAVAILABLE', 503);
      if (known.status === 401) headers.set('WWW-Authenticate', 'Bearer');
      if (known.status === 429 || known.status === 503) headers.set('Retry-After', '60');
      return json(
        {
          error: { code: known.code, message: known.code, requestId: headers.get('x-request-id')! },
        },
        known.status,
      );
    }
  };
}
