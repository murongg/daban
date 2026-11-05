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

## GitHub login and registration

Both hosts use Better Auth with the same Drizzle schema. Create a [GitHub OAuth App](https://github.com/settings/developers) for each gallery origin. Set its homepage to your gallery and its authorization callback to `https://bots.example.test/api/auth/callback/github`, replacing the example origin. Local development uses the exact browser origin, for example `http://127.0.0.1:3000/api/auth/callback/github`. GitHub OAuth Apps have one callback URL; use separate apps for local and production environments.

| Variable | Purpose |
| --- | --- |
| GITHUB_CLIENT_ID | OAuth App client ID |
| GITHUB_CLIENT_SECRET | OAuth App client secret; server only |
| BETTER_AUTH_SECRET | Random secret of at least 32 characters; generate with `openssl rand -base64 32` |
| GALLERY_PUBLIC_ORIGIN | Exact browser origin, without a path or trailing slash; required for GitHub on both hosts |
| GALLERY_GITHUB_ADMIN_IDS | Optional comma-separated numeric GitHub user IDs with global administration rights |
| GALLERY_GITHUB_ALLOWED_IDS | Optional comma-separated numeric GitHub user IDs allowed to register and sign in |

Configure all three credentials together. When all are absent, the gallery retains token-only authentication. Partial credentials or invalid ID lists stop authentication initialization. Never put secrets in client-side `NEXT_PUBLIC_*` variables, templates, source control, or build logs.

“Continue with GitHub” signs in an existing account or registers a new one. The provider requests only `read:user` and `user:email`, with no repository permission. A public gallery accepts new GitHub users unless an allowlist is configured. A private gallery requires an allowed or administrator ID; an administrator is always allowed. IDs are stable numeric GitHub IDs, not usernames or emails. The first signup never becomes an administrator automatically.

Each account receives one personal `gh-<id>` namespace, with a suffix if an old namespace already exists. Existing namespaces and machine tokens keep their permissions; matching usernames or emails do not claim them. Administrators can still manage automation tokens through “Use an access token.” Browser sessions expire after 12 hours and logout revokes them in the database. Email/password registration and email-based account linking are disabled. The gallery session API exposes publication permissions and a CSRF nonce, never OAuth credentials or the underlying session token.

Keep `BETTER_AUTH_SECRET` stable across replicas and restarts and back it up securely alongside the database: it signs sessions and encrypts stored provider tokens. Apply the new gallery migration before deploying the Worker. Node applies additive migrations on startup. See the [Better Auth GitHub provider guide](https://better-auth.com/docs/authentication/github) for app setup.

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

The default read mode is private. To allow anonymous browsing, set GALLERY_READ_MODE to public and explicitly publish templates with public visibility. Private templates still require authorization. Set GALLERY_PUBLIC_ORIGIN to the exact HTTPS origin in `vars`; with GitHub authentication it is required. Token-only Workers can use the request origin when it is absent. Web and API requests remain same-origin.

To enable GitHub, add `GALLERY_PUBLIC_ORIGIN` and the numeric admin/allow lists to `wrangler.jsonc`'s `vars`, then store credentials as Worker secrets and redeploy:

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler deploy
```

`GALLERY_ADMIN_TOKEN` remains an optional recovery/automation credential when GitHub administrators are configured. Store local OAuth credentials in an ignored `.dev.vars` file and use a local OAuth App callback matching the Wrangler browser origin.

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

For GitHub, export the three credentials and your numeric admin/allow lists before starting Compose; the supplied Compose file passes them to the service. Direct Node deployment reads the same environment variables. Keep the public origin equal to the reverse proxy's HTTPS origin and preserve cookies and callback query parameters when forwarding requests. GitHub login requires outbound HTTPS access to GitHub.

For direct Node deployment, build with `npm run build:gallery`, set the data directory and public origin, then run `npm start --workspace @daban/gallery`. `node --experimental-strip-types tools/gallery.ts` creates `outputs/gallery-standalone` with its own lockfile and vendored packages. Install its production dependencies with `npm ci --omit=dev --ignore-scripts`, then run `node main.js`.

## Using the gallery

Add its origin and optional token in Daban's Bot Gallery. Review a specific version before installing it as a new Bot. That screen also accepts offline v3 packages. Saved Bot profiles expose template authoring, package download, publication, update previews and configuration history.

Default working preferences are authored separately from learned personal memory. Downloading or publishing freezes a release; changed content requires a new version. Repeating an identical publication is safe. Updates compare the installed baseline, personal changes and target release. Conflicting items require explicit choices. New or changed skills stay disabled until reviewed; rollback does not revive old skill consent.

File-installed Bots may bind an update source only after the installed version and digest match. A changed sourceId stops updates. Closing the client does not cancel accepted operations or running VM tasks. Use the retained receipt/retry action after an uncertain result. Legacy v1/v2 transfer keeps its existing entry point.

## Updates and backups

Build, apply new D1 migrations, then deploy the Worker. Generated gallery SQL is synchronized into `apps/gallery/migrations`; released migrations remain immutable. R2 bytes are persisted and checked before an atomic D1 publication batch. Unregistered objects are not downloadable through the API.

Back up both D1 metadata and R2 objects, retaining sourceId, and verify referenced package digests during recovery. For self-hosting, stop the service and back up the entire data volume, including SQLite/WAL and package files. Restore into an empty directory owned by the service account. Bot package exports do not replace a server backup.

The deployment uses [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/), [R2 conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) and [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/binding/). Package limits account for [Workers memory limits](https://developers.cloudflare.com/workers/platform/limits/).
