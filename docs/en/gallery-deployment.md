# Deploy a Bot gallery

[User guide](README.md) · [简体中文](../zh-CN/gallery-deployment.md)

The gallery runs independently of Daban, model credentials and Linux VMs. Both deployments serve the same v3 Bot packages and `/api/v1` API. Installed Bots keep their configuration and run locally when the gallery is offline.

The frontend uses Next.js App Router and React. `next build` exports a static application; the build then copies it to `dist-gallery/web` for both hosts. Catalogs and sessions load from the same-origin API in the browser, so no account or private template data is fetched during the build. Shared `/bots/<namespace>/<slug>/versions/<version>` links resolve at runtime. Next bootstrap scripts are emitted as same-origin assets to retain the strict CSP without inline script permission. The standalone Node package serves the built files and does not need a Next.js server.

For frontend development, run the Node API with `GALLERY_PORT=8080` and `GALLERY_PUBLIC_ORIGIN=http://127.0.0.1:3000`, then run `npm run dev --workspace @daban/gallery` and open `http://127.0.0.1:3000`. The development server proxies `/api` to `http://127.0.0.1:8080`; `GALLERY_DEV_ORIGIN` overrides that target. Production static exports use the current origin directly. The gallery owns a TypeScript 6 compiler for Next's compiler API while the repository retains TypeScript 7; both checks remain strict. `.next`, `out`, and `next-env.d.ts` are generated framework artifacts.

| Component | Cloudflare | Self-hosted |
| --- | --- | --- |
| API | Workers | Node.js |
| Catalog, permissions, sessions | D1 with Drizzle ORM | SQLite with Drizzle ORM |
| Packages | Private R2 bucket | Persistent files |
| Web interface | Workers Static Assets | Same Node service |
| Default package limit | 8 MiB | 100 MiB |

## Cloudflare

Build from the repository root, then provision resources in your own account:

```sh
npm ci
npm run build:gallery
cd apps/gallery
npx wrangler login
npx wrangler d1 create daban-gallery
npx wrangler r2 bucket create daban-gallery-packages
```

Replace the all-zero development database_id in `apps/gallery/wrangler.jsonc` with the returned D1 ID. Existing resources can be reused. Keep bindings named DB, PACKAGES and ASSETS. Keep the R2 bucket private; package downloads must pass API authorization.

```sh
npx wrangler d1 migrations apply daban-gallery --remote
openssl rand -hex 32
npx wrangler secret put GALLERY_ADMIN_TOKEN
npx wrangler deploy
```

Save the generated 64-character hexadecimal token in a password manager and enter that same value at the secret prompt. Sign into the web interface with it. Administrators can issue namespace-scoped read or publication tokens and revoke them by ID. Tokens are displayed once and cannot be recovered. Rotate the bootstrap secret through Wrangler; previous bootstrap sessions stop working.

The default read mode is private. To allow anonymous browsing, set GALLERY_READ_MODE to public and explicitly publish templates with public visibility. Private templates still require authorization. For a custom domain, set GALLERY_PUBLIC_ORIGIN to its exact HTTPS origin; otherwise the Worker uses the request origin. Web and API requests remain same-origin.

```sh
npx wrangler d1 migrations apply daban-gallery --local
npx wrangler dev
npx wrangler deploy --dry-run --outdir ../../outputs/gallery-worker
```

Local credentials may be placed in an ignored `.dev.vars` file. Local Wrangler state is separate from production. A dry run checks packaging without deploying to your account. Workers support packages up to 8 MiB in this implementation; the configured limit may be lowered and is advertised by the discovery endpoint. The limit accounts for the Workers memory budget.

## Self-hosting

From the repository root, set your HTTPS origin and launch behind your TLS reverse proxy:

```sh
export GALLERY_PUBLIC_ORIGIN=https://bots.example.test
docker compose -f apps/gallery/compose.yaml up -d --build
docker compose -f apps/gallery/compose.yaml exec gallery node main.js create-token team publisher --admin
```

Replace the example domain. Save the returned token securely and retain its ID for revocation:

```sh
docker compose -f apps/gallery/compose.yaml exec gallery node main.js revoke-token <token-id>
```

The container runs as a non-root user, stores data in /data, and binds its example host port to loopback. Configuration includes GALLERY_DATA_DIR, GALLERY_PORT (8080), GALLERY_PUBLIC_ORIGIN, GALLERY_READ_MODE (private) and GALLERY_MAX_PACKAGE_BYTES (104857600, which can be lowered).

For direct Node deployment, build with `npm run build:gallery`, set the data directory and public origin, then run `npm start --workspace @daban/gallery`. `node --experimental-strip-types tools/gallery.ts` creates `outputs/gallery-standalone` with its own lockfile and vendored packages. Install its production dependencies with `npm ci --omit=dev --ignore-scripts`, then run `node main.js`.

## Using the gallery

Add its origin and optional token in Daban's Bot Gallery. Review a specific version before installing it as a new Bot. That screen also accepts offline v3 packages. Saved Bot profiles expose template authoring, package download, publication, update previews and configuration history.

Default working preferences are authored separately from learned personal memory. Downloading or publishing freezes a release; changed content requires a new version. Repeating an identical publication is safe. Updates compare the installed baseline, personal changes and target release. Conflicting items require explicit choices. New or changed skills stay disabled until reviewed; rollback does not revive old skill consent.

File-installed Bots may bind an update source only after the installed version and digest match. A changed sourceId stops updates. Closing the client does not cancel accepted operations or running VM tasks. Use the retained receipt/retry action after an uncertain result. Legacy v1/v2 transfer keeps its existing entry point.

## Updates and backups

Build, apply new D1 migrations, then deploy the Worker. Generated gallery SQL is synchronized into `apps/gallery/migrations`; released migrations remain immutable. R2 bytes are persisted and checked before an atomic D1 publication batch. Unregistered objects are not downloadable through the API.

Back up both D1 metadata and R2 objects, retaining sourceId, and verify referenced package digests during recovery. For self-hosting, stop the service and back up the entire data volume, including SQLite/WAL and package files. Restore into an empty directory owned by the service account. Bot package exports do not replace a server backup.

The deployment uses [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/), [R2 conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) and [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/binding/). Package limits account for [Workers memory limits](https://developers.cloudflare.com/workers/platform/limits/).
