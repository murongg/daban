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

Usage and budget ownership stays in the Host. `budgets.ts` records durable per-send reservations and raw provider usage; `usage.ts` meters actual SDK fetches below prompt-cache retries, and Risk reviews use the same ledger. Logical tasks, group stages and explicit Goal continuations inherit one captured budget and immutable price snapshots. Missing usage remains unknown; prices are estimates without currency conversion. Only verified request-count bounds can be strict. Token and fee bounds remain soft until provider billing bounds are verified.

`budget-goals.ts` binds explicit Human continuation receipts to the native Goal, session, budget revision and current Human turn. It does not own Goal lifecycle or rounds. The existing `owned-goal-rounds` SDK hook checks the one-use Host permission immediately before native resume; quota increases and state observations alone never arm a Goal. Ordinary retries keep the native Goal read-only.
