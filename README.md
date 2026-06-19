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
[`src/tools/fetch-repo.ts`](src/tools/fetch-repo.ts). In Flue a tool's `execute` receives only
its validated arguments — no sandbox — so `fetch_repo` does not clone; it validates the GitHub
URL with the shared helpers in [`src/lib/github.ts`](src/lib/github.ts) and returns the exact,
injection-safe shell command. The subagent then runs that command with its bash tool inside the
router's `local()` sandbox, reads the diff / runs the tests, and returns its result for the
router to narrate.

Each chat instance gets its own scratch directory under the OS temp dir (created before the
sandbox initializes). Private repos are supported via a `GITHUB_TOKEN`: it is exposed to the
sandbox as an env var and referenced as `$GITHUB_TOKEN` at clone time, so the secret authenticates
the clone without ever entering the model's context or the host's git config.

## Usage

Start the server, then chat with the agent over `flue connect`:

- `Review https://github.com/owner/repo/pull/123`
- `Run the tests for https://github.com/owner/repo`
- `Run the unit tests for https://github.com/owner/repo/tree/some-branch`

## Getting started

Requirements: **Node 24** and a package manager (`pnpm` recommended).

```bash
pnpm install

# Set your Anthropic API key (used directly, not via a gateway).
cp .env.example .env
echo 'ANTHROPIC_API_KEY="sk-ant-..."' >> .env
# Optional: a GitHub token with repo read access, for private repos.
# echo 'GITHUB_TOKEN="ghp_..."' >> .env

# Start the server.
pnpm dev          # http://127.0.0.1:3583

# In another terminal, chat with the bot:
pnpm exec flue connect d0lt-bot local
```

Flue loads the project-root `.env` for `flue dev` and `flue connect`.

## Development

```bash
pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint --fix && oxfmt
pnpm format:check   # oxfmt --check (no writes)
pnpm build          # flue build --target node
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
src/
├─ agents/
│  ├─ d0lt-bot.ts        # root router; owns the local() sandbox; route → flue connect
│  └─ d0lt-bot.md        # routing instructions (delegate review vs test)
├─ subagents/
│  ├─ reviewer.ts(.md)    # PR review subagent profile + instructions
│  └─ test-runner.ts(.md) # test runner subagent profile + instructions
├─ tools/
│  └─ fetch-repo.ts      # shared: validates URL → safe clone command
└─ lib/
   └─ github.ts          # URL parsing, ref validation, clone-script builder (shared)
docs/plans/              # design document
```

## How this differs from the eve original

The two are feature-equivalent; the framework forces a few differences:

| eve original                                  | this Flue port                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `fetch_repo` **tool** clones into the sandbox | `fetch_repo` tool returns a safe clone _command_ the subagent runs via bash (tools have no sandbox in Flue) |
| declared subagents with `outputSchema`        | `defineAgentProfile` subagents; results relayed as structured markdown (profiles have no output schema)     |
| isolated sandbox (microsandbox/Docker/Vercel) | Flue `local()` host sandbox (swappable for a remote one)                                                    |
| zod, `defineAgent`, `eveChannel`              | valibot, `createAgent`, `route` export + `flue connect`                                                     |
| credential brokering at the sandbox firewall  | `$GITHUB_TOKEN` from the sandbox env (kept out of model context)                                            |

See [`docs/plans/`](docs/plans/) for the design write-up.
