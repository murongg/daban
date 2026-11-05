# Daban Project Guidelines

## Source Language

- All project-maintained client code, Electron main and preload code, Linux runtime code, browser scripts, and tests must use TypeScript.
- JavaScript is allowed only in build output and third-party dependencies. Do not place handwritten logic in generated directories to bypass this rule.

## No `void` Keyword

- TS / TSX source must not use the `void` keyword, including expressions and explicit return types.
- Await asynchronous operations or handle failures explicitly with `.catch(...)`. Do not hide failures by discarding Promises.
- Prefer inferred return types for functions that return no value. Use `unknown` for callback contracts where appropriate and `undefined` when an empty value must be explicit.
- Do not bypass these rules by relaxing strict checks, adding `@ts-nocheck`, using `any`, or omitting files from compilation entry points.

## Verification

- `npm run check:source` verifies that maintained directories contain only TypeScript and checks actual syntax nodes for forbidden keywords.
- `npm run typecheck` runs strict type checks for the client, Electron, Linux runtime, build scripts, and tests.
- For behavior changes, write a failing test first using synthetic data, then run the relevant client, runtime, and Linux integration regressions.
- Do not weaken task ownership, request deduplication, or file access checks. Closing a window must not stop tasks running inside the VM.

## Internationalization

- Translation keys must be semantic English identifiers, such as `settings.title` and `models.loadList`. Do not use Chinese text as keys or retain compatibility mappings for Chinese keys.
- Maintain Chinese and English messages in `apps/desktop/locales/zh-CN.ts` and `en.ts`. Both dictionaries must have matching keys and placeholders.
- Access application copy through typed `MessageKey` values. Preserve user content, model output, saved names, and domain enum values as authored; do not turn them into translation keys.

## Readability and Linting

- Do not handwrite minified source or pack independent statements onto one line. Use normal indentation, line breaks, and clear code blocks.
- Use the pinned Biome version for consistent formatting and linting: `npm run format` and `npm run lint`.
- Keep strict TypeScript and forbidden-keyword checks enabled. Do not hide problems by disabling checks or adding broad rule exclusions.
- Exclude build output and third-party dependencies from source formatting.

Biome preserves existing non-null assertions, CSS cascade ordering, and necessary `!important` usage; these are not lint bans. Correctness and accessibility checks remain enabled. Explain exceptions for remote desktop focus and modal backdrops next to the affected code. Preserve keyboard dismissal, focus management, and control ownership checks.

## Database Access

- SQLite stores must use Drizzle ORM (`drizzle-orm/node-sqlite`) through `packages/engine/src/database.ts`. Declare tables in `<store>-schema.ts` and use the Drizzle query builder for reads, writes, upserts, and transactions. Do not call `prepare` or `exec` on `DatabaseSync`, or write SQL strings, in store code.
- Cloudflare gallery metadata uses `drizzle-orm/d1` with the same `gallery-schema.ts` and generated migrations. Use conditional writes and D1 atomic batches; do not assume Node SQLite interactive transactions exist in Workers. Keep Worker runtime imports independent of Node filesystem, `node:sqlite`, Agent and VM implementations.
- Raw SQL is allowed only when the ORM cannot reasonably express a complex query, such as window functions, recursive CTEs, or SQLite-specific expressions. Use Drizzle's parameterized `sql` template for such fragments and add a one-line comment explaining why. Column arithmetic such as `` sql`${table.revision} + 1` `` and `excluded.*` in upserts are ordinary builder usage and need no comment. Never pass untrusted values to `sql.raw`.
- Other allowed SQL: connection pragmas inside `database.ts`, generated migrations, the legacy step passed to `migrate()` that upgrades pre-ORM files to the baseline schema, and test fixtures that build legacy or corrupt files.
- To change a schema, edit `<store>-schema.ts`, run `npm run db:generate -- <store> <name>`, and review the generated `packages/engine/drizzle/<store>` SQL. After manually editing a migration (for example, to add `STRICT`), run `npm run db:embed`. Do not edit generated `*-migrations.ts` files or migrations that have already shipped. `npm run db:check`, part of `npm run lint`, verifies schemas, migrations, and embedded copies.
- Existing user database files must keep opening after an upgrade. Keep legacy steps working and cover them with tests that create pre-ORM files.

## Workspace Boundaries

- Use npm workspaces: `apps/desktop` for the client, `apps/agent` for the host control service, `apps/runtime` for the Linux execution service, `packages/engine` for role-specific implementations, and `packages/protocol` for the public protocol. Repository tooling belongs in `tools`.
- `apps/gallery` owns the independently deployable Bot gallery webpage and Node/Cloudflare entry points. Its standalone Node lockfile is `apps/gallery/standalone-lock.json`; D1 migration copies in `apps/gallery/migrations` are synchronized from generated engine SQL by `tools/gallery-migrations.ts`.
- Desktop renderer code lives in `src/app`, `src/components`, and `src/features`; keep feature tests colocated. Put pure renderer/Electron modules in `apps/desktop/shared` and synthetic UI helpers in `apps/desktop/src/test`. See `docs/architecture.md` for the directory map.
- Applications must declare their own dependencies. Import shared protocol definitions only through the public `@daban/protocol` entry point. Do not import between applications, use cross-workspace relative imports, or access package-internal source files.
- Root commands build in this order: protocol package, implementation library, then applications. Preserve compatibility with existing build entry points and user data paths.
- `apps/runtime/standalone-lock.json` supports standalone Linux deployment; `apps/agent/standalone-lock.json` supports host service deployment. When updating dependencies, synchronize the root lockfile and the corresponding standalone lockfiles. Do not depend on development-machine workspace links.

