import type { D1Database, Fetcher, R2Bucket } from '@cloudflare/workers-types';
import { CloudflareGallery } from '@daban/engine/gallery-cloudflare';
import { createGalleryHandler } from '@daban/engine/gallery-http';

interface Env {
  DB: D1Database;
  PACKAGES: R2Bucket;
  ASSETS: Fetcher;
  GALLERY_PUBLIC_ORIGIN?: string;
  GALLERY_READ_MODE?: string;
  GALLERY_MAX_PACKAGE_BYTES?: string;
  GALLERY_ADMIN_TOKEN?: string;
}
const instances = new WeakMap<
  Env,
  { backend: CloudflareGallery; handle: ReturnType<typeof createGalleryHandler>; origin: string }
>();
export default {
  async fetch(request: Request, env: Env) {
    const origin = env.GALLERY_PUBLIC_ORIGIN || new URL(request.url).origin;
    try {
      let runtime = instances.get(env);
      if (!runtime || runtime.origin !== origin) {
        const mode = env.GALLERY_READ_MODE ?? 'private';
        if (mode !== 'public' && mode !== 'private') throw Error('INVALID_GALLERY_READ_MODE');
        const backend = new CloudflareGallery({
          DB: env.DB,
          PACKAGES: env.PACKAGES,
          readMode: mode,
          maxPackageBytes: Number(env.GALLERY_MAX_PACKAGE_BYTES ?? 8388608),
          adminToken: env.GALLERY_ADMIN_TOKEN,
        });
        runtime = {
          backend,
          origin,
          handle: createGalleryHandler(backend, {
            origin,
            assets: async (assetRequest) =>
              env.ASSETS.fetch(assetRequest.url) as unknown as Response,
          }),
        };
        instances.set(env, runtime);
      }
      await runtime.backend.ready;
      return runtime.handle(request, request.headers.get('cf-connecting-ip') ?? 'unknown');
    } catch {
      return Response.json(
        {
          error: {
            code: 'TEMPORARILY_UNAVAILABLE',
            message: 'TEMPORARILY_UNAVAILABLE',
            requestId: crypto.randomUUID(),
          },
        },
        { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } },
      );
    }
  },
};
