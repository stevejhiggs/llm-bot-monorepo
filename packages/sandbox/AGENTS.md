# AGENTS.md — @repo/sandbox

Agent-facing companion for `@repo/sandbox`. See [`README.md`](README.md) for the human overview.
This package is the runtime-selected, lazily-provisioned execution sandbox shared by the bots under
`bots/`. It depends on nothing else in `packages/` (the DAG leaf) and knows nothing about GitHub,
Slack, or any specific bot.

## What's in here

```
src/
├─ index.ts        # public root export: resolveSandboxKind, lazySandbox, workDir, SandboxKind
├─ sandbox.ts      # resolveSandboxKind() — pick node vs cloudflare (pure; unit-tested)
├─ lazy-sandbox.ts # lazySandbox() — defer setup to first use (pure; unit-tested)
├─ work-dir.ts     # workDir() — per-run scratch dir under the OS temp dir
├─ node.ts         # ./node export: createNodeSandbox() — host local() sandbox
├─ cloudflare.ts   # ./cloudflare export: createCloudflareSandbox() — CF Sandbox container DO
├─ sandbox.test.ts
└─ lazy-sandbox.test.ts
```

## Public API

- **`@repo/sandbox`** (target-agnostic — imports neither adapter):
  - `resolveSandboxKind(env: Record<string, string | undefined>, isWorkerd?: boolean): "local" | "cloudflare"`
  - `lazySandbox(inner: SandboxFactory, prepare: (env: SessionEnv) => Promise<void>): SandboxFactory`
  - `workDir(appName: string, runId: string): string` — scratch dir namespaced by `appName`
  - type `SandboxKind = "local" | "cloudflare"`
- **`@repo/sandbox/node`**: `createNodeSandbox({ id: string, appName: string, secrets?: Record<string, string | undefined> }): { sandbox: SandboxFactory, cwd: string }`
- **`@repo/sandbox/cloudflare`**: `createCloudflareSandbox({ id: string, sandboxBinding, secrets?: Record<string, string | undefined> }): { sandbox: SandboxFactory, cwd: string }` (`sandboxBinding` is the `Sandbox` Durable Object binding, typed `Parameters<typeof getSandbox>[0]`).

## Contracts (do not break these)

### 1. The bundle split is load-bearing

`./node` imports `@flue/runtime/node` (which shells out via `child_process`); `./cloudflare` imports
`@flue/runtime/cloudflare` + `@cloudflare/sandbox` (workerd-only). The two must never be reachable
from the same static graph:

- The root `index.ts` re-exports **only** the target-agnostic helpers — never an adapter. Keep it
  that way.
- Consumers reach the adapters via dynamic `import("@repo/sandbox/node" | ".../cloudflare")`. If
  either adapter is pulled into the static graph, the workerd build (`build:cf`) fails because the
  node sandbox's `child_process` import has no workerd implementation.

When you touch these modules, the gate is **both** builds: `pnpm build` and
`pnpm --filter d0lt-bot build:cf`. A typecheck pass is not enough — the split only fails at bundle
time.

### 2. Lazy provisioning — defer the expensive op to first use

`lazySandbox(inner, prepare)` wraps a `SandboxFactory` so the one-time expensive setup runs at most
once, **before** the first shell/file op, and not at all if no such op happens:

- It gates every async `SessionEnv` method (`exec`, `readFile`, `writeFile`, `stat`, `readdir`,
  `exists`, `mkdir`, `rm`, …) behind a memoized `prepare()`.
- It passes the **sync** members (`cwd`, `resolvePath`) straight through, so they answer without
  triggering `prepare` (and therefore without booting).
- `prepare` runs before the first delegated op, so anything it sets up (injecting secrets into the
  container) is in place before the first clone.

For this to hold, the adapters (`node.ts`, `cloudflare.ts`) must **construct a `SandboxFactory`
without doing eager I/O** — just method closures + a known `cwd`. Keep all real work inside the
`prepare` callback. The lazy behavior is unit-tested in `lazy-sandbox.test.ts`; the two adapters
import target-specific deps and are intentionally **not** unit-tested directly (mirrored by
`sandbox.test.ts` covering only the pure `resolveSandboxKind`).

### 3. Secrets are generic and injected before first use

The adapters take a generic `secrets: Record<string, string | undefined>` — they do **not** know
about `GITHUB_TOKEN` or any specific secret. The consuming bot decides what to inject. On node the
record becomes the shell `env`; on Cloudflare the defined entries are pushed via the container's
`setEnvVars` inside `prepare` (undefined values are dropped, and `setEnvVars` is skipped entirely
when none remain, so an empty secrets set never boots the container for nothing). Keep this package
secret-name-agnostic — if a bot needs a differently-named secret, it passes a different record; no
change here.

### 4. `resolveSandboxKind` must not fall back to node on workerd

`FLUE_SANDBOX=cloudflare|local` is an explicit override; unset infers from the runtime
(`navigator.userAgent === "Cloudflare-Workers"` → cloudflare, else local). The inference exists so a
deployed Worker that forgot to set `FLUE_SANDBOX` still picks the container — never the node
`local()` sandbox, whose `child_process` shell throws on workerd. `isWorkerd` is injectable for
tests.

### 5. Scratch dirs are namespaced per bot

`workDir(appName, runId)` returns `${tmpdir()}/<appName>/<runId>`, and `createNodeSandbox` requires
`appName` from the consuming bot. The namespace keeps two bots on the same host from sharing scratch
space — pass each bot's own name (e.g. `"d0lt-bot"`), never a shared default. Both segments are
sanitised to path/shell-safe characters with a fallback, so a stripped-empty value can't collapse
the path. (Cloudflare's `cwd` is the container's fixed `/workspace`, so `appName` is node-only.)

## Dependencies

`@flue/runtime` (catalog `flue`, pinned + patched at `1.0.0-beta.2` — must resolve to exactly that),
`@cloudflare/sandbox` (catalog `cf`, only used by `./cloudflare`). No dependency on `@repo/github` or
`@repo/slack`.

## Tests

```bash
pnpm --filter @repo/sandbox test       # vitest run — pure, offline
pnpm --filter @repo/sandbox typecheck  # tsc --noEmit
```

Tests are pure and offline: `lazy-sandbox.test.ts` drives `lazySandbox` with a fake `SessionEnv`
that records call order; `sandbox.test.ts` exercises `resolveSandboxKind` with an injected
`isWorkerd`. Do not add a test that boots a real container or shells out.
