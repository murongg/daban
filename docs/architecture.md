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


## Bot approval rules

The Host owns `ApprovalRules` (`packages/engine/src/approval-rules.ts`) and its Drizzle store. It stores exact rules, revisions and idempotent edit receipts. Commands, IntegrationTools, SoftwareTools and Interactions retain their existing effect and approval receipts. ModelRuns derives the approval category from the existing Host-captured `AutomationSource`: time, file and manual schedule firings are automation; an independent Human entry has no automation source. Schedules and Groups retain their original provenance forwarding and persistence. Public task fields and model RPC cannot supply provenance, edit rules or submit decision metadata.

Deny wins over ask and allow. Commands recheck after guest preparation; MCP rechecks in its existing dispatch callback; SoftwareTools rereads the complete plan receipt before install; DSH web policy checks even task/search-authorized URLs and validates the captured revision immediately before proceeding. Unknown outcomes continue to query the original receipt rather than replaying effects. Optional transcript failure does not revoke a durable Interaction decision; a web fast path without another receipt requires a durable transcript decision.

MCP allow eligibility comes from an explicit Human purpose confirmation in the existing Interactions receipt, bound by ModelRuns to the current task and persisted RunTurn ID. One-time decisions, rule settings and model arguments cannot create that authority. IntegrationTools checks the captured task/turn after waits and immediately before sending; a new turn or changed exact resource, source, scope or rule version invalidates reuse. Closed or restored runs cannot reuse purpose receipts.

The `approval-rules-v3` capability is negotiated independently through the existing HTTP client. It negotiates complete rule scopes, captured project decision context, Host-only purpose scope and explicit Human purpose replies. Older HTTP clients receive Interaction/MCP shapes without policy or purpose metadata and retain ordinary one-time replies. The Electron IPC and RuntimeClient remain their committed-baseline owners; this change does not copy the separate remote extraction or introduce a remote snapshot negotiation protocol. Rules support Bot and explicit project subjects. Project rules persist under the project ID and apply only to current members whose accepted task captures that project. ModelRuns checks the actual Projects revision/member authority before evaluation and at final dispatch, merges Bot and project restrictions, and records the captured project in the decision hash. Each Bot still needs its own task/Turn purpose proof. The imported Projects owner remains the authority for access and membership.

## Project resources

`Projects` in the host owns project IDs, explicit Bot grants, revisions and durable change receipts in `projects.sqlite`. Membership is part of the validated project document; callers use `assertScope` or `assertHumanScope`, not its tables. The old shared workspace and browser keep their original paths and logins, with a symbolic `legacy-shared` resource registration. New projects do not copy credentials or private Bot data. A failed project store or mirror disables project access while legacy file ports and historical task receipts remain available.

The executor's `ProjectResources` derives directories from authenticated resource IDs outside the legacy listing root. Overlapping custom legacy/data roots disable project execution while preserving the original legacy path. Shared content and private task staging are separate: read members may create their own task outputs, while publishing through `/shared` requires write access. Project scope is captured in task records, request fingerprints, SDK session identity, recovery context and group delivery. Revocations invalidate old revisions immediately; receipts remain queryable and unknown external effects are never replayed.

`BrowserProfiles` owns one persistent context per profile resource. Private identities are keyed by project and Bot; project login sharing requires an independent browser grant. Tabs and computer leases retain their original Bot owner. Scope changes require an idle, explicitly disconnected computer so switching identity cannot close applications or steal human control. Profile preparation failures keep the prior binding. Content permissions apply to managed file and knowledge ports; the existing full VM command and native desktop privileges are not OS-level tenant isolation.

Existing Bot SQL owner values and edit hashes remain unchanged. The Drizzle scopeKey property maps the legacy bot column to unambiguous subject keys; no SQL layout migration is required. New project mutations validate current Human scope inside the rule transaction, while exact historical edit receipts remain recoverable after revision changes or archive. Preview is pure and checks the selected subject; actual task execution also combines its Bot and captured project rules.
