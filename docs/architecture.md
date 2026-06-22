# Architecture Map

This repo is easiest to understand by following a request from ingress to reply.
The bot has one router agent, two subagents, three entry points, and shared
packages. Most runtime behavior is channel-specific at the edge, then common once
the request reaches the router.

## Workspace Shape

```
bots/d0lt-bot/             Flue runner: channels, router agent, subagents, deploy config
apps/chat/                 TanStack Start web UI that proxies to the runner
packages/github/           GitHub parsing, webhook planning, channel factory, comment tool
packages/slack/            Slack event planning, channel factory, reply/progress tools, mrkdwn
packages/channel-registry/ Generic channel registry resolver and shared types
packages/sandbox/          Runtime-selected sandbox adapters and lazy provisioning
packages/observability/    Flue observer that projects runtime events to console logs
```

The shared packages are source-only TypeScript packages. Consumers import their
`.ts` sources directly through `workspace:*`; there is no package build step.

## Chat Request Flow

```
flue connect or apps/chat
  -> d0lt-bot agent instance
  -> source resolves to chat
  -> base prompt only
  -> reviewer or test_runner subagent
  -> shared sandbox
  -> final answer in the same conversation
```

Important files:

- `bots/d0lt-bot/src/agents/d0lt-bot.ts` creates the router agent and chooses the
  sandbox implementation.
- `packages/channel-registry/src/index.ts` resolves channel conversation keys.
  A chat id does not parse as any channel key, so it gets no channel prompt
  fragment and no outbound channel tools.
- `bots/d0lt-bot/src/subagents/reviewer.ts` and
  `bots/d0lt-bot/src/subagents/test-runner.ts` build the subagent profiles.
- `packages/github/src/fetch-repo.ts` exposes the `fetch_repo` tool both subagents
  use to obtain a shell-safe clone command.

For the web UI path, the browser talks to `apps/chat`, not directly to the runner:

```
browser
  -> apps/chat /api/flue proxy
  -> runner HTTP route
  -> d0lt-bot agent instance
```

The runner HTTP route is opt-in with `CHANNEL_HTTP_ENABLE=true`.

## GitHub Request Flow

```
GitHub webhook
  -> bots/d0lt-bot/src/channels/github.ts
  -> packages/github createGitHubBotChannel()
  -> packages/github planDelivery()
  -> dispatch({ agent: "d0lt-bot", id: channel conversation key, input })
  -> d0lt-bot agent instance
  -> channel registry parses id as github
  -> base prompt + @repo/github instructions.md
  -> router gets comment_on_github_issue bound to the verified issue/PR
  -> subagent does sandbox work
  -> router posts final GitHub comment
```

Key contracts:

- `packages/github/src/github-webhook.ts` keeps webhook decision logic pure.
- `packages/github/src/github-channel.ts` dispatches by agent name, never by
  importing the agent.
- `commentOnIssue(ref)` binds the destination from the verified delivery, so the
  model supplies only the comment body.
- `fetch_repo` returns a clone command; it does not clone itself.

## Slack Request Flow

```
Slack Events API
  -> bots/d0lt-bot/src/channels/slack.ts
  -> packages/slack createSlackBotChannel()
  -> packages/slack planSlackEvent()
  -> optional thread-context fetch
  -> dispatch({ agent: "d0lt-bot", id: channel conversation key, input })
  -> d0lt-bot agent instance
  -> channel registry parses id as slack
  -> base prompt + @repo/slack instructions.md
  -> router gets reply_in_slack_thread and post_slack_progress
  -> subagents also get post_slack_progress
  -> router posts final Slack reply
```

Key contracts:

- `packages/slack/src/slack-events.ts` keeps event planning pure and does network
  thread-context work separately.
- `replyInThread(ref)` fails loud because the final reply matters.
- `postProgressInThread(ref)` fails quiet because progress messages must not abort
  the main work.
- `toMrkdwn()` converts the model's GFM-ish output to Slack mrkdwn before posting.

## Sandbox Selection

The router owns one sandbox per agent instance. The implementation is selected at
runtime:

```
FLUE_SANDBOX unset/local
  -> dynamic import("@repo/sandbox/node")
  -> host local() sandbox

FLUE_SANDBOX=cloudflare or workerd runtime
  -> dynamic import("@repo/sandbox/cloudflare")
  -> Cloudflare Sandbox container Durable Object
```

The dynamic import boundary is load-bearing. Do not statically import
`@repo/sandbox/node` or `@repo/sandbox/cloudflare` from shared code; the node adapter
pulls in `child_process`, which cannot enter the workerd bundle.

## Prompt Composition

Each turn gets:

1. `bots/d0lt-bot/src/agents/d0lt-bot.md`
2. The channel package's `instructions.md`, only when the conversation id parses as
   that channel.

The registry in `bots/d0lt-bot/src/agents/d0lt-bot.ts` keeps prompt fragments and
channel tool binding together, while each registry entry is created by that
channel's package through its `./agent-integration` export. The bot chooses which
integrations are installed; the package owns the parser, prompt fragment, and
router/subagent tools for its own channel. The generic resolver and shared types
live in `@repo/channel-registry`.

## Testing Strategy

Channel logic is tested below the agent graph:

- GitHub: drive `planDelivery()` and inject fake Octokit clients.
- Slack: drive `planSlackEvent()`, `fetchThreadContext()`, and tool factories with
  fake WebClient instances.
- Sandbox: test selection and lazy provisioning with fake sandboxes.
- Chat UI: test stream projection logic in `apps/chat/src/lib/`, not in React
  components.

The agent graph imports markdown with `with { type: "markdown" }`, so avoid pulling
the graph into ordinary Vitest unit tests.
