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
- **Interaction planning** — `planSlackInteraction()` is the pure inbound twin for block actions:
  when a user clicks a button or selects a menu the bot posted, Slack delivers it to
  `/channels/slack/interactions` and the function re-enters the same thread's agent as a
  `slack.block_action` turn.
- **`reply_with_blocks` / `postProgressInThread`** — the agent's outbound tools, bound at
  construction to the thread from the verified event, so the model supplies only the blocks/text,
  never the destination. `reply_with_blocks` posts a [Block Kit](https://docs.slack.dev/block-kit/)
  message; plain prose goes in a `markdown` block, which renders GFM directly (no mrkdwn
  conversion for the final reply). The reply tool throws on Slack post failures (loud) and returns
  an error object on invalid blocks so the model can retry; the progress tool swallows failures (a
  transient Slack hiccup mid-run must not abort the work).
- **Block Kit helpers** — `BlocksSchema` (valibot subset of Block Kit) and `translateBlocks()`
  (validates, converts `mrkdwn`-typed text objects, assigns `action_id`s, derives the fallback).
- **`toMrkdwn`** — converts GitHub-flavored markdown to Slack mrkdwn (bold, links, headings,
  bullets; tables degrade to bullet lines). Used for `post_slack_progress` notes and for
  `mrkdwn`-typed text objects inside blocks; `markdown` blocks pass GFM verbatim.
- **`workerdSafeFetch`** — a `fetch` wrapper that makes `@slack/web-api` work on Cloudflare Workers.
- **`createSlackBotChannel`** — constructs the Flue channel (wiring both an `events` and an
  `interactions` handler under the same `SLACK_SIGNING_SECRET` verification), so the bot's
  discovered `channels/slack.ts` is a thin shim that just passes `{ enabled, signingSecret?,
  agentName }`. It dispatches to the agent by name, so the shim never imports the agent (no
  channel ⇄ agent cycle).
- **`slack-block-kit` skill** — `skills/slack-block-kit/SKILL.md`, exported as
  `"./skills/slack-block-kit/SKILL.md"`, registered on the d0lt-bot agent only for Slack-channel
  turns. Teaches the model which block to use for what.

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

## Slack app setup

Configure these in the Slack app's settings (`api.slack.com/apps`) to point it at a bot that mounts
this channel. The URLs are the routes this package serves, relative to wherever the bot mounts Flue
— replace `https://<your-app>` with the bot's public origin:

- **Event Subscriptions → Request URL:** `https://<your-app>/channels/slack/events`
- **Subscribe to bot events:** `app_mention` and `message.im`
- **Interactivity & Shortcuts → turn on Interactivity, Request URL:**
  `https://<your-app>/channels/slack/interactions` — required for the buttons and menus the bot
  posts via `reply_with_blocks`; without it, a click does nothing. Like the events endpoint it is
  served by `createSlackBotChannel` and verifies `X-Slack-Signature` with the same
  `SLACK_SIGNING_SECRET` (no extra secret), and only responds once the channel is enabled. Slack
  sends a verification `POST` when you save the URL, so the bot must be running and the channel
  enabled at that moment.
- **OAuth scopes:** `app_mentions:read`, `chat:write`, and the `*:history` scopes for the
  conversations the bot runs in — `channels:history`, `groups:history`, `im:history`,
  `mpim:history` (a threaded mention reads earlier messages via `conversations.replies` for
  context). Posting Block Kit messages and receiving button clicks needs no scope beyond
  `chat:write`.

The package reads no environment itself: the consuming bot supplies `SLACK_SIGNING_SECRET` (to
verify inbound requests) and `SLACK_BOT_TOKEN` (`xoxb-…`, for outbound replies and reading thread
context) and enables the channel — see the bot's own README for where those values go per target.

## Public API

```ts
import {
  planSlackEvent, planSlackInteraction,
  postProgressInThread, workerdSafeFetch, client,
  type SlackDispatchPlan, type SlackDispatchInput,
  createSlackBotChannel, type SlackBotChannelOptions,
  toMrkdwn, BlocksSchema, translateBlocks,
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
