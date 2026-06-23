# AGENTS.md

Guidance for AI coding agents working in this repository. See `README.md` for the
human-oriented overview; this file is the agent-facing technical companion.

## Project overview

A GitHub assistant built on the [Flue](https://flueframework.com/) agent framework. It reviews pull
requests and runs repositories' tests inside a sandbox, and can be driven from chat, GitHub
comments, or Slack.

For a request-flow map, read [`docs/architecture.md`](docs/architecture.md). For file-by-file
change recipes, read [`docs/development.md`](docs/development.md). This `AGENTS.md` keeps the
contracts and footguns that coding agents must preserve while editing.

- **Monorepo:** Turborepo. Bots (Flue runners) live under `bots/`; supporting apps live under
  `apps/`. Root scripts fan out via `turbo`. `bots/d0lt-bot` is the first bot — the Flue runner
  (the agent). `apps/chat` is a TanStack Start web UI that talks to the runner — see "The chat web
  app". Additional bots are added under `bots/`. Shared functionality lives in source-only packages
  under `packages/` (`@repo/channel-registry`, `@repo/sandbox`, `@repo/github`, `@repo/slack`,
  `@repo/observability`) — bots consume them via
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
- `pnpm console` — open an interactive chat with the agent via `@flue/dev-console`
  (`flue-dev-console agent:d0lt-bot --server http://127.0.0.1:3583`). Requires `pnpm dev` running in
  another terminal; the console attaches to it (it does not start the server or load `.env`).
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
not resolve without the Flue plugin — that is why testable logic lives in the `@repo/*` packages
(and the bot's `lib/` where applicable, such as `channel-flags.ts`), not in `channels/` or the agent
graph).

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

### Shared packages (`packages/`)

Reusable, bot-agnostic logic lives in **source-only** packages (no build step — consumers
import the `.ts` directly). Each is authoritative for its own internals; this file points to them
rather than repeating them. When you change a package, read its `AGENTS.md` first.

- **[`@repo/channel-registry`](packages/channel-registry/AGENTS.md)** — the generic channel registry
  resolver and shared `ChannelIntegration` / `ConversationTools` types used by the bot and channel
  packages.
- **[`@repo/sandbox`](packages/sandbox/AGENTS.md)** — runtime-selected, lazily-provisioned execution
  sandbox (node `local()` vs Cloudflare container), plus `resolveSandboxKind` / `lazySandbox` /
  `workDir`. The bundle-split and lazy-provisioning contracts live there.
- **[`@repo/github`](packages/github/AGENTS.md)** — GitHub URL/clone-script helpers, webhook
  decision logic (`planDelivery`), the outbound `commentOnIssue` tool, and the `fetchRepoTool` the
  subagents clone with.
- **[`@repo/slack`](packages/slack/AGENTS.md)** — Slack Events API decision logic (`planSlackEvent`),
  the outbound `reply_with_blocks` / `postProgressInThread` tools, Block Kit formatting helpers
  (`block-schema.ts`, `blocks.ts`), inbound interaction handling (`interactions/plan.ts`,
  `channel/interactions-ack.ts`), the `slack-block-kit` skill, and the GFM→mrkdwn `toMrkdwn`.
- **[`@repo/observability`](packages/observability/AGENTS.md)** — `createConsoleObserver`, the
  console sink that projects Flue's `observe(...)` event stream into structured logs (failures, slow
  ops, an activity trail). The bot's `app.ts` registers it at startup.

They form a shallow DAG: `@repo/channel-registry` is a shared leaf, GitHub/Slack depend on it for
agent-integration types, and `bots/d0lt-bot → {channel-registry, sandbox, github, slack,
observability}`. Versions are shared through pnpm catalogs in `pnpm-workspace.yaml` (`flue` / `cf` /
`external`). `@flue/runtime` is `1.0.0-beta.3`; `@flue/github` / `@flue/slack` stay at `1.0.0-beta.1`
(no beta.2/beta.3 published for those two).

### One agent, three entry points

A single **router agent** (`bots/d0lt-bot/src/agents/d0lt-bot.ts`) is reached three ways, all
landing on the same agent instance/conversation:

