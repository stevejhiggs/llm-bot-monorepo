# d0lt-bot → Cloudflare deployment (dual-target) — design

**Date:** 2026-06-20
**Status:** Approved design, pending implementation plan
**Scope:** Make the `apps/d0lt-bot` Flue app deployable to Cloudflare Workers while keeping the
current Node-target local-dev experience unchanged.

## Goal

Run the same d0lt-bot agent on two targets:

- **Local (node target):** unchanged — `local()` sandbox spawning real `/bin/bash` in an OS temp
  dir, exactly as today.
- **Deployed (cloudflare target):** the same router + subagents running inside a Durable Object,
  with shell work executed in a **Cloudflare Sandbox** container.

Selection between the two is driven by an **environment variable**, not Flue internals.

Out of scope (unchanged from today): posting results back to GitHub; any change to the
reviewer/test-runner behavior or the `fetch_repo` tool.

## Key constraint that drives the design

d0lt-bot's core work is arbitrary shell: `git clone`, detect stack, install deps, run tests.
Cloudflare offers two sandbox options; only one runs Linux commands:

| Option | Runs `git`/install/tests? | Verdict |
| --- | --- | --- |
| **Cloudflare Sandbox** (`@cloudflare/sandbox`, container-backed) | Yes — full Linux at `/workspace` | **Use this** |
| Cloudflare Shell (`cloudflare-shell` adapter) | No — model-facing `code` tool only, no Linux shell | Not suitable |

So the deployed sandbox is **Cloudflare Sandbox** (container). The `cloudflare-shell` adapter is
explicitly rejected for this app.

## Architecture

Only the **root agent module** (`apps/d0lt-bot/src/agents/d0lt-bot.ts`) changes. The two
subagents (`reviewer`, `test_runner`) and the `fetch_repo` tool are untouched: subagents share the
router's sandbox and inherit its model, so wiring the sandbox once at the router covers everything.

### Conditional sandbox selection

The root agent factory (already `async`) chooses a sandbox by reading an env var, e.g.
`FLUE_SANDBOX` (values: `local` | `cloudflare`; default `local` so existing `pnpm dev` is
unaffected).

```text
FLUE_SANDBOX=local  (or unset)  →  local({ env: { GITHUB_TOKEN } }),  cwd = per-id OS temp dir
FLUE_SANDBOX=cloudflare         →  cloudflareSandbox(getSandbox(env.Sandbox, id)), cwd = /workspace
```

- **local branch:** identical to current code — `mkdir` the per-id scratch dir, `local(...)` from
  `@flue/runtime/node`, `cwd = workDir(id)`.
- **cloudflare branch:** `cloudflareSandbox(getSandbox(env.Sandbox, id))` from
  `@flue/runtime/cloudflare`, `cwd = '/workspace'`. No host `mkdir` — the container provides the
  filesystem.

**Bundling rule (important):** the two branches must use **dynamic `import()`**, not top-level
imports, so the Workers bundle never pulls `@flue/runtime/node` and the Node bundle never pulls
`@cloudflare/sandbox`. Each module is node-only or cloudflare-only and will break the other
target's build if statically imported.

> Risk / validation point: even behind a runtime branch, the Cloudflare (Vite/wrangler) build may
> still try to *resolve* a dynamic `import('@flue/runtime/node')`. If `workerd` rejects it, the
> fallback is to split the two sandbox factories into separate files and pick the specifier at
> build time (a Vite `define`/alias or a build-target-conditioned import path) so the dead branch
> is statically eliminated. Confirm during implementation with `wrangler deploy --dry-run`.

### Model

Keep `anthropic/claude-sonnet-4-6` on **both** targets (code review quality matters; not switching
to Workers AI). On Cloudflare, `ANTHROPIC_API_KEY` is provided as a Worker secret.

### Secrets / GITHUB_TOKEN

Mirror current local behavior: inject `GITHUB_TOKEN` as a Worker secret into the container env so
`$GITHUB_TOKEN` continues to authenticate private clones at run time, without entering the model's
context. Cloudflare's zero-trust **outbound Workers** egress proxy is noted as a future hardening,
not built now.

## New / changed files

