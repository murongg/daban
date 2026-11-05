import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
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
import { and, eq, exists, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Fault } from './control.js';
import {
  type GalleryBackend,
  galleryHash,
  galleryRecord,
  galleryRequestFields,
} from './gallery-http.js';
import {
  galleryAllowed,
  galleryPrecondition,
  galleryText,
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
import { parseSkill } from './skill-content.js';

export interface CloudflareGalleryOptions {
  DB: D1Database;
  PACKAGES: R2Bucket;
  name?: string;
  readMode?: 'public' | 'private';
  maxPackageBytes?: number;
  adminToken?: string;
}
const randomSecret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

export class CloudflareGallery implements GalleryBackend {
  private readonly db;
  readonly ready: Promise<unknown>;
  private sourceId = '';
  private readonly authorities = new WeakMap<GalleryPrincipal, string>();
  constructor(readonly options: CloudflareGalleryOptions) {
    this.db = drizzle(options.DB.withSession('first-primary'));
    if (
      (options.maxPackageBytes ?? 8388608) > 8388608 ||
      (options.maxPackageBytes ?? 8388608) < 1 ||
      !Number.isInteger(options.maxPackageBytes ?? 8388608)
    )
      throw new Fault('INVALID_GALLERY_CONFIG', 400);
    if (options.adminToken && !/^[a-f0-9]{64}$/.test(options.adminToken))
      throw new Fault('INVALID_ADMIN_TOKEN', 400);
    this.ready = this.load();
  }
  private async load() {
    await this.db
      .insert(gallerySettings)
      .values({ key: 'sourceId', value: crypto.randomUUID() })
      .onConflictDoNothing()
      .run();
    this.sourceId = (await this.db
      .select()
      .from(gallerySettings)
      .where(eq(gallerySettings.key, 'sourceId'))
      .get())!.value;
    if (!releaseUuid(this.sourceId)) throw new Fault('GALLERY_STORE_UNSAFE');
  }
  async discovery(): Promise<GalleryDiscovery> {
    await this.ready;
    return {
      format: 'daban.gallery',
      version: 1,
      sourceId: this.sourceId,
      name: this.options.name ?? 'Daban Bot Gallery',
      apiVersions: [1],
      packageVersions: [3],
      readMode: this.options.readMode ?? 'private',
      maxPackageBytes: this.options.maxPackageBytes ?? 8388608,
    };
  }
  async createToken(principal: GalleryPrincipal) {
    validateGalleryPrincipal(principal);
    const token = randomSecret();
    const id = crypto.randomUUID();
    await this.db
      .insert(galleryTokens)
      .values({ id, hash: await galleryHash(token), principal: JSON.stringify(principal) })
      .run();
    return { id, token };
  }
  async revokeToken(id: string) {
    await this.db.batch([
      this.db.delete(gallerySessions).where(eq(gallerySessions.token, id)),
      this.db.delete(galleryTokens).where(eq(galleryTokens.id, id)),
    ]);
  }
  async authenticate(token: string) {
    if (!token || token.length > 256) throw new Fault('INVALID_CREDENTIAL', 401);
    const hash = await galleryHash(token);
    if (this.options.adminToken && hash === (await galleryHash(this.options.adminToken))) {
      const principal: GalleryPrincipal = {
        principalId: 'bootstrap-admin',
        namespaces: [],
        scopes: ['admin'],
      };
      this.authorities.set(principal, `bootstrap:${hash}`);
      return { tokenId: `bootstrap:${hash}`, principal };
    }
    const row = await this.db
      .select()
      .from(galleryTokens)
      .where(eq(galleryTokens.hash, hash))
      .get();
    if (!row) throw new Fault('INVALID_CREDENTIAL', 401);
    const principal: GalleryPrincipal = JSON.parse(row.principal);
    this.authorities.set(principal, row.id);
    return { tokenId: row.id, principal };
  }
  async session(token: string) {
    const auth = await this.authenticate(token);
    const secret = randomSecret();
    const csrf = randomSecret();
    const expires = Date.now() + 43200000;
    await this.db
      .insert(gallerySessions)
      .values({ hash: await galleryHash(secret), token: auth.tokenId, csrf, expires })
      .run();
    return {
      secret,
      session: {
        ...auth.principal,
        expiresAt: new Date(expires).toISOString(),
        csrfToken: csrf,
      } satisfies GallerySession,
    };
  }
  async readSession(secret: string) {
    const row = await this.db
      .select()
      .from(gallerySessions)
      .where(eq(gallerySessions.hash, await galleryHash(secret)))
      .get();
    if (!row || row.expires <= Date.now()) throw new Fault('INVALID_CREDENTIAL', 401);
    let principal: GalleryPrincipal;
    if (row.token.startsWith('bootstrap:')) {
      if (
        !this.options.adminToken ||
        row.token !== `bootstrap:${await galleryHash(this.options.adminToken)}`
      )
        throw new Fault('INVALID_CREDENTIAL', 401);
      principal = { principalId: 'bootstrap-admin', namespaces: [], scopes: ['admin'] };
    } else {
      const token = await this.db
        .select()
        .from(galleryTokens)
        .where(eq(galleryTokens.id, row.token))
        .get();
      if (!token) throw new Fault('INVALID_CREDENTIAL', 401);
      principal = JSON.parse(token.principal);
    }
    const session = {
      ...principal,
      expiresAt: new Date(row.expires).toISOString(),
      csrfToken: row.csrf,
    } satisfies GallerySession;
    this.authorities.set(session, row.token);
    return session;
  }
  async logout(secret: string) {
    await this.db
      .delete(gallerySessions)
      .where(eq(gallerySessions.hash, await galleryHash(secret)))
      .run();
  }
  checkCsrf(expected: string, actual: string) {
    let difference = expected.length ^ actual.length;
    for (let index = 0; index < expected.length; index++)
      difference |= expected.charCodeAt(index) ^ (actual.charCodeAt(index) || 0);
    if (difference) throw new Fault('CSRF_REJECTED', 403);
  }
  allowed = galleryAllowed;
  async authorize(principal: GalleryPrincipal | undefined, namespace: string, scope: GalleryScope) {
    const proof = principal ? this.authorities.get(principal) : undefined;
    if (
      proof &&
      !proof.startsWith('bootstrap:') &&
      !(await this.db.select().from(galleryTokens).where(eq(galleryTokens.id, proof)).get())
    )
      throw new Fault('INVALID_CREDENTIAL', 401);
    if (!galleryAllowed(principal, namespace, scope)) throw new Fault('PUBLISH_FORBIDDEN', 403);
  }
  private async rawReleases(id: string) {
    return (
      await this.db.select().from(galleryReleases).where(eq(galleryReleases.template, id)).all()
    )
      .map((row) => JSON.parse(row.content) as GalleryRelease)
      .sort((a, b) => compareReleaseVersions(b.version, a.version));
  }
  private async rawTemplate(id: string): Promise<GalleryTemplate> {
    const row = await this.db
      .select()
      .from(galleryTemplates)
      .where(eq(galleryTemplates.id, id))
      .get();
    if (!row) throw new Fault('TEMPLATE_NOT_FOUND', 404);
    const result: GalleryTemplate = JSON.parse(row.content);
    return result;
  }
  async template(id: string, principal?: GalleryPrincipal) {
    const result = await this.rawTemplate(id);
    if (
      !this.allowed(principal, result.namespace, 'catalog:read') &&
      (this.options.readMode !== 'public' || result.visibility !== 'public')
    )
      throw new Fault('TEMPLATE_NOT_FOUND', 404);
    return result;
  }
  async create(input: unknown, principal: GalleryPrincipal, key: string): Promise<GalleryTemplate> {
    if (!galleryRecord(input)) throw new Fault('INVALID_REQUEST', 400);
    galleryRequestFields(
      input,
      ['id', 'namespace', 'slug', 'name', 'summary', 'tags', 'visibility'],
      ['id', 'namespace', 'slug', 'name', 'summary', 'tags', 'visibility'],
    );
    const value = input as unknown as GalleryTemplateInput;
    validateGalleryTemplate(value);
    await this.authorize(principal, value.namespace, 'templates:write');
    if (!releaseUuid(key)) throw new Fault('INVALID_REQUEST', 400);
    const requestKey = `${principal.principalId}:POST:templates:${key}`;
    const fingerprint = await galleryHash(
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
    const existing = await this.db
      .select()
      .from(galleryRequests)
      .where(eq(galleryRequests.key, requestKey))
      .get();
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Fault('IDEMPOTENCY_KEY_REUSED');
      return JSON.parse(existing.result);
    }
    const at = new Date().toISOString();
    const result: GalleryTemplate = {
      ...value,
      state: 'active',
      revision: 1,
      latest: null,
      createdAt: at,
      updatedAt: at,
    };
    try {
      await this.db.batch([
        this.db.insert(galleryTemplates).values({
          id: value.id,
          namespace: value.namespace,
          slug: value.slug,
          content: JSON.stringify(result),
        }),
        this.db
          .insert(galleryRequests)
          .values({ key: requestKey, fingerprint, result: JSON.stringify(result) }),
      ]);
      return result;
    } catch (error) {
      const replay = await this.db
        .select()
        .from(galleryRequests)
        .where(eq(galleryRequests.key, requestKey))
        .get();
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new Fault('IDEMPOTENCY_KEY_REUSED');
        return JSON.parse(replay.result);
      }
      if (
        await this.db.select().from(galleryTemplates).where(eq(galleryTemplates.id, value.id)).get()
      )
        throw new Fault('TEMPLATE_ID_CONFLICT');
      if (
        await this.db
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
      throw error;
    }
  }
  async patch(id: string, input: unknown, principal: GalleryPrincipal, match?: string) {
    const current = await this.rawTemplate(id);
    await this.authorize(principal, current.namespace, 'templates:write');
    if (!galleryRecord(input) || !Object.keys(input).length)
      throw new Fault('INVALID_REQUEST', 400);
    galleryRequestFields(input, ['name', 'summary', 'tags', 'visibility', 'state']);
    if (input.state !== undefined && !['active', 'archived'].includes(String(input.state)))
      throw new Fault('INVALID_REQUEST', 400);
    galleryPrecondition(match, `"template:${current.revision}"`);
    const result = {
      ...current,
      ...input,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    } as GalleryTemplate;
    validateGalleryTemplate(result);
    const saved = await this.db
      .update(galleryTemplates)
      .set({ content: JSON.stringify(result), revision: result.revision, state: result.state })
      .where(and(eq(galleryTemplates.id, id), eq(galleryTemplates.revision, current.revision)))
      .run();
    if (!saved.meta.changes) throw new Fault('REVISION_CONFLICT', 412);
    return result;
  }
  async releases(id: string, principal?: GalleryPrincipal) {
    await this.template(id, principal);
    return this.rawReleases(id);
  }
  async release(id: string, version: string, principal?: GalleryPrincipal) {
    if (!releaseVersion(version)) throw new Fault('INVALID_REQUEST', 400);
    const result = (await this.releases(id, principal)).find((item) => item.version === version);
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
    const template = await this.rawTemplate(id);
    await this.authorize(principal, template.namespace, 'releases:write');
    if (!releaseDigest(digest) || (await galleryHash(text)) !== digest)
      throw new Fault('INVALID_PACKAGE', 400);
    if (new TextEncoder().encode(text).length > (this.options.maxPackageBytes ?? 8388608))
      throw new Fault('PACKAGE_TOO_LARGE', 413);
    const value = parseBotRelease(text, true);
    if (value.manifest.templateId !== id || value.manifest.releaseVersion !== version)
      throw new Fault('PACKAGE_PATH_MISMATCH', 400);
    const prior = (await this.rawReleases(id)).find((item) => item.version === version);
    if (prior && prior.digest !== digest) throw new Fault('VERSION_CONTENT_CONFLICT');
    for (const skill of value.definition.skills) {
      const main = skill.package.files.find((file) => file.path === 'SKILL.md')!;
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Uint8Array.from(atob(main.data), (char) => char.charCodeAt(0)),
      );
      if (parseSkill(content, true).name !== skill.package.root)
        throw new Fault('INVALID_SKILL', 400);
    }
    await this.options.PACKAGES.put(`${digest}.json`, text, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { sha256: digest },
    });
    const stored = await this.options.PACKAGES.get(`${digest}.json`);
    if (!stored || (await galleryHash(await stored.text())) !== digest)
      throw new Fault('PACKAGE_INTEGRITY_ERROR', 503);
    await this.authorize(principal, template.namespace, 'releases:write');
    if (prior) {
      if (prior.digest !== digest) throw new Fault('VERSION_CONTENT_CONFLICT');
      return { created: false, release: prior };
    }
    if (template.state === 'archived') throw new Fault('TEMPLATE_ARCHIVED');
    const m = value.manifest;
    const release: GalleryRelease = {
      templateId: id,
      version,
      digest,
      packageVersion: 3,
      bytes: new TextEncoder().encode(text).length,
      summary: m.summary,
      license: m.license,
      changelog: m.changelog,
      requires: m.requires,
      state: 'published',
      reason: null,
      publishedAt: new Date().toISOString(),
      revision: 1,
    };
    const mutation = crypto.randomUUID();
    const latest =
      !template.latest || compareReleaseVersions(version, template.latest.version) > 0
        ? { version, digest, packageVersion: 3 as const, bytes: release.bytes }
        : template.latest;
    const updated = {
      ...template,
      latest,
      revision: template.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.authorize(principal, template.namespace, 'releases:write');
    // D1 has no interactive transaction: both writes are conditional inside one atomic batch.
    const results = await this.db.batch([
      this.db.insert(galleryReleases).select(
        this.db
          .select({
            template: sql<string>`${id}`.as('template'),
            version: sql<string>`${version}`.as('version'),
            content: sql<string>`${JSON.stringify(release)}`.as('content'),
            revision: sql<number>`1`.as('revision'),
            mutation: sql<string>`${mutation}`.as('mutation'),
          })
          .from(galleryTemplates)
          .where(
            and(
              eq(galleryTemplates.id, id),
              eq(galleryTemplates.revision, template.revision),
              eq(galleryTemplates.state, 'active'),
            ),
          ),
      ),
      this.db
        .update(galleryTemplates)
        .set({ content: JSON.stringify(updated), revision: updated.revision })
        .where(
          and(
            eq(galleryTemplates.id, id),
            eq(galleryTemplates.revision, template.revision),
            exists(
              this.db
                .select()
                .from(galleryReleases)
                .where(
                  and(
                    eq(galleryReleases.template, id),
                    eq(galleryReleases.version, version),
                    eq(galleryReleases.mutation, mutation),
                  ),
                ),
            ),
          ),
        ),
    ]);
    if (!results[0].meta.changes) {
      const current = (await this.rawReleases(id)).find((item) => item.version === version);
      if (current?.digest === digest) return { created: false, release: current };
      if (current) throw new Fault('VERSION_CONTENT_CONFLICT');
      throw new Fault('REVISION_CONFLICT', 412);
    }
    return { created: true, release };
  }
  async withdraw(
    id: string,
    version: string,
    input: unknown,
    principal: GalleryPrincipal,
    match?: string,
  ) {
    const template = await this.rawTemplate(id);
    await this.authorize(principal, template.namespace, 'releases:write');
    if (!galleryRecord(input)) throw new Fault('INVALID_REQUEST', 400);
    galleryRequestFields(input, ['state', 'reason'], ['state', 'reason']);
    if (
      !['published', 'withdrawn'].includes(String(input.state)) ||
      (input.state === 'withdrawn' ? !galleryText(input.reason, 2048, true) : input.reason !== null)
    )
      throw new Fault('INVALID_REQUEST', 400);
    const current = await this.release(id, version, principal);
    galleryPrecondition(match, `"release:${current.revision}"`);
    const result = {
      ...current,
      state: input.state,
      reason: input.reason,
      revision: current.revision + 1,
    } as GalleryRelease;
    const versions = (await this.rawReleases(id)).map((entry) =>
      entry.version === version ? result : entry,
    );
    const latest = versions.find((entry) => entry.state === 'published');
    const updated = {
      ...template,
      latest: latest
        ? {
            version: latest.version,
            digest: latest.digest,
            packageVersion: 3 as const,
            bytes: latest.bytes,
          }
        : null,
      revision: template.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const mutation = crypto.randomUUID();
    const writes = await this.db.batch([
      this.db
        .update(galleryReleases)
        .set({ content: JSON.stringify(result), revision: result.revision, mutation })
        .where(
          and(
            eq(galleryReleases.template, id),
            eq(galleryReleases.version, version),
            eq(galleryReleases.revision, current.revision),
            exists(
              this.db
                .select()
                .from(galleryTemplates)
                .where(
                  and(
                    eq(galleryTemplates.id, id),
                    eq(galleryTemplates.revision, template.revision),
                  ),
                ),
            ),
          ),
        ),
      this.db
        .update(galleryTemplates)
        .set({ content: JSON.stringify(updated), revision: updated.revision })
        .where(
          and(
            eq(galleryTemplates.id, id),
            eq(galleryTemplates.revision, template.revision),
            exists(
              this.db
                .select()
                .from(galleryReleases)
                .where(
                  and(
                    eq(galleryReleases.template, id),
                    eq(galleryReleases.version, version),
                    eq(galleryReleases.mutation, mutation),
                  ),
                ),
            ),
          ),
        ),
    ]);
    if (!writes[0].meta.changes) throw new Fault('REVISION_CONFLICT', 412);
    return result;
  }
  async list(principal: GalleryPrincipal | undefined, query: URLSearchParams) {
    const includeArchived = query.get('includeArchived') === 'true';
    if (
      includeArchived &&
      !principal?.scopes.some((scope) => scope === 'templates:write' || scope === 'admin')
    )
      throw new Fault('PUBLISH_FORBIDDEN', 403);
    const q = query.get('q') ?? '';
    if (q.length > 200) throw new Fault('INVALID_REQUEST', 400);
    const result: GalleryTemplate[] = [];
    for (const row of await this.db.select().from(galleryTemplates).all()) {
      try {
        // latest is updated in the publication batch; listing must not issue one D1 query per card.
        const item: GalleryTemplate = JSON.parse(row.content);
        if (
          !this.allowed(principal, item.namespace, 'catalog:read') &&
          (this.options.readMode !== 'public' || item.visibility !== 'public')
        )
          continue;
        if (
          (item.state === 'archived' &&
            (!includeArchived || !this.allowed(principal, item.namespace, 'templates:write'))) ||
          (query.has('namespace') && query.get('namespace') !== item.namespace) ||
          (query.has('tag') && !item.tags.includes(query.get('tag')!)) ||
          !`${item.name} ${item.summary} ${item.tags.join(' ')}`
            .toLowerCase()
            .includes(q.toLowerCase())
        )
          continue;
        result.push(item);
      } catch (error) {
        if (!(error instanceof Fault && error.status === 404)) throw error;
      }
    }
    return result.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  }
  async download(id: string, version: string, principal?: GalleryPrincipal) {
    const template = await this.template(id, principal);
    const release = await this.release(id, version, principal);
    if (
      release.state === 'withdrawn' &&
      !this.allowed(principal, template.namespace, 'releases:write')
    )
      throw new Fault('RELEASE_WITHDRAWN', 410);
    const object = await this.options.PACKAGES.get(`${release.digest}.json`);
    if (!object) throw new Fault('PACKAGE_INTEGRITY_ERROR', 503);
    const text = await object.text();
    if (
      (await galleryHash(text)) !== release.digest ||
      botReleaseText(parseBotRelease(text, true)) !== text
    )
      throw new Fault('PACKAGE_INTEGRITY_ERROR', 503);
    return { release, text };
  }
}
