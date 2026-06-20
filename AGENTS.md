# AGENTS.md

Guidance for AI coding agents working in this repository. See `README.md` for the
human-oriented overview; this file is the agent-facing technical companion.

## Project overview

A proof-of-concept GitHub assistant built on the [Flue](https://flueframework.com/) agent
framework, ported from the eve-based `d0lt-bot`. It reviews pull requests and runs repositories'
tests inside a sandbox, and can be driven from chat, GitHub comments, or Slack.

- **Monorepo:** Turborepo. The only app is `apps/d0lt-bot`; root scripts fan out via `turbo`.
- **Stack:** TypeScript (ESM, `NodeNext`), Node 24, pnpm 11. Flue runtime + CLI (`@flue/*`,
  currently `1.0.0-beta`). Tests with Vitest; lint/format with oxlint + oxfmt. Deploys to Node or
  Cloudflare Workers.

## Setup commands

- Install deps: `pnpm install` (requires Node 24; pnpm is the package manager — do not use npm/yarn).
- Configure secrets for local dev: copy `apps/d0lt-bot/.env.example` to `apps/d0lt-bot/.env`
  (node) and/or `.dev.vars` (Cloudflare). At minimum set `ANTHROPIC_API_KEY`. With both channels
  present the app also needs `GITHUB_WEBHOOK_SECRET` and `SLACK_SIGNING_SECRET` to boot (see
  "Secrets and startup").

## Development workflow

Run from the repo root unless noted.

- `pnpm dev` — start the dev server (node target, port 3583, watch mode).
- `pnpm connect` — open an interactive chat with the agent (`flue connect d0lt-bot local`).
- `pnpm typecheck` — `tsc --noEmit` across the workspace.
- Cloudflare locally: `pnpm --filter d0lt-bot dev:cf` (sets `FLUE_SANDBOX=cloudflare`, reads
  `.dev.vars`). Requires Docker only at deploy time, when wrangler builds the sandbox image.

## Testing instructions

Tests run on **Vitest**. Test files are colocated as `*.test.ts` under `src/`.

- Run all tests: `pnpm test` (root, delegates to the app) or `pnpm --filter d0lt-bot test`.
- Watch mode: `pnpm --filter d0lt-bot test:watch`.
- Run one file: `pnpm --filter d0lt-bot test src/lib/slack-events.test.ts`.
- Focus by name: `pnpm --filter d0lt-bot test -- -t '<substring>'`.

Tests are pure and offline — no network, no live Flue runtime. Channel logic is tested by driving
the pure `plan*()` functions directly and invoking the outbound tools with an **injected fake
client** (Octokit/WebClient). Follow that pattern for new channels; do not require the agent graph
in a test (the agent imports markdown via `with { type: "markdown" }`, which Vitest's loader does
not resolve without the Flue plugin — that is why testable logic lives in `lib/`, not `channels/`).

## Code style

- TypeScript ESM. Import sibling modules with explicit `.ts` extensions
  (`allowImportingTsExtensions` is on); markdown instructions via
  `import x from "./x.md" with { type: "markdown" }`.
- Tool parameter schemas use **valibot** (`v.object({...})`), matching existing tools — not raw
  JSON Schema.
- Lint/format: `pnpm lint` runs `oxlint --fix && oxfmt` (writes fixes); `pnpm format:check` is the
  read-only gate. **oxlint and oxfmt have separate ignore configs** (`.oxlintrc.json` and
  `.oxfmtrc.json`) — both ignore `.agents/**`; keep new ignores in sync across both files. oxlint
  runs type-aware.
- Keep comments at the density of surrounding code; the codebase documents *why* (security/safety
  contracts) more than *what*.

## Architecture

### One agent, three entry points

A single **router agent** (`apps/d0lt-bot/src/agents/d0lt-bot.ts`) is reached three ways, all
landing on the same agent instance/conversation:

1. **Chat** — `flue connect` (instance id `local`); private child-process IPC, no HTTP.
2. **GitHub channel** — webhooks → `dispatch()`.
3. **Slack channel** — Events API → `dispatch()`.

The channels reach the agent via `dispatch()` (internal Durable Object delivery), not its HTTP
route. **All three entry points are opt-in** via `CHANNEL_<NAME>_ENABLE` env vars
(`CHANNEL_GITHUB_ENABLE`, `CHANNEL_SLACK_ENABLE`, `CHANNEL_HTTP_ENABLE`), read through
`channelEnabled()` in `src/lib/channel-flags.ts`; unset (the default) means disabled:

- **HTTP** — when disabled the agent exports no `route`, so `POST /agents/d0lt-bot/:id` 404s and is
  absent from `openapi.json`. The shipped handler is an unauthenticated pass-through; add auth
  before enabling in prod.
- **GitHub / Slack** — Flue's file-based discovery requires each `channels/*.ts` to export a valid
  `channel`, so a disabled channel can't be removed; it constructs with a placeholder secret (no
  real secret needed to boot) and its handler ignores every delivery, leaving the route mounted but
  inert. Enabling it requires the real secret (`createXChannel` throws on an empty one).