## Version Management and Releases

### Semantic Versioning

- Follow [Semantic Versioning 2.0.0](https://semver.org/): use `MAJOR.MINOR.PATCH` with non-negative integers and no leading zeroes. The `v` prefix belongs to Git tag names, not package versions.
- From `1.0.0`, increment PATCH for backward-compatible fixes, MINOR for backward-compatible features or public API deprecations, and MAJOR for incompatible public API changes. Choose the highest required increment across all changes included in the release, and reset lower components when incrementing MINOR or MAJOR.
- Prereleases append a suffix such as `-beta.1` or `-rc.1` and sort below the stable version with the same base. Increment the numeric suffix for successive versions in the same prerelease stage; remove the entire prerelease suffix when promoting the base version to stable.

### Project Conventions

- Use one release version for the entire project. The root `package.json` is the source of truth; all five workspaces must use the same version and must not be versioned independently. Read the version from package metadata in code and tooling instead of adding duplicated version constants.
- Assess compatibility against public APIs and protocols, documented commands and configuration, and supported user data and upgrade paths. Judge the release by its shipped behavior and compatibility impact, not the size of a refactor or a commit prefix. A version increment does not authorize removing existing compatibility safeguards.
- During `0.x`, the project's policy is PATCH for compatible fixes and internal maintenance, and MINOR for new functionality or breaking changes. Explicitly document breaking changes and any required migration. This is a project convention; SemVer itself does not prescribe these increments before `1.0.0`.
- Plan `1.0.0` when the compatibility contract is documented and the project is ready to maintain it, with verified upgrade paths for supported existing user data. Do not infer readiness from the number of releases or promote to `1.0.0` automatically.
- Change the project version only as part of an explicitly requested release or version bump. Ordinary feature, fix, refactor, dependency, and documentation work must retain the current project version; do not add a version bump to each PR. Documentation-only changes need no release; if compatible maintenance is intentionally released, use PATCH. Classify dependency updates by their effect on the shipped product.
- Use numbered prerelease stages such as `alpha.N`, `beta.N`, and `rc.N` as needed; stages may be skipped. Keep independently managed protocol, database schema, and environment package versions separate from the project release version.

### Release Workflow

- After merging the changes to release, use a clean, up-to-date `main` checkout, run `npm ci`, and ensure the relevant checks pass. Run `npm run release` (bumpp), or `npm run release -- --release <version>` for an explicit target. Derive the increment from all changes since the preceding release, or since the preceding stable release when starting a prerelease cycle. Verify an explicitly requested target against this policy instead of silently substituting another version. Confirm the target is newer than the previous release in its channel and its tag is unused before proceeding; the command commits, tags, and pushes.
- Synchronize the root package, all five workspaces, internal dependency versions, `package-lock.json`, and both standalone lockfiles through `bump.config.ts` and `tools/bump.ts`. Preserve standalone `file:` dependency paths and unrelated third-party versions. Review the resulting release commit for synchronized versions and unrelated changes.
- bumpp creates the `chore(release): v<version>` commit and an annotated `v<version>` tag, then pushes both. Do not bypass this flow with manual version edits, `npm version`, or `git tag` commands. The tag triggers `.github/workflows/release.yml`; its main-ancestry, version, signing, and changelog checks remain required.
- Published versions and tags are immutable: do not move, delete, or reuse them to replace release content. Retry a failed workflow with the same existing tag when the source is unchanged; source changes require a new version. See `docs/releasing.md` for the full procedure.

## Verification Artifacts and Disk Usage

- Do not add incidental verification or decorative screenshots to maintained project files or PR commits. Keep temporary screenshots in ignored artifact directories such as `outputs/`; include screenshots in the repository only when explicitly requested or necessary for maintained documentation.
- After each verification phase, remove obsolete artifacts that can be rebuilt. Keep the current client and one rollback version, and the latest complete environment package plus one previous version. Reports, logs, and cleanup records may be retained.
- Normally keep one reusable test VM. Retire extra instances created for standalone installation checks after verification finishes and they are no longer needed for recovery. Keep clean-image build VMs only as required by current build work.
- Before deleting a test VM, check the verification reports, actual directory, and image provenance. Confirm that the VM is stopped and its disks are not in use, then delete it through the VM manager. Do not bulk-delete based only on directory names or historical reports.
- Once a compressed environment package passes verification, its consumers have stopped, and its original cache can be rebuilt, remove intermediate raw images and obsolete environment packages. Do not automatically recreate previously retired resources during later work.
- Do not clean up currently used VMs, user workspaces, login credentials, or recovery backups. Do not delete running clients or active test resources. Record actual disk usage with `df` before and after cleanup; do not simply add directory sizes for sparse disks or clones that share storage blocks.
