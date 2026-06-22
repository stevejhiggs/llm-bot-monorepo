# llm-bot-monorepo

A monorepo for building LLM-powered bots on the [Flue](https://flueframework.com/) agent
framework. It is structured to host multiple bots over time; **d0lt-bot** is the first.

## d0lt-bot

A GitHub assistant built on Flue. It is a port of
[`d0lt-bot`](../d0lt-bot) (which is built on [eve](https://www.npmjs.com/package/eve)) to Flue.
Point it at a pull request or a repository in chat and it does the work in a sandbox:

- **Review a pull request** — clones the repo, reads the diff in context, and returns a
  structured code review: a summary, severity-tagged findings (file/line/suggestion), and an
  `approve` / `comment` / `request_changes` recommendation.
- **Run a repository's tests** — clones the code, detects the stack, installs dependencies,
  runs the tests, and reports a pass/fail result with the relevant output.

You can drive it three ways: interactively over chat (`flue connect`); from GitHub itself —
the bot reacts to pull-request/issue comments and newly opened PRs and posts its results back
as GitHub comments (see [GitHub integration](#github-integration)); or from Slack, by @-mentioning
or DMing the bot, with results posted back in-thread (see [Slack integration](#slack-integration)).

Note: like the original, this is not a full review system — it's a test of how these patterns
map onto Flue.

## How it works

A root agent routes each request to one of two specialist **subagents**, each delegated to via
Flue's built-in `task` capability — mirroring the eve original:

```
  chat (flue connect) ─┐
  GitHub webhooks ─────┼──▶ d0lt-bot (router agent, owns the local() sandbox)
  Slack events ────────┘        │ delegates via `task`
                ┌───────────────┴────────────────┐
                ▼                                 ▼
            reviewer                        test_runner
   fetch_repo → bash: clone + diff   fetch_repo → bash: clone → install → test
   → reads pr.diff + files           → detects stack, runs tests
   → structured review               → pass/fail + output
```

Both subagents share one `fetch_repo` tool (`fetchRepoTool` from [`@repo/github`](packages/github)).
In Flue a tool's `execute` receives only its validated arguments — no sandbox — so `fetch_repo`
does not clone; it validates the GitHub URL and returns the exact, injection-safe shell command.
The subagent then runs that command with its bash tool inside the router's `local()` sandbox,
reads the diff / runs the tests, and returns its result for the router to narrate.

Each chat instance gets its own scratch directory under the OS temp dir (created before the
sandbox initializes). Private repos are supported via a `GITHUB_TOKEN`: it is exposed to the
sandbox as an env var and referenced as `$GITHUB_TOKEN` at clone time, so the secret authenticates
the clone without ever entering the model's context or the host's git config.

## Usage

Start the server (`pnpm dev`), then chat with the agent via `pnpm connect`:

- `Review https://github.com/owner/repo/pull/123`
- `Run the tests for https://github.com/owner/repo`
- `Run the unit tests for https://github.com/owner/repo/tree/some-branch`

## GitHub integration

The bot can also be driven from GitHub directly. A [Flue GitHub channel](https://flueframework.com/docs/ecosystem/channels/github/)
in [`bots/d0lt-bot/src/channels/github.ts`](bots/d0lt-bot/src/channels/github.ts) receives verified
webhook deliveries and dispatches them to the same router agent; the agent then posts its result
back as a GitHub comment using a `comment_on_github_issue` tool bound to that issue/PR. The
webhook-handling logic and the comment tool live in
[`@repo/github`](packages/github) (unit-tested there).

What triggers a run:

- **A comment on a PR** containing the trigger phrase (default `@d0lt-bot`, set
  `GITHUB_TRIGGER_PHRASE` to change it) → review the PR, or run its tests if the comment asks.
- **A comment on a plain issue** containing the trigger phrase → run the tests for that repo.
- **A newly opened PR** (`pull_request.opened`) → an automatic review, no phrase needed.

Comments authored by bot accounts are ignored, so the bot never reacts to its own posts.

### Setup

Two secrets, with different jobs: `GITHUB_WEBHOOK_SECRET` verifies inbound deliveries, and
`GITHUB_TOKEN` authenticates the outbound comments (and private-repo clones). Set them the same
way as `ANTHROPIC_API_KEY` — `.dev.vars` locally, `wrangler secret put` when deployed.

Then create a webhook on the repo (or org) pointing at the deployed app:

- **Payload URL:** `https://<your-app>/channels/github/webhook`
- **Content type:** `application/json` (form-encoded deliveries are rejected before verification)
- **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
- **Events:** *Issue comments* and *Pull requests* (the minimum this bot acts on)

GitHub expects a `2xx` within ten seconds and does not auto-retry, so the channel acks
immediately and processes the work asynchronously on the agent instance. Deliveries are not
deduplicated by `deliveryId` (GitHub doesn't auto-retry, and comments on the same PR already
serialize on one instance); the id is threaded through so dedup can be added if needed.

## Slack integration

The bot can also be driven from Slack. A [Flue Slack channel](https://flueframework.com/docs/ecosystem/channels/slack/)
in [`bots/d0lt-bot/src/channels/slack.ts`](bots/d0lt-bot/src/channels/slack.ts) receives verified
Events API deliveries and dispatches them to the same router agent; the agent replies in the
Slack thread using a `reply_in_slack_thread` tool bound to that thread. The event-handling
logic and the reply tool live in
[`@repo/slack`](packages/slack) (unit-tested there).

What triggers a run:

- **An @-mention** (`app_mention`) in a channel or thread — e.g. `@d0lt-bot review
  https://github.com/owner/repo/pull/1`.
- **A direct message** to the bot (`message` with `channel_type: im`).

In both cases the message text is treated like a chat request (a GitHub URL + what to do), and
the result is posted back in-thread. Because a run takes a while, the bot also posts coarse
progress milestones in the thread as it works (e.g. cloning, installing, running tests) before the
final result. Messages from bots and edited/system messages are ignored.

### Setup

Two secrets, with different jobs: `SLACK_SIGNING_SECRET` verifies inbound requests, and
`SLACK_BOT_TOKEN` (the bot user OAuth token, `xoxb-…`) authenticates outbound replies. Set them
the same way as `ANTHROPIC_API_KEY` — `.dev.vars` locally, `wrangler secret put` when deployed.

In your Slack app config:

- **Event Subscriptions → Request URL:** `https://<your-app>/channels/slack/events`
- **Subscribe to bot events:** `app_mention` and `message.im`
- **OAuth scopes:** `app_mentions:read`, `im:history`, and `chat:write`

Slack expects a fast `2xx` and retries on timeout/non-2xx, so the channel acks immediately and
processes the work asynchronously. Events API retries are not deduplicated (messages in the same
thread serialize on one instance).

## Deploying to Cloudflare

The same agent runs on two targets. Locally it uses the node `local()` sandbox; deployed,
it runs shell work in a Cloudflare Sandbox **container** (`@cloudflare/sandbox`). The sandbox
is chosen by the `FLUE_SANDBOX` env var, set automatically by the `*:cf` scripts.

Local Cloudflare dev (reads `bots/d0lt-bot/.dev.vars`):

```bash
pnpm --filter d0lt-bot dev:cf
```

Deploy (requires `wrangler login`):

```bash
cd bots/d0lt-bot
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN          # optional, for private repos + posting comments
wrangler secret put GITHUB_WEBHOOK_SECRET # to receive GitHub webhooks (see GitHub integration)
wrangler secret put SLACK_SIGNING_SECRET  # to receive Slack events (see Slack integration)
wrangler secret put SLACK_BOT_TOKEN       # for the Slack channel to post replies
pnpm deploy                               # build:cf + wrangler deploy
```

The GitHub channel's Octokit client and the Slack channel's `@slack/web-api` client both run on
Cloudflare under the `nodejs_compat` flag already set
in `wrangler.jsonc`.

`wrangler.jsonc` and `Dockerfile` live in `bots/d0lt-bot/`. The `Dockerfile` base-image tag is
pinned to the installed `@cloudflare/sandbox` version. Durable Object migrations are append-only —
never reorder or rewrite deployed entries.

### How the Cloudflare sandbox works

- **Why a container.** The bot's work is real shell — `git clone`, detect the stack, install
  deps, run tests. Workers have no filesystem or shell, so the deployed agent runs that work in a
  [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox) container (a `Sandbox` Durable
  Object) instead of the host `local()` sandbox used locally.
- **The image.** The `Dockerfile` is just `FROM docker.io/cloudflare/sandbox:<version>`. That base
  image ships the control-plane server the SDK talks to plus `node`, `git`, `curl`, and a
  `/workspace` working dir — which is why the agent's `cwd` is `/workspace` on Cloudflare. Add
  `RUN` lines only if a test stack needs extra tooling. Docker is needed locally **only** at
  `pnpm deploy` time, when wrangler builds and pushes the image.
- **Private repos.** The `GITHUB_TOKEN` secret is injected into the container's environment (via
  the sandbox's `setEnvVars`), so clones authenticate as `$GITHUB_TOKEN` at run time without the
  token ever entering the model's context — the same contract as local dev.
- **Lazy provisioning.** Both targets wrap their sandbox in `lazySandbox()` (from `@repo/sandbox`),
  which defers the one-time expensive setup — the container boot (`setEnvVars`) on Cloudflare, the
  scratch-dir `mkdir` on node — until the first shell/file op. A turn that never shells out (a plain
  chat reply, a Slack message that isn't a review/test request) never spins up a container; a
  review/test turn boots it just-in-time on its first command, with `GITHUB_TOKEN` injected first.
- **Not Cloudflare Shell.** This uses Cloudflare *Sandbox* (full Linux), not the `cloudflare-shell`
  adapter, which exposes only a code tool and can't run `git`/install/test commands.

## Getting started

This is a [Turborepo](https://turborepo.com) monorepo. Bots (the Flue runners) live under
[`bots/`](bots) — the first is [`bots/d0lt-bot`](bots/d0lt-bot) — and supporting apps live under
[`apps/`](apps), currently a web chat UI in [`apps/chat`](apps/chat) that talks to a runner over
HTTP (see [`apps/chat/README.md`](apps/chat/README.md)). Shared functionality lives under
[`packages/`](packages) as source-only TypeScript packages (`@repo/sandbox`, `@repo/github`,
`@repo/slack`) — bots consume them via `workspace:*` and TypeScript resolves their `.ts` sources
directly (no build step). Additional bots can be added under `bots/`. The root `pnpm` scripts fan
out to the workspace via `turbo`.

Requirements: **Node 24** and a package manager (`pnpm` recommended).

```bash
pnpm install

# Set your Anthropic API key (used directly, not via a gateway).
cp bots/d0lt-bot/.env.example bots/d0lt-bot/.env
echo 'ANTHROPIC_API_KEY="sk-ant-..."' >> bots/d0lt-bot/.env
# Optional: a GitHub token with repo read access, for private repos.
# echo 'GITHUB_TOKEN="ghp_..."' >> bots/d0lt-bot/.env

# Start the server.
pnpm dev          # http://127.0.0.1:3583

# In another terminal, chat with the bot:
pnpm connect
```

Flue loads `bots/d0lt-bot/.env` for `flue dev` and `flue connect`.

## Development

Run from the repo root; `turbo` runs the matching task in `bots/d0lt-bot`.

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
bots/d0lt-bot/             # the first bot (Flue app); more bots can live alongside it under bots/
├─ src/
│  ├─ agents/
│  │  ├─ d0lt-bot.ts        # root router; owns the local() sandbox; route → flue connect
│  │  └─ d0lt-bot.md        # routing instructions (delegate review vs test)
│  ├─ subagents/
│  │  ├─ reviewer.ts(.md)    # PR review subagent profile + instructions
│  │  └─ test-runner.ts(.md) # test runner subagent profile + instructions
│  └─ lib/
│     ├─ channel-flags.ts   # CHANNEL_<NAME>_ENABLE opt-in gating
│     └─ observe.ts         # console observer for Flue events
├─ flue.config.ts
├─ tsconfig.json           # extends ../../tsconfig.base.json
└─ package.json
apps/chat/                 # web chat UI (TanStack Start); proxies to the runner
├─ src/
│  ├─ components/Chat.tsx  # transcript UI; renders text/reasoning/tool-call parts
│  ├─ lib/                 # pure, tested logic (proxy, transcript, tool-part, …)
│  ├─ routes/             # TanStack file routes
│  └─ server.ts            # same-origin /api/flue proxy → FLUE_RUNNER_URL
└─ package.json
packages/
├─ sandbox/                # @repo/sandbox — lazySandbox, resolveSandboxKind, node/cf adapters
├─ github/                 # @repo/github — planDelivery, fetchRepoTool, commentOnIssue
└─ slack/                  # @repo/slack  — planSlackEvent, replyInThread, toMrkdwn
turbo.json                 # task pipeline (build / dev / typecheck / test)
tsconfig.base.json         # shared TS compiler options
docs/superpowers/          # design specs & implementation plans
```