1. **Chat** — `pnpm console` (interactive `@flue/dev-console`, attaches to `pnpm dev`) or the
   `apps/chat` web UI.
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
  `channel`, so a disabled channel can't be removed; the shim still calls its factory but passes
  `enabled: false` and no secret, so the factory constructs with a placeholder secret (no real
  secret needed to boot) and its handler ignores every delivery, leaving the route mounted but
  inert. Enabling it requires the real secret (the factory throws on an empty one when enabled).

The router attaches a lightweight sandbox facade. It works with repositories two ways: it loads the
shared **`explore-repo` skill** (`@repo/github`'s `skills/explore-repo/SKILL.md`, imported as
`@repo/github/skills/explore-repo/SKILL.md`) to answer ad-hoc repo questions itself (clone +
read-only inspect), and it delegates the two heavy jobs — full PR reviews and test runs — to the
**subagents** (`reviewer`, `test_runner` under `src/subagents/`) via Flue's built-in `task`
capability. The router and both subagents register the same `explore-repo` skill, so the
clone/inspect procedure lives in one place next to the `fetch_repo` tool it depends on. Nobody
assembles git commands from a raw URL: the shared `fetchRepoTool` (from `@repo/github`) validates a
GitHub URL and returns an injection-safe shell command that the skill runs with the bash tool inside
the router's sandbox.
The facade answers Flue's automatic workspace context discovery (`AGENTS.md`, skills, directory
listing) without booting the real sandbox, then provisions the full sandbox on the first real
workspace operation.

### Runtime-selected sandbox (dual target)

The router owns one lightweight sandbox facade selected at runtime. `resolveSandboxKind(process.env)`
(from `@repo/sandbox`) reads `FLUE_SANDBOX`, and the agent initializer picks the implementation
with a dynamic `import()` — `@repo/sandbox/node` (host `local()` sandbox, dev default) or
`@repo/sandbox/cloudflare` (a Cloudflare Sandbox **container** Durable Object, when deployed).
**Keep that import dynamic:** it is what keeps each target's deps out of the other target's bundle,
and the workerd build (`build:cf`) fails otherwise. The bot passes a `secrets` record
(`{ GITHUB_TOKEN }`) at construction; the sandbox injects it before the first clone.

The mechanism (lazy provisioning, the bundle split, the adapters, `secrets`, `workDir`) lives in
**[`@repo/sandbox`](packages/sandbox/AGENTS.md)** — read it before changing any of it. The gate for
sandbox changes is **both** `pnpm build` and `pnpm --filter d0lt-bot build:cf`.

### Channel pattern

Each integration is split into two files for a specific reason — keep the split:

- **Thin discovered channel** `src/channels/<name>.ts` — a shim that calls the package's channel
  factory (`createGitHubBotChannel` / `createSlackBotChannel`) with the bot-owned values (the
  `channelEnabled("<name>")` flag, the resolved secret, the `agentName`, any config) and exports the
  result as `channel`. Flue auto-discovers `channels/*.ts` and serves each under
  `/channels/<name>/...`; every file there **must** export a `channel`. Do not put helpers — or the
  construction/dispatch logic — in `channels/`.
- **Testable logic + channel construction** live in the channel's package — `@repo/github`
  (webhooks) / `@repo/slack` (events): the outbound API client, a pure `plan*()` function (verified
  delivery → `{ ref, input } | null`), the outbound tool factory (`commentOnIssue` /
  `reply_with_blocks`), the **channel factory** that builds the Flue channel and wires `plan*()` →
  `dispatch`, and the **agent-integration factory** that returns that channel's registry entry
  (prompt fragment, parser, router tools, subagent tools). The channel factory dispatches to the
  agent **by name** (`dispatch({ agent: agentName, ... })`), so the shim never imports the agent.
  See [`packages/github/AGENTS.md`](packages/github/AGENTS.md) /
  [`packages/slack/AGENTS.md`](packages/slack/AGENTS.md) for each package's contracts.

The agent classifies each turn's source once through `CHANNEL_REGISTRY` in
`src/agents/d0lt-bot.ts` (resolved by `@repo/channel-registry`). The registry tries each
channel's `parseConversationKey(id)` in order; chat ids parse as no channel and therefore get the
base prompt only and no channel tools. Both the prompt fragment and the `{ router, subagent }` tool
lists derive from the matched registry entry. The matched entry is produced by the channel package,
so GitHub-specific and Slack-specific tool/prompt wiring stays next to that channel's tools.
Outbound tools take only the message body/text from the model; the destination (issue/thread) is
fixed at bind time from the verified delivery, so the model cannot redirect a post.

