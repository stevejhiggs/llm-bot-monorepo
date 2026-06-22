# Extract sandbox/github/slack into source-only packages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the bot-agnostic sandbox, GitHub, and Slack functionality out of `bots/d0lt-bot` into three source-only workspace packages under `packages/`, with no behavior change.

**Architecture:** Three internal "Just-in-Time" packages (`@repo/sandbox`, `@repo/github`, `@repo/slack`) whose `package.json` `exports` point directly at `.ts` — no build step. Consumers (the bot via `flue build`/esbuild, the chat app via vite) transpile on the fly; `tsc` resolves them through the existing `allowImportingTsExtensions` + `noEmit` in `tsconfig.base.json`. The bot keeps everything Flue-discovered or markdown-importing (channels, agent, subagents, observability) and imports the rest from the packages. No inter-package dependencies: `bot → {sandbox, github, slack}`.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 24, pnpm 11 workspaces + catalogs, Turborepo, Vitest, Flue (`@flue/*` 1.0.0-beta), `@cloudflare/sandbox`, valibot.

## Global Constraints

- **Package manager is pnpm 11** — never use npm/yarn. Run from the repo root unless noted.
- **Source-only packages** — no `build` script, no `dist`. `exports` map straight to `./src/*.ts`.
- **Scope is `@repo/*`** — `@repo/sandbox`, `@repo/github`, `@repo/slack`.
- **Sibling/relative imports use explicit `.ts` extensions**; package imports use the bare specifier (`@repo/github`).
- **Tool parameter schemas use valibot** (`v.object({...})`) — unchanged, just moved.
- **`@flue/runtime` is pinned to `1.0.0-beta.2`** and patched via `patchedDependencies` in `pnpm-workspace.yaml`. Every reference (catalog or direct) MUST resolve to exactly `1.0.0-beta.2` or the patch stops applying.
- **Exact dependency versions** (copy verbatim into catalogs): `@flue/runtime` `1.0.0-beta.2`, `@flue/github` `1.0.0-beta.1`, `@flue/slack` `1.0.0-beta.1`, `@cloudflare/sandbox` `^0.12.1`, `@octokit/rest` `^22.0.1`, `@slack/web-api` `8.0.0-rc.1`, `valibot` `^1.4.1`, `@types/node` `24.13.2`, `typescript` `7.0.1-rc`, `vitest` `^4.1.9`.
- **Target-bundle split must survive:** `@flue/runtime/node` only reachable via `@repo/sandbox/node`; `@flue/runtime/cloudflare` + `@cloudflare/sandbox` only via `@repo/sandbox/cloudflare`; both reached by **dynamic** `import()` from the agent. `pnpm --filter d0lt-bot build:cf` is the gate (workerd rejects node built-ins at build time).
- **Commit style:** Conventional Commits (`feat:`, `refactor:`, `chore:`, `docs:`). End commit messages with the `Co-Authored-By` trailer this repo uses.
- **oxfmt** may reformat files you touch; keep formatting scoped to changed files only.

---

## File Structure

New packages (each: `package.json` + `tsconfig.json` + `src/`):

```
packages/sandbox/src/
  index.ts          re-exports resolveSandboxKind, lazySandbox, workDir + types
  sandbox.ts        resolveSandboxKind, SandboxKind   (moved verbatim)
  lazy-sandbox.ts   lazySandbox                        (moved verbatim)
  work-dir.ts       workDir                            (moved from bot lib/github.ts)
  node.ts           createNodeSandbox                  (moved from sandbox.node.ts, secrets-parameterized)
  cloudflare.ts     createCloudflareSandbox            (moved from sandbox.cloudflare.ts, secrets-parameterized)
  sandbox.test.ts   (moved verbatim)
  lazy-sandbox.test.ts (moved verbatim)

packages/github/src/
  index.ts          re-exports all github helpers, webhook logic, fetchRepoTool
  github.ts         URL/clone helpers                  (moved, minus workDir)
  github-webhook.ts planDelivery/triggerPhrase/commentOnIssue/client (moved verbatim)
  fetch-repo.ts     fetch_repo tool                    (moved, import path fixed)
  github-webhook.test.ts (moved verbatim)

packages/slack/src/
  index.ts          re-exports all slack-events + slack-format symbols
  slack-events.ts   planSlackEvent/replyInThread/postProgressInThread/workerdSafeFetch/client (moved verbatim)
  slack-format.ts   toMrkdwn                           (moved verbatim)
  slack-events.test.ts (moved verbatim)
  slack-format.test.ts (moved verbatim)
```

