# AGENTS.md — @repo/slack

Agent-facing companion for `@repo/slack`. See [`README.md`](README.md) for the human overview.
Slack logic that is unit-testable in isolation: Events API decision logic, the outbound
reply/progress tools, the GFM → mrkdwn converter, and the channel factory. The bot's discovered
`channels/slack.ts` is a thin shim that calls `createSlackBotChannel` with bot-owned values
(enablement, the resolved signing secret, the agent name).

## What's in here

```
src/
├─ index.ts             # public export surface (see Public API)
├─ slack-events.ts      # planSlackEvent(), fetchThreadContext(), enrichWithThreadContext(),
│                       #   replyInThread(), postProgressInThread(), workerdSafeFetch(),
│                       #   WebClient + types
├─ slack-format.ts      # toMrkdwn() — GitHub-flavored markdown → Slack mrkdwn (pure)
├─ slack-channel.ts     # createSlackBotChannel() — constructs the Flue channel for the bot's shim
├─ instructions.md      # the agent's "When the turn comes from Slack" prompt fragment (see below)
├─ slack-events.test.ts
└─ slack-format.test.ts
```

`instructions.md` is the Slack-specific section of the agent's prompt, exposed via the package's
`exports` map (`"./instructions.md"`) and imported by the bot with `with { type: "markdown" }`.
Keeping it here puts the prose describing `reply_in_slack_thread` / `post_slack_progress` /
`threadContext` next to the tools it documents. See the root AGENTS.md "Source-dependent prompt".

## Public API

From `slack-events.ts`:
- `planSlackEvent(payload): SlackDispatchPlan | null` — pure decision logic. The plan carries
  `messageTs` (the trigger's own `ts`) so the channel can tell a threaded reply apart from a root.
- `fetchThreadContext({ channelId, threadTs, excludeTs }, slack?, max?)` — reads a thread via
  `conversations.replies` (paginated, capped) and formats the most recent `max` messages
  oldest-first, excluding the trigger; `null` if empty. Needs the bot token to carry `*:history`.
- `enrichWithThreadContext(plan, slack?)` — returns the input to dispatch, attaching `threadContext`
  when the turn is a reply inside an existing thread (`ref.threadTs !== messageTs`). Fail-quiet.
- `replyInThread(ref, slack?)` — Flue tool factory for the final reply; bound to one thread.
- `postProgressInThread(ref, slack?)` — Flue tool factory for best-effort progress notes.
- `workerdSafeFetch(baseFetch?): typeof fetch` — the fetch wrapper for `@slack/web-api` on workerd.
- `client` — a shared `WebClient` (the default for the tool factories), built with
  `workerdSafeFetch`.
- types `SlackDispatchPlan`, `SlackDispatchInput`.

From `slack-format.ts`:
- `toMrkdwn(markdown: string): string` — pure GFM → mrkdwn conversion.

From `slack-channel.ts`:
- `createSlackBotChannel(options): SlackChannel` — builds the Flue channel. `options` is
  `{ enabled, signingSecret?, agentName }`; the package reads no env. The handler runs
  `planSlackEvent`, then `enrichWithThreadContext` (attaches prior thread messages for a threaded
  turn), then dispatches by name (`dispatch({ agent: agentName, ... })`).
- type `SlackBotChannelOptions`.

## Contracts (do not break these)

### 1. The destination is fixed at bind time

`planSlackEvent` returns `null` for everything the bot doesn't act on (so the channel answers an
empty 200) — handled cases are `app_mention` and a DM (`channel_type === "im"`) from a real user
(not a bot post, not an edit/system subtype), so a reply can never re-trigger the bot. Both tool
factories bind `channelId` + `threadTs` from the **verified** event, so the model supplies only the
text and cannot post elsewhere.

### 2. Reply fails loud; progress fails quiet

`replyInThread` lets a failed post throw — the final result must reach the user or surface an error.
`postProgressInThread` swallows a failed post (logs, returns `{ ok: false }`): a transient Slack
hiccup while narrating a long run must not abort the work. Keep this asymmetry. The progress tool is
injected into the **subagents** (not just the router) so they can post phase milestones while the
router is blocked on its `task`.

### 3. `workerdSafeFetch` is required on Cloudflare — keep both fixes

`@slack/web-api` mishandles workerd two ways, both patched here: it calls its stored fetch as a
method (`this.fetchFn(...)`), which workerd rejects unless `this === globalThis` (so the wrapper is
the bound default fetch), and it sets `redirect: "error"`, which workerd rejects (so the wrapper
rewrites it to `"manual"`; Slack never redirects). `baseFetch` is injectable so the rewrite is
unit-tested without a network.

### 4. `toMrkdwn` is deliberately lossy

Slack renders mrkdwn, not GFM: single-asterisk bold, `<url|text>` links, no tables. The converter
masks fenced/inline code first (so a `**` inside code stays literal), degrades tables to bullet
lines, then rewrites bold/italic/strike/headings/bullets/links. It is a pragmatic, lossy converter,
not a full markdown engine — don't grow it into one.

### 5. The channel dispatches by name, never by an agent import

`createSlackBotChannel` dispatches with `dispatch({ agent: agentName, ... })`, so the shim has no
import edge to the agent (the agent imports `channel` for `parseConversationKey`, one-directional).
Don't import the agent into a channel.

### 6. Thread-context fetch is separate from the pure plan, and fails quiet

`planSlackEvent` stays **pure** (no network) — the thread fetch lives in `fetchThreadContext` /
`enrichWithThreadContext`, called by the channel handler with the shared `client`. Keep that split
so the plan stays unit-testable without a network. `enrichWithThreadContext` only fetches for a
threaded reply (`ref.threadTs !== messageTs`) and, like `postProgressInThread`, **fails quiet**: a
failed or empty fetch dispatches the turn without `threadContext` rather than dropping it. The fetch
labels authors with raw Slack ids (no `users.info`) and caps both the message count and page-follows.

## How the bot consumes it

`channels/slack.ts` calls `createSlackBotChannel(...)` and exports the result as `channel`. The
agent binds `replyInThread` and `postProgressInThread` per conversation: the router posts the
opening ack and the final reply (through `toMrkdwn`), and the subagents post progress milestones in
between.

## Dependencies

`@flue/runtime` + `@flue/slack` (catalog `flue`; `@flue/runtime` must resolve to the patched
`1.0.0-beta.2`), `@slack/web-api` + `valibot` (catalog `external`). No dependency on `@repo/sandbox`
or `@repo/github`.

## Tests

```bash
pnpm --filter @repo/slack test       # vitest run — pure, offline
pnpm --filter @repo/slack typecheck  # tsc --noEmit
```

`slack-events.test.ts` drives `planSlackEvent` with hand-built payloads, exercises the tool
factories with an **injected fake `WebClient`**, and asserts the `workerdSafeFetch` rewrite with a
fake `baseFetch`. `slack-format.test.ts` covers `toMrkdwn` conversions directly. No network, no live
runtime.
