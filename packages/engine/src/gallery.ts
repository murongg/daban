import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  botReleaseText,
  compareReleaseVersions,
  type GalleryDiscovery,
  type GalleryPrincipal,
  type GalleryRelease,
  type GalleryScope,
  type GallerySession,
  type GalleryTemplate,
  type GalleryTemplateInput,
  parseBotRelease,
  releaseDigest,
  releaseUuid,
  releaseVersion,
} from '@daban/protocol';
import { and, eq } from 'drizzle-orm';
import { Fault } from './control.js';
import { configure, type Database, migrate } from './database.js';
import { migrations } from './gallery-migrations.js';
import {
  galleryAllowed,
  galleryPrecondition,
  validateGalleryPrincipal,
  validateGalleryTemplate,
} from './gallery-policy.js';
import {
  galleryReleases,
  galleryRequests,
  gallerySessions,
  gallerySettings,
  galleryTemplates,
  galleryTokens,
} from './gallery-schema.js';
import { privateMetadata } from './private-files.js';
import { ReleaseStore, releaseHash } from './releases.js';

export interface GalleryOptions {
  directory: string;
  name?: string;
  readMode?: 'public' | 'private';
  maxPackageBytes?: number;
}
export function galleryObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function galleryFields(
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
const string = (value: unknown, max: number, required = false): value is string =>
  typeof value === 'string' &&
  !value.includes('\0') &&
  !/[\uD800-\uDFFF]/u.test(value) &&
  Buffer.byteLength(value) <= max &&
  (!required || value.trim().length > 0);

export class GalleryStore {
  readonly ready: Promise<unknown>;
  readonly packages: ReleaseStore;
  private connection?: Database;
  private readonly authorities = new WeakMap<GalleryPrincipal, string>();
  sourceId = '';
  constructor(readonly options: GalleryOptions) {
    this.packages = new ReleaseStore(options.directory);
    this.ready = this.load();
  }
  get db() {
    if (!this.connection) throw new Fault('TEMPORARILY_UNAVAILABLE', 503);
    return this.connection;
  }
  private async load() {
    await this.packages.ready;
    const file = path.join(this.options.directory, 'gallery.sqlite');
    const handle = await open(
      file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || !(await privateMetadata(file, info, 0o600)))
        throw new Fault('GALLERY_STORE_UNSAFE');
    } finally {
      await handle.close();
    }
    const client = new DatabaseSync(file);
    try {
      configure(client, { journal: 'WAL', synchronous: 'FULL', busyTimeout: 5000 });
      this.connection = migrate(client, migrations);
      this.db
        .insert(gallerySettings)
        .values({ key: 'sourceId', value: randomUUID() })
        .onConflictDoNothing()
        .run();
      this.sourceId = this.db
        .select()
        .from(gallerySettings)
        .where(eq(gallerySettings.key, 'sourceId'))
        .get()!.value;
      if (!releaseUuid(this.sourceId)) throw new Fault('GALLERY_STORE_UNSAFE');
      this.db.delete(gallerySessions).where(eq(gallerySessions.expires, 0)).run();
    } catch (error) {
      client.close();
      this.connection = undefined;
      throw error;
    }
  }
  discovery(): GalleryDiscovery {
    return {
      format: 'daban.gallery',
      version: 1,
      sourceId: this.sourceId,
      name: this.options.name ?? 'Daban Bot Gallery',
      apiVersions: [1],
      packageVersions: [3],
      readMode: this.options.readMode ?? 'private',
      maxPackageBytes: this.options.maxPackageBytes ?? 104857600,
    };
  }
  createToken(principal: GalleryPrincipal) {
    validateGalleryPrincipal(principal);
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    this.db
      .insert(galleryTokens)
      .values({ id, hash: releaseHash(token), principal: JSON.stringify(principal) })
      .run();
    return { id, token };
  }
  revokeToken(id: string) {
    this.db.transaction((tx) => {
      tx.delete(gallerySessions).where(eq(gallerySessions.token, id)).run();
      tx.delete(galleryTokens).where(eq(galleryTokens.id, id)).run();
    });
  }
  authenticate(token: string) {
    if (token.length > 256) throw new Fault('INVALID_CREDENTIAL', 401);
    const row = this.db
      .select()
      .from(galleryTokens)
      .where(eq(galleryTokens.hash, releaseHash(token)))
      .get();
    if (!row) throw new Fault('INVALID_CREDENTIAL', 401);
    const principal: GalleryPrincipal = JSON.parse(row.principal);
    this.authorities.set(principal, row.id);
    return { principal, tokenId: row.id };
  }
  session(token: string) {
    const authenticated = this.authenticate(token);
    const secret = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const expires = Date.now() + 12 * 3600 * 1000;
    this.db
      .insert(gallerySessions)
      .values({ hash: releaseHash(secret), token: authenticated.tokenId, csrf, expires })
      .run();
    return {
      secret,
      session: {
        ...authenticated.principal,
        csrfToken: csrf,
        expiresAt: new Date(expires).toISOString(),
      } satisfies GallerySession,
    };
  }
  readSession(secret: string) {
    const row = this.db
      .select()
      .from(gallerySessions)
      .where(eq(gallerySessions.hash, releaseHash(secret)))
      .get();
    if (!row || row.expires <= Date.now()) throw new Fault('INVALID_CREDENTIAL', 401);
    const token = this.db.select().from(galleryTokens).where(eq(galleryTokens.id, row.token)).get();
    if (!token) throw new Fault('INVALID_CREDENTIAL', 401);
    const principal: GalleryPrincipal = JSON.parse(token.principal);
    const session = {
      ...principal,
      csrfToken: row.csrf,
      expiresAt: new Date(row.expires).toISOString(),
    } satisfies GallerySession;
    this.authorities.set(session, row.token);
    return session;
  }
  logout(secret: string) {
    this.db
      .delete(gallerySessions)
      .where(eq(gallerySessions.hash, releaseHash(secret)))
      .run();
  }
  checkCsrf(expected: string, actual: string) {
    if (
      Buffer.byteLength(expected) !== Buffer.byteLength(actual) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    )
      throw new Fault('CSRF_REJECTED', 403);
  }
  allowed(principal: GalleryPrincipal | undefined, namespace: string, scope: GalleryScope) {
    return galleryAllowed(principal, namespace, scope);
  }
  authorize(principal: GalleryPrincipal | undefined, namespace: string, scope: GalleryScope) {
    const proof = principal ? this.authorities.get(principal) : undefined;
    if (proof && !this.db.select().from(galleryTokens).where(eq(galleryTokens.id, proof)).get())
      throw new Fault('INVALID_CREDENTIAL', 401);
    if (!this.allowed(principal, namespace, scope)) throw new Fault('PUBLISH_FORBIDDEN', 403);
  }
  private rawTemplate(id: string): GalleryTemplate {
    const row = this.db.select().from(galleryTemplates).where(eq(galleryTemplates.id, id)).get();
    if (!row) throw new Fault('TEMPLATE_NOT_FOUND', 404);
    const value: GalleryTemplate = JSON.parse(row.content);
    const latest = this.rawReleases(id).filter((item) => item.state === 'published')[0];
    value.latest = latest
      ? {
          version: latest.version,
          digest: latest.digest,
          packageVersion: latest.packageVersion,
          bytes: latest.bytes,
        }
      : null;
    return value;
  }
  template(id: string, principal?: GalleryPrincipal) {
    const result = this.rawTemplate(id);
    if (
      !this.allowed(principal, result.namespace, 'catalog:read') &&
      (this.options.readMode !== 'public' || result.visibility !== 'public')
    )
      throw new Fault('TEMPLATE_NOT_FOUND', 404);
    return result;
  }
  private validate(input: GalleryTemplateInput) {
    validateGalleryTemplate(input);
  }
  create(input: unknown, principal: GalleryPrincipal, key: string) {
    if (!galleryObject(input)) throw new Fault('INVALID_REQUEST', 400);
    galleryFields(
      input,
      ['id', 'namespace', 'slug', 'name', 'summary', 'tags', 'visibility'],
      ['id', 'namespace', 'slug', 'name', 'summary', 'tags', 'visibility'],
    );
    this.validate(input as unknown as GalleryTemplateInput);
    const value = input as unknown as GalleryTemplateInput;
    this.authorize(principal, value.namespace, 'templates:write');
    if (!releaseUuid(key)) throw new Fault('INVALID_REQUEST', 400);
    const requestKey = `${principal.principalId}:POST:templates:${key}`;
    const fingerprint = releaseHash(
      JSON.stringify([
        value.id,
        value.namespace,
        value.slug,
        value.name,
        value.summary,
        value.tags,
        value.visibility,
      ]),
    );
    return this.db.transaction(
      (tx) => {
        const previous = tx
          .select()
          .from(galleryRequests)
          .where(eq(galleryRequests.key, requestKey))
          .get();
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new Fault('IDEMPOTENCY_KEY_REUSED');
          return JSON.parse(previous.result) as GalleryTemplate;
        }
        if (tx.select().from(galleryTemplates).where(eq(galleryTemplates.id, value.id)).get())
          throw new Fault('TEMPLATE_ID_CONFLICT');
        if (
          tx
            .select()
            .from(galleryTemplates)
            .where(
              and(
                eq(galleryTemplates.namespace, value.namespace),
                eq(galleryTemplates.slug, value.slug),
              ),
            )
            .get()
        )
          throw new Fault('TEMPLATE_SLUG_CONFLICT');
        const at = new Date().toISOString();
        const result: GalleryTemplate = {
          ...value,
          state: 'active',
          revision: 1,
          createdAt: at,
          updatedAt: at,
          latest: null,
        };
        tx.insert(galleryTemplates)
          .values({
            id: result.id,
            namespace: result.namespace,
            slug: result.slug,
            content: JSON.stringify(result),
          })
          .run();
        tx.insert(galleryRequests)
          .values({ key: requestKey, fingerprint, result: JSON.stringify(result) })
          .run();
        return result;
      },
      { behavior: 'immediate' },
    );
  }
  patch(id: string, patch: unknown, principal: GalleryPrincipal, match?: string) {
    const current = this.rawTemplate(id);
    this.authorize(principal, current.namespace, 'templates:write');
    if (!galleryObject(patch) || !Object.keys(patch).length)
      throw new Fault('INVALID_REQUEST', 400);
    galleryFields(patch, ['name', 'summary', 'tags', 'visibility', 'state']);
    if (patch.state !== undefined && !['active', 'archived'].includes(String(patch.state)))
      throw new Fault('INVALID_REQUEST', 400);
    this.precondition(match, `"template:${current.revision}"`);
    const result = {
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    } as GalleryTemplate;
    this.validate(result);
    this.db
      .update(galleryTemplates)
      .set({ content: JSON.stringify(result), revision: result.revision, state: result.state })
      .where(eq(galleryTemplates.id, id))
      .run();
    return result;
  }
  precondition(match: string | undefined, actual: string) {
    galleryPrecondition(match, actual);
  }
  private bump(id: string) {
    const template = this.rawTemplate(id);
    template.revision++;
    template.updatedAt = new Date().toISOString();
    this.db
      .update(galleryTemplates)
      .set({
        content: JSON.stringify(template),
        revision: template.revision,
        state: template.state,
      })
      .where(eq(galleryTemplates.id, id))
      .run();
  }
  private rawReleases(id: string): GalleryRelease[] {
    return this.db
      .select()
      .from(galleryReleases)
      .where(eq(galleryReleases.template, id))
      .all()
      .map((row) => JSON.parse(row.content) as GalleryRelease)
      .sort((a, b) => compareReleaseVersions(b.version, a.version));
  }
  releases(id: string, principal?: GalleryPrincipal) {
    this.template(id, principal);
    return this.rawReleases(id);
  }
  release(id: string, version: string, principal?: GalleryPrincipal) {
    if (!releaseVersion(version)) throw new Fault('INVALID_REQUEST', 400);
    const result = this.releases(id, principal).find((item) => item.version === version);
    if (!result) throw new Fault('RELEASE_NOT_FOUND', 404);
    return result;
  }
  async publish(
    id: string,
    version: string,
    text: string,
    digest: string,
    principal: GalleryPrincipal,
  ) {
    const template = this.rawTemplate(id);
    this.authorize(principal, template.namespace, 'releases:write');
    if (!releaseDigest(digest) || releaseHash(text) !== digest)
      throw new Fault('INVALID_PACKAGE', 400);
    const value = parseBotRelease(text, true);
    if (value.manifest.templateId !== id || value.manifest.releaseVersion !== version)
      throw new Fault('PACKAGE_PATH_MISMATCH', 400);
    const prior = this.rawReleases(id).find((item) => item.version === version);
    if (prior && prior.digest !== digest) throw new Fault('VERSION_CONTENT_CONFLICT');
    const saved = await this.packages.save(value);
    return this.db.transaction(
      (tx) => {
        const current = this.rawTemplate(id);
        this.authorize(principal, current.namespace, 'releases:write');
        const existing = this.rawReleases(id).find((item) => item.version === version);
        if (existing) {
          if (existing.digest !== digest) throw new Fault('VERSION_CONTENT_CONFLICT');
          return { created: false, release: existing };
        }
        if (current.state === 'archived') throw new Fault('TEMPLATE_ARCHIVED');
        const manifest = value.manifest;
        const release: GalleryRelease = {
          templateId: id,
          version,
          digest,
          packageVersion: 3,
          bytes: saved.bytes,
          summary: manifest.summary,
          license: manifest.license,
          changelog: manifest.changelog,
          requires: manifest.requires,
          state: 'published',
          reason: null,
          publishedAt: new Date().toISOString(),
          revision: 1,
        };
        tx.insert(galleryReleases)
          .values({ template: id, version, content: JSON.stringify(release) })
          .run();
        this.bump(id);
        return { created: true, release };
      },
      { behavior: 'immediate' },
    );
  }
  withdraw(
    id: string,
    version: string,
    input: unknown,
    principal: GalleryPrincipal,
    match?: string,
  ) {
    const template = this.rawTemplate(id);
    this.authorize(principal, template.namespace, 'releases:write');
    if (!galleryObject(input)) throw new Fault('INVALID_REQUEST', 400);
    galleryFields(input, ['state', 'reason'], ['state', 'reason']);
    if (
      !['published', 'withdrawn'].includes(String(input.state)) ||
      (input.state === 'withdrawn' ? !string(input.reason, 2048, true) : input.reason !== null)
    )
      throw new Fault('INVALID_REQUEST', 400);
    return this.db.transaction((tx) => {
      const current = this.release(id, version, principal);
      this.precondition(match, `"release:${current.revision}"`);
      const result = {
        ...current,
        state: input.state,
        reason: input.reason,
        revision: current.revision + 1,
      } as GalleryRelease;
      tx.update(galleryReleases)
        .set({ content: JSON.stringify(result), revision: result.revision })
        .where(and(eq(galleryReleases.template, id), eq(galleryReleases.version, version)))
        .run();
      this.bump(id);
      return result;
    });
  }
  list(principal: GalleryPrincipal | undefined, query: URLSearchParams) {
    const includeArchived = query.get('includeArchived') === 'true';
    if (
      includeArchived &&
      !principal?.scopes.some((scope) => scope === 'templates:write' || scope === 'admin')
    )
      throw new Fault('PUBLISH_FORBIDDEN', 403);
    const q = query.get('q') ?? '';
    if (q.length > 200) throw new Fault('INVALID_REQUEST', 400);
    return this.db
      .select()
      .from(galleryTemplates)
      .all()
      .flatMap((row) => {
        try {
          const item = this.template(row.id, principal);
          if (
            (item.state === 'archived' &&
              (!includeArchived || !this.allowed(principal, item.namespace, 'templates:write'))) ||
            (query.has('namespace') && item.namespace !== query.get('namespace')) ||
            (query.has('tag') && !item.tags.includes(query.get('tag')!)) ||
            !`${item.name} ${item.summary} ${item.tags.join(' ')}`
              .toLowerCase()
              .includes(q.toLowerCase())
          )
            return [];
          return [item];
        } catch (error) {
          if (error instanceof Fault && error.status === 404) return [];
          throw error;
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  async download(id: string, version: string, principal?: GalleryPrincipal) {
    const template = this.template(id, principal);
    const release = this.release(id, version, principal);
    if (
      release.state === 'withdrawn' &&
      !this.allowed(principal, template.namespace, 'releases:write')
    )
      throw new Fault('RELEASE_WITHDRAWN', 410);
    return { release, text: botReleaseText(await this.packages.read(release.digest)) };
  }
  close() {
    this.connection?.$client.close();
    this.connection = undefined;
    this.packages.close();
  }
}

export { startGallery } from './gallery-server.js';
