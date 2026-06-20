# Slack channel integration for d0lt-bot

Date: 2026-06-20
Status: approved

## Goal

Let users drive d0lt-bot from Slack: @-mention the bot (or DM it) with a GitHub
PR/repo URL and an instruction; the bot does the work and replies in the Slack
thread. Follows the Flue Slack channel blueprint (`flue add channel slack`,
`channel/slack@1`). Mirrors the GitHub channel already in the project.

## Surfaces (decided)

- **`app_mention`** — the bot acts when @-mentioned in a channel or thread.
- **`message` with `channel_type === "im"`** — direct messages, so users can DM
  the bot without an @-mention.
- Ignore everything else (channel messages without a mention, `app_rate_limited`,
  etc.). Ignore messages with a `bot_id` or a `subtype` (bot/edited/system
  messages) to prevent self-triggers and loops.
- `interactions` and `commands` surfaces are not wired (omission removes those
  routes).

## Architecture (reuse the existing router agent)

Same pattern as `channels/github.ts`: the channel verifies and dispatches to the
existing `d0lt-bot` agent, which routes to the `reviewer` / `test_runner`
subagents and posts its result back through a thread-bound tool.

```
Slack ──POST /channels/slack/events──▶ @flue/slack verifies signature + timestamp
                  │  planSlackEvent(payload) → { ref, input } | null
                  │  dispatch(d0ltBot, { id: conversationKey(ref), input })
                  ▼
            d0lt-bot agent instance (one per Slack thread)
                  │  reads `text` as the request (like chat) → reviewer/test_runner
                  ▼  replies in-thread
            reply_in_slack_thread tool → @slack/web-api chat.postMessage
```

Unlike GitHub (where the PR URL comes from the comment's context and is
pre-resolved into `target.url`), a Slack message carries the URL in its text —
exactly like a chat message. So the dispatched input just forwards the text and
the agent extracts the URL itself, reusing its existing chat routing.

## Components

### `src/channels/slack.ts` (new, thin discovered channel)
- `export const channel = createSlackChannel({ signingSecret: process.env.SLACK_SIGNING_SECRET!, async events({ payload }) { ... } })`.
- The `events` handler calls `planSlackEvent(payload)`; if non-null,
  `await dispatch(d0ltBot, { id: channel.conversationKey(plan.ref), input: plan.input })`.
- `export { replyInThread } from "../lib/slack-events.ts"`.

### `src/lib/slack-events.ts` (new, testable — mirrors github-webhook.ts)
- `export const client = new WebClient(process.env.SLACK_BOT_TOKEN)`.
- `export function planSlackEvent(payload): { ref: SlackThreadRef; input: SlackDispatchInput } | null` —
  pure: no network, no dispatch, no channel coupling.
  - `payload.type !== "event_callback"` → null.
  - `app_mention` → `{ type: "slack.app_mention", eventId, text }`.
  - `message` with `channel_type === "im"`, no `bot_id`, no `subtype` →
    `{ type: "slack.message.im", eventId, text }`.
  - otherwise → null.
  - `ref = { teamId: payload.team_id, channelId: event.channel, threadTs: event.thread_ts ?? event.ts }`.
- `export function replyInThread(ref: { channelId: string; threadTs: string }, slack = client)` —
  `reply_in_slack_thread` tool (valibot `text` param) calling
  `slack.chat.postMessage({ channel: ref.channelId, thread_ts: ref.threadTs, text })`
  and returning `{ channel, ts }`. `slack` injectable for tests.

### `src/agents/d0lt-bot.ts` (edit)
Refactor the existing `githubTools(id)` into a `channelTools(id)` resolver that
tries each channel's `parseConversationKey(id)` in turn and binds the matching
outbound tool:
- GitHub conversation key → `commentOnIssue(ref)`.
- Slack conversation key → `replyInThread({ channelId, threadTs })`.
- neither (chat id like `local`) → no channel tool.

Channel ⇄ agent import cycles remain safe because all cross-module bindings are
read inside the deferred initializer.

### `src/agents/d0lt-bot.md` (edit)
Add a "When the turn comes from Slack" section: the `text` is the user's request
(a GitHub URL + what to do); handle it exactly like a chat request (route to the
right subagent); then **post the result back by calling `reply_in_slack_thread`**.

### Config / secrets (edit)
- `.env.example`, `.dev.vars`: add `SLACK_SIGNING_SECRET` (verify ingress) and
  `SLACK_BOT_TOKEN` (outbound Web API).
- `README.md`: document the Event Subscriptions request URL
  (`/channels/slack/events`), the subscribed events (`app_mention`, `message.im`),
  the two secrets, and `wrangler secret put`. `@slack/web-api` v8 runs on
  Cloudflare under the existing `nodejs_compat` flag.

### Dependencies
`@flue/slack` and `@slack/web-api@^8.0.0-rc.1`.

## Testing (`src/lib/slack-events.test.ts`)

Pure-logic + tool tests; no network.
- `app_mention` → plan with `slack.app_mention` + correct ref.
- IM `message` (no bot_id/subtype) → plan with `slack.message.im`.
- `message` with `bot_id` → null (loop prevention).
- `message` with a `subtype` → null.
- channel `message` (`channel_type !== "im"`) → null.
- `app_rate_limited` payload → null.
- `threadTs` falls back to `ts` when `thread_ts` is absent.
- `replyInThread` posts the right `channel`/`thread_ts`/`text` and returns
  `{ channel, ts }` via an injected fake client.

Then run typecheck, both Flue builds (node + cloudflare), and lint.

## Out of scope (YAGNI)

- Slack interactivity and slash commands.
- Events API retry deduplication (the channel does not dedup; thread dispatches
  serialize on one instance — documented, same as the GitHub channel).
