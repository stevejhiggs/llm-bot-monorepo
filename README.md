# d0lt-bot poc (Flue)

A GitHub assistant built on the [Flue](https://flueframework.com/) agent framework. It is a
port of [`d0lt-bot`](../d0lt-bot) (which is built on [eve](https://www.npmjs.com/package/eve))
to Flue. Point it at a pull request or a repository in chat and it does the work in a sandbox:

- **Review a pull request** — clones the repo, reads the diff in context, and returns a
  structured code review: a summary, severity-tagged findings (file/line/suggestion), and an
  `approve` / `comment` / `request_changes` recommendation.
- **Run a repository's tests** — clones the code, detects the stack, installs dependencies,
  runs the tests, and reports a pass/fail result with the relevant output.

Note: like the original, this is not a full review system — it's a test of how these patterns
map onto Flue. Posting results back to GitHub is not wired up.

## How it works

A root agent routes each request to one of two specialist **subagents**, each delegated to via
Flue's built-in `task` capability — mirroring the eve original:

```
you ──chat (flue connect)──▶ d0lt-bot (router agent, owns the local() sandbox)
                                │ delegates via `task`
                ┌───────────────┴────────────────┐
                ▼                                 ▼
            reviewer                        test_runner
   fetch_repo → bash: clone + diff   fetch_repo → bash: clone → install → test
   → reads pr.diff + files           → detects stack, runs tests
   → structured review               → pass/fail + output
```

Both subagents share one `fetch_repo` tool, defined once in
[`apps/d0lt-bot/src/tools/fetch-repo.ts`](apps/d0lt-bot/src/tools/fetch-repo.ts). In Flue a tool's `execute` receives only
its validated arguments — no sandbox — so `fetch_repo` does not clone; it validates the GitHub
URL with the shared helpers in [`apps/d0lt-bot/src/lib/github.ts`](apps/d0lt-bot/src/lib/github.ts) and returns the exact,
injection-safe shell command. The subagent then runs that command with its bash tool inside the
router's `local()` sandbox, reads the diff / runs the tests, and returns its result for the
router to narrate.

Each chat instance gets its own scratch directory under the OS temp dir (created before the
sandbox initializes). Private repos are supported via a `GITHUB_TOKEN`: it is exposed to the
sandbox as an env var and referenced as `$GITHUB_TOKEN` at clone time, so the secret authenticates
the clone without ever entering the model's context or the host's git config.

## Usage

Start the server (`pnpm dev`), then chat with the agent via `pnpm connect`:

- `Review https://github.com/owner/repo/pull/123`
- `Run the tests for https://github.com/owner/repo`
- `Run the unit tests for https://github.com/owner/repo/tree/some-branch`

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

## Getting started

This is a [Turborepo](https://turborepo.com) monorepo; the bot lives in
[`apps/d0lt-bot`](apps/d0lt-bot). The root `pnpm` scripts fan out to the workspace via `turbo`.

Requirements: **Node 24** and a package manager (`pnpm` recommended).

```bash
pnpm install

# Set your Anthropic API key (used directly, not via a gateway).
cp apps/d0lt-bot/.env.example apps/d0lt-bot/.env
echo 'ANTHROPIC_API_KEY="sk-ant-..."' >> apps/d0lt-bot/.env
# Optional: a GitHub token with repo read access, for private repos.
# echo 'GITHUB_TOKEN="ghp_..."' >> apps/d0lt-bot/.env

# Start the server.
pnpm dev          # http://127.0.0.1:3583

# In another terminal, chat with the bot:
pnpm connect
```

Flue loads `apps/d0lt-bot/.env` for `flue dev` and `flue connect`.

## Development

Run from the repo root; `turbo` runs the matching task in `apps/d0lt-bot`.

```bash
pnpm typecheck      # turbo run typecheck (tsc --noEmit)
pnpm lint           # oxlint --fix && oxfmt (root-wide, one pass)
pnpm format:check   # oxfmt --check (no writes)
pnpm build          # turbo run build (flue build --target node)
```

## Configuration

| Variable            | Required | Purpose                                         |
| ------------------- | -------- | ----------------------------------------------- |
| `ANTHROPIC_API_KEY` | yes      | Calls Claude (Sonnet 4.6) directly.             |
| `GITHUB_TOKEN`      | no       | Repo read access for cloning **private** repos. |

Public repos work without a token. When `GITHUB_TOKEN` is set it is used for all clones.
Cloning runs in Flue's `local()` sandbox, which executes on the host machine — appropriate for
a local POC over trusted repos. To restore the eve original's stronger isolation, swap
`local()` for a remote sandbox integration (`flue add sandbox …`, e.g. Daytona or Vercel
Sandbox).

## Project layout

```
apps/d0lt-bot/             # the bot (Flue app)
├─ src/
│  ├─ agents/
│  │  ├─ d0lt-bot.ts        # root router; owns the local() sandbox; route → flue connect
│  │  └─ d0lt-bot.md        # routing instructions (delegate review vs test)
│  ├─ subagents/
│  │  ├─ reviewer.ts(.md)    # PR review subagent profile + instructions
│  │  └─ test-runner.ts(.md) # test runner subagent profile + instructions
│  ├─ tools/
│  │  └─ fetch-repo.ts      # shared: validates URL → safe clone command
│  └─ lib/
│     └─ github.ts          # URL parsing, ref validation, clone-script builder (shared)
├─ flue.config.ts
├─ tsconfig.json           # extends ../../tsconfig.base.json
└─ package.json
packages/                  # shared packages (none yet)
turbo.json                 # task pipeline (build / dev / typecheck)
tsconfig.base.json         # shared TS compiler options
docs/plans/                # design document
```