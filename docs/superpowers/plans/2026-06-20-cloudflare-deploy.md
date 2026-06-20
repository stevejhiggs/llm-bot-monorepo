# d0lt-bot Cloudflare Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apps/d0lt-bot` deployable to Cloudflare Workers (container-backed sandbox) while keeping the existing node-target `local()` sandbox for local dev, selected by an env var.

**Architecture:** A single shared root-agent module picks its sandbox at runtime from an env var (`FLUE_SANDBOX`). The selection is a pure function (`resolveSandboxKind`) plus two factory modules behind **dynamic `import()`** — `sandbox.node.ts` (`local()`) and `sandbox.cloudflare.ts` (`cloudflareSandbox(getSandbox(...))`) — so each build target only bundles its own sandbox dependency. Cloudflare adds `cloudflare.ts` (exports the `Sandbox` DO), a root `wrangler.jsonc`, and a `Dockerfile`.

**Tech Stack:** Flue (`@flue/runtime` / `@flue/cli` 1.0.0-beta), TypeScript, pnpm + Turborepo, Cloudflare Workers + Durable Objects, `@cloudflare/sandbox`, `agents` SDK, Wrangler, Node 24, Valibot.

## Global Constraints

- Node engine: `24.x`; package manager `pnpm@11.8.0`; ESM (`"type": "module"`) with **explicit `.ts` import specifiers** (match existing files, e.g. `import x from "../lib/github.ts"`).
- Flue is invoked from inside `apps/d0lt-bot` (its package scripts run `flue ...`), so **`apps/d0lt-bot/` is the Flue "project root"**: `wrangler.jsonc` and `Dockerfile` live there.
- Cloudflare target requires `compatibility_flags: ["nodejs_compat"]` and `compatibility_date: "2026-06-01"`.
- Do **not** hand-author Flue's generated `FLUE_*` bindings in `wrangler.jsonc`; Flue merges them at build. Declare only application-owned resources (`Sandbox`).
- All Durable Object classes are introduced via `new_sqlite_classes` (never legacy `new_classes`); `FlueRegistry` must be in the first migration; migration history is append-only.
- **No `db.ts`** anywhere — the Cloudflare build rejects it.
- Model stays `anthropic/claude-sonnet-4-6` on both targets.
- `GITHUB_TOKEN` reaches the container as an env var (parity with local `$GITHUB_TOKEN`); never logged, never placed in `wrangler.jsonc`.
- Local dev (`pnpm dev` + `pnpm connect`) must behave identically to today at every task boundary (default `FLUE_SANDBOX` unset → `local`).
- Pin `@cloudflare/sandbox` and the `Dockerfile` base image tag to the same version.

---

### Task 1: Pure sandbox-kind selection + extract node factory (node dev unchanged)

Refactor the inline `local()` wiring out of the root agent into a selection helper and a node factory module, with a unit test for the pure selector. Node behavior is byte-for-byte the same.

**Files:**
- Create: `apps/d0lt-bot/src/lib/sandbox.ts`
- Create: `apps/d0lt-bot/src/lib/sandbox.node.ts`
- Create: `apps/d0lt-bot/src/lib/sandbox.test.ts`
- Modify: `apps/d0lt-bot/src/agents/d0lt-bot.ts`

**Interfaces:**
- Produces:
  - `resolveSandboxKind(env: Record<string, string | undefined>): "local" | "cloudflare"` — returns `"cloudflare"` iff `env.FLUE_SANDBOX === "cloudflare"`, else `"local"`.
  - `createNodeSandbox(opts: { id: string }): Promise<{ sandbox: unknown; cwd: string }>` (in `sandbox.node.ts`) — builds the per-id temp dir (via existing `workDir`), `mkdir -p`s it, returns `{ sandbox: local({ env: { GITHUB_TOKEN } }), cwd }`.

- [ ] **Step 1: Write the failing test**

