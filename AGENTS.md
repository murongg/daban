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

## Workspace Boundaries

- Use npm workspaces: `apps/desktop` for the client, `apps/agent` for the host control service, `apps/runtime` for the Linux execution service, `packages/engine` for role-specific implementations, and `packages/protocol` for the public protocol. Repository tooling belongs in `tools`.
- Desktop renderer code lives in `src/app`, `src/components`, and `src/features`; keep feature tests colocated. Put pure renderer/Electron modules in `apps/desktop/shared` and synthetic UI helpers in `apps/desktop/src/test`. See `docs/architecture.md` for the directory map.
- Applications must declare their own dependencies. Import shared protocol definitions only through the public `@daban/protocol` entry point. Do not import between applications, use cross-workspace relative imports, or access package-internal source files.
- Root commands build in this order: protocol package, implementation library, then applications. Preserve compatibility with existing build entry points and user data paths.
- `apps/runtime/standalone-lock.json` supports standalone Linux deployment; `apps/agent/standalone-lock.json` supports host service deployment. When updating dependencies, synchronize the root lockfile and the corresponding standalone lockfiles. Do not depend on development-machine workspace links.

## Releases

- Use `npm run release` (bumpp) from a clean, up-to-date `main` checkout after merging the changes to release. For an explicit version, use `npm run release -- --release <version>`; stable and prerelease versions are supported.
- Keep the root package, all five workspaces, internal dependency versions, `package-lock.json`, and both standalone lockfiles synchronized through `bump.config.ts` and `tools/bump.ts`. Preserve standalone `file:` dependency paths and unrelated third-party versions.
- bumpp creates the `chore(release): v<version>` commit, an annotated `v<version>` tag, and pushes both. Do not replace this flow with manual version edits or `git tag` commands. The tag triggers the existing `.github/workflows/release.yml`; its main-ancestry, version, signing, and changelog checks remain required. See `docs/releasing.md` for the full procedure.

## Verification Artifacts and Disk Usage

- After each verification phase, remove obsolete artifacts that can be rebuilt. Keep the current client and one rollback version, and the latest complete environment package plus one previous version. Reports, logs, and cleanup records may be retained.
- Normally keep one reusable test VM. Retire extra instances created for standalone installation checks after verification finishes and they are no longer needed for recovery. Keep clean-image build VMs only as required by current build work.
- Before deleting a test VM, check the verification reports, actual directory, and image provenance. Confirm that the VM is stopped and its disks are not in use, then delete it through the VM manager. Do not bulk-delete based only on directory names or historical reports.
- Once a compressed environment package passes verification, its consumers have stopped, and its original cache can be rebuilt, remove intermediate raw images and obsolete environment packages. Do not automatically recreate previously retired resources during later work.
- Do not clean up currently used VMs, user workspaces, login credentials, or recovery backups. Do not delete running clients or active test resources. Record actual disk usage with `df` before and after cleanup; do not simply add directory sizes for sparse disks or clones that share storage blocks.
