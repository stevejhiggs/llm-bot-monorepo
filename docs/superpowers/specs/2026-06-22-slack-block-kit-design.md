# Slack Block Kit: rich message authoring + interactivity

**Date:** 2026-06-22
**Status:** Approved design, pre-implementation
**Package:** `@repo/slack` (with one wiring change in `bots/d0lt-bot`)

## Summary

Give the d0lt-bot agent the ability to (1) post **rich Slack messages** — markdown,
tables, cards, status banners, buttons and menus — instead of plain mrkdwn text, and
(2) **react to clicks**, where an interaction (button click / menu selection) re-enters
the agent as a new turn in the same thread.

The agent authors blocks through a single new outbound tool, `reply_with_blocks`, whose
`blocks` argument is a **validated subset of real Block Kit** (valibot schema mirroring
Slack's field names). A new `slack-block-kit` skill — owned by `@repo/slack`, mirroring
the existing `@repo/github` `explore-repo` skill — teaches the agent which block to use
for what, and the limits.

This is the larger "option B" scope chosen during brainstorming (rich authoring now, plus
the teaching skill), as opposed to a buttons-only first cut.

## Background & key findings

- **`@flue/slack` already supports interactivity natively.** `createSlackChannel` accepts
  an `interactions?(input)` handler and, when present, auto-serves a signature-verified
  `/interactions` route, delivering a pre-parsed `SlackBlockActionsPayload`. There is **no
  new endpoint or HMAC plumbing to build** — only wiring inside `@repo/slack`, symmetric
  with the existing events path (`events/plan.ts` → `channel/channel.ts` → `dispatch`).
- **Slack shipped a `markdown` block** (renders standard/GFM markdown directly: bold,
  italic, links, lists, code, **tables**, task lists; 12k-char cumulative limit;
  non-interactive). The agent already emits GFM, so this **supersedes the lossy
  `toMrkdwn` conversion on the blocks path** (`toMrkdwn` degrades GFM tables to bullets).
  The `markdown` block is the **default text vehicle** in this design.
- **Slack shipped native tables** — a static `table` block (≤100 rows × 20 cols) and a
  heavier interactive `data_table` (deferred). For most agent output, GFM tables inside a
  `markdown` block are the simplest path; the native `table` block is used when strict
  column control or programmatic rows are wanted.
- **The `card` block** is Slack's flagship "agent experience" block (icon/title/subtitle/
  hero image/short body/up to 3 buttons). It is **in v1** at the user's request.
- **Surface caveat (verified the hard way):** Slack's per-block reference pages do not
  all restate which surfaces a block supports, and the marketing/changelog summaries are
  unreliable about it — e.g. the "agent experiences" blog implies `alert` works in
  messages, but the `alert` reference states it is **"only supported in modals."** So
  `alert` is **excluded from v1** (it cannot render in a thread message) and folded into
  the deferred-with-modals bucket. `markdown` and `card` message support is taken from
  Slack's product positioning (both exist to let agents post rich *messages*); because the
  reference pages don't quote it verbatim, the implementation plan **smoke-tests rendering
  in a real channel first** before the schema is built around them.
- **Single reply tool.** Because the `markdown` block renders GFM directly (and more
  faithfully than the lossy `toMrkdwn` path — tables survive), the agent posts every reply
  through `reply_with_blocks`: plain prose is just one `markdown` block. This makes the
  `markdown` block load-bearing for all replies, so the Task 1 smoke-test of that block is a
  prerequisite, and replies longer than the block's 12,000-char limit are split across
  multiple messages. `reply_in_slack_thread` is retained in code (exported, unbound) as a
  fast rollback.
