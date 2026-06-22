# llm-bot-monorepo

A monorepo for building LLM-powered bots on the [Flue](https://flueframework.com/) agent framework.
It is structured to host multiple bots over time; **[d0lt-bot](bots/d0lt-bot/README.md)** — a GitHub
PR-review and test-running assistant — is the first.

- **Bots** (the Flue runners) live under [`bots/`](bots). Each is a deployable Flue app; see its own
  README for what it does and how to run it. → [`bots/d0lt-bot`](bots/d0lt-bot/README.md)
- **Apps** (supporting UIs/services) live under [`apps/`](apps) — currently a web chat UI in
  [`apps/chat`](apps/chat/README.md) that talks to a runner over HTTP.
- **Packages** are source-only TypeScript shared by the bots, consumed via `workspace:*` (no build
  step — TypeScript resolves their `.ts` sources directly):
  - [`@repo/sandbox`](packages/sandbox/README.md) — runtime-selected, lazily-provisioned execution sandbox.
  - [`@repo/github`](packages/github/README.md) — GitHub URL/clone helpers, webhook handling, the comment tool.
  - [`@repo/slack`](packages/slack/README.md) — Slack event handling, the reply/progress tools, GFM→mrkdwn.
  - [`@repo/observability`](packages/observability/README.md) — the console observer for Flue events.

## Getting started

This is a [Turborepo](https://turborepo.com) monorepo; root `pnpm` scripts fan out to the workspace
via `turbo`. Requirements: **Node 24** and `pnpm`.

```bash
pnpm install

# Set your Anthropic API key (used directly, not via a gateway).
cp bots/d0lt-bot/.env.example bots/d0lt-bot/.env
echo 'ANTHROPIC_API_KEY="sk-ant-..."' >> bots/d0lt-bot/.env

# Start the server, then chat with the bot in another terminal.
pnpm dev          # http://127.0.0.1:3583
pnpm connect
```

Flue loads `bots/d0lt-bot/.env` for `flue dev` and `flue connect`. For everything d0lt-bot — usage,
GitHub/Slack integration, Cloudflare deploy, and the full config table — see
[`bots/d0lt-bot/README.md`](bots/d0lt-bot/README.md).

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
│  ├─ agents/              # root router agent (owns the sandbox) + routing instructions
│  ├─ subagents/           # reviewer + test_runner profiles + instructions
│  ├─ channels/            # discovered GitHub/Slack channel shims (call the package factories)
│  └─ lib/                 # channel-flags (CHANNEL_<NAME>_ENABLE gating)
├─ flue.config.ts
└─ package.json
apps/chat/                 # web chat UI (TanStack Start); proxies to the runner
packages/
├─ sandbox/                # @repo/sandbox       — lazySandbox, resolveSandboxKind, node/cf adapters
├─ github/                 # @repo/github        — planDelivery, fetchRepoTool, commentOnIssue, channel
├─ slack/                  # @repo/slack         — planSlackEvent, replyInThread, toMrkdwn, channel
└─ observability/          # @repo/observability — createConsoleObserver
turbo.json                 # task pipeline (build / dev / typecheck / test)
tsconfig.base.json         # shared TS compiler options
docs/superpowers/          # design specs & implementation plans
```

Monorepo-wide conventions for AI coding agents live in [`AGENTS.md`](AGENTS.md).
