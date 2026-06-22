# AGENTS.md — @repo/slack

Agent-facing companion for `@repo/slack`. See [`README.md`](README.md) for the human overview.
This package holds the Slack logic that must be unit-testable in isolation: Events API decision
logic, the outbound reply/progress tools, and the GFM → mrkdwn converter. It does not construct or
own a Flue channel — the bot's discovered `bots/d0lt-bot/src/channels/slack.ts` does that and
imports from here.

## What's in here

```
src/
├─ index.ts             # public export surface (see Public API)
├─ slack-events.ts      # planSlackEvent(), replyInThread(), postProgressInThread(),
│                       #   workerdSafeFetch(), WebClient + types
├─ slack-format.ts      # toMrkdwn() — GitHub-flavored markdown → Slack mrkdwn (pure)
├─ slack-events.test.ts
└─ slack-format.test.ts
```

## Public API

From `slack-events.ts`:
- `planSlackEvent(payload): SlackDispatchPlan | null` — pure decision logic.
- `replyInThread(ref, slack?)` — Flue tool factory for the final reply; bound to one thread.
- `postProgressInThread(ref, slack?)` — Flue tool factory for best-effort progress notes.
- `workerdSafeFetch(baseFetch?): typeof fetch` — the fetch wrapper for `@slack/web-api` on workerd.
- `client` — a shared `WebClient` (the default for the tool factories), built with
  `workerdSafeFetch`.
- types `SlackDispatchPlan`, `SlackDispatchInput`.

From `slack-format.ts`:
- `toMrkdwn(markdown: string): string` — pure GFM → mrkdwn conversion.

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
lines, then rewrites bold/italic/strike/headings/bullets/links. It is a pragmatic, lossy converter —
not a full markdown engine. Don't grow it into one; if a construct renders acceptably in Slack
already, leave it.

## How the bot consumes it

`bots/d0lt-bot/src/channels/slack.ts` (thin, Flue-discovered) imports `planSlackEvent` and, on a
verified event, dispatches `{ id: conversationKey(plan.ref), input: plan.input }` to the agent. It
re-exports `replyInThread`; the agent binds it (and `postProgressInThread`) per conversation. The
router posts the opening ack and the final reply (running the model's markdown through `toMrkdwn`);
the subagents post the progress milestones in between. The channel file stays in the bot because
Flue's discovery requires `channels/*.ts` there and it imports the agent to `dispatch()`.

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
