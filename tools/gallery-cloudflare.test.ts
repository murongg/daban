import { fileURLToPath } from 'node:url';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { expect, test } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { CloudflareGallery } from '../packages/engine/src/gallery-cloudflare.js';
import { createGalleryHandler } from '../packages/engine/src/gallery-http.js';
import { migrations } from '../packages/engine/src/gallery-migrations.js';
import { releaseHash } from '../packages/engine/src/releases.js';
import { botReleaseText } from '../packages/protocol/src/releases.js';
import { syntheticRelease } from './testing/releases.js';

test('D1/R2 publication is atomic under concurrent requests and private conditional downloads reauthorize', async () => {
  const platform = await getPlatformProxy<{ DB: D1Database; PACKAGES: R2Bucket }>({
    configPath: fileURLToPath(new URL('../apps/gallery/wrangler.jsonc', import.meta.url)),
    persist: false,
  });
  try {
    for (const migration of migrations)
      for (const statement of migration.sql)
        if (statement.trim()) await platform.env.DB.prepare(statement).run();
    const backend = new CloudflareGallery({
      ...platform.env,
      readMode: 'public',
      adminToken: 'a'.repeat(64),
    });
    await backend.ready;
    const principal = {
      principalId: 'mock-author',
      namespaces: ['mock-team'],
      scopes: ['templates:write', 'releases:write'] as const,
    };
    const publisher = await backend.createToken({ ...principal, scopes: [...principal.scopes] });
    const reader = await backend.createToken({
      principalId: 'mock-reader',
      namespaces: ['mock-team'],
      scopes: ['catalog:read'],
    });
    const origin = 'https://gallery.example.test';
    const handle = createGalleryHandler(backend, { origin });
    const release = syntheticRelease();
    const id = release.manifest.templateId;
    const request = (route: string, init: RequestInit = {}) =>
      handle(new Request(`${origin}/api/v1${route}`, init));
    const headers = {
      Authorization: `Bearer ${publisher.token}`,
      'Content-Type': 'application/json',
    };
    const created = await request('/templates', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': '30000000-0000-4000-8000-000000000003' },
      body: JSON.stringify({
        id,
        namespace: 'mock-team',
        slug: 'mock-bot',
        name: 'Synthetic',
        summary: 'Synthetic only',
        tags: [],
        visibility: 'private',
      }),
    });
    expect(created.status).toBe(201);
    const route = `/templates/${id}/releases/1.0.0`;
    const text = botReleaseText(release);
    const digest = releaseHash(text);
    const upload = () =>
      request(route, {
        method: 'PUT',
        headers: { ...headers, 'Daban-Package-SHA256': digest },
        body: text,
      });
    expect(
      (await Promise.all([upload(), upload()])).map((response) => response.status).sort(),
    ).toEqual([200, 201]);
    expect(await platform.env.PACKAGES.get(`${digest}.json`).then((object) => object?.text())).toBe(
      text,
    );
    expect((await request(`${route}/package`)).status).toBe(404);
    const fetched = await request(`${route}/package`, {
      headers: { Authorization: `Bearer ${reader.token}` },
    });
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe(text);
    const template = await backend.template(id, { ...principal, scopes: [...principal.scopes] });
    const patch = (name: string) =>
      request(`/templates/${id}`, {
        method: 'PATCH',
        headers: { ...headers, 'If-Match': `"template:${template.revision}"` },
        body: JSON.stringify({ name }),
      });
    expect(
      (await Promise.all([patch('Synthetic A'), patch('Synthetic B')]))
        .map((response) => response.status)
        .sort(),
    ).toEqual([200, 412]);
    await backend.revokeToken(reader.id);
    expect(
      (
        await request(`${route}/package`, {
          headers: {
            Authorization: `Bearer ${reader.token}`,
            'If-None-Match': `"sha256:${digest}"`,
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(route, {
          method: 'PUT',
          headers: { ...headers, 'Daban-Package-SHA256': digest, 'Content-Length': '8388609' },
          body: text,
        })
      ).status,
    ).toBe(413);
    const fresh = new CloudflareGallery({ ...platform.env, readMode: 'private' });
    expect((await fresh.discovery()).sourceId).toBe((await backend.discovery()).sourceId);
    const denied = createGalleryHandler(fresh, { origin });
    expect((await denied(new Request(`${origin}/api/v1/templates`))).status).toBe(401);
  } finally {
    await platform.dispose();
  }
});
