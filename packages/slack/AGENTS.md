# AGENTS.md — @repo/slack

Agent-facing companion for `@repo/slack`. See [`README.md`](README.md) for the human overview.
Slack logic that is unit-testable in isolation: Events API decision logic, the outbound
reply/progress tools, the GFM → mrkdwn converter, and the channel factory. The bot's discovered
`channels/slack.ts` is a thin shim that calls `createSlackBotChannel` with bot-owned values
(enablement, the resolved signing secret, the agent name).

## What's in here

The package is grouped into domain folders along its pure/side-effecting boundary —
`events/` (pure inbound decision for Events API), `interactions/` (pure inbound decision for block
actions), `channel/` (the Flue channel plus everything that talks to the Slack Web API, and the
agent-registry wiring), `format/` (the pure GFM → mrkdwn converter and Block Kit schema/helpers),
and `skills/` (agent skills) — plus the public `index.ts` barrel. Files are named for their role
within a folder; nothing carries a redundant `slack-` prefix.

```
src/
├─ index.ts                       # public export surface (see Public API)
├─ events/
│  ├─ plan.ts                     # planSlackEvent() + SlackDispatch* types (pure inbound decision)
│  └─ plan.test.ts
├─ interactions/
│  └─ plan.ts                     # planSlackInteraction() — pure inbound decision for block actions
├─ channel/
│  ├─ channel.ts                  # createSlackBotChannel() — constructs the Flue channel (events + interactions handlers)
│  ├─ client.ts                   # the shared WebClient + workerdSafeFetch()
│  ├─ thread-context.ts           # fetchThreadContext(), enrichWithThreadContext() — inbound enrichment
│  ├─ reply.ts                    # postProgressInThread() — best-effort progress tool
│  ├─ actions.ts                  # reply_with_blocks tool definition
│  ├─ interactions-ack.ts         # resolveInteractiveMessage() — best-effort message update after a click
│  ├─ agent-integration.ts        # tested core for the bot's registry entry
│  ├─ default-agent-integration.ts # ./agent-integration export; attaches instructions.md
│  ├─ instructions.md             # the agent's "When the turn comes from Slack" prompt fragment (see below)
│  ├─ client.test.ts
│  ├─ thread-context.test.ts
│  └─ reply.test.ts
├─ format/
│  ├─ mrkdwn.ts                   # toMrkdwn() — GitHub-flavored markdown → Slack mrkdwn (pure)
│  ├─ block-schema.ts             # BlocksSchema — valibot subset of Block Kit blocks
│  ├─ blocks.ts                   # translateBlocks() — validates, converts mrkdwn, assigns action_ids, derives fallback
│  └─ mrkdwn.test.ts
└─ skills/
   └─ slack-block-kit/
      └─ SKILL.md                 # slack-block-kit skill — teaches the agent which Block Kit block to use
```

`planSlackEvent` (pure) and `toMrkdwn` (pure) sit in `events/` and `format/`; everything that needs
the `WebClient` — the thread-context fetch and the reply/progress tools — sits in `channel/` next to
the shared `client`. That keeps the folder boundary aligned with what each piece can be tested
against (a pure call vs an injected fake `WebClient`).

`channel/instructions.md` is the Slack-specific section of the agent's prompt, exposed via the
package's `exports` map (`"./instructions.md"`) and attached by the package's `./agent-integration`
export. Keeping it here puts the prose describing `reply_with_blocks` / `post_slack_progress` /
`threadContext` next to the tools it documents. See the root AGENTS.md "Source-dependent prompt".

## Public API