`subagent` is for tools a channel turn needs to give the **subagents**, not just the router. Slack
uses it for `post_slack_progress`: the subagents post phase milestones (cloning/installing, running
tests) while the router is blocked on its `task`. The subagent profiles are therefore **factories**
(`createReviewer`/`createTestRunner`) built in the agent initializer with those injected tools —
not static profiles. The router posts the opening ack and the final reply via `reply_with_blocks`;
the reply is a Block Kit message (plain prose goes in a `markdown` block, which renders GFM
directly — no `toMrkdwn` pass). `toMrkdwn` still applies inside `post_slack_progress` notes and
for `mrkdwn`-typed text objects within blocks.

### Source-dependent prompt

The agent's instructions are composed per turn, not static: a channel-agnostic **base**
(`src/agents/instructions.md` — the subagent routing + notes) plus the **fragment** for the turn's
source. Each channel package owns its fragment as a markdown file (`packages/<name>/src/instructions.md`,
exposed via the package's `exports` map as `"./instructions.md"`) and imports it from that package's
`"./agent-integration"` subpath with `with { type: "markdown" }`; the bot attaches the selected
fragment through `CHANNEL_REGISTRY` (chat → base alone). So the model sees only the section for
where the turn came from, and a channel's prose lives next to its tools. The `*.md` import type
comes from `@flue/runtime`'s global ambient `declare module '*.md'`, so package-subpath imports
type-check without extra `.d.ts` — but the markdown **loader** resolving a package `.md` is
confirmed only by `pnpm build` / `build:cf`, so run both when touching this. The same applies to
`with { type: "skill" }` imports of `SKILL.md` files — run both builds when adding or moving a
skill. The `slack-block-kit` skill (`@repo/slack/skills/slack-block-kit/SKILL.md`) is registered
on the d0lt-bot agent only for Slack-channel turns (`conversation.source === "slack"`), teaching
the model which Block Kit block to use for what.

To add a channel end to end, follow the recipe in
[`docs/development.md#add-a-channel`](docs/development.md#add-a-channel). The short version: package
logic + channel factory, thin discovered shim, `CHANNEL_REGISTRY` entry, package-owned
`./agent-integration` + `instructions.md` exports, env docs, and package tests.

### No channel ⇄ agent import cycle

The agent imports the channels (for `parseConversationKey`), but the channels do **not** import the
agent: the channel factory dispatches by discovered name (`dispatch({ agent: agentName, ... })`)
rather than by an imported agent reference. That keeps the edge one-directional
(agent → channel), so there is no import cycle to reason about. Don't reintroduce one — never import
the agent from a `channels/*.ts` shim or from a channel package; dispatch by name instead.

### Secrets and startup

The channel factories throw on an empty secret, but only an **enabled** channel is passed its real
secret by the shim (a disabled one is passed `undefined` and the factory substitutes a placeholder),
so the app needs a secret only for the channels you turn on. The bot resolves every secret/config
value from `process.env` in the shim and passes it in; the channel packages never read the
environment. On Cloudflare, secrets/vars are read via `process.env` (under the `nodejs_compat` flag
+ the `compatibility_date` in `wrangler.jsonc`). `GITHUB_TOKEN` is injected into the sandbox env and
referenced by name as `$GITHUB_TOKEN` in the clone script — it never enters the model's context. See
`.env.example` for the full list.

### Observability (`src/app.ts` + `@repo/observability`)

Flue emits no telemetry on its own — you must register an observer. `src/app.ts` calls
`observe(createConsoleObserver())` at module-eval time (before any request/alarm delivers work) and
mounts `flue()` at `/` — keep that mount if you edit it. The observer projection lives in
**[`@repo/observability`](packages/observability/AGENTS.md)**.

It is deliberately a **console** sink, not OpenTelemetry: on Cloudflare the lines land in Workers
Logs (gated by `observability.enabled: true` in `wrangler.jsonc`), queryable in the dashboard, with
no external backend. For rich OTLP traces, add `@flue/opentelemetry` + a workerd-compatible exporter.

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
