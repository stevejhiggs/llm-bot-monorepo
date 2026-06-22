# Slack thread context for dispatch

**Date:** 2026-06-22
**Status:** Approved

## Problem

When d0lt-bot is @-mentioned inside an existing Slack thread, the dispatched turn
carries only the text of the mention message itself (`SlackDispatchInput.text`).
The bot has no view of the conversation that preceded the mention, so a message
like "review that PR" — where the PR URL was posted earlier in the thread — has no
referent. We want to fetch the surrounding thread and pass it to the agent as
context.

## Decisions

- **Trigger:** only when the mention/DM is a reply *inside an existing thread*
  (`thread_ts` present and `!== ts`). Top-level mentions and plain DMs dispatch
  exactly as today — no extra API call, no context.
- **Scope:** the most recent ~20 messages of the thread (oldest-first), excluding
  the triggering message. Bounded pagination caps a pathological thread.
- **Usernames:** kept as raw Slack IDs; no `users.info` resolution (YAGNI).
- **Failure mode:** fail-quiet. A failed fetch logs and dispatches the turn
  *without* context — a Slack hiccup must never drop the turn.

## Architecture

`planSlackEvent` stays **pure** (no network — a documented package contract). The
thread fetch is a separate network step in `slack-events.ts`, behind an injected
`WebClient` so it is unit-testable with a fake client, matching the existing tool
pattern.

### Type changes (`slack-events.ts`)

- `SlackDispatchPlan` gains `messageTs: string` — the triggering message's own
  `ts`. "In a thread" is then `ref.threadTs !== messageTs`. This single field
  drives both the gate and the trigger-exclusion. It is **not** sent to the model.
- `SlackDispatchInput` gains optional `threadContext?: string`.

### New functions (`slack-events.ts`)

```ts
fetchThreadContext(
  args: { channelId: string; threadTs: string; excludeTs: string },
  slack?: WebClient,
  max = 20,
): Promise<string | null>
```
Calls `conversations.replies` with bounded pagination (≤ a few pages as a safety
cap; logs if it truncates). Drops the triggering message (`excludeTs`). Takes the
most recent `max` of what remains and formats them oldest-first, one line per
message, labelled `[bot]` for the bot's own prior posts (those carrying `bot_id`)
or `[<USERID>]` otherwise. Returns `null` when nothing remains (e.g. the only
other messages were filtered out).

```ts
enrichWithThreadContext(plan, slack?): Promise<SlackDispatchInput>
```
Orchestrator. If `plan.ref.threadTs === plan.messageTs` (not a thread), returns
`plan.input` unchanged with no API call. Otherwise calls `fetchThreadContext`; on a
non-null result, returns `{ ...plan.input, threadContext }`; on `null` or any
thrown error, logs and returns `plan.input` unchanged (fail-quiet).

### Wiring (`slack-channel.ts`)

The events handler stays thin:

```ts
const plan = planSlackEvent(payload);
if (!plan) return;
const input = await enrichWithThreadContext(plan);   // shared client
await dispatch({ agent: agentName, id: channel.conversationKey(plan.ref), input });
```

### Agent (`d0lt-bot.md`)

The "When the turn comes from Slack" section notes a `threadContext` field may
carry earlier thread messages (oldest-first, context only): use it to resolve
references like "review that PR", but the actual request is still in `text`.

### Docs

`conversations.replies` requires the existing `SLACK_BOT_TOKEN` to carry history
scopes. Add `channels:history` / `groups:history` / `im:history` / `mpim:history`
to the documented scopes in `bots/d0lt-bot/README.md` (and confirm `.env.example`).

## Testing

Pure, offline Vitest with an injected fake `WebClient`:

- `fetchThreadContext`: paginates across pages; excludes the triggering message;
  slices to the most recent `max`; formats `[bot]` vs `[<USERID>]` oldest-first;
  returns `null` when empty.
- `enrichWithThreadContext`: not-threaded → no fetch, input unchanged; threaded →
  attaches `threadContext`; fetch error → input unchanged (fail-quiet).
- `planSlackEvent`: now also asserts `messageTs` is populated.

## Out of scope

- Username/display-name resolution.
- Reaction, file, or block content in the context (text only).
- Per-message truncation (the 20-message cap bounds size).