From `events/plan.ts`:
- `planSlackEvent(payload): SlackDispatchPlan | null` — pure decision logic. The plan carries
  `messageTs` (the trigger's own `ts`) so the channel can tell a threaded reply apart from a root.
- types `SlackDispatchPlan`, `SlackDispatchInput`.

From `interactions/plan.ts`:
- `planSlackInteraction(payload): { ref, input } | null` — pure inbound decision for block actions
  (button clicks, overflow menu, static select). The inbound twin of `events/plan.ts`; handles
  `button`, `overflow`, and `static_select` action types. Returns `null` for everything else.

From `channel/client.ts`:
- `workerdSafeFetch(baseFetch?): typeof fetch` — the fetch wrapper for `@slack/web-api` on workerd.
- `client` — a shared `WebClient` (the default for the tool factories + thread-context fetch), built
  with `workerdSafeFetch`.

From `channel/thread-context.ts`:
- `fetchThreadContext({ channelId, threadTs, excludeTs }, slack?, max?)` — reads a thread via
  `conversations.replies` (paginated, capped) and formats the most recent `max` messages
  oldest-first, excluding the trigger; `null` if empty. Needs the bot token to carry `*:history`.
- `enrichWithThreadContext(plan, slack?)` — returns the input to dispatch, attaching `threadContext`
  when the turn is a reply inside an existing thread (`ref.threadTs !== messageTs`). Fail-quiet.

From `channel/reply.ts` / `channel/actions.ts`:
- `reply_with_blocks` (defined in `actions.ts`) — Flue tool factory for the final reply; posts a
  Block Kit message into the bound thread. The model supplies a validated `blocks` array (and
  optional `text` fallback); destination is fixed at bind time. Throws on a Slack post failure
  (loud); returns an error object to the model on invalid blocks so the model can retry.
- `postProgressInThread(ref, slack?)` — Flue tool factory for best-effort progress notes (quiet).

From `format/mrkdwn.ts`:
- `toMrkdwn(markdown: string): string` — pure GFM → mrkdwn conversion.

From `format/block-schema.ts`:
- `BlocksSchema` — valibot subset of Block Kit: markdown/header/section/context/divider/image/
  table/card/data_visualization/actions blocks; button/overflow/static_select elements.

From `format/blocks.ts`:
- `translateBlocks(blocks)` — validates the model's blocks array against `BlocksSchema`, converts
  `mrkdwn`-typed text objects via `toMrkdwn`, assigns `action_id`s, and derives the `text` fallback.

From `channel/interactions-ack.ts`:
- `resolveInteractiveMessage(responseUrl, blocks?)` — posts a best-effort message update to
  `response_url` after a block action click; swallows failures.

From `channel/channel.ts`:
- `createSlackBotChannel(options): SlackChannel` — builds the Flue channel. `options` is
  `{ enabled, signingSecret?, agentName }`; the package reads no env. Wires both an `events`
  handler (`planSlackEvent` → `enrichWithThreadContext` → `dispatch`) and an `interactions` handler
  (`planSlackInteraction` → `dispatch`, re-entering the same thread's agent as a `slack.block_action`
  turn) under the same `SLACK_SIGNING_SECRET` verification. The interactions endpoint is
  auto-served at `/channels/slack/interactions`.
- type `SlackBotChannelOptions`.

From `./agent-integration` (`channel/default-agent-integration.ts`):
- `createSlackAgentIntegration(channel): SlackAgentIntegration` — returns the bot's registry entry
  for Slack: package-owned prompt fragment, `channel.parseConversationKey`, router
  `reply_with_blocks` / `post_slack_progress`, and subagent `post_slack_progress`.
- type `SlackAgentIntegration`.

## Contracts (do not break these)

### 1. The destination is fixed at bind time

`planSlackEvent` returns `null` for everything the bot doesn't act on (so the channel answers an
empty 200) — handled cases are `app_mention` and a DM (`channel_type === "im"`) from a real user
(not a bot post, not an edit/system subtype), so a reply can never re-trigger the bot. Both tool
factories bind `channelId` + `threadTs` from the **verified** event, so the model supplies only the
text and cannot post elsewhere.

### 2. Reply fails loud; progress fails quiet

`reply_with_blocks` throws on a failed Slack post — the final result must reach the user or surface
an error. On invalid blocks (schema validation failure) it returns an error object to the model so
the model can retry with corrected blocks, rather than crashing the turn.
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
agent binds `reply_with_blocks` and `postProgressInThread` per conversation: the router posts the
opening ack and the final reply as a Block Kit message (plain prose in a `markdown` block renders
GFM directly — no `toMrkdwn` pass for the final reply; `toMrkdwn` still applies inside
`post_slack_progress` notes and for `mrkdwn`-typed text objects within blocks), and the subagents
post progress milestones in between. When a user clicks a button or selects a menu, the
`/channels/slack/interactions` endpoint re-enters the same thread's agent as a `slack.block_action`
turn. The `slack-block-kit` skill (`skills/slack-block-kit/SKILL.md`, exported as
`"./skills/slack-block-kit/SKILL.md"`) is registered on the d0lt-bot agent only for Slack-channel
turns, teaching the model which block to use for what.

## Dependencies

`@flue/runtime` (catalog `flue`, `1.0.0-beta.3`) + `@flue/slack` (catalog `flue`, `1.0.0-beta.1` —
no beta.2/beta.3 published), `@repo/channel-registry` for the shared agent-integration type shape,
`@slack/web-api` + `valibot` (catalog `external`). No dependency on `@repo/sandbox` or
`@repo/github`.

## Tests

```bash
pnpm --filter @repo/slack test       # vitest run — pure, offline
pnpm --filter @repo/slack typecheck  # tsc --noEmit
```

`events/plan.test.ts` drives `planSlackEvent` with hand-built payloads. `channel/reply.test.ts` and
`channel/thread-context.test.ts` exercise the tool factories and the thread fetch with an
**injected fake `WebClient`**; `channel/client.test.ts` asserts the `workerdSafeFetch` rewrite with
a fake `baseFetch`. `format/mrkdwn.test.ts` covers `toMrkdwn` conversions directly. No network, no
live runtime.
