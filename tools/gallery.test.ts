import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { startGallery } from '../packages/engine/src/gallery-server.js';
import { releaseHash } from '../packages/engine/src/releases.js';
import { botReleaseText } from '../packages/protocol/src/releases.js';
import { syntheticRelease } from './testing/releases.js';

test('the standalone host serves Next chunks and artwork with strict security headers', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-gallery-web-'));
  const webRoot = path.join(directory, 'web');
  await mkdir(path.join(webRoot, '_next/static'), { recursive: true });
  await mkdir(path.join(webRoot, 'avatars'), { recursive: true });
  await writeFile(path.join(webRoot, 'index.html'), '<h1>SYNTHETIC GALLERY</h1>');
  await writeFile(path.join(webRoot, '_next/static/mock.js'), 'SYNTHETIC NEXT CHUNK');
  await writeFile(path.join(webRoot, 'avatars/mock.png'), 'SYNTHETIC PNG');
  const gallery = await startGallery({
    directory: path.join(directory, 'data'),
    host: '127.0.0.1',
    port: 0,
    origin: 'http://127.0.0.1',
    webRoot,
    readMode: 'public',
  });
  try {
    const chunk = await fetch(`${gallery.url}/_next/static/mock.js`);
    expect(await chunk.text()).toBe('SYNTHETIC NEXT CHUNK');
    expect(chunk.headers.get('content-type')).toContain('javascript');
    expect(chunk.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(chunk.headers.get('content-security-policy')).not.toContain('unsafe-inline');
    const avatar = await fetch(`${gallery.url}/avatars/mock.png`);
    expect(avatar.headers.get('content-type')).toBe('image/png');
    expect((await fetch(`${gallery.url}/_next/static/missing.js`)).status).toBe(404);
    expect(
      await (await fetch(`${gallery.url}/bots/mock-team/mock-bot/versions/1.0.0`)).text(),
    ).toContain('SYNTHETIC GALLERY');
  } finally {
    await gallery.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('standalone gallery enforces immutable versions, ownership, sessions and private conditional downloads', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-gallery-'));
  const gallery = await startGallery({
    directory,
    host: '127.0.0.1',
    port: 0,
    readMode: 'public',
    origin: 'http://127.0.0.1',
  });
  try {
    const token = gallery.store.createToken({
      principalId: 'mock-author',
      namespaces: ['mock-team'],
      scopes: ['templates:write', 'releases:write'],
    });
    const reader = gallery.store.createToken({
      principalId: 'mock-reader',
      namespaces: ['mock-team'],
      scopes: ['catalog:read'],
    });
    const outsider = gallery.store.createToken({
      principalId: 'mock-outsider',
      namespaces: ['other-team'],
      scopes: ['releases:write'],
    });
    const headers = { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' };
    const release = syntheticRelease();
    const id = release.manifest.templateId;
    const create = await fetch(`${gallery.url}/api/v1/templates`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': '30000000-0000-4000-8000-000000000003' },
      body: JSON.stringify({
        id,
        namespace: 'mock-team',
        slug: 'mock-bot',
        name: 'Synthetic Bot',
        summary: 'Synthetic only',
        tags: [],
        visibility: 'private',
      }),
    });
    expect(create.status).toBe(201);
    const text = botReleaseText(release);
    const digest = releaseHash(text);
    const endpoint = `${gallery.url}/api/v1/templates/${id}/releases/1.0.0`;
    const upload = () =>
      fetch(endpoint, {
        method: 'PUT',
        headers: { ...headers, 'Daban-Package-SHA256': digest },
        body: text,
      });
    expect((await upload()).status).toBe(201);
    expect((await upload()).status).toBe(200);
    const altered = structuredClone(release);
    altered.manifest.changelog = 'SYNTHETIC CHANGED';
    const changed = botReleaseText(altered);
    expect(
      (
        await fetch(endpoint, {
          method: 'PUT',
          headers: { ...headers, 'Daban-Package-SHA256': releaseHash(changed) },
          body: changed,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(endpoint, {
          method: 'PUT',
          headers: {
            ...headers,
            Authorization: `Bearer ${outsider.token}`,
            'Daban-Package-SHA256': digest,
          },
          body: text,
        })
      ).status,
    ).toBe(404);
    const packageUrl = `${endpoint}/package`;
    expect((await fetch(packageUrl)).status).toBe(404);
    const downloaded = await fetch(packageUrl, {
      headers: { Authorization: `Bearer ${reader.token}` },
    });
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe(text);
    const etag = downloaded.headers.get('etag')!;
    gallery.store.revokeToken(reader.id);
    expect(
      (
        await fetch(packageUrl, {
          headers: { Authorization: `Bearer ${reader.token}`, 'If-None-Match': etag },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(endpoint, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ state: 'withdrawn', reason: 'Synthetic withdrawal' }),
        })
      ).status,
    ).toBe(428);
    expect(
      (
        await fetch(endpoint, {
          method: 'PATCH',
          headers: { ...headers, 'If-Match': '"release:1"' },
          body: JSON.stringify({ state: 'withdrawn', reason: 'Synthetic withdrawal' }),
        })
      ).status,
    ).toBe(200);
    const replacementReader = gallery.store.createToken({
      principalId: 'mock-reader-2',
      namespaces: ['mock-team'],
      scopes: ['catalog:read'],
    });
    expect(
      (
        await fetch(packageUrl, {
          headers: { Authorization: `Bearer ${replacementReader.token}`, 'If-None-Match': etag },
        })
      ).status,
    ).toBe(410);
    const session = await fetch(`${gallery.url}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: gallery.origin },
      body: JSON.stringify({ token: token.token }),
    });
    expect(session.status).toBe(200);
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    expect(session.headers.get('set-cookie')).toContain('HttpOnly');
    expect(
      (
        await fetch(endpoint, {
          method: 'PATCH',
          headers: {
            Cookie: cookie,
            Origin: 'https://evil.example.test',
            'Content-Type': 'application/json',
            'If-Match': '"release:2"',
          },
          body: JSON.stringify({ state: 'published', reason: null }),
        })
      ).status,
    ).toBe(403);
    const discovery = await fetch(`${gallery.url}/.well-known/daban-gallery.json`).then(
      (response) => response.json(),
    );
    expect(discovery).toMatchObject({
      format: 'daban.gallery',
      apiVersions: [1],
      packageVersions: [3],
    });
  } finally {
    await gallery.close();
    await rm(directory, { recursive: true, force: true });
  }
});
