# Extract `sandbox`, `github`, `slack` into source-only packages

**Date:** 2026-06-22
**Status:** Approved design, ready for planning

## Goal

The monorepo currently holds all bot functionality inside `bots/d0lt-bot`. Take
advantage of the workspace by extracting the reusable, bot-agnostic functionality into
three internal packages under `packages/`: **sandbox**, **github**, and **slack**.

The packages are **source-only** ("Just-in-Time packages" in Turborepo terms): their
`package.json` `exports` point directly at `.ts` files and they have **no build step**.
Consumers transpile on the fly — esbuild via `flue build`, vite for the chat app — and
`tsc` resolves them through the existing `allowImportingTsExtensions` + `noEmit` in
`tsconfig.base.json`.

This is a structural refactor: no behavior changes, no new features. Every moved module
keeps its current logic, comments, and tests.

## Decisions (locked during brainstorming)

- **Scope/naming:** `@repo/*` — `@repo/sandbox`, `@repo/github`, `@repo/slack`. Generic
  monorepo-internal scope, decoupled from the `d0lt` branding (the repo is reframed as a
  generic `llm-bot-monorepo`).
- **Tests move with the code:** each package owns its colocated `*.test.ts` and runs its
  own Vitest. Root `test` becomes `turbo run test`.
- **Sandbox is GitHub-agnostic:** the node/cloudflare sandbox factories take a generic
  `secrets` record instead of reading `GITHUB_TOKEN` by name. The bot passes
  `{ GITHUB_TOKEN }`. This removes the only inter-package coupling.

## Architecture

### Package layout

```
packages/
  sandbox/   @repo/sandbox   — runtime-selected, lazy sandbox (GitHub-agnostic)
  github/    @repo/github    — GitHub URL/clone helpers, webhook planning, fetch_repo tool
  slack/     @repo/slack     — Slack event planning, outbound tools, GFM -> mrkdwn
```

Resulting dependency DAG (no inter-package edges):

```
bots/d0lt-bot --> @repo/sandbox
              --> @repo/github
              --> @repo/slack
```

### `@repo/sandbox`

Subpath exports keep each target's deps out of the other target's bundle (the contract
the agent's dynamic `import()` relies on):

- `.` → `resolveSandboxKind`, `lazySandbox`, `workDir`, sandbox types.
  - `workDir` **moves here** from `lib/github.ts` — it computes a per-run scratch dir, a
    sandbox concern, not a GitHub one. It is currently used only by `sandbox.node.ts`.
- `./node` → `createNodeSandbox` (uses `@flue/runtime/node`).
- `./cloudflare` → `createCloudflareSandbox` (uses `@flue/runtime/cloudflare` +
  `@cloudflare/sandbox`).

Source files (moved from `bots/d0lt-bot/src/lib/`):
`sandbox.ts` (→ part of `index.ts`), `lazy-sandbox.ts`, `sandbox.node.ts` (→ `node.ts`),
`sandbox.cloudflare.ts` (→ `cloudflare.ts`).

Tests: `sandbox.test.ts`, `lazy-sandbox.test.ts`.

**Decoupling change.** The factories take a generic secrets record:

- `createNodeSandbox({ id, secrets })` — passes `secrets` to `local({ env: secrets })`,
  derives `cwd` from `workDir(id)`.
- `createCloudflareSandbox({ id, sandboxBinding, secrets })` — `getSandbox(sandboxBinding,
  id)`; on first use injects only the defined entries of `secrets` via `setEnvVars(...)`.
  (Renames the current `env: { Sandbox, GITHUB_TOKEN }` shape into an explicit
  `sandboxBinding` + `secrets` split so the package names nothing GitHub-specific.)

The bot passes `secrets: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }` from the agent
initializer. The clone script in `@repo/github` still references `$GITHUB_TOKEN` by name,
so the contract that the token never enters the model's context is unchanged — the bot is
simply the one place that names the token now.

### `@repo/github`

Single `.` export. Source files (moved from `bots/d0lt-bot/src/`):

- `lib/github.ts` — pure helpers `parseGitHubTarget`, `parsePrTarget`, `assertSafeRef`,
  `looksPrivate`, `buildCloneScript`, and the `GitHubTarget` type. **Minus `workDir`**
  (moved to `@repo/sandbox`); update this file's header comment accordingly.
- `lib/github-webhook.ts` — `planDelivery`, `triggerPhrase`, `commentOnIssue`, the shared
  `client` (Octokit), and the `Dispatch*` types.
- `tools/fetch-repo.ts` — the `fetch_repo` Flue tool, re-exported from the package index
  as a named export `fetchRepoTool` (it is currently a default export; keep a default too
  if cheaper, but the bot imports the named form).

Tests: `github-webhook.test.ts`.

Deps: `@flue/runtime`, `@flue/github`, `@octokit/rest`, `valibot`.

### `@repo/slack`

Single `.` export. Source files (moved from `bots/d0lt-bot/src/lib/`):

- `slack-events.ts` — `planSlackEvent`, `replyInThread`, `postProgressInThread`,
  `workerdSafeFetch`, the shared `client` (WebClient), and the `SlackDispatch*` types.
- `slack-format.ts` — `toMrkdwn`.

Tests: `slack-events.test.ts`, `slack-format.test.ts`.

Deps: `@flue/runtime`, `@flue/slack`, `@slack/web-api`, `valibot`.

## What stays in `bots/d0lt-bot`

Everything Flue-discovered, agent-graph-specific, or markdown-importing — the things that
cannot move, plus the orchestration glue:

- **`channels/github.ts`, `channels/slack.ts`** — Flue's file-based discovery requires
  `channels/*.ts` in the bot's `src`, and they import the agent (`d0ltBot`) to
  `dispatch()`. They now import `planDelivery`/`triggerPhrase`/`commentOnIssue` from
  `@repo/github` and `planSlackEvent`/`replyInThread` from `@repo/slack`. The
  agent↔channel deferred-only import cycle is unchanged.
- **`agents/d0lt-bot.ts` + `d0lt-bot.md`** — the router; imports markdown.
- **`subagents/reviewer.ts`, `subagents/test-runner.ts` + `.md`** — import markdown; swap
  `import fetchRepo from "../tools/fetch-repo.ts"` → `import { fetchRepoTool } from
  "@repo/github"`.
- **`lib/channel-flags.ts`** — this bot's policy for which channels it enables; out of
  scope for this extraction. (Candidate for a future `@repo/bot-kit`; not now — YAGNI.)
- **`lib/observe.ts` + `app.ts`** — the bot's observability wiring.
- **`cloudflare.ts`** — re-exports the `Sandbox` Durable Object class for wrangler; the
  bot's Worker entry. The DO implementation comes from `@cloudflare/sandbox`, which
  `@repo/sandbox` also depends on — same version, deduped by pnpm.

After the move the bot's `tools/` directory is empty (remove it) and `lib/` shrinks to
`channel-flags.ts` + `observe.ts` and their tests.

## Wiring

### Package `package.json` (sandbox shown; github/slack analogous, single `.` export)

```jsonc
{
  "name": "@repo/sandbox",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".":            { "types": "./src/index.ts",      "default": "./src/index.ts" },
    "./node":       { "types": "./src/node.ts",       "default": "./src/node.ts" },
    "./cloudflare": { "types": "./src/cloudflare.ts", "default": "./src/cloudflare.ts" }
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@flue/runtime": "catalog:flue",
    "@cloudflare/sandbox": "catalog:cf"
  },
  "devDependencies": {
    "@types/node": "catalog:tooling",
    "typescript": "catalog:tooling",
    "vitest": "catalog:testing"
  },
  "engines": { "node": "24.x" }
}
```

Each package also gets a `tsconfig.json`:

```jsonc
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts"] }
```

### Dependency versions via pnpm catalogs

Add catalogs to `pnpm-workspace.yaml` so framework/external versions live in one place and
every package references `catalog:`:

- `flue`: `@flue/runtime` (note: pinned to the patched `1.0.0-beta.2`), `@flue/github`,
  `@flue/slack`.
- `cf`: `@cloudflare/sandbox`.
- `external`: `valibot`, `@octokit/rest`, `@slack/web-api` — the third-party libs the
  packages share with the bot. They join a catalog too (not pinned per-package) so the bot
  and packages cannot drift, consistent with the `flue`/`cf` treatment.
- Reuse existing `tooling` (`@types/node`, `typescript`) and `testing` (`vitest`).

The bot's `package.json`:
- adds `"@repo/sandbox": "workspace:*"`, `"@repo/github": "workspace:*"`,
  `"@repo/slack": "workspace:*"`;
- drops the direct deps it no longer imports itself (they become transitive through the
  packages), keeping only what the bot's own remaining source imports (e.g.
  `@cloudflare/sandbox` is still needed by `cloudflare.ts`; `agents`, `hono`, `@flue/*`
  as used by the agent/app).