Bot after extraction — `bots/d0lt-bot/src/`:
```
agents/      d0lt-bot.ts (+ .md)          imports updated to @repo/*
channels/    github.ts, slack.ts          imports updated to @repo/*
subagents/   reviewer.ts, test-runner.ts (+ .md)  import fetchRepoTool from @repo/github
lib/         channel-flags.ts (+ .test), observe.ts (+ .test)   ← all sandbox/github/slack lib files removed
app.ts, cloudflare.ts                      unchanged
(tools/ directory removed — fetch-repo.ts moved out)
```

---

## Task 1: Extract `@repo/sandbox`

**Files:**
- Create: `packages/sandbox/package.json`, `packages/sandbox/tsconfig.json`, `packages/sandbox/src/index.ts`, `packages/sandbox/src/work-dir.ts`
- Move: `bots/d0lt-bot/src/lib/sandbox.ts` → `packages/sandbox/src/sandbox.ts`; `lib/lazy-sandbox.ts` → `packages/sandbox/src/lazy-sandbox.ts`; `lib/sandbox.node.ts` → `packages/sandbox/src/node.ts`; `lib/sandbox.cloudflare.ts` → `packages/sandbox/src/cloudflare.ts`; `lib/sandbox.test.ts` → `packages/sandbox/src/sandbox.test.ts`; `lib/lazy-sandbox.test.ts` → `packages/sandbox/src/lazy-sandbox.test.ts`
- Modify: `pnpm-workspace.yaml` (add catalogs); `bots/d0lt-bot/src/lib/github.ts` (remove `workDir` + now-unused `tmpdir` import); `bots/d0lt-bot/src/agents/d0lt-bot.ts` (sandbox imports); `bots/d0lt-bot/package.json` (add `@repo/sandbox` dep)
- Test: `packages/sandbox/src/sandbox.test.ts`, `packages/sandbox/src/lazy-sandbox.test.ts` (moved, unchanged)

**Interfaces:**
- Produces:
  - `@repo/sandbox` → `resolveSandboxKind(env: Record<string,string|undefined>, isWorkerd?: boolean): "local"|"cloudflare"`, `lazySandbox(inner, prepare)`, `workDir(runId: string): string`, type `SandboxKind`
  - `@repo/sandbox/node` → `createNodeSandbox({ id: string, secrets?: Record<string,string|undefined> }): { sandbox, cwd }`
  - `@repo/sandbox/cloudflare` → `createCloudflareSandbox({ id: string, sandboxBinding, secrets?: Record<string,string|undefined> }): { sandbox, cwd }`

- [ ] **Step 1: Add catalogs to `pnpm-workspace.yaml`**

Under the existing `catalogs:` block (which has `tooling` and `testing`), add three more catalogs. Final `catalogs:` section:

```yaml
catalogs:
  tooling:
    "@types/node": 24.13.2
    typescript: 7.0.1-rc

  testing:
    vitest: ^4.1.9

  flue:
    "@flue/runtime": 1.0.0-beta.2
    "@flue/github": 1.0.0-beta.1
    "@flue/slack": 1.0.0-beta.1

  cf:
    "@cloudflare/sandbox": ^0.12.1

  external:
    valibot: ^1.4.1
    "@octokit/rest": ^22.0.1
    "@slack/web-api": 8.0.0-rc.1
```

- [ ] **Step 2: Create `packages/sandbox/package.json`**

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

