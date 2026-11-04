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

## Project resources

`Projects` in the host owns project IDs, explicit Bot grants, revisions and durable change receipts in `projects.sqlite`. Membership is part of the validated project document; callers use `assertScope` or `assertHumanScope`, not its tables. The old shared workspace and browser keep their original paths and logins, with a symbolic `legacy-shared` resource registration. New projects do not copy credentials or private Bot data. A failed project store or mirror disables project access while legacy file ports and historical task receipts remain available.

The executor's `ProjectResources` derives directories from authenticated resource IDs outside the legacy listing root. Overlapping custom legacy/data roots disable project execution while preserving the original legacy path. Shared content and private task staging are separate: read members may create their own task outputs, while publishing through `/shared` requires write access. Project scope is captured in task records, request fingerprints, SDK session identity, recovery context and group delivery. Revocations invalidate old revisions immediately; receipts remain queryable and unknown external effects are never replayed.

`BrowserProfiles` owns one persistent context per profile resource. Private identities are keyed by project and Bot; project login sharing requires an independent browser grant. Tabs and computer leases retain their original Bot owner. Scope changes require an idle, explicitly disconnected computer so switching identity cannot close applications or steal human control. Profile preparation failures keep the prior binding. Content permissions apply to managed file and knowledge ports; the existing full VM command and native desktop privileges are not OS-level tenant isolation.
