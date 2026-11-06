import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GalleryStore, galleryAuthConfig, startGallery } from '@daban/engine/gallery';

async function main() {
  const directory = path.resolve(process.env.GALLERY_DATA_DIR ?? './gallery-data');
  const [command, namespace, principal] = process.argv.slice(2);
  if (command === 'create-token' || command === 'revoke-token') {
    const store = new GalleryStore({ directory });
    await store.ready;
    try {
      if (command === 'revoke-token') {
        if (!namespace) throw Error('TOKEN_ID_REQUIRED');
        store.revokeToken(namespace);
        return;
      }
      if (!namespace || !principal)
        throw Error('Usage: create-token <namespace> <principal> [--admin]');
      const result = store.createToken({
        principalId: principal,
        namespaces: [namespace],
        scopes: process.argv.includes('--admin')
          ? ['admin']
          : ['catalog:read', 'templates:write', 'releases:write'],
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      store.close();
    }
    return;
  }
  const origin = process.env.GALLERY_PUBLIC_ORIGIN;
  if (!origin) throw Error('GALLERY_PUBLIC_ORIGIN_REQUIRED');
  const mode = process.env.GALLERY_READ_MODE ?? 'private';
  if (mode !== 'public' && mode !== 'private') throw Error('INVALID_GALLERY_READ_MODE');
  const gallery = await startGallery({
    directory,
    origin,
    readMode: mode,
    port: Number(process.env.GALLERY_PORT ?? 8080),
    maxPackageBytes: Number(process.env.GALLERY_MAX_PACKAGE_BYTES ?? 104857600),
    webRoot: fileURLToPath(new URL('./web/', import.meta.url)),
    auth: galleryAuthConfig({
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      GALLERY_GITHUB_ADMIN_IDS: process.env.GALLERY_GITHUB_ADMIN_IDS,
      GALLERY_GITHUB_ALLOWED_IDS: process.env.GALLERY_GITHUB_ALLOWED_IDS,
    }),
  });
  process.stdout.write('Daban Bot Gallery ready\n');
  const close = () => {
    gallery.close().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'GALLERY_STOP_FAILED'}\n`);
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'GALLERY_START_FAILED'}\n`);
  process.exitCode = 1;
});
