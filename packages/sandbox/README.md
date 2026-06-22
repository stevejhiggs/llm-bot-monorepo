# @repo/sandbox

Runtime-selected, lazily-provisioned execution sandbox for the Flue bots in this monorepo. It
answers the two questions a bot has about running shell and filesystem work:

- **Which sandbox?** `resolveSandboxKind()` chooses between a host-local sandbox (dev) and a
  Cloudflare Sandbox container (deployed), from the `FLUE_SANDBOX` env var or the runtime.
- **When do we pay for it?** `lazySandbox()` defers the wrapped sandbox env creation and the
  one-time expensive setup (a container boot, or a scratch-dir `mkdir`) until the first shell/file
  operation. It also answers Flue's startup workspace discovery probes in memory, so attaching the
  sandbox facade on a plain reply does not boot the full sandbox.

It is **source-only**: no build step. Consumers import the `.ts` directly via the package's
`exports` (TypeScript resolves them through the workspace's `allowImportingTsExtensions` + `noEmit`).

## Public API

| Import | Exports |
| --- | --- |
| `@repo/sandbox` | `resolveSandboxKind(env, isWorkerd?)`, `lazySandbox(innerOrThunk, prepare, { cwd, discoveryCwd? })`, `workDir(runId)`, type `SandboxKind` |
| `@repo/sandbox/node` | `createNodeSandbox({ id, appName, secrets? })` → `{ sandbox, cwd }` |
| `@repo/sandbox/cloudflare` | `createCloudflareSandbox({ id, sandboxBinding, secrets? })` → `{ sandbox, cwd }` |

The root entry (`.`) is **target-agnostic** — it pulls in neither adapter, so importing it is safe
on any runtime. The `./node` and `./cloudflare` entries each import their target's deps; reach them
only via a dynamic `import()` so each target's code stays out of the other's bundle.

## Usage (from a bot's agent initializer)

```ts
import { resolveSandboxKind } from "@repo/sandbox";

const kind = resolveSandboxKind(process.env);
const { sandbox, cwd } =
  kind === "cloudflare"
    ? (await import("@repo/sandbox/cloudflare")).createCloudflareSandbox({
        id,
        sandboxBinding: env.Sandbox,
        secrets: { GITHUB_TOKEN: env.GITHUB_TOKEN },
      })
    : (await import("@repo/sandbox/node")).createNodeSandbox({
        id,
        appName: "d0lt-bot",
        secrets: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
      });
```

`secrets` is a generic record injected into the sandbox environment before the first command runs;
the bot passes `{ GITHUB_TOKEN }` so private clones authenticate via `$GITHUB_TOKEN` without the
token entering the model's context.

## How the Cloudflare sandbox works

When deployed, the bot's shell work — `git clone`, detect the stack, install deps, run tests — can't
run on a Worker (no filesystem or shell), so `createCloudflareSandbox` runs it in a
[Cloudflare Sandbox](https://developers.cloudflare.com/sandbox) container (a `Sandbox` Durable
Object) instead of the host `local()` sandbox used in dev.

- **The image.** The bot's `Dockerfile` is just `FROM docker.io/cloudflare/sandbox:<version>`. That
  base image ships the control-plane server the SDK talks to plus `node`, `git`, `curl`, and a
  `/workspace` working dir — which is why `cwd` is `/workspace` on Cloudflare. Add `RUN` lines only
  if a test stack needs extra tooling. Docker is needed **only** at `pnpm deploy` time, when wrangler
  builds and pushes the image.
- **Private repos.** The `GITHUB_TOKEN` secret is injected into the container's environment (via the
  sandbox's `setEnvVars`), so clones authenticate as `$GITHUB_TOKEN` at run time without the token
  entering the model's context — the same contract as local dev.
- **Lazy provisioning.** Both targets wrap their sandbox in `lazySandbox()`, which defers the
  wrapped sandbox env creation and the one-time expensive setup — the container boot (`setEnvVars`)
  on Cloudflare, the scratch-dir `mkdir` on node — until the first shell/file op. `cwd` and
  `resolvePath` stay cheap because the adapter supplies a base cwd to the lazy wrapper. The wrapper
  also answers Flue's startup probes for `AGENTS.md`, `CLAUDE.md`, `.agents/skills`, and the cwd
  listing as absent/empty without booting; the first real workspace operation still provisions the
  full sandbox and injects secrets before it runs. The Cloudflare adapter passes the inner factory as
  a thunk, so `getSandbox()` is also deferred until that first real operation.
- **Not Cloudflare Shell.** This uses Cloudflare *Sandbox* (full Linux), not the `cloudflare-shell`
  adapter, which exposes only a code tool and can't run `git`/install/test commands.

## Tests

```bash
pnpm --filter @repo/sandbox test       # vitest run
pnpm --filter @repo/sandbox typecheck  # tsc --noEmit
```

See [`AGENTS.md`](AGENTS.md) for the design contracts (the lazy-provisioning guarantee, the
bundle-split rule, the secrets-injection timing) and the source map. Monorepo-wide conventions
(pnpm, turbo, lint) live in the [root `AGENTS.md`](../../AGENTS.md).
