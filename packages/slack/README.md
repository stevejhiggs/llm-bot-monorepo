# @repo/slack

Slack building blocks for the Flue bots in this monorepo: Events API decision logic, the outbound
reply/progress tools, and a GitHub-flavored-markdown → Slack-mrkdwn converter. Everything here is
**pure or client-injectable**, so it can be unit-tested without a live Flue runtime or network — the
reason this logic lives in a package rather than in a bot's discovered `channels/*.ts`.

It is **source-only**: no build step. Consumers import the `.ts` directly via the package's
`exports`.

## What it gives a bot

- **Event planning** — `planSlackEvent()` decides what (if anything) a verified Events API delivery
  should dispatch to the agent (an `@`-mention, or a DM), returning `{ ref, input } | null`. Pure.
- **`replyInThread` / `postProgressInThread`** — the agent's outbound tools, bound at construction
  to the thread from the verified event, so the model supplies only the text, never the
  destination. The reply tool surfaces failures; the progress tool swallows them (a transient Slack
  hiccup mid-run must not abort the work).
- **`toMrkdwn`** — converts the model's GitHub-flavored markdown to Slack mrkdwn (bold, links,
  headings, bullets; tables degrade to bullet lines). Slack does not render GFM.
- **`workerdSafeFetch`** — a `fetch` wrapper that makes `@slack/web-api` work on Cloudflare Workers.
- **`createSlackBotChannel`** — constructs the Flue channel, so the bot's discovered
  `channels/slack.ts` is a thin shim that just passes `{ enabled, signingSecret?, agentName }`. It
  dispatches to the agent by name, so the shim never imports the agent (no channel ⇄ agent cycle).

## Public API

```ts
import {
  planSlackEvent, replyInThread, postProgressInThread, workerdSafeFetch, client,
  type SlackDispatchPlan, type SlackDispatchInput,
  createSlackBotChannel, type SlackBotChannelOptions,
  toMrkdwn,
} from "@repo/slack";
```

## Tests

```bash
pnpm --filter @repo/slack test       # vitest run
pnpm --filter @repo/slack typecheck  # tsc --noEmit
```

See [`AGENTS.md`](AGENTS.md) for the contracts (destination-fixed-at-bind-time, the workerd fetch
fixes, the lossy-by-design mrkdwn conversion) and how the bot's discovered channel wires these in.
Monorepo-wide conventions live in the [root `AGENTS.md`](../../AGENTS.md).
