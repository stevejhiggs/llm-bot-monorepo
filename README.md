# llm-bot-monorepo

A scaffold for building LLM-powered bots on the [Flue](https://flueframework.com/) agent framework.
It is structured to host multiple deployable bots over time, with shared packages for the pieces
most bots need: channel routing, sandboxed repository work, GitHub and Slack integrations, and
runtime observability.

**[d0lt-bot](bots/d0lt-bot/README.md)** is the first bot built on the scaffold: a GitHub PR-review
and test-running assistant that can be driven from chat, GitHub comments, or Slack.

## What this gives you

- **A reusable bot scaffold** — add new Flue runners under [`bots/`](bots) while reusing the same
  source-only packages through `workspace:*`.
- **Shared channel architecture** — GitHub, Slack, and chat entry points all dispatch into the same
  agent shape without coupling channel handlers back to the bot implementation.
- **Dynamic sandboxing** — bots can run shell and filesystem work in a local sandbox for development
  or a Cloudflare Sandbox container when deployed, selected at runtime.
- **Lazy sandbox startup** — simple turns do not pay for sandbox provisioning; the real sandbox wakes
  only when a workspace operation is needed.
- **A concrete reference bot** — d0lt-bot shows the scaffold handling PR reviews, test runs, private
  repo cloning, Slack thread progress, GitHub comments, web chat, and console-based observability.

## Workspace shape

- **Bots** (the Flue runners) live under [`bots/`](bots). Each is a deployable Flue app; see its own
  README for what it does and how to run it. → [`bots/d0lt-bot`](bots/d0lt-bot/README.md)
- **Apps** (supporting UIs/services) live under [`apps/`](apps) — currently a web chat UI in
  [`apps/chat`](apps/chat/README.md) that talks to a runner over HTTP.
- **Packages** are source-only TypeScript shared by the bots, consumed via `workspace:*` (no build
  step — TypeScript resolves their `.ts` sources directly):
  - [`@repo/channel-registry`](packages/channel-registry/README.md) — shared channel registry resolver and types.
  - [`@repo/sandbox`](packages/sandbox/README.md) — runtime-selected, lazily-provisioned execution sandbox.
  - [`@repo/github`](packages/github/README.md) — GitHub URL/clone helpers, webhook handling, the comment tool.
  - [`@repo/slack`](packages/slack/README.md) — Slack event handling, the reply/progress tools, GFM→mrkdwn.
  - [`@repo/observability`](packages/observability/README.md) — the console observer for Flue events.

## Getting started

This is a [Turborepo](https://turborepo.com) monorepo; root `pnpm` scripts fan out to the workspace
via `turbo`. Requirements: **Node 24** and `pnpm`.

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure d0lt-bot

The runner calls Anthropic directly. Copy the example env file and set your API key:

```bash
cp bots/d0lt-bot/.env.example bots/d0lt-bot/.env
```

Edit `bots/d0lt-bot/.env` and replace the placeholder `ANTHROPIC_API_KEY`. The example enables the
direct HTTP route with `CHANNEL_HTTP_ENABLE="1"`, which is needed for the web interface. Public
GitHub repos work without `GITHUB_TOKEN`; set one if you want the bot to clone private repos.

### 3. Start the runner

```bash
pnpm dev
```

The d0lt-bot runner listens on `http://127.0.0.1:3583`.

### 4. Talk to the bot

Attach the interactive console (`@flue/dev-console`) in another terminal — it connects to the runner
started above:

```bash
pnpm console
```

Or use the web chat interface:

```bash
cp apps/chat/.env.example apps/chat/.env
pnpm --filter chat dev
```

Then open `http://localhost:3000`. The chat app proxies browser requests to the runner via
`FLUE_RUNNER_URL` in `apps/chat/.env` and requires the runner's `CHANNEL_HTTP_ENABLE` flag to be on.

Flue loads `bots/d0lt-bot/.env` for `flue dev` (`pnpm console` attaches to that running server and
does not load `.env` itself). For everything d0lt-bot — usage,
GitHub/Slack integration, Cloudflare deploy, and the full config table — see
[`bots/d0lt-bot/README.md`](bots/d0lt-bot/README.md).

## Useful docs

- [`docs/architecture.md`](docs/architecture.md) follows chat, GitHub, and Slack requests through
  the repo and calls out the runtime boundaries.
- [`docs/development.md`](docs/development.md) has file-by-file recipes for adding channels, tools,
  subagents, sandbox changes, and chat stream rendering changes.
- [`AGENTS.md`](AGENTS.md) is the agent-facing contract reference: conventions, footguns, and
  verification gates for AI coding agents.
- Historical design notes live under [`docs/plans`](docs/plans) and
  [`docs/superpowers`](docs/superpowers). They preserve implementation history; prefer the active
  docs above for current architecture and commands.

## Development

Run from the repo root; `turbo` runs the matching task across the workspace.

```bash
pnpm typecheck      # turbo run typecheck (tsc --noEmit)
pnpm test           # turbo run test (vitest)
pnpm lint           # oxlint --fix && oxfmt (root-wide, one pass)
pnpm format:check   # oxfmt --check (no writes)
pnpm build          # turbo run build (flue build --target node)
```

## Project layout

```
bots/d0lt-bot/             # the first bot (Flue app); more bots can live alongside it under bots/
├─ src/
│  ├─ agents/              # root router agent (lightweight sandbox facade) + instructions
│  ├─ subagents/           # reviewer + test_runner profiles + instructions
│  ├─ channels/            # discovered GitHub/Slack channel shims (call the package factories)
│  └─ lib/                 # channel flags + pure routing helpers
├─ flue.config.ts
└─ package.json
apps/chat/                 # web chat UI (TanStack Start); proxies to the runner
packages/
├─ channel-registry/       # @repo/channel-registry — registry resolver + shared types
├─ sandbox/                # @repo/sandbox          — lazySandbox, resolveSandboxKind, node/cf adapters
├─ github/                 # @repo/github           — planDelivery, fetchRepoTool, commentOnIssue, channel
├─ slack/                  # @repo/slack            — planSlackEvent, replyInThread, toMrkdwn, channel
└─ observability/          # @repo/observability    — createConsoleObserver
turbo.json                 # task pipeline (build / dev / typecheck / test)
tsconfig.base.json         # shared TS compiler options
docs/plans/                # historical design plans
docs/superpowers/          # historical specs & implementation plans
docs/architecture.md       # request-flow and runtime map
docs/development.md        # common change recipes
```

Monorepo-wide conventions for AI coding agents live in [`AGENTS.md`](AGENTS.md).