- [ ] **Step 3: Create `packages/sandbox/tsconfig.json`**

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Move the four source modules and two test files**

```bash
cd /Users/steve/code/personal/d0lt-bot-flue
git mv bots/d0lt-bot/src/lib/sandbox.ts          packages/sandbox/src/sandbox.ts
git mv bots/d0lt-bot/src/lib/lazy-sandbox.ts     packages/sandbox/src/lazy-sandbox.ts
git mv bots/d0lt-bot/src/lib/sandbox.node.ts     packages/sandbox/src/node.ts
git mv bots/d0lt-bot/src/lib/sandbox.cloudflare.ts packages/sandbox/src/cloudflare.ts
git mv bots/d0lt-bot/src/lib/sandbox.test.ts      packages/sandbox/src/sandbox.test.ts
git mv bots/d0lt-bot/src/lib/lazy-sandbox.test.ts packages/sandbox/src/lazy-sandbox.test.ts
```

`sandbox.test.ts` (imports `./sandbox.ts`) and `lazy-sandbox.test.ts` (imports `./lazy-sandbox.ts`) keep working unchanged — those files moved alongside them.

- [ ] **Step 5: Create `packages/sandbox/src/work-dir.ts`** (moved out of the bot's `github.ts`)

```ts
import { tmpdir } from "node:os";

/**
 * An isolated per-run working directory for a clone. Flue's `local()` sandbox
 * runs on the host, so each run gets its own scratch dir keyed by the run id
 * (an alphanumeric ULID) under the OS temp dir, never the project dir.
 */
export function workDir(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "");
  return `${tmpdir()}/d0lt-bot/${safe || "run"}`;
}
```

- [ ] **Step 6: Update `packages/sandbox/src/node.ts`** — fix the `workDir` import and parameterize secrets

Replace the file's top imports and `createNodeSandbox` signature so it reads:

```ts
import { mkdir } from "node:fs/promises";
import { local } from "@flue/runtime/node";
import { lazySandbox } from "./lazy-sandbox.ts";
import { workDir } from "./work-dir.ts";

// Node-target sandbox: real host shell in a per-instance scratch dir. `secrets`
// (when provided) is exposed to the shell so e.g. private clones authenticate via
// $GITHUB_TOKEN without the secret entering the model's context. The scratch-dir
// mkdir is deferred (via lazySandbox) to the first shell/file op, so a turn that
// never touches the sandbox doesn't create one.
export function createNodeSandbox({
  id,
  secrets,
}: {
  id: string;
  secrets?: Record<string, string | undefined>;
}) {
  const cwd = workDir(id);
  const sandbox = lazySandbox(local({ env: secrets ?? {} }), async () => {
    await mkdir(cwd, { recursive: true });
  });
  return { sandbox, cwd };
}
```

- [ ] **Step 7: Update `packages/sandbox/src/cloudflare.ts`** — parameterize secrets and rename the binding param

```ts
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";
import { lazySandbox } from "./lazy-sandbox.ts";

type SandboxBinding = Parameters<typeof getSandbox>[0];

// Cloudflare-target sandbox: a per-instance container with git/node/shell at
// /workspace. `secrets` (Worker secrets) are injected into the container env so
// e.g. private clones authenticate via $GITHUB_TOKEN, matching local behavior.
export function createCloudflareSandbox({
  id,
  sandboxBinding,
  secrets,
}: {
  id: string;
  sandboxBinding: SandboxBinding;
  secrets?: Record<string, string | undefined>;
}) {
  const stub = getSandbox(sandboxBinding, id);
  // setEnvVars() boots the container, so defer it (via lazySandbox) to the first
  // shell/file op: a turn that never touches the sandbox doesn't spin one up. The
  // secrets are injected before that first op, so $GITHUB_TOKEN clones still
  // authenticate. (getSandbox() SandboxOptions does not accept envVars; injection
  // is via the stub method after the stub is created.)
  const sandbox = lazySandbox(cloudflareSandbox(stub), async () => {
    const defined = Object.fromEntries(
      Object.entries(secrets ?? {}).filter(([, value]) => value != null),
    ) as Record<string, string>;
    if (Object.keys(defined).length > 0) await stub.setEnvVars(defined);
  });
  return { sandbox, cwd: "/workspace" };
}
```

- [ ] **Step 8: Create `packages/sandbox/src/index.ts`**

```ts
export { resolveSandboxKind, type SandboxKind } from "./sandbox.ts";
export { lazySandbox } from "./lazy-sandbox.ts";
export { workDir } from "./work-dir.ts";
```

- [ ] **Step 9: Remove `workDir` (and the now-unused `tmpdir` import) from `bots/d0lt-bot/src/lib/github.ts`**

Delete the `import { tmpdir } from "node:os";` line and the entire `workDir` function (the `/** An isolated per-run working directory ... */` block). Update the file header comment that mentions workDir if present. Leave every other helper (`parseGitHubTarget`, `assertSafeRef`, `buildCloneScript`, etc.) untouched. Verify nothing else in the file references `workDir` or `tmpdir`:

```bash
grep -n "workDir\|tmpdir" bots/d0lt-bot/src/lib/github.ts
```
Expected: no output.

- [ ] **Step 10: Add the workspace dependency to the bot**

In `bots/d0lt-bot/package.json`, add to `dependencies` (alphabetical with the existing entries):

```jsonc
    "@repo/sandbox": "workspace:*",
```

- [ ] **Step 11: Update the agent's sandbox imports** — `bots/d0lt-bot/src/agents/d0lt-bot.ts`

Change the static import:
```ts
import { resolveSandboxKind } from "@repo/sandbox";
```
(was `from "../lib/sandbox.ts"`)

Change the two dynamic imports inside `createAgent` to use the package subpaths and the new param shape:
```ts
  const { sandbox, cwd } =
    kind === "cloudflare"
      ? (await import("@repo/sandbox/cloudflare")).createCloudflareSandbox({
          id,
          sandboxBinding: (env as any).Sandbox,
          secrets: { GITHUB_TOKEN: (env as any).GITHUB_TOKEN },
        })
      : (await import("@repo/sandbox/node")).createNodeSandbox({
          id,
          secrets: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
        });
```

- [ ] **Step 12: Install and run the sandbox package tests**

```bash
cd /Users/steve/code/personal/d0lt-bot-flue
pnpm install
pnpm --filter @repo/sandbox test
```
Expected: `pnpm install` relinks the new package; tests PASS (the same `sandbox.test.ts` + `lazy-sandbox.test.ts` assertions, now green from their new home).

- [ ] **Step 13: Typecheck the whole workspace**

```bash
pnpm typecheck
```
Expected: PASS. The bot still imports github/slack from its own `lib/` (those files still exist), and now imports sandbox from `@repo/sandbox`.

- [ ] **Step 14: Build both targets (the sandbox split gate)**

```bash
pnpm build
pnpm --filter d0lt-bot build:cf
```
Expected: both succeed. `build:cf` proves `@flue/runtime/node` did not leak into the workerd bundle through the new package subpaths.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "refactor(sandbox): extract @repo/sandbox source-only package

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extract `@repo/github`

**Files:**
- Create: `packages/github/package.json`, `packages/github/tsconfig.json`, `packages/github/src/index.ts`
- Move: `bots/d0lt-bot/src/lib/github.ts` → `packages/github/src/github.ts`; `lib/github-webhook.ts` → `packages/github/src/github-webhook.ts`; `lib/github-webhook.test.ts` → `packages/github/src/github-webhook.test.ts`; `bots/d0lt-bot/src/tools/fetch-repo.ts` → `packages/github/src/fetch-repo.ts`
- Modify: `packages/github/src/fetch-repo.ts` (import path); `bots/d0lt-bot/src/channels/github.ts` (imports); `bots/d0lt-bot/src/agents/d0lt-bot.ts` (commentOnIssue import); `bots/d0lt-bot/src/subagents/reviewer.ts` + `test-runner.ts` (fetchRepoTool import); `bots/d0lt-bot/package.json` (add `@repo/github` dep); remove empty `bots/d0lt-bot/src/tools/` dir
- Test: `packages/github/src/github-webhook.test.ts` (moved, unchanged — imports `./github-webhook.ts` and `@octokit/rest`)

**Interfaces:**
- Consumes: nothing from Task 1 (independent package).
- Produces: `@repo/github` →
  - `parseGitHubTarget(url, refOverride?)`, `parsePrTarget(url)`, `assertSafeRef(ref)`, `looksPrivate(err)`, `buildCloneScript(target)`, type `GitHubTarget`
  - `planDelivery(delivery, phrase)`, `triggerPhrase()`, `commentOnIssue(ref, octokit?)`, `client` (Octokit), types `DispatchPlan`/`DispatchInput`/`DispatchTarget`
  - `fetchRepoTool` (the `fetch_repo` Flue tool, default-exported by `fetch-repo.ts`, re-exported here as a named binding)

- [ ] **Step 1: Create `packages/github/package.json`**

```jsonc
{
  "name": "@repo/github",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" }
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@flue/github": "catalog:flue",
    "@flue/runtime": "catalog:flue",
    "@octokit/rest": "catalog:external",
    "valibot": "catalog:external"
  },
  "devDependencies": {
    "@types/node": "catalog:tooling",
    "typescript": "catalog:tooling",
    "vitest": "catalog:testing"
  },
  "engines": { "node": "24.x" }
}
```

- [ ] **Step 2: Create `packages/github/tsconfig.json`**

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Move the three source modules and the test**

```bash
cd /Users/steve/code/personal/d0lt-bot-flue
git mv bots/d0lt-bot/src/lib/github.ts             packages/github/src/github.ts
git mv bots/d0lt-bot/src/lib/github-webhook.ts      packages/github/src/github-webhook.ts
git mv bots/d0lt-bot/src/lib/github-webhook.test.ts packages/github/src/github-webhook.test.ts
git mv bots/d0lt-bot/src/tools/fetch-repo.ts        packages/github/src/fetch-repo.ts
rmdir bots/d0lt-bot/src/tools
```

`github-webhook.ts` (imports `@flue/github`, `@octokit/rest`, `valibot`) and `github-webhook.test.ts` (imports `./github-webhook.ts`, `@octokit/rest`) keep working unchanged.

- [ ] **Step 4: Fix the import in `packages/github/src/fetch-repo.ts`**

Change its one relative import from the old `lib` path to the sibling module:
```ts
import { buildCloneScript, parseGitHubTarget } from "./github.ts";
```
(was `from "../lib/github.ts"`). Everything else in the file (the `defineTool` default export) is unchanged.

- [ ] **Step 5: Create `packages/github/src/index.ts`**

```ts
export {
  assertSafeRef,
  buildCloneScript,
  type GitHubTarget,
  looksPrivate,
  parseGitHubTarget,
  parsePrTarget,
} from "./github.ts";
export {
  client,
  commentOnIssue,
  type DispatchInput,
  type DispatchPlan,
  type DispatchTarget,
  planDelivery,
  triggerPhrase,
} from "./github-webhook.ts";
export { default as fetchRepoTool } from "./fetch-repo.ts";
```

- [ ] **Step 6: Add the workspace dependency to the bot**

In `bots/d0lt-bot/package.json` `dependencies`, add:
```jsonc
    "@repo/github": "workspace:*",
```

- [ ] **Step 7: Update `bots/d0lt-bot/src/channels/github.ts`**

Replace the two `../lib/github-webhook.ts` references with the package:
```ts
import { planDelivery, triggerPhrase } from "@repo/github";
```
(was `from "../lib/github-webhook.ts"`), and the re-export at the bottom:
```ts
export { commentOnIssue } from "@repo/github";
```
(was `from "../lib/github-webhook.ts"`). Leave the `channelEnabled` import and all handler logic unchanged.

- [ ] **Step 8: Update `bots/d0lt-bot/src/agents/d0lt-bot.ts`**

Change the comment tool import:
```ts
import { commentOnIssue } from "@repo/github";
```
(was `from "../lib/github-webhook.ts"`).

- [ ] **Step 9: Update both subagents to import the tool from the package**

In `bots/d0lt-bot/src/subagents/reviewer.ts` and `bots/d0lt-bot/src/subagents/test-runner.ts`, replace:
```ts
import fetchRepo from "../tools/fetch-repo.ts";
```
with:
```ts
import { fetchRepoTool } from "@repo/github";
```
and update the `tools` array in each file from `[fetchRepo, ...extraTools]` to `[fetchRepoTool, ...extraTools]`.

- [ ] **Step 10: Install and run the github package tests**

```bash
cd /Users/steve/code/personal/d0lt-bot-flue
pnpm install
pnpm --filter @repo/github test
```
Expected: install relinks `@repo/github`; `github-webhook.test.ts` PASSES.

- [ ] **Step 11: Typecheck the workspace**

```bash
pnpm typecheck
```
Expected: PASS. The bot now imports github from `@repo/github`; slack still from local `lib/`.

- [ ] **Step 12: Build both targets (channel discovery + workerd gate)**

```bash
pnpm build
pnpm --filter d0lt-bot build:cf
```
Expected: both succeed. `pnpm build` proves Flue still discovers `channels/github.ts` with its new package imports.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "refactor(github): extract @repo/github source-only package

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Extract `@repo/slack`

**Files:**
- Create: `packages/slack/package.json`, `packages/slack/tsconfig.json`, `packages/slack/src/index.ts`
- Move: `bots/d0lt-bot/src/lib/slack-events.ts` → `packages/slack/src/slack-events.ts`; `lib/slack-format.ts` → `packages/slack/src/slack-format.ts`; `lib/slack-events.test.ts` → `packages/slack/src/slack-events.test.ts`; `lib/slack-format.test.ts` → `packages/slack/src/slack-format.test.ts`
- Modify: `bots/d0lt-bot/src/channels/slack.ts` (imports); `bots/d0lt-bot/src/agents/d0lt-bot.ts` (replyInThread/postProgressInThread import); `bots/d0lt-bot/package.json` (add `@repo/slack` dep)
- Test: `packages/slack/src/slack-events.test.ts`, `packages/slack/src/slack-format.test.ts` (moved, unchanged)

**Interfaces:**
- Consumes: nothing from earlier tasks (independent package).
- Produces: `@repo/slack` → `planSlackEvent(payload)`, `replyInThread(ref, slack?)`, `postProgressInThread(ref, slack?)`, `workerdSafeFetch(baseFetch?)`, `client` (WebClient), `toMrkdwn(markdown)`, types `SlackDispatchPlan`/`SlackDispatchInput`

- [ ] **Step 1: Create `packages/slack/package.json`**

```jsonc
{
  "name": "@repo/slack",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" }
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@flue/runtime": "catalog:flue",
    "@flue/slack": "catalog:flue",
    "@slack/web-api": "catalog:external",
    "valibot": "catalog:external"
  },
  "devDependencies": {
    "@types/node": "catalog:tooling",
    "typescript": "catalog:tooling",
    "vitest": "catalog:testing"
  },
  "engines": { "node": "24.x" }
}
```

- [ ] **Step 2: Create `packages/slack/tsconfig.json`**

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Move the two source modules and two test files**

```bash
cd /Users/steve/code/personal/d0lt-bot-flue
git mv bots/d0lt-bot/src/lib/slack-events.ts      packages/slack/src/slack-events.ts
git mv bots/d0lt-bot/src/lib/slack-format.ts       packages/slack/src/slack-format.ts
git mv bots/d0lt-bot/src/lib/slack-events.test.ts  packages/slack/src/slack-events.test.ts
git mv bots/d0lt-bot/src/lib/slack-format.test.ts  packages/slack/src/slack-format.test.ts
```

`slack-events.ts` imports `./slack-format.ts` (sibling, moved alongside) and both test files import their siblings — all unchanged.

- [ ] **Step 4: Create `packages/slack/src/index.ts`**

```ts
export {
  client,
  planSlackEvent,
  postProgressInThread,
  replyInThread,
  type SlackDispatchInput,
  type SlackDispatchPlan,
  workerdSafeFetch,
} from "./slack-events.ts";
export { toMrkdwn } from "./slack-format.ts";
```

- [ ] **Step 5: Add the workspace dependency to the bot**

In `bots/d0lt-bot/package.json` `dependencies`, add:
```jsonc
    "@repo/slack": "workspace:*",
```

- [ ] **Step 6: Update `bots/d0lt-bot/src/channels/slack.ts`**

Replace:
```ts
import { planSlackEvent } from "@repo/slack";
```
(was `from "../lib/slack-events.ts"`), and the bottom re-export:
```ts
export { replyInThread } from "@repo/slack";
```
(was `from "../lib/slack-events.ts"`). Leave the rest unchanged.

- [ ] **Step 7: Update `bots/d0lt-bot/src/agents/d0lt-bot.ts`**

Replace:
```ts
import { postProgressInThread, replyInThread } from "@repo/slack";
```
(was `from "../lib/slack-events.ts"`).

- [ ] **Step 8: Install and run the slack package tests**

```bash
cd /Users/steve/code/personal/d0lt-bot-flue
pnpm install
pnpm --filter @repo/slack test
```
Expected: install relinks `@repo/slack`; `slack-events.test.ts` + `slack-format.test.ts` PASS.

- [ ] **Step 9: Confirm the bot's `lib/` now holds only channel-flags + observe**

```bash
ls bots/d0lt-bot/src/lib
```
Expected: exactly `channel-flags.ts`, `channel-flags.test.ts`, `observe.ts`, `observe.test.ts` (no sandbox/github/slack files remain).

- [ ] **Step 10: Typecheck + build both targets**

```bash
pnpm typecheck
pnpm build
pnpm --filter d0lt-bot build:cf
```
Expected: all pass. `pnpm build` proves Flue still discovers `channels/slack.ts` with its package import.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(slack): extract @repo/slack source-only package

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire up turbo/test, prune bot deps, update docs

**Files:**
- Modify: `turbo.json` (add `test` task); root `package.json` (root `test` script); `bots/d0lt-bot/package.json` (drop now-transitive deps, optionally catalog the shared ones); `AGENTS.md`; `README.md`
- Test: the full workspace gate (all package + bot tests via turbo)

**Interfaces:**
- Consumes: the three `@repo/*` packages from Tasks 1–3.
- Produces: `pnpm test` fans out across every package + the bot via `turbo run test`.

- [ ] **Step 1: Add a `test` task to `turbo.json`**

Add `test` alongside the existing tasks (it needs no build dependency — the packages are source-only and tests are offline):

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "tui",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".flue/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "test": {}
  }
}
```

- [ ] **Step 2: Point the root `test` script at turbo** — root `package.json`

Change:
```jsonc
    "test": "turbo run test",
