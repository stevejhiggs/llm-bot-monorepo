# AGENTS.md

Guidance for AI coding agents working in this repository. See `README.md` for the
human-oriented overview; this file is the agent-facing technical companion.

## Project overview

A proof-of-concept GitHub assistant built on the [Flue](https://flueframework.com/) agent
framework, ported from the eve-based `d0lt-bot`. It reviews pull requests and runs repositories'
tests inside a sandbox, and can be driven from chat, GitHub comments, or Slack.

- **Monorepo:** Turborepo. Bots (Flue runners) live under `bots/`; supporting apps live under
  `apps/`. Root scripts fan out via `turbo`. `bots/d0lt-bot` is the first bot — the Flue runner
  (the agent). `apps/chat` is a TanStack Start web UI that talks to the runner — see "The chat web
  app". Additional bots are added under `bots/`. Shared functionality lives in source-only packages
  under `packages/` (`@repo/sandbox`, `@repo/github`, `@repo/slack`) — bots consume them via
  `workspace:*` and TypeScript resolves `.ts` sources directly (no build step required).
- **Stack:** TypeScript (ESM, `NodeNext`), Node 24, pnpm 11. Flue runtime + CLI (`@flue/*`,
  currently `1.0.0-beta`). Tests with Vitest; lint/format with oxlint + oxfmt. Deploys to Node or
  Cloudflare Workers.

## Setup commands

- Install deps: `pnpm install` (requires Node 24; pnpm is the package manager — do not use npm/yarn).
- Configure secrets for local dev: copy `bots/d0lt-bot/.env.example` to `bots/d0lt-bot/.env`
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

Tests run on **Vitest**. Test files are colocated as `*.test.ts` within each package and the bot.

- Run all tests: `pnpm test` (root, runs `turbo run test` across all packages and the bot).
- Run one package: `pnpm --filter @repo/sandbox test` (or `@repo/github`, `@repo/slack`, `d0lt-bot`, `chat`).
- Watch mode: `pnpm --filter d0lt-bot test:watch`.
- Run one file: `pnpm --filter d0lt-bot test src/lib/channel-flags.test.ts`.
- Focus by name: `pnpm --filter d0lt-bot test -- -t '<substring>'`.

Tests are pure and offline — no network, no live Flue runtime. Channel logic is tested by driving
the pure `plan*()` functions directly and invoking the outbound tools with an **injected fake
client** (Octokit/WebClient). Follow that pattern for new channels; do not require the agent graph
in a test (the agent imports markdown via `with { type: "markdown" }`, which Vitest's loader does
not resolve without the Flue plugin — that is why testable logic lives in the `@repo/*` packages (and the bot's `lib/channel-flags.ts` / `lib/observe.ts`), not in `channels/` or the agent graph).

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

A single **router agent** (`bots/d0lt-bot/src/agents/d0lt-bot.ts`) is reached three ways, all
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
shared `fetchRepoTool` (from `@repo/github`) validates a GitHub URL and returns an
injection-safe shell command that the subagent runs with its bash tool inside the router's sandbox.

### Runtime-selected sandbox (dual target)

The same code runs on two targets. `resolveSandboxKind()` (from `@repo/sandbox`) reads
`FLUE_SANDBOX`: unset → node `local()` sandbox (`@repo/sandbox/node`); `cloudflare` → a Cloudflare
Sandbox **container** Durable Object (`@repo/sandbox/cloudflare`). The agent initializer picks the
implementation with a dynamic `import()` so each target's sandbox module stays out of the other
target's bundle — preserve this when touching the agent or sandbox modules.

Both targets wrap their adapter in `lazySandbox()` (from `@repo/sandbox`), which **defers the
sandbox's one-time expensive setup until the first shell/file op** — the container boot
(`setEnvVars`) on Cloudflare, the scratch-dir `mkdir` on node. A turn that never touches the
sandbox (a plain chat reply, a Slack message that isn't a review/test request) therefore never
provisions one. The wrapper gates every async `SessionEnv` method behind a memoized `prepare()`
that runs at most once **before** the first delegated op (the bot passes a `secrets` record
`{ GITHUB_TOKEN }` at construction time, injected into the sandbox before the first clone), and
passes the sync `cwd`/`resolvePath` straight through so they answer without booting. Keep the
node/cloudflare adapter modules in `@repo/sandbox` building a `SandboxFactory` (not doing eager
I/O) so this contract holds; the lazy behavior is unit-tested in `packages/sandbox/src/`
(the two glue modules import target-specific deps and aren't tested directly, matching the
`resolveSandboxKind`-only sandbox test).

### Channel pattern (follow this when adding a channel)

Each integration is split into two files for a specific reason — keep the split:

- **Thin discovered channel** `src/channels/<name>.ts` — constructs the channel
  (`createGitHubChannel` / `createSlackChannel`), and its handler calls the plan function then
  `dispatch(d0ltBot, { id: channel.conversationKey(plan.ref), input: plan.input })`. Flue
  auto-discovers `channels/*.ts` and serves each under `/channels/<name>/...`; every file there
  **must** export a `channel`. Do not put helpers in `channels/`.
- **Testable logic** in `@repo/github` / `@repo/slack` (was `src/lib/<name>-(webhook|events).ts`) —
  the outbound API client, a pure `plan*()` function (verified delivery → `{ ref, input } | null`),
  and the outbound tool factory (`commentOnIssue` / `replyInThread`). The thin channel in
  `bots/d0lt-bot/src/channels/<name>.ts` imports these plan/tool functions from the package.

The agent's `conversationTools(id)` tries each channel's `parseConversationKey(id)` in turn and
returns `{ router, subagent }` tool lists (chat ids parse as no channel → both empty). Outbound
tools take only the message body/text from the model; the destination (issue/thread) is fixed at
bind time from the verified delivery, so the model cannot redirect a post.

`subagent` is for tools a channel turn needs to give the **subagents**, not just the router. Slack
uses it for `post_slack_progress`: the subagents post phase milestones (cloning/installing, running
tests) while the router is blocked on its `task`. The subagent profiles are therefore **factories**
(`createReviewer`/`createTestRunner`) built in the agent initializer with those injected tools —
not static profiles. The router posts the opening ack and the final reply; the final reply runs the
model's markdown through `toMrkdwn` (`lib/slack-format.ts`) because Slack renders mrkdwn, not GFM.

To add a channel end to end: create the two files above, gate the channel with
`channelEnabled("<name>")` (placeholder secret + early-return when disabled), add a branch to
`conversationTools(id)`, add a "When the turn comes from <X>" section to `src/agents/d0lt-bot.md`,
and document its enable flag + secrets in `.env.example`, `.dev.vars`, and `README.md`.

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

### Observability (`src/app.ts` + `lib/observe.ts`)

Flue emits no telemetry on its own — you must register an observer. `src/app.ts` is the authored
application entrypoint (Flue generates a default when it's absent); we author it for one reason: to
call `observe(createConsoleObserver())` at module-eval time, before any request/alarm delivers work.
It otherwise mounts `flue()` at `/` exactly like the default, so routing is unchanged — keep that
mount if you edit it. `lib/observe.ts` is the **testable** half (mirroring the channel split): a pure
`createConsoleObserver(sink = console)` that turns the `observe(...)` event stream
([events reference](https://flueframework.com/docs/api/events-reference/)) into structured console
logs — failures (`submission_settled` failed, `operation`/`turn`/`tool`/`task` `isError`), slow
operations, and a one-line-per-step activity trail; it ignores streaming deltas. The sink is injected
so the unit test drives it with a fake.

This is deliberately a **console** sink, not OpenTelemetry: on Cloudflare the lines land in Workers
Logs (gated by `observability.enabled: true` in `wrangler.jsonc`), queryable in the dashboard, with
no external backend. For rich OTLP traces (per-model-turn cost, tool spans) to an external backend,
add `@flue/opentelemetry` + a workerd-compatible SDK/exporter — see Flue's OpenTelemetry guide.

### The chat web app (`apps/chat`)

A TanStack Start app that renders a conversation with the agent via `useFlueAgent` from
`@flue/react`. The browser never hits the runner directly: it calls this app's same-origin server
proxy under `/api/flue` (`src/server.ts` + `src/lib/proxy.ts`), which forwards to `FLUE_RUNNER_URL`
(sidesteps CORS; the runner serves none). The runner must have `CHANNEL_HTTP_ENABLE=true`. Run both:
`pnpm dev` (runner, port 3583) and `pnpm --filter chat dev` (UI, port 3000).

**Rendering the agent stream — represent every part type.** `useFlueAgent` reduces the runner's
event stream into `UIMessage[]`, and each message's `parts` is a discriminated union
(`@flue/react`'s `UIMessagePart`): `text`, `reasoning`, `dynamic-tool` (tool calls — `toolName`,
`input`, and a `state` of `input-available` | `output-available` | `output-error` carrying
`output`/`errorText`), and `file`. The bot's real work (subagent `task` delegation, `fetch_repo`,
`bash`, `read`) arrives as `dynamic-tool` parts, and the subagent's turns stream into the **same**
conversation. A renderer that handles only `text`/`reasoning` silently drops all of it and shows
tool-only turns as **empty bubbles** — the symptom to watch for. When touching `Chat.tsx` or adding
a part type, handle the whole union; verify against a real run, not just text replies.

- Tool results often arrive MCP-shaped (`{ content: [{ type: "text", text }] }`) and shell output
  carries ANSI colour codes — normalise both before display.
- Keep the projection logic pure and in `src/lib/` with a colocated `*.test.ts` (e.g.
  `lib/tool-part.ts`), mirroring the runner's "testable logic lives in `lib/`" rule; components stay
  thin. Tests are offline Vitest — no live runner.
- To exercise it end to end, drive the UI in a browser and inspect the stream (the runner replays a
  conversation at `GET {FLUE_RUNNER_URL}/agents/d0lt-bot/<id>?offset=-1`).

## Build and deployment

- Build (node): `pnpm build` → `bots/d0lt-bot/dist/server.mjs`.
- Build (Cloudflare): `pnpm --filter d0lt-bot build:cf` → `bots/d0lt-bot/dist/d0lt_bot/` (note the
  underscore), including the generated `wrangler.json`.
- Deploy: `pnpm --filter d0lt-bot deploy` (build:cf + `wrangler deploy`). Requires `wrangler
  login`; set production secrets with `wrangler secret put <NAME>`.
- Cloudflare constraints:
  - Durable Object migrations in `bots/d0lt-bot/wrangler.jsonc` are **append-only** — never reorder
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
