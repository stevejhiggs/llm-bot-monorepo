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

## Event handling

`planSlackEvent(payload)` is the pure decision: given a verified Events API delivery, it returns
`{ ref, input } | null` — `null` for everything the bot doesn't act on (the channel then answers an
empty 200). What it acts on:

- **An @-mention** (`app_mention`) in a channel or thread — e.g. `@d0lt-bot review
  https://github.com/owner/repo/pull/1`.
- **A direct message** to the bot (`message` with `channel_type: im`).

In both cases the message text is treated like a chat request (a GitHub URL + what to do), and the
result is posted back in-thread. Because a run takes a while, the bot also posts coarse progress
milestones in the thread (cloning, installing, running tests) via `postProgressInThread` before the
final reply. Messages from bots and edited/system messages are ignored, so a reply can't re-trigger
the bot. Slack expects a fast `2xx` and retries on timeout/non-2xx, so the channel acks immediately
and processes the work asynchronously; retries are not deduplicated (messages in the same thread
serialize on one instance).

## Public API

```ts
import {
  planSlackEvent, replyInThread, postProgressInThread, workerdSafeFetch, client,
  type SlackDispatchPlan, type SlackDispatchInput,
  createSlackBotChannel, type SlackBotChannelOptions,
  toMrkdwn,
} from "@repo/slack";

import { createSlackAgentIntegration } from "@repo/slack/agent-integration";
```

## Tests

```bash
pnpm --filter @repo/slack test       # vitest run
pnpm --filter @repo/slack typecheck  # tsc --noEmit
```

See [`AGENTS.md`](AGENTS.md) for the contracts (destination-fixed-at-bind-time, the workerd fetch
fixes, the lossy-by-design mrkdwn conversion) and how the bot's discovered channel wires these in.
Monorepo-wide conventions live in the [root `AGENTS.md`](../../AGENTS.md).