The router owns the sandbox and delegates to two **subagents** (`reviewer`, `test_runner` under
`src/subagents/`) via Flue's built-in `task` capability. Subagents never clone directly: the
shared `fetch_repo` tool (`src/tools/fetch-repo.ts`) validates a GitHub URL and returns an
injection-safe shell command (assembled by `src/lib/github.ts`) that the subagent runs with its
bash tool inside the router's sandbox.

### Runtime-selected sandbox (dual target)

The same code runs on two targets. `resolveSandboxKind()` (`src/lib/sandbox.ts`) reads
`FLUE_SANDBOX`: unset → node `local()` sandbox (`sandbox.node.ts`); `cloudflare` → a Cloudflare
Sandbox **container** Durable Object (`sandbox.cloudflare.ts`). The agent initializer picks the
implementation with a dynamic `import()` so each target's sandbox module stays out of the other
target's bundle — preserve this when touching the agent or sandbox modules.

### Channel pattern (follow this when adding a channel)

Each integration is split into two files for a specific reason — keep the split:

- **Thin discovered channel** `src/channels/<name>.ts` — constructs the channel
  (`createGitHubChannel` / `createSlackChannel`), and its handler calls the plan function then
  `dispatch(d0ltBot, { id: channel.conversationKey(plan.ref), input: plan.input })`. Flue
  auto-discovers `channels/*.ts` and serves each under `/channels/<name>/...`; every file there
  **must** export a `channel`. Do not put helpers in `channels/`.
- **Testable logic** `src/lib/<name>-(webhook|events).ts` — the outbound API client, a pure
  `plan*()` function (verified delivery → `{ ref, input } | null`), and the outbound tool factory
  (`commentOnIssue` / `replyInThread`).

The agent's `channelTools(id)` tries each channel's `parseConversationKey(id)` in turn to bind the
matching outbound tool (chat ids parse as neither → no channel tool). Outbound tools take only the
message body/text from the model; the destination (issue/thread) is fixed at bind time from the
verified delivery, so the model cannot redirect a post.

To add a channel end to end: create the two files above, gate the channel with
`channelEnabled("<name>")` (placeholder secret + early-return when disabled), add a branch to
`channelTools(id)`, add a "When the turn comes from <X>" section to `src/agents/d0lt-bot.md`, and
document its enable flag + secrets in `.env.example`, `.dev.vars`, and `README.md`.

### Channel ⇄ agent import cycle

Channels import the agent (to `dispatch`) and the agent imports the channels (for
`parseConversationKey`). This cycle is safe **only because every cross-module binding is read
inside a deferred callback/initializer** (the channel's handler, the agent's `createAgent`
callback), never at module-eval time. Keep new cross-references deferred.

### Secrets and startup

Channels are constructed at module load and `createGitHubChannel`/`createSlackChannel` throw on an
empty secret — but only an **enabled** channel passes its real secret (a disabled one constructs
with a placeholder), so the app needs the secret for each channel you turn on, and nothing for the
ones you leave off. On Cloudflare, secrets/vars are read via `process.env` (supported under the
`nodejs_compat` flag + the recent `compatibility_date` in `wrangler.jsonc`). `GITHUB_TOKEN` is
injected into the sandbox env and referenced by name as
`$GITHUB_TOKEN` in the clone script — it never enters the model's context. See `.env.example` for
the full list.

## Build and deployment

- Build (node): `pnpm build` → `apps/d0lt-bot/dist/server.mjs`.
- Build (Cloudflare): `pnpm --filter d0lt-bot build:cf` → `apps/d0lt-bot/dist/d0lt_bot/` (note the
  underscore), including the generated `wrangler.json`.
- Deploy: `pnpm --filter d0lt-bot deploy` (build:cf + `wrangler deploy`). Requires `wrangler
  login`; set production secrets with `wrangler secret put <NAME>`.
- Cloudflare constraints:
  - Durable Object migrations in `apps/d0lt-bot/wrangler.jsonc` are **append-only** — never reorder
    or rewrite deployed entries; append a new tagged migration for any new DO class.
  - The `Dockerfile` base-image tag is pinned to the installed `@cloudflare/sandbox` version; bump
    them together.

## Pull request guidelines

- Before committing, run `pnpm typecheck`, `pnpm test`, and `pnpm lint`. For channel or
  sandbox changes also run **both** `pnpm build` and `pnpm --filter d0lt-bot build:cf` — channel
  discovery and the workerd bundle only fail at build time.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
- Keep `oxfmt` reformatting scoped to files you actually changed; do not sweep unrelated formatting
  into a feature commit.
