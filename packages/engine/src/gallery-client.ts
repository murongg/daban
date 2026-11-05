import {
  botReleaseText,
  type GalleryDiscovery,
  type GalleryPage,
  type GalleryRelease,
  type GalleryTemplate,
  galleryOrigin,
  parseBotRelease,
  parseReleaseJSON,
  releaseDigest,
  releaseUuid,
} from '@daban/protocol';
import { eq } from 'drizzle-orm';
import { Fault } from './control.js';
import { galleryRecord as galleryObject } from './gallery-http.js';
import { type ReleaseStore, releaseHash } from './releases.js';
import { releaseSources } from './releases-schema.js';

export class GalleryClient {
  constructor(readonly store: ReleaseStore) {}
  list() {
    return this.store.db
      .select()
      .from(releaseSources)
      .all()
      .map(({ token, ...source }) => ({ ...source, authenticated: !!token }));
  }
  private source(origin: string) {
    const source = this.store.db
      .select()
      .from(releaseSources)
      .where(eq(releaseSources.origin, origin))
      .get();
    if (!source) throw new Fault('GALLERY_SOURCE_NOT_FOUND', 404);
    return source;
  }
  private async fetch(
    origin: string,
    route: string,
    token?: string | null,
    init: RequestInit = {},
    limit = 1024 * 1024,
  ) {
    if (!galleryOrigin(origin, true) || !route.startsWith('/') || route.startsWith('//'))
      throw new Fault('INVALID_GALLERY_SOURCE', 400);
    const response = await fetch(`${origin}${route}`, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(60000),
      headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (response.status >= 300 && response.status < 400)
      throw new Fault('GALLERY_REDIRECT_REJECTED');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > limit) {
          await reader.cancel();
          throw new Fault('PACKAGE_TOO_LARGE', 413);
        }
        chunks.push(part.value);
      }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (!response.ok) {
      let code = 'GALLERY_REQUEST_FAILED';
      try {
        const value = JSON.parse(text);
        if (typeof value?.error?.code === 'string' && /^[A-Z_]{1,80}$/.test(value.error.code))
          code = value.error.code;
      } catch {
        /* Only stable error codes cross the remote boundary. */
      }
      throw new Fault(
        code === 'INVALID_CREDENTIAL' ? 'GALLERY_INVALID_CREDENTIAL' : code,
        response.status,
      );
    }
    return { text, response };
  }
  private async discover(origin: string): Promise<GalleryDiscovery> {
    const { text } = await this.fetch(origin, '/.well-known/daban-gallery.json');
    const value = parseReleaseJSON(text);
    if (
      !galleryObject(value) ||
      value.format !== 'daban.gallery' ||
      value.version !== 1 ||
      !releaseUuid(value.sourceId) ||
      typeof value.name !== 'string' ||
      value.name.length > 200 ||
      !Array.isArray(value.apiVersions) ||
      !value.apiVersions.includes(1) ||
      !Array.isArray(value.packageVersions) ||
      !value.packageVersions.includes(3) ||
      !['public', 'private'].includes(String(value.readMode)) ||
      !Number.isSafeInteger(value.maxPackageBytes) ||
      Number(value.maxPackageBytes) < 1 ||
      Number(value.maxPackageBytes) > 104857600
    )
      throw new Fault('GALLERY_PROTOCOL_UNSUPPORTED');
    return value as unknown as GalleryDiscovery;
  }
  async save(origin: string, token?: string) {
    const prior = this.store.db
      .select()
      .from(releaseSources)
      .where(eq(releaseSources.origin, origin))
      .get();
    const discovery = await this.discover(origin);
    if (prior && prior.sourceId !== discovery.sourceId) throw new Fault('GALLERY_SOURCE_CHANGED');
    const credential = token === undefined ? prior?.token : token || null;
    await this.fetch(origin, '/api/v1/templates?limit=1', credential);
    const value = {
      origin,
      sourceId: discovery.sourceId,
      name: discovery.name,
      token: credential ?? null,
    };
    this.store.db
      .insert(releaseSources)
      .values(value)
      .onConflictDoUpdate({ target: releaseSources.origin, set: value })
      .run();
    return this.list();
  }
  remove(origin: string) {
    this.store.db.delete(releaseSources).where(eq(releaseSources.origin, origin)).run();
    return this.list();
  }
  private async request(origin: string, route: string, init: RequestInit = {}, limit?: number) {
    const source = this.source(origin);
    const discovery = await this.discover(origin);
    if (source.sourceId !== discovery.sourceId) throw new Fault('GALLERY_SOURCE_CHANGED');
    return this.fetch(origin, route, source.token, init, limit);
  }
  async templates(origin: string, q = '', cursor?: string): Promise<GalleryPage<GalleryTemplate>> {
    const query = new URLSearchParams({ q });
    if (cursor) query.set('cursor', cursor);
    const result = parseReleaseJSON(
      (await this.request(origin, `/api/v1/templates?${query}`)).text,
    );
    if (
      !galleryObject(result) ||
      !Array.isArray(result.items) ||
      result.items.length > 100 ||
      (result.nextCursor !== null && typeof result.nextCursor !== 'string')
    )
      throw new Fault('INVALID_GALLERY_RESPONSE');
    return result as unknown as GalleryPage<GalleryTemplate>;
  }
  async releases(origin: string, id: string): Promise<GalleryPage<GalleryRelease>> {
    const value = parseReleaseJSON(
      (await this.request(origin, `/api/v1/templates/${id}/releases?limit=100`)).text,
    );
    if (!galleryObject(value) || !Array.isArray(value.items))
      throw new Fault('INVALID_GALLERY_RESPONSE');
    return value as unknown as GalleryPage<GalleryRelease>;
  }
  async download(origin: string, id: string, version: string, expected?: string) {
    const descriptor = parseReleaseJSON(
      (await this.request(origin, `/api/v1/templates/${id}/releases/${version}`)).text,
    );
    if (
      !galleryObject(descriptor) ||
      !releaseDigest(descriptor.digest) ||
      descriptor.templateId !== id ||
      descriptor.version !== version ||
      descriptor.packageVersion !== 3 ||
      descriptor.state !== 'published'
    )
      throw new Fault('INVALID_GALLERY_RESPONSE');
    if (expected && expected !== descriptor.digest) throw new Fault('GALLERY_CONTENT_CHANGED');
    const downloaded = await this.request(
      origin,
      `/api/v1/templates/${id}/releases/${version}/package`,
      {},
      104857600,
    );
    if (
      releaseHash(downloaded.text) !== descriptor.digest ||
      downloaded.response.headers.get('daban-package-sha256') !== descriptor.digest
    )
      throw new Fault('PACKAGE_INTEGRITY_ERROR');
    const release = parseBotRelease(downloaded.text, true);
    if (release.manifest.templateId !== id || release.manifest.releaseVersion !== version)
      throw new Fault('PACKAGE_PATH_MISMATCH');
    return { release, source: { sourceOrigin: origin, sourceId: this.source(origin).sourceId } };
  }
  async publish(
    origin: string,
    namespace: string,
    slug: string,
    digest: string,
    visibility: 'public' | 'private' = 'private',
  ) {
    const release = await this.store.read(digest);
    const id = release.manifest.templateId;
    try {
      await this.request(origin, `/api/v1/templates/${id}`);
    } catch (error) {
      if (!(error instanceof Fault && error.status === 404)) throw error;
      await this.request(origin, '/api/v1/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          id,
          namespace,
          slug,
          name: release.definition.profile.name,
          summary: release.manifest.summary,
          tags: [],
          visibility,
        }),
      });
    }
    return parseReleaseJSON(
      (
        await this.request(
          origin,
          `/api/v1/templates/${id}/releases/${release.manifest.releaseVersion}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Daban-Package-SHA256': digest },
            body: botReleaseText(release),
          },
          1024 * 1024,
        )
      ).text,
    );
  }
}