- **`data_visualization` is in v1** (added at the user's request): a self-contained chart
  block (`pie`/`bar`/`area`/`line`, ≤6 series/segments, ≤50-char title), non-interactive,
  no nested blocks. Its message-surface support is likewise unverified, so it is included in
  the same smoke test. `plan` was considered but **deferred** — it nests the deferred
  `task_card` block, fits a review/test bot poorly, and is the most likely to be a
  non-message surface.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| What a click does | **Re-enters the agent** as a new turn in the same thread. |
| Who authors blocks | **The agent**, via the `reply_with_blocks` tool. |
| First interaction to design around | **Generic confirm** (yes/no gate before an action). |
| DSL shape | **Validated subset mirroring real Block Kit field names** (not a bespoke abstraction, not raw passthrough). |
| Default text vehicle | **`markdown` block** (GFM passthrough); `section.text`+mrkdwn only when an accessory is needed. |
| Skill location | `@repo/slack`, mirroring `@repo/github`'s `explore-repo` skill. |
| `card` block | **In v1.** |
| Reply tools | **Single `reply_with_blocks`.** Plain prose is sent as one `markdown` block; there is no separate plain-text reply tool bound to the agent. `reply_in_slack_thread` stays in code (exported, unbound) as a rollback until the smoke test confirms the `markdown` block renders in messages. This removes the "when to use blocks" decision entirely. |

## Scope: supported Block Kit subset (v1)

**Blocks:** `markdown` (default text), `header`, `section` (+`fields`, +accessory),
`context`, `divider`, `image`, `table`, `card`, `data_visualization`, `actions`.

**Interactive elements:** `button`, `overflow`, `static_select` — usable in an `actions`
block, as a `section` accessory, and inside a `card`'s actions (≤3 buttons).

**Deferred** (schema + skill extend later through the *same* interactions handler):
`alert` (modal-only), `carousel`, `data_table`, `plan` (nests the deferred `task_card`
block), `task_card`, `file`, `video`, `rich_text`; modals (`view_submission`/`view_closed`),
`input` and `context_actions`
blocks; advanced selects (external/users/conversations/channels + multi-selects),
date/time pickers, checkboxes, radio buttons, inputs, `feedback_buttons`, `icon_button`,
`workflow_button`; dynamic menu options (`block_suggestion`); slash commands; shortcuts.

## Architecture

The design is **symmetric with the existing events path**. Events have a pure decision
function (`events/plan.ts`) wired to `dispatch` in `channel/channel.ts`. Interactions get
the same two-layer split. Block authoring is an isolated, pure DSL→Block Kit translator
plus one thread-bound tool.

### Components

| File | Status | Purpose |
|---|---|---|
| `format/block-schema.ts` | new | valibot schema for the supported Block Kit subset (the DSL the model fills). Mirrors Slack field names. |
| `format/blocks.ts` | new | Pure translate validated DSL → Slack Block Kit JSON; assign/namespace `action_id`s for interactive elements; enforce count/size limits not expressible in the schema. Unit-tested, no Slack coupling. |
| `channel/actions.ts` | new | The `reply_with_blocks` tool, bound to one verified thread (like `replyInThread`). Params `{ blocks, text? }`. Validates, translates, posts via `chat.postMessage`. |
| `interactions/plan.ts` | new | Pure `planSlackInteraction(payload) → SlackInteractionPlan \| null`. Mirrors `events/plan.ts`. Narrows to `block_actions`; normalizes button/overflow/static_select; reconstructs the thread ref from the signed payload. |
| `channel/interactions-ack.ts` | new | Best-effort `response_url` update that swaps an `actions` block for a resolved state (disable buttons after click). Failures swallowed + logged. |
| `channel/channel.ts` | edit | Add the `interactions` handler to the `createSlackChannel` call; factor the shared `dispatch` into a helper used by both `events` and `interactions`. |
| `channel/agent-integration.ts` | edit | Add `replyWithBlocks(ref)` to the **router** toolset. |
| `channel/instructions.md` | edit | Short section: rich messages via `reply_with_blocks`; clicks/selections arrive as `slack.block_action` turns; defer detail to the skill. |
| `interactions/plan.ts` (`SlackBlockActionInput`) | new (in the file above) | The click-turn type lives beside `planSlackInteraction` as a standalone `SlackBlockActionInput` (below), **not** folded into `events/plan.ts`'s `SlackDispatchInput` — the two turn shapes share no fields, so a forced union would carry dead fields. Both flow through `dispatch` as JSON identically. |
| `index.ts` | edit | Export the new public surface. |
| `skills/slack-block-kit/SKILL.md` (+ optional `references/`) | new | The teaching skill (below). |
| `package.json` (`@repo/slack`) | edit | Add `exports` entry `"./skills/slack-block-kit/SKILL.md": "./src/skills/slack-block-kit/SKILL.md"`. |
| `bots/d0lt-bot/src/agents/d0lt-bot.ts` | edit | Import the skill; add it to `skills` **only when `conversation.source === "slack"`** (GitHub/chat turns omit it). |

### The outbound tool: `reply_with_blocks`

valibot params:

- `blocks`: array (1–50) of blocks conforming to `block-schema.ts`.
- `text`: optional string — the notification/accessibility fallback. Auto-derived from
  the first `header`/`markdown`/`section` text if omitted.

Behavior:

- Destination thread is **fixed at bind time** from the verified event (same property as
  `replyInThread`); the model supplies only block content, never channel/thread.
- valibot validation → the model retries on a malformed block (consistent with existing
  tools). `format/blocks.ts` then enforces limits not expressible in the schema (≤50
  blocks, ≤5 buttons per `actions`, ≤3 buttons per `card`, char limits) and **owns
  `action_id` assignment/namespacing** for interactive elements — this is what makes
  click-routing reliable and is why raw Block Kit passthrough is rejected.
- `markdown` block carries GFM **verbatim** (no `toMrkdwn`). `section.text` and other
  mrkdwn fields still pass through `toMrkdwn`.
- Posts via `chat.postMessage({ channel, thread_ts, text, blocks })`. Returns
  `{ channel, ts }`.

### Interpreting a click — `SlackBlockActionInput` (in `interactions/plan.ts`)

```ts
{
  type: "slack.block_action";
  elementType: "button" | "overflow" | "static_select";
  actionId: string;
  value: string;     // button value, or selected_option.value for menus
  blockId: string;
  userId: string;    // who clicked (any thread member may click)
  text: string;      // synthesized, e.g. 'User clicked "Deploy".'
}
```

The agent both authored the buttons and interprets the click; correlation rides in
`value` + the durable agent's own memory of what it posted. **No server-side pending-
interaction state.**

### Data flow — generic confirm

1. Agent gates an action → `reply_with_blocks({ blocks: [ markdown prompt, actions:
   [Yes(primary,value:"confirm"), Cancel(danger,value:"cancel")] ] })`.
2. Tool validates + translates + posts to the bound thread; returns ts.
3. User clicks. Slack POSTs a signed `block_actions` payload to `/interactions`;
   `@flue/slack` verifies and calls our handler.
4. `planSlackInteraction` reconstructs `SlackThreadRef` from the payload (`team.id`,
   `container.channel_id`, `container.thread_ts ?? message_ts`), normalizes the
   triggering element, synthesizes the turn.
5. Handler fires a best-effort `response_url` update ("✅ You chose: Yes"), then
   `dispatch({ agent, id: channel.conversationKey(ref), input })` and returns `200`.
6. The durable per-thread agent wakes with the click turn and proceeds.

## The skill: `slack-block-kit`

Owned by `@repo/slack`, mirroring `@repo/github`'s `explore-repo` skill exactly:

- **Location:** `packages/slack/src/skills/slack-block-kit/SKILL.md` (+ optional
  `references/`; the github skill uses none, so keep `SKILL.md` lean and only add
  references if the catalog earns it).
- **Export:** `package.json` → `"./skills/slack-block-kit/SKILL.md":
  "./src/skills/slack-block-kit/SKILL.md"`.
- **Import:** `d0lt-bot.ts` → `import slackBlockKit from
  "@repo/slack/skills/slack-block-kit/SKILL.md" with { type: "skill" }`; add to
  `skills: [...]`.

Registered on the agent **only for Slack-channel turns** (keyed off the
`conversation.source` the channel registry already returns) — the same way the
`reply_with_blocks` tool and the Slack instructions fragment are channel-scoped. GitHub and
chat turns never see it. `exploreRepo` stays unconditional (repo inspection is
cross-channel). And because skills load on demand by name + description (progressive
disclosure), even on a Slack turn it costs nothing in context until the agent decides to
compose a rich message.

**`SKILL.md` content (lean):**

- Frontmatter: `name: slack-block-kit` (must match the directory name); `description`
  telling the agent to use it when composing rich Slack messages with `reply_with_blocks`,
  and that it explains which block to use for what and the limits.
- Body — a purpose-oriented decision guide:
  - **Text →** `markdown` block (pass GFM straight through, incl. tables). Default choice.
  - **Title →** `header`.
  - **Compact entity summary (deployment/PR/ticket) →** `card` (short body, ≤3 buttons).
  - **Strict columnar / many-row data →** `table` block.
  - **Charts (counts/breakdowns over a few categories) →** `data_visualization`
    (`pie`/`bar`/`area`/`line`, ≤6 series/segments).
  - **Small key/value pairs →** `section` + `fields`.
  - **Muted metadata →** `context`. **Separator →** `divider`.
  - **Status/urgency →** a `markdown` block led with an emoji (⚠️ warning, ✅ success,
    ❌ error). (The native `alert` block is modal-only and cannot be used in messages.)
  - **Asking the user to choose/confirm →** `actions` with `button`/`static_select`/
    `overflow`; clicks come back as `slack.block_action` turns, so put correlation info in
    each element's `value`.
  - The hard limits (≤50 blocks; ≤5 buttons/`actions`; ≤3 buttons/`card`; 75-char button
    labels; 150/200-char card fields; 12k-char markdown; 100×20 table) and `mrkdwn` vs
    `plain_text` rules.
  - 2–3 copy-paste DSL patterns: a confirm, a labeled summary card, a results table.

## Error handling, edge cases, security

- **Unhandled interaction types** (`view_submission`, `shortcut`, …) → `plan` returns
  `null` → empty `200`, exactly like unhandled events. The handler **never throws** (a 500
  makes Slack retry).
- **Malformed payload** (missing channel/thread) → `null` + `console.warn`, empty `200`.
- **`response_url` update is best-effort** — failures swallowed + logged, like
  `postProgressInThread`.
- **Double-click / retries** — primary guard is disabling buttons via `response_url`;
  secondary is the agent being idempotent on its own proposal.
- **Who can click** — any thread member can click a rendered element; the clicker's
  `userId` is passed to the agent, which (via instructions) decides whether that matters.
  A hard "only the original requester" lock is a **noted future extension**, not built now.
- **No value injection** — users can only interact with elements we rendered; requests are
  Slack-signed; `value`/`action_id` are always what we set.
- **Destination integrity** — preserved: the model never supplies channel/thread.

## Testing (mirrors existing `.test.ts` layout)

- `format/block-schema` + `format/blocks` — valid DSL → correct Slack JSON; invalid →
  schema error; limit enforcement (block count, buttons/`actions`, buttons/`card`, char
  caps); `action_id` assignment; `markdown` GFM passthrough vs `section` mrkdwn conversion.
- `interactions/plan` — `block_actions` for button/overflow/static_select → correct ref +
  normalized input; non-`block_actions` → `null`; malformed → `null`.
- `channel/actions` — tool posts blocks with an injected client; destination fixed; returns
  ts; `text` fallback derived when omitted.
- `channel/channel` — interactions handler wires plan → dispatch with the right
  conversation id; disabled channel ignores clicks.

## Out of scope (v1)

Everything in the **Deferred** list above. All of it is reachable later through the same
`interactions` handler + a schema extension + a skill update — no architectural change
required. `data_table`, `carousel`, and modals each carry their own interaction/event
surface and deserve their own scope.

## References

- Blocks reference: https://docs.slack.dev/reference/block-kit/blocks/
- Markdown block: https://docs.slack.dev/reference/block-kit/blocks/markdown-block/
- Table block: https://docs.slack.dev/reference/block-kit/blocks/table-block/
- Card block: https://docs.slack.dev/reference/block-kit/blocks/card-block/
- Build richer agent experiences with Block Kit: https://slack.dev/build-richer-agent-experiences-with-block-kit/
- `@flue/slack` types: `node_modules/@flue/slack/dist/index.d.mts` (`SlackChannelOptions.interactions`, `SlackBlockActionsPayload`)
- Existing patterns: `packages/slack/src/events/plan.ts`, `channel/channel.ts`, `channel/reply.ts`; `packages/github/src/skills/explore-repo/SKILL.md`
