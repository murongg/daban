import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { galleryOrigin } from '@daban/protocol';
import { Fault } from './control.js';
import { type GalleryOptions, GalleryStore } from './gallery.js';
import { createGalleryHandler } from './gallery-http.js';

export interface GalleryServerOptions extends GalleryOptions {
  host?: string;
  port?: number;
  origin: string;
  webRoot?: string;
}
export async function startGallery(options: GalleryServerOptions) {
  const limit = options.maxPackageBytes ?? 104857600;
  if (
    !galleryOrigin(options.origin, true) ||
    !['public', 'private'].includes(options.readMode ?? 'private') ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 104857600
  )
    throw new Fault('INVALID_GALLERY_CONFIG', 400);
  const store = new GalleryStore(options);
  await store.ready;
  let handle: ReturnType<typeof createGalleryHandler> | undefined;
  const server = http.createServer((incoming, outgoing) => {
    const run = async () => {
      if (!handle) throw new Fault('TEMPORARILY_UNAVAILABLE', 503);
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (value) headers.set(key, value.join(', '));
      }
      const init: RequestInit = { method: incoming.method, headers };
      if (!['GET', 'HEAD'].includes(incoming.method ?? 'GET'))
        Object.assign(init, { body: Readable.toWeb(incoming), duplex: 'half' });
      const result = await handle(
        new Request(new URL(incoming.url ?? '/', options.origin), init),
        incoming.socket.remoteAddress,
      );
      outgoing.statusCode = result.status;
      result.headers.forEach((value, key) => {
        outgoing.setHeader(key, value);
      });
      if (result.body)
        await pipeline(Readable.fromWeb(result.body as unknown as NodeReadableStream), outgoing);
      else outgoing.end();
      incoming.resume();
    };
    run().catch(() => {
      if (!outgoing.headersSent) {
        outgoing.statusCode = 503;
        outgoing.end();
      } else outgoing.destroy();
      incoming.resume();
    });
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 15000;
  try {
    await new Promise<unknown>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 8080, options.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        resolve(undefined);
      });
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Fault('INVALID_GALLERY_CONFIG');
  const url = `http://${options.host === '::1' ? '[::1]' : options.host === '0.0.0.0' || !options.host ? '127.0.0.1' : options.host}:${address.port}`;
  const origin = options.port === 0 && options.origin === 'http://127.0.0.1' ? url : options.origin;
  handle = createGalleryHandler(store, {
    origin,
    assets: options.webRoot
      ? async (request) => {
          const route = new URL(request.url).pathname;
          const root = path.resolve(options.webRoot!);
          const asset =
            route.startsWith('/assets/') ||
            route.startsWith('/_next/static/') ||
            route.startsWith('/avatars/') ||
            route === '/brand.png';
          const file = asset ? path.resolve(root, `.${route}`) : path.join(root, 'index.html');
          if (!file.startsWith(`${root}${path.sep}`)) return new Response(null, { status: 404 });
          const bytes = await readFile(file).catch(() => undefined);
          return bytes
            ? new Response(bytes, {
                headers: {
                  'Content-Type': file.endsWith('.js')
                    ? 'text/javascript; charset=utf-8'
                    : file.endsWith('.css')
                      ? 'text/css; charset=utf-8'
                      : file.endsWith('.png')
                        ? 'image/png'
                        : 'text/html; charset=utf-8',
                },
              })
            : new Response(null, { status: 404 });
        }
      : undefined,
  });
  return {
    store,
    server,
    url,
    origin,
    close: async () => {
      await new Promise<unknown>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
        server.closeIdleConnections();
      });
      store.close();
    },
  };
}