`apps/d0lt-bot/src/lib/sandbox.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveSandboxKind } from "./sandbox.ts";

test("defaults to local when FLUE_SANDBOX is unset", () => {
  assert.equal(resolveSandboxKind({}), "local");
});

test("selects cloudflare when FLUE_SANDBOX=cloudflare", () => {
  assert.equal(resolveSandboxKind({ FLUE_SANDBOX: "cloudflare" }), "cloudflare");
});

test("any other value falls back to local", () => {
  assert.equal(resolveSandboxKind({ FLUE_SANDBOX: "node" }), "local");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/d0lt-bot && node --experimental-strip-types --test src/lib/sandbox.test.ts`
Expected: FAIL — cannot resolve `./sandbox.ts` / `resolveSandboxKind is not a function`.
(If your Node 24 build strips types without the flag, `node --test src/lib/sandbox.test.ts` also works.)

- [ ] **Step 3: Write the pure selector**

`apps/d0lt-bot/src/lib/sandbox.ts`:

```ts
export type SandboxKind = "local" | "cloudflare";

// Selects the sandbox implementation at runtime. Local dev (env unset) keeps the
// node local() sandbox; the Cloudflare build sets FLUE_SANDBOX=cloudflare.
export function resolveSandboxKind(
  env: Record<string, string | undefined>,
): SandboxKind {
  return env.FLUE_SANDBOX === "cloudflare" ? "cloudflare" : "local";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/d0lt-bot && node --experimental-strip-types --test src/lib/sandbox.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Extract the node factory**

`apps/d0lt-bot/src/lib/sandbox.node.ts`:

```ts
import { mkdir } from "node:fs/promises";
import { local } from "@flue/runtime/node";
import { workDir } from "./github.ts";

// Node-target sandbox: real host shell in a per-instance scratch dir. GITHUB_TOKEN
// (when set) is exposed to the shell so private clones authenticate via
// $GITHUB_TOKEN without the secret entering the model's context.
export async function createNodeSandbox({ id }: { id: string }) {
  const cwd = workDir(id);
  await mkdir(cwd, { recursive: true });
  return {
    sandbox: local({ env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN } }),
    cwd,
  };
}
```

- [ ] **Step 6: Rewire the root agent to use the helper (local branch only)**

Replace the body of `apps/d0lt-bot/src/agents/d0lt-bot.ts`'s factory. Remove the now-unused top-level `mkdir`, `local`, and `workDir` imports (they move into `sandbox.node.ts`):

```ts
import { createAgent, type AgentRouteHandler } from "@flue/runtime";
import instructions from "./d0lt-bot.md" with { type: "markdown" };
import reviewer from "../subagents/reviewer.ts";
import testRunner from "../subagents/test-runner.ts";

export const description =
  "GitHub assistant: routes PR reviews and test runs to specialist subagents.";

export const route: AgentRouteHandler = async (_c, next) => next();

