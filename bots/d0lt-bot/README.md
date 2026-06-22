# d0lt-bot

A GitHub assistant built on [Flue](https://flueframework.com/). Point it at a pull request or a
repository and it does the work in a sandbox:

- **Review a pull request** — clones the repo, reads the diff in context, and returns a structured
  code review: a summary, severity-tagged findings (file/line/suggestion), and an `approve` /
  `comment` / `request_changes` recommendation.
- **Run a repository's tests** — clones the code, detects the stack, installs dependencies, runs the
  tests, and reports a pass/fail result with the relevant output.

You can drive it three ways: interactively over chat (`flue connect`); from GitHub, where it reacts
to pull-request/issue comments and newly opened PRs and posts results back as comments (see
[GitHub integration](#github-integration)); or from Slack, by @-mentioning or DMing it, with results
posted back in-thread (see [Slack integration](#slack-integration)).

This is a proof of concept — a test of how these patterns map onto Flue, not a full review system.

## How it works

A root agent routes each request to one of two specialist **subagents**, each delegated to via
Flue's built-in `task` capability. The router owns a lightweight sandbox facade; the real node or
Cloudflare sandbox is provisioned on the first workspace operation.

```
  chat (flue connect) ─┐
  GitHub webhooks ─────┼──▶ d0lt-bot (router agent, owns the sandbox)
  Slack events ────────┘        │ lightweight sandbox; full sandbox on first workspace op
                ┌───────────────┴────────────────┐
                ▼                                 ▼
            reviewer                        test_runner
       clone + inspect diff             clone + install + test
       structured review                pass/fail + output
```

Both subagents use `fetchRepoTool` from [`@repo/github`](../../packages/github) to get an
injection-safe clone script, then run it in the router's sandbox. Private repos are supported by
injecting `GITHUB_TOKEN` into the sandbox environment and referencing it as `$GITHUB_TOKEN` at clone
time, so the token does not enter the model context. For the full runtime map, see
[`docs/architecture.md`](../../docs/architecture.md).

## Usage

Start the server (`pnpm dev` from the repo root), then chat with the agent via `pnpm connect`:

- `Review https://github.com/owner/repo/pull/123`
- `Run the tests for https://github.com/owner/repo`
- `Run the unit tests for https://github.com/owner/repo/tree/some-branch`

## GitHub integration

A [Flue GitHub channel](https://flueframework.com/docs/ecosystem/channels/github/) in
[`src/channels/github.ts`](src/channels/github.ts) receives verified webhook deliveries and
dispatches them to the router agent, which posts its result back as a GitHub comment. The
decision logic (what a delivery triggers) and the comment tool live in
[`@repo/github`](../../packages/github/README.md#webhook-handling); in short, a comment containing
the trigger phrase (default `@d0lt-bot`, override with `GITHUB_TRIGGER_PHRASE`) reviews a PR or runs
a repo's tests, and a newly opened PR is auto-reviewed.

### Setup

Two secrets, with different jobs: `GITHUB_WEBHOOK_SECRET` verifies inbound deliveries, and
`GITHUB_TOKEN` authenticates outbound comments (and private-repo clones). For node dev, put them in
`bots/d0lt-bot/.env`; for Cloudflare dev, put them in `.dev.vars`; when deployed, use
`wrangler secret put`. Enable the channel with `CHANNEL_GITHUB_ENABLE=true`.

Then create a webhook on the repo (or org) pointing at the deployed app:

- **Payload URL:** `https://<your-app>/channels/github/webhook`
- **Content type:** `application/json` (form-encoded deliveries are rejected before verification)
- **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
- **Events:** *Issue comments* and *Pull requests* (the minimum this bot acts on)

## Slack integration

A [Flue Slack channel](https://flueframework.com/docs/ecosystem/channels/slack/) in
[`src/channels/slack.ts`](src/channels/slack.ts) receives verified Events API deliveries and
dispatches them to the router agent, which replies in the Slack thread. The decision logic and the
reply/progress tools live in [`@repo/slack`](../../packages/slack/README.md#event-handling); in
short, an @-mention or a DM is treated like a chat request (a GitHub URL + what to do), the result
is posted in-thread, and coarse progress milestones are posted while it works.

### Setup

Two secrets, with different jobs: `SLACK_SIGNING_SECRET` verifies inbound requests, and
`SLACK_BOT_TOKEN` (the bot user OAuth token, `xoxb-…`) authenticates outbound replies and reads
thread context. For node dev, put them in `bots/d0lt-bot/.env`; for Cloudflare dev, put them in
`.dev.vars`; when deployed, use `wrangler secret put`. Enable the channel with
`CHANNEL_SLACK_ENABLE=true`.

In your Slack app config:

- **Event Subscriptions → Request URL:** `https://<your-app>/channels/slack/events`
- **Subscribe to bot events:** `app_mention` and `message.im`
- **OAuth scopes:** `app_mentions:read`, `chat:write`, and the `*:history` scopes for the
  conversations the bot runs in — `channels:history`, `groups:history`, `im:history`,
  `mpim:history`. When mentioned inside a thread the bot reads the earlier messages
  (`conversations.replies`) and passes them to the agent as context, which needs the matching
  `*:history` scope.

## Deploying to Cloudflare

The same agent runs on two targets. Locally it uses the node `local()` sandbox; deployed, it runs
shell work in a Cloudflare Sandbox **container** (`@cloudflare/sandbox`). The sandbox is chosen by
the `FLUE_SANDBOX` env var, set automatically by the `*:cf` scripts — see
[`@repo/sandbox`](../../packages/sandbox/README.md#how-the-cloudflare-sandbox-works) for how the
container is provisioned.

Local Cloudflare dev (reads `.dev.vars`):

```bash
pnpm --filter d0lt-bot dev:cf
```

Deploy (requires `wrangler login`):

```bash
cd bots/d0lt-bot
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN          # optional, for private repos + posting comments
wrangler secret put GITHUB_WEBHOOK_SECRET # to receive GitHub webhooks
wrangler secret put SLACK_SIGNING_SECRET  # to receive Slack events
wrangler secret put SLACK_BOT_TOKEN       # for the Slack channel to post replies
pnpm deploy                               # build:cf + wrangler deploy
```

`wrangler.jsonc` and `Dockerfile` live here in `bots/d0lt-bot/`. The `Dockerfile` base-image tag is
pinned to the installed `@cloudflare/sandbox` version. Durable Object migrations are append-only —
never reorder or rewrite deployed entries.

## Production observability

The bot registers Flue observers from [`src/app.ts`](src/app.ts) before mounting the generated Flue
routes. In production this produces two telemetry streams:

- **Workers Logs / traces** — `wrangler.jsonc` enables Cloudflare-native persisted logs and traces.
  The console observer records failures, slow operations, and one-line activity breadcrumbs with
  `instance`, `dispatch`, and `operationId` correlation fields.
- **Workers Analytics Engine metrics** — the `OBSERVABILITY` Analytics Engine binding writes one
  bounded point per completed Flue operation/tool/task/turn/submission/compaction/run and per
  application log event. Points include counts, durations, token totals, cost totals, and safe
  dimensions; they intentionally exclude prompts, model output, shell output, tool results, raw
  errors, and secrets.

Alerting and long-term export are configured in Cloudflare, not in this repo. Recommended production
alerts: webhook 5xx rate, tool/task failure rate, model turn failure rate, operations over 30s,
sandbox/container failures, and token/cost spikes. For external retention or dashboards, configure
Cloudflare OTLP export or Workers Logpush for the deployed Worker.

## Configuration

| Variable                | Required    | Purpose                                                                                 |
| ----------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`     | yes         | Calls Claude (Sonnet 4.6) directly.                                                     |
| `GITHUB_TOKEN`          | conditional | Required for GitHub comments; optional for public repo clones; needed for private repos. |
| `CHANNEL_GITHUB_ENABLE` | no          | Enable the GitHub webhook channel (needs the secret below).                             |
| `GITHUB_WEBHOOK_SECRET` | no          | Verifies inbound GitHub deliveries.                                                     |
| `GITHUB_TRIGGER_PHRASE` | no          | Activating phrase (default `@d0lt-bot`).                                                |
| `CHANNEL_SLACK_ENABLE`  | no          | Enable the Slack events channel (needs the secrets below).                              |
| `SLACK_SIGNING_SECRET`  | no          | Verifies inbound Slack requests.                                                        |
| `SLACK_BOT_TOKEN`       | no          | Bot user OAuth token (`xoxb-…`) for outbound replies.                                   |
| `CHANNEL_HTTP_ENABLE`   | no          | Expose the direct HTTP invocation route (e.g. for the web chat UI).                     |

Public repo cloning works without a token. Node dev runs shell commands on the host-local sandbox;
for stronger isolation, use the Cloudflare target described above. See the full variable list in
[`.env.example`](.env.example).