### Agent dynamic imports

In `agents/d0lt-bot.ts`:
- `import { resolveSandboxKind } from "@repo/sandbox"`
- `(await import("@repo/sandbox/cloudflare")).createCloudflareSandbox({ id, sandboxBinding: env.Sandbox, secrets: { GITHUB_TOKEN: env.GITHUB_TOKEN } })`
- `(await import("@repo/sandbox/node")).createNodeSandbox({ id, secrets: { GITHUB_TOKEN: process.env.GITHUB_TOKEN } })`
- `import { commentOnIssue } from "@repo/github"`
- `import { postProgressInThread, replyInThread } from "@repo/slack"`

Still dynamic imports, so esbuild keeps each target's deps out of the other target's
bundle — the split AGENTS.md documents is preserved.

### Turborepo + root scripts

- Add a `test` task to `turbo.json`.
- Root `test` script → `turbo run test` (fans out across all packages + the bot).
- `typecheck` already fans out via turbo; the new packages' `typecheck` joins
  automatically.
- Root `lint` (`oxlint --fix && oxfmt`) and `format:check` already sweep `packages/**`
  (only `.agents/**` is ignored in both `.oxlintrc.json` and `.oxfmtrc.json`).

### Docs

Targeted edits only, no rewrite:
- `AGENTS.md` — the Architecture section's `src/lib/...` paths now point at packages; add a
  short "Packages" subsection describing the three packages and the source-only convention.
- `README.md` — update the monorepo overview to mention `packages/`.

## Testing & verification

Tests are pure and offline (injected fakes, no agent graph), so they move intact and keep
passing from their new homes. Per AGENTS.md, gate the change with:

1. `pnpm install` (relinks the new workspace packages + catalogs).
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm lint`
5. **Both** build targets, because channel discovery and the workerd target split only
   fail at build time:
   - `pnpm build`
   - `pnpm --filter d0lt-bot build:cf`

## Risks & mitigations

- **`.ts` exports resolution under NodeNext.** Relies on `allowImportingTsExtensions` +
  `noEmit` (already set in `tsconfig.base.json`) and bundler transpilation. This is the
  documented Turborepo Just-in-Time pattern. Verified by `pnpm typecheck` and both builds.
- **Target bundle split.** Must keep `@flue/runtime/node` only behind `@repo/sandbox/node`
  and `@flue/runtime/cloudflare` + `@cloudflare/sandbox` only behind
  `@repo/sandbox/cloudflare`, reached via dynamic import. Verified by `build:cf` (workerd
  rejects node built-ins at build time).
- **Version drift between bot and packages.** Mitigated by pnpm catalogs as the single
  source of truth for framework/external versions.
- **`@flue/runtime` patch.** `patchedDependencies` pins `@flue/runtime@1.0.0-beta.2`; the
  catalog entry must match that exact version so the patch still applies.

## Out of scope

- Moving `channel-flags.ts` / `observe.ts` into a shared package.
- Any behavior, API, or feature change.
- Unrelated refactoring or formatting sweeps.
