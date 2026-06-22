# @repo/sandbox

Runtime-selected, lazily-provisioned execution sandbox for the Flue bots in this monorepo. It
answers the two questions a bot has about running shell and filesystem work:

- **Which sandbox?** `resolveSandboxKind()` chooses between a host-local sandbox (dev) and a
  Cloudflare Sandbox container (deployed), from the `FLUE_SANDBOX` env var or the runtime.
- **When do we pay for it?** `lazySandbox()` defers the one-time expensive setup (a container boot,
  or a scratch-dir `mkdir`) until the first shell/file operation — so a turn that never shells out
  (a plain chat reply) never provisions a sandbox.

It is **source-only**: no build step. Consumers import the `.ts` directly via the package's
`exports` (TypeScript resolves them through the workspace's `allowImportingTsExtensions` + `noEmit`).

## Public API

| Import | Exports |
| --- | --- |
| `@repo/sandbox` | `resolveSandboxKind(env, isWorkerd?)`, `lazySandbox(inner, prepare)`, `workDir(runId)`, type `SandboxKind` |
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

## Tests

```bash
pnpm --filter @repo/sandbox test       # vitest run
pnpm --filter @repo/sandbox typecheck  # tsc --noEmit
```

See [`AGENTS.md`](AGENTS.md) for the design contracts (the lazy-provisioning guarantee, the
bundle-split rule, the secrets-injection timing) and the source map. Monorepo-wide conventions
(pnpm, turbo, lint) live in the [root `AGENTS.md`](../../AGENTS.md).
