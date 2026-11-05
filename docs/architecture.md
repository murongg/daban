# Repository structure

Daban uses npm workspaces. Install dependencies and run shared commands from the repository root.

```text
apps/
  desktop/
    src/
      app/                 Application composition, workspace layout and global state
      components/
        controls/          Reusable controls, dialogs and tooltips
        content/           Markdown, code, formulas and diagrams
      features/            Bot, chat, models, computer and other product features
      i18n/                Renderer locale adapter and translation tests
      styles/              Global tokens, layout and settings styles
      test/                Synthetic fixtures and shared test helpers
      main.tsx             Renderer entry point
    shared/                Pure modules shared by renderer and Electron
    electron/              Main process, preload and native adapters
    locales/               Paired English and Simplified Chinese catalogs
    preview/               Isolated synthetic UI scenes
    acceptance/            Desktop and packaged-client acceptance checks
    public/                Icons, avatars and provider assets
  agent/                   Host service, model credentials, DSH, approvals and VM management
  runtime/                 Linux execution-service entry point
packages/
  engine/                  Implementations with separate host and executor entry graphs
  protocol/                Public types, wire contracts and validation
tools/                     Build, packaging and source-boundary checks
  testing/                 Shared Vitest environment setup
docs/                      User guides, architecture and development instructions
vitest.config.ts           Repository test configuration
```

Feature-specific tests and styles stay beside their feature. Tests that cover several features live with the application composition or the feature that owns the workflow. Synthetic preview fixtures belong in `src/test`; frozen historical sample identities used by data migration remain in `src/app/samples.ts`.

`shared` is local to the desktop application. It holds framework-independent code used by both Electron and the renderer; it is not a new workspace package. Renderer controls depend on the locale adapter, while feature code uses the application runtime and state. `app` composes these features.

Applications depend on the public exports of `@daban/engine` and `@daban/protocol`. They do not import one another. The engine retains separate public host and executor entry points and its verified deployment layout; organizing renderer files does not move model credentials or approvals into the VM.

The root `vitest.config.ts` owns all unit tests: the `desktop` project uses jsdom, while the `node` project runs compiled agent/engine tests and TypeScript tooling tests. Linux and browser integration tests retain the Node test runner. `apps/desktop/vite.config.ts` owns the renderer build, and `apps/desktop/electron/vite.config.ts` owns main/preload bundling. Root scripts continue building protocol, engine and applications in dependency order.

See [development](development.md) for commands and [project guidelines](../AGENTS.md) for language, package-boundary and verification rules. Project code is licensed under [AGPL-3.0-only](../LICENSE); third-party notices retain their original licenses.

## Execution and Goal controls

Execution limits remain with ModelRuns and its existing SDK policy: 60 tool calls, 300000ms of active execution excluding actual Human waits, and at most three native Goal rounds. Registry execution ordinals accompany the existing attempt fence and supplement TaskJournal contributions when providers reuse call IDs; they do not create a separate quota or billing ledger. Per-request usage collection, prices, configurable request/fee budgets and quota increases have been removed. Existing financial sidecar files and shipped migrations are left untouched and are not opened by the runtime.

`goal-controls.ts` belongs to the native Goal owner and stores only exact Goal/session links, Human epochs and one-use resume grants in `goals.sqlite`. It has no quota, price or usage data. The existing `owned-goal-rounds` SDK hook checks the permission immediately before resume; observations and AutomationSource provenance never authorize it. Ordinary retries keep the Goal read-only. Retired group budget columns remain inert compatibility storage so old databases are not destructively migrated.

Archived Project Goal hashes remain distinct for data compatibility. Current Goal controls refuse scoped owners, and stored grants require a matching owner hash without retired scope. Project history is not imported into current Goal links or normalized into ordinary authority.

## Retired project metadata

Project management, membership edits, project environment selection, Host project APIs and executor `projects.sync`/`projects.bind` are removed. Ordinary shared workspace paths, configured browser profile paths and existing logins remain unchanged. No project files, database files, resource indexes or profiles are deleted, moved or copied during startup.

Task journals, historical snapshots and cached file references retain validated project identity to keep history readable and prevent same-named files or sessions from crossing scopes. New project tasks, retries, file locators and collaboration sources fail with `PROJECT_RETIRED`; they never fall through to an unscoped shared path. The retired `projects.sqlite` store is no longer opened or resumed. Its shipped schema/migrations remain as history and synthetic compatibility fixtures, without schema rollback or background resource preparation.

`BrowserProfiles` continues to own ordinary shared contexts and their Bot references. Computer control, tab ownership, viewer grants, request deduplication and path/symlink protections remain independent of the removed project selection. Project-backed monitoring cannot read or retarget its saved paths; old rules and uncertain receipts do not authorize a broader task.
