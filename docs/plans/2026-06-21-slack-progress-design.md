# Slack progress updates — design

**Date:** 2026-06-21
**Status:** accepted

## Problem

A Slack-driven run (review or test) posts **only the final result**, after 30–60s of
silent work. Users want to be told what's happening as it happens.

## Decisions

1. **Granularity:** coarse milestones as **separate thread messages** (not one
   edited-in-place card). e.g. `🔧 On it…`, `📦 Cloning & installing…`,
   `🧪 Running tests…`, then the final result.
2. **Target:** must work on **both** node and Cloudflare. This rules out
   `observe()` (in-isolate only) → progress is **model-driven** via a thread-bound
   tool the model calls.
3. **Framework:** stay on **Flue** (Chat SDK would be a lateral re-plumb of the
   channel layer and doesn't solve the real blocker — see below).
4. **Final result formatting:** the model keeps emitting GitHub-flavored markdown;
   a converter turns it into Slack **mrkdwn** (lossy for tables). Posted as a
   mrkdwn `text` message (not Block Kit blocks, whose 3000-char section limit is
   worse for long test output).

### Why not Chat SDK (chat-sdk.dev)

It's a multi-platform bot framework (adapters, JSX cards, post+edit streaming) but
is AI-agnostic — it does **not** own the agent loop. The hard part here is that the
middle milestones happen **inside the subagents while the router is blocked on its
`task`**, which is a Flue agent-loop concern. Chat SDK wouldn't help; adopting it
means replacing working `createSlackChannel`/`dispatch` code plus adding a state
backend. Revisit only if we want edit-in-place cards or many more platforms.

## Design

### Why subagents must post

The router delegates the actual work (clone/install/test) to a subagent via the
built-in `task` capability and is **blocked** until it returns. So the middle
milestones can only come from the subagent. The router posts the opening ack and
the final result; the subagent posts the phase markers in between.

### Components

- **`lib/slack-format.ts`** (new, pure, unit-tested): `toMrkdwn(md): string`.
  Conversions: `**bold**`→`*bold*`, `[t](u)`→`<u|t>`, headings→bold lines,
  `~~x~~`→`~x~`, 2-column tables→`• key: value`, bullets→`•`. Inline/fenced code
  left untouched. Deliberately lossy for tables.
- **`lib/slack-events.ts`**:
  - `postProgressInThread(ref, slack?)` → `post_slack_progress` tool. Short text,
    a new message per call, destination fixed at bind time (same anti-redirect
    contract as the reply tool). **Best-effort:** catches/logs Slack errors and
    returns `{ ok:false }` so a failed progress post never aborts the run.
  - `replyInThread` runs its text through `toMrkdwn` before posting.
- **`subagents/reviewer.ts` / `test-runner.ts`**: become factories accepting
  `extraTools: ToolDefinition[]`, built in the router initializer where the
  conversation `id` is known.
- **`agents/d0lt-bot.ts`**: derive the Slack ref from `id`; for a Slack
  conversation inject `post_slack_progress` into both subagents **and** the router
  (alongside `reply_in_slack_thread`). Non-Slack ids inject nothing — the tool is
  absent and uncallable.
- **Instructions:** `d0lt-bot.md` (Slack section: ack before delegating, result
  via reply tool); `test-runner.md` / `reviewer.md` (post one short line before
  each major phase if the progress tool is available; never put results there).

### Message flow (Slack run)

1. Router → `post_slack_progress` opening ack.
2. Subagent → `post_slack_progress` per phase.
3. Router → `reply_in_slack_thread` final (mrkdwn-converted) result.

### Non-goals

- Edit-in-place / single status card (needs a shared message `ts` across sessions
  and isolates — a persistent store; revisit if we move to single-actor progress).
- Progress on GitHub (would spam a PR) or chat (the web UI already shows live tool
  activity).

## Testing

Offline Vitest with an injected fake `WebClient`:
- `slack-format.test.ts` — `toMrkdwn` cases (bold, links, table→bullets, headings,
  strikethrough, code untouched).
- `slack-events.test.ts` — `post_slack_progress` posts to the bound thread and
  swallows errors; `replyInThread` converts markdown before posting.

## Verification

`pnpm typecheck`, `pnpm test`, `pnpm lint`, and — because this touches channels —
**both** `pnpm build` and `pnpm --filter d0lt-bot build:cf`.