// Root router. It owns the sandbox; its two subagents share it. The sandbox is
// chosen at runtime: local() for node dev, Cloudflare Sandbox when deployed.
export default createAgent(async ({ id }) => {
  // Sandbox is chosen via resolveSandboxKind(process.env) in Task 4; for now the
  // node factory is loaded directly. Dynamic import() establishes the pattern that
  // keeps each target's sandbox module out of the other target's bundle.
  const { createNodeSandbox } = await import("../lib/sandbox.node.ts");
  const { sandbox, cwd } = await createNodeSandbox({ id });

  return {
    model: "anthropic/claude-sonnet-4-6",
    instructions,
    sandbox,
    cwd,
    subagents: [reviewer, testRunner],
  };
});
```

Note: `resolveSandboxKind` (Task 1 Step 3) is intentionally not imported yet — it is wired into the branch in Task 4, so importing it here would be an unused import. The unit test from Step 1 is what exercises it at this stage.

- [ ] **Step 7: Verify typecheck + node dev still work**

Run: `cd apps/d0lt-bot && pnpm typecheck`
Expected: PASS (no errors).

Run: `cd apps/d0lt-bot && pnpm dev` in one shell, then in another `pnpm connect` and send `Review https://github.com/sindresorhus/is-odd/pull/1` (or any public PR). Expected: behaves exactly as before this task. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add apps/d0lt-bot/src/lib/sandbox.ts apps/d0lt-bot/src/lib/sandbox.node.ts apps/d0lt-bot/src/lib/sandbox.test.ts apps/d0lt-bot/src/agents/d0lt-bot.ts
git commit -m "refactor: extract sandbox selection behind a runtime helper"
```

---

### Task 2: Add Cloudflare dependencies and the Sandbox DO export

Install the Cloudflare-only deps and create the `cloudflare.ts` entrypoint that exports the container `Sandbox` Durable Object. No agent wiring yet; node build stays green.

**Files:**
- Modify: `apps/d0lt-bot/package.json`
- Create: `apps/d0lt-bot/src/cloudflare.ts`

**Interfaces:**
- Produces: a top-level Worker export `Sandbox` (the `@cloudflare/sandbox` Durable Object class), referenced by `wrangler.jsonc` in Task 3.

- [ ] **Step 1: Install dependencies**

Run (from repo root so pnpm resolves the workspace):

```bash
pnpm --filter d0lt-bot add @cloudflare/sandbox agents
pnpm --filter d0lt-bot add -D wrangler
```

Expected: `apps/d0lt-bot/package.json` gains `@cloudflare/sandbox` + `agents` in `dependencies` and `wrangler` in `devDependencies`; `pnpm-lock.yaml` updates.

- [ ] **Step 2: Record the installed sandbox version (for the Dockerfile pin)**

Run: `node -p "require('./apps/d0lt-bot/node_modules/@cloudflare/sandbox/package.json').version"`
Note the version (e.g. `0.9.2`) — Task 3's `Dockerfile` base image tag must match it.

- [ ] **Step 3: Create the Worker entrypoint exporting the Sandbox DO**

`apps/d0lt-bot/src/cloudflare.ts`:

```ts
// Worker-level Cloudflare exports. The Sandbox Durable Object backs the
// container sandbox used by the deployed agent. Its binding, migration, and
// container image are declared in wrangler.jsonc.
export { Sandbox } from "@cloudflare/sandbox";
```

- [ ] **Step 4: Verify node build still works**

Run: `cd apps/d0lt-bot && pnpm typecheck && pnpm build`
Expected: PASS. (`cloudflare.ts` is inert for the node target.)

- [ ] **Step 5: Commit**

```bash
git add apps/d0lt-bot/package.json apps/d0lt-bot/src/cloudflare.ts pnpm-lock.yaml
git commit -m "feat: add @cloudflare/sandbox deps and Sandbox DO export"
```

---

### Task 3: wrangler.jsonc, Dockerfile, and local-CF secrets

Author the Cloudflare deployment config. Discover the generated agent DO class name from a real build rather than guessing it.

**Files:**
- Create: `apps/d0lt-bot/wrangler.jsonc`
- Create: `apps/d0lt-bot/Dockerfile`
- Create: `apps/d0lt-bot/.dev.vars` (gitignored)
- Modify: `.gitignore`
- Modify: `apps/d0lt-bot/package.json` (scripts)

**Interfaces:**
- Consumes: `Sandbox` export from `apps/d0lt-bot/src/cloudflare.ts` (Task 2).
- Produces: `build:cf`, `dev:cf`, `deploy` scripts; a deployable `wrangler.jsonc` whose migration `v1` lists the real generated agent class.

- [ ] **Step 1: Discover the generated agent Durable Object class name**

Run: `cd apps/d0lt-bot && FLUE_SANDBOX=cloudflare npx flue build --target cloudflare`

This may warn/fail about missing `wrangler.jsonc`/migrations — that's expected at this step. Inspect the generated output for the agent class name:

Run: `grep -rEo "Flue[A-Za-z0-9]*Agent" apps/d0lt-bot/dist 2>/dev/null | sort -u`
Expected: one class name derived from `src/agents/d0lt-bot.ts` (likely `FlueD0ltBotAgent`). **Use the exact string printed**, not the guess, everywhere below.

- [ ] **Step 2: Write `wrangler.jsonc`**

`apps/d0lt-bot/wrangler.jsonc` (replace `FlueD0ltBotAgent` with the discovered name if different):

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

- [ ] **Step 3: Write the `Dockerfile`**

`apps/d0lt-bot/Dockerfile` (replace `0.9.2` with the version from Task 2 Step 2):

```dockerfile
# Pin to the installed @cloudflare/sandbox version — they are versioned together.
# Base image bundles node, git, curl and a /workspace working dir.
FROM docker.io/cloudflare/sandbox:0.9.2
```

- [ ] **Step 4: Create local Cloudflare dev secrets**

`apps/d0lt-bot/.dev.vars` (do not commit):

```
ANTHROPIC_API_KEY="sk-ant-..."
# GITHUB_TOKEN="ghp_..."   # optional, for private repos
```

Ensure it is ignored — append to `.gitignore` at repo root if not already covered:

```
.dev.vars
.dev.vars*
```

Run: `git check-ignore apps/d0lt-bot/.dev.vars`
Expected: prints the path (i.e. it is ignored).

- [ ] **Step 5: Add Cloudflare scripts**

In `apps/d0lt-bot/package.json` `scripts`, add:

```json
"dev:cf": "FLUE_SANDBOX=cloudflare flue dev --target cloudflare",
"build:cf": "FLUE_SANDBOX=cloudflare flue build --target cloudflare",
"deploy": "FLUE_SANDBOX=cloudflare flue build --target cloudflare && wrangler deploy --config dist/d0lt-bot/wrangler.json"
```

- [ ] **Step 6: Build and dry-run**

Run: `cd apps/d0lt-bot && pnpm build:cf`
Expected: build succeeds; writes `dist/d0lt-bot/wrangler.json`.

Run: `cd apps/d0lt-bot && npx wrangler deploy --dry-run --config dist/d0lt-bot/wrangler.json`
Expected: dry run succeeds — bindings (`Sandbox`, generated `FLUE_*`), migrations, and container all validate, and **no node-only module** (`@flue/runtime/node`) is reported in the Worker bundle. If it complains about `@flue/runtime/node` being pulled in, see Task 4 (the cloudflare branch + dynamic import keeps it out); re-run after Task 4.

- [ ] **Step 7: Commit**

```bash
git add apps/d0lt-bot/wrangler.jsonc apps/d0lt-bot/Dockerfile apps/d0lt-bot/package.json .gitignore
git commit -m "feat: add Cloudflare wrangler config, Dockerfile, and CF scripts"
```

---

### Task 4: Wire the Cloudflare sandbox branch (with GITHUB_TOKEN injection)

Add the cloudflare factory and switch the root agent on `resolveSandboxKind`. This is the task where the deployed sandbox actually becomes container-backed.

**Files:**
- Create: `apps/d0lt-bot/src/lib/sandbox.cloudflare.ts`
- Modify: `apps/d0lt-bot/src/agents/d0lt-bot.ts`

**Interfaces:**
- Consumes: `resolveSandboxKind` (Task 1); `Sandbox` binding `env.Sandbox` (Tasks 2–3).
- Produces: `createCloudflareSandbox(opts: { id: string; env: { Sandbox: unknown } }): Promise<{ sandbox: unknown; cwd: string }>`.

- [ ] **Step 1: Inspect the installed sandbox API for env injection**

Read the installed types to find how to pass `GITHUB_TOKEN` into the container:

Run: `grep -rEn "envVars|setEnvVars|env\\b" apps/d0lt-bot/node_modules/@cloudflare/sandbox/dist/*.d.ts | head -40`

Identify the supported mechanism — typically either `getSandbox(ns, id, { envVars })` or a `sandbox.setEnvVars({...})` method on the stub. Use whichever the installed types expose in Step 2. (Only `GITHUB_TOKEN` is injected; `ANTHROPIC_API_KEY` is used by the Worker/runtime, not the container.)

- [ ] **Step 2: Write the cloudflare factory**

`apps/d0lt-bot/src/lib/sandbox.cloudflare.ts` — use the env-injection call confirmed in Step 1. Template assuming the `getSandbox(..., { envVars })` form; switch to `stub.setEnvVars({...})` before returning if that is what the types expose:

```ts
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";

type SandboxEnv = { Sandbox: Parameters<typeof getSandbox>[0] };

// Cloudflare-target sandbox: a per-instance container with git/node/shell at
// /workspace. GITHUB_TOKEN (a Worker secret) is injected into the container env
// so private clones authenticate via $GITHUB_TOKEN, matching local behavior.
export async function createCloudflareSandbox({
  id,
  env,
}: {
  id: string;
  env: SandboxEnv & { GITHUB_TOKEN?: string };
}) {
  const stub = getSandbox(env.Sandbox, id, {
    envVars: env.GITHUB_TOKEN ? { GITHUB_TOKEN: env.GITHUB_TOKEN } : {},
  });
  return { sandbox: cloudflareSandbox(stub), cwd: "/workspace" };
}
```

- [ ] **Step 3: Switch the root agent on sandbox kind**

Modify `apps/d0lt-bot/src/agents/d0lt-bot.ts` factory to branch. The cloudflare branch reads bindings from the agent `env` argument:

```ts
export default createAgent(async ({ id, env }) => {
  const kind = resolveSandboxKind(process.env);

  const { sandbox, cwd } =
    kind === "cloudflare"
      ? await (await import("../lib/sandbox.cloudflare.ts")).createCloudflareSandbox({
          id,
          env: { Sandbox: (env as any).Sandbox, GITHUB_TOKEN: (env as any).GITHUB_TOKEN },
        })
      : await (await import("../lib/sandbox.node.ts")).createNodeSandbox({ id });

  return {
    model: "anthropic/claude-sonnet-4-6",
    instructions,
    sandbox,
    cwd,
    subagents: [reviewer, testRunner],
  };
});
```

(The `(env as any)` casts bridge the node/cloudflare `env` shape difference; tighten with a generic `Env` type if `createAgent<unknown, Env>` is adopted later.)

- [ ] **Step 4: Verify node dev is still unaffected**

Run: `cd apps/d0lt-bot && pnpm typecheck && pnpm dev` then `pnpm connect` in another shell; run a public PR review. Expected: identical to today (cloudflare branch not taken, its module never imported). Stop the server.

- [ ] **Step 5: Verify the Cloudflare build/dry-run is clean**

Run: `cd apps/d0lt-bot && pnpm build:cf && npx wrangler deploy --dry-run --config dist/d0lt-bot/wrangler.json`
Expected: both succeed; bundle validates with the container `Sandbox`; no `@flue/runtime/node` pulled into the Worker bundle.

> If the dry-run still reports `@flue/runtime/node` in the Worker bundle, the runtime env-var branch isn't being tree-shaken. Fix: replace the runtime `kind` check that guards the dynamic imports with a build-time condition the bundler can evaluate — e.g. gate each `import()` on `import.meta.env.MODE`/a Vite `define`, or alias `sandbox.node.ts` to an empty stub for the cloudflare build in the Vite config. Re-run until the node module is absent.

- [ ] **Step 6: Local Cloudflare smoke test**

Run: `cd apps/d0lt-bot && pnpm dev:cf`. In another shell, hit the agent over HTTP (the connect flow targets the node server; for CF use the HTTP/stream surface). Send a public-PR review request and confirm the container clones + reads the diff under `/workspace`. Expected: a structured review returns. Stop the server.

(First container start pulls/builds the image and is slow; subsequent runs are cached.)

- [ ] **Step 7: Commit**

```bash
git add apps/d0lt-bot/src/lib/sandbox.cloudflare.ts apps/d0lt-bot/src/agents/d0lt-bot.ts apps/d0lt-bot/package.json
git commit -m "feat: select Cloudflare container sandbox on the cloudflare target"
```

---

### Task 5: Docs + deploy runbook

Update project docs so the dual-target setup and deploy steps are discoverable. No code.

**Files:**
- Modify: `apps/d0lt-bot/.env.example`
- Modify: `README.md`

- [ ] **Step 1: Document the env var in `.env.example`**

Append to `apps/d0lt-bot/.env.example`:

```
# Sandbox selection. Unset/"local" uses the node local() shell sandbox (default).
# The Cloudflare build sets this to "cloudflare" (see package.json scripts).
# FLUE_SANDBOX="local"
```

- [ ] **Step 2: Add a "Deploying to Cloudflare" section to `README.md`**

Add after the "Usage" section:

````markdown
## Deploying to Cloudflare

The same agent runs on two targets. Locally it uses the node `local()` sandbox; deployed,
it runs shell work in a Cloudflare Sandbox **container** (`@cloudflare/sandbox`). The sandbox
is chosen by the `FLUE_SANDBOX` env var, set automatically by the `*:cf` scripts.

Local Cloudflare dev (reads `apps/d0lt-bot/.dev.vars`):

```bash
pnpm --filter d0lt-bot dev:cf
```

Deploy (requires `wrangler login`):

```bash
cd apps/d0lt-bot
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN        # optional, for private repos
pnpm deploy                              # build:cf + wrangler deploy
```

`wrangler.jsonc` and `Dockerfile` live in `apps/d0lt-bot/`. The `Dockerfile` base-image tag is
pinned to the installed `@cloudflare/sandbox` version. Durable Object migrations are append-only —
never reorder or rewrite deployed entries.
````

- [ ] **Step 3: Commit**

```bash
git add apps/d0lt-bot/.env.example README.md
git commit -m "docs: document Cloudflare dual-target deploy"
```

---

### Task 6: First real deploy (requires user's Cloudflare account)

Not automatable in this plan — needs the user's Cloudflare auth. Execute interactively.

- [ ] **Step 1: Authenticate** — user runs `wrangler login` (or sets `CLOUDFLARE_API_TOKEN`).
- [ ] **Step 2: Set secrets** — `cd apps/d0lt-bot && wrangler secret put ANTHROPIC_API_KEY` (and `GITHUB_TOKEN` if private repos are needed).
- [ ] **Step 3: Deploy** — `pnpm --filter d0lt-bot deploy`. Expected: Wrangler uploads the Worker + container image and prints a `*.workers.dev` URL.
- [ ] **Step 4: Smoke test the deployed Worker** — send a public-PR review request to the deployed URL's agent/stream endpoint; confirm a structured review returns and the container performed the clone. Watch logs with `wrangler tail`.

---

## Notes for the implementer

- **Why dynamic `import()`:** `@flue/runtime/node` (`local()`) is node-only and `@cloudflare/sandbox` is cloudflare-only. Static top-level imports of both would break whichever target doesn't support one of them. The branch + `import()` keeps each module out of the other target's bundle. Task 4 Step 5 verifies this; its fallback note covers the case where runtime branching isn't enough.
- **Subagents are untouched:** `reviewer` and `test_runner` share the router's sandbox and inherit its model, so wiring the sandbox once at the router covers them on both targets.
- **Class-name discovery (Task 3 Step 1) is mandatory** — the `v1` migration must list the exact generated class; a wrong name fails deploy and the migration can't be rewritten later.