| File | Change |
| --- | --- |
| `apps/d0lt-bot/src/agents/d0lt-bot.ts` | Env-var branch selecting `local()` vs `cloudflareSandbox(...)` via dynamic import; `cwd` per branch. |
| `apps/d0lt-bot/src/cloudflare.ts` | New. `export { Sandbox } from '@cloudflare/sandbox';` |
| `wrangler.jsonc` (project root) | New. See below. |
| `Dockerfile` (project root) | New. `FROM docker.io/cloudflare/sandbox:<pinned>`; pin to the installed `@cloudflare/sandbox` version. Extra `RUN` lines only if test stacks need more tooling. |
| `apps/d0lt-bot/package.json` | Add `@cloudflare/sandbox` (+ `agents` SDK, `wrangler` dev dep per Flue CF requirements); add `dev:cf`, `build:cf`, `deploy` scripts. |
| `apps/d0lt-bot/.dev.vars` (gitignored) | Local CF dev secrets (`ANTHROPIC_API_KEY`, optional `GITHUB_TOKEN`). |
| `.gitignore` | Ensure `.dev.vars*` ignored. |
| `apps/d0lt-bot/.env.example` / README | Document the new env var, secrets, and deploy flow. |

> Note on wrangler.jsonc location: Flue reads the **project-root** `wrangler.jsonc`. Confirm during
> implementation whether, in this Turborepo monorepo, the root or `apps/d0lt-bot/` is the "project
> root" Flue expects for the d0lt-bot build, and place the file (and `Dockerfile`) accordingly.

### `wrangler.jsonc` (shape)

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "d0lt-bot",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "class_name": "Sandbox", "name": "Sandbox" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FlueRegistry", "FlueD0ltBotAgent"] },
    { "tag": "v2", "new_sqlite_classes": ["Sandbox"] }
  ],
  "containers": [{ "class_name": "Sandbox", "image": "./Dockerfile" }]
}
```

- Do **not** hand-author Flue's generated `FLUE_*` bindings — Flue merges those at build.
- `FlueRegistry` is required in the first migration; it stores Flue's run indexing for `/runs`
  lookups. The generated agent class name (`FlueD0ltBotAgent` here) must be confirmed from the
  actual build output before first deploy and the migration kept stable thereafter.
- All classes (including the container `Sandbox` DO) are introduced via `new_sqlite_classes`, never
  legacy `new_classes`; this matches Flue's official Cloudflare deploy example.
- **No `db.ts`:** Cloudflare uses Durable Object SQLite automatically and the Cloudflare build
  *rejects* a source-root `db.ts` if present. The repo has none today — do not add one for the CF
  target. (`db.ts` is a node-target-only concern and is orthogonal to these DO migrations.)

## Build & deploy flow

```bash
# local dev (unchanged)
pnpm dev                          # flue dev --target node, FLUE_SANDBOX unset → local()

# local cloudflare dev
flue dev --target cloudflare      # reads .dev.vars; FLUE_SANDBOX=cloudflare

# deploy
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN          # optional, for private repos
flue build --target cloudflare
wrangler deploy --dry-run --config dist/d0lt-bot/wrangler.json
wrangler deploy --config dist/d0lt-bot/wrangler.json
```

## Testing / validation

- **Local node:** `pnpm dev` + `pnpm connect`, review a public PR and run tests — must behave
  exactly as today (regression check on the env-var default).
- **Local cloudflare:** `flue dev --target cloudflare`, exercise the same two flows against the
  container sandbox; verify `git clone`, install, and test runs work in `/workspace`.
- **Dry run:** `wrangler deploy --dry-run` passes (validates bindings, migrations, container, and
  that no node-only module leaked into the Worker bundle).
- **Private repo:** confirm `$GITHUB_TOKEN` clone works in the container with the secret set.

## Open items to resolve during implementation

1. Exact generated agent DO class name for the `v1` migration (read from build output).
2. Project-root vs `apps/d0lt-bot/` placement of `wrangler.jsonc` + `Dockerfile` in this monorepo.
3. Whether the dynamic-import bundling rule is sufficient or a build-time split is needed (dry-run).
4. Pinned `@cloudflare/sandbox` / base image version and `agents` SDK version (Flue tested against
   `agents` 0.14.x).