```
(was `"pnpm --filter d0lt-bot test"`).

- [ ] **Step 3: Prune the bot's now-transitive direct dependencies**

In `bots/d0lt-bot/package.json`, the bot no longer imports `@octokit/rest`, `@slack/web-api`, or `valibot` directly (they live only inside the packages now). Remove those three lines from `dependencies`. Optionally switch the remaining shared framework deps to catalog refs for drift safety. The resulting `dependencies` block:

```jsonc
  "dependencies": {
    "@cloudflare/sandbox": "catalog:cf",
    "@flue/github": "catalog:flue",
    "@flue/runtime": "catalog:flue",
    "@flue/slack": "catalog:flue",
    "@repo/github": "workspace:*",
    "@repo/sandbox": "workspace:*",
    "@repo/slack": "workspace:*",
    "agents": "^0.16.2",
    "hono": "^4.12.22"
  },
```

(`agents` and `hono` are bot-only — leave them as direct version pins. `@cloudflare/sandbox` stays because `cloudflare.ts` re-exports its `Sandbox` DO class.)

- [ ] **Step 4: Re-install so the lockfile reflects the pruned/catalog deps**

```bash
cd /Users/steve/code/personal/d0lt-bot-flue
pnpm install
```
Expected: succeeds; lockfile updates. Confirm `@flue/runtime` still resolves to the patched `1.0.0-beta.2`:
```bash
pnpm why @flue/runtime | grep -m1 "1.0.0-beta.2"
```
Expected: a line showing `1.0.0-beta.2` (the patch still applies).

- [ ] **Step 5: Update `AGENTS.md`**

Make these targeted edits (do not rewrite the file):
- In **Project overview**, after the monorepo bullet, note that shared functionality lives in source-only `packages/` (`@repo/sandbox`, `@repo/github`, `@repo/slack`) consumed by bots via `workspace:*`, exposing `.ts` directly with no build step.
- In **Architecture → Runtime-selected sandbox**, update the module paths: `resolveSandboxKind` and `lazySandbox` now live in `@repo/sandbox`; the node/cloudflare adapters in `@repo/sandbox/node` and `@repo/sandbox/cloudflare`; the factories take a `secrets` record (the bot passes `{ GITHUB_TOKEN }`) rather than reading the token by name.
- In **Architecture → Channel pattern**, update the "testable logic" path: it now lives in `@repo/github` / `@repo/slack` (was `src/lib/<name>-(webhook|events).ts`); the thin discovered channel stays in `bots/d0lt-bot/src/channels/<name>.ts` and imports the plan/tool functions from the package.
- In **Architecture**, note `fetch_repo` is now `fetchRepoTool` from `@repo/github` (was `src/tools/fetch-repo.ts`).
- In **Testing instructions**, note tests are colocated in each package and the bot; `pnpm test` runs `turbo run test` across all of them; a single package's suite runs via `pnpm --filter @repo/<name> test`.

- [ ] **Step 6: Update `README.md`**

In the monorepo-overview section, add `packages/` to the layout description: source-only shared packages (`@repo/sandbox`, `@repo/github`, `@repo/slack`) that bots consume via `workspace:*` with no build step. Keep edits scoped to the overview; do not restructure the doc.

- [ ] **Step 7: Run the full verification gate**

```bash
cd /Users/steve/code/personal/d0lt-bot-flue
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm --filter d0lt-bot build:cf
```
Expected: all green. `pnpm test` now shows the three `@repo/*` suites plus the bot's `channel-flags`/`observe` suites via turbo. `pnpm lint` (`oxlint --fix && oxfmt`) reformats only touched files.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: wire turbo test, prune bot deps, document packages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (whole feature)

Run from the repo root; all must pass:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm --filter d0lt-bot build:cf
```

Manual confirmation checklist:
- `packages/{sandbox,github,slack}/` each exist with `package.json` (source-only `exports`, no `build` script), `tsconfig.json`, `src/`, and their moved `*.test.ts`.
- `bots/d0lt-bot/src/lib/` contains only `channel-flags.*` and `observe.*`; `bots/d0lt-bot/src/tools/` is gone.
- `bots/d0lt-bot/src/agents/d0lt-bot.ts` imports `@repo/sandbox`, `@repo/github`, `@repo/slack` (with dynamic `import("@repo/sandbox/{node,cloudflare}")`).
- `git grep -n "\.\./lib/sandbox\|\.\./lib/github\|\.\./lib/slack\|\.\./tools/fetch-repo" bots/` returns nothing.
- `pnpm why @flue/runtime` shows `1.0.0-beta.2` (patch intact).
