---
name: slack-block-kit
description: Use when composing any Slack reply with the `reply_with_blocks` tool — it is the single reply tool, so even plain prose is sent as one `markdown` block. Covers choosing which block to use (markdown, table, card, data_visualization, section/fields, context, header, buttons, menus) for what purpose, and staying within Slack's limits.
---

You are composing a Slack message as a `blocks` array passed to `reply_with_blocks`. Each
block is a JSON object with a `type`. Pick the simplest blocks that convey the result.

## Which block for what

- **Prose / any formatted text → `markdown`.** This renders standard GitHub-flavored
  markdown directly (bold, italic, links, lists, code, **tables**, task lists). This is
  your default for text. Example: `{ "type": "markdown", "text": "**Done.** See `repo/`." }`
- **A heading → `header`** (`text` is a `plain_text` object, ≤150 chars).
- **A compact summary of one entity** (a deployment, PR, ticket) **→ `card`**: optional
  `title`/`subtitle` (≤150), short `body`/`subtext` (≤200), optional `icon`/`hero_image`,
  and optional `actions` with **up to 3 buttons**. Use for a glanceable summary, not long text.
- **Tabular data → a `markdown` block with a GFM table** (easiest), or the native
  **`table`** block when you want strict columns/many rows (`rows` of cells
  `{ "type": "raw_text", "text": "…" }`, ≤100 rows × 20 cols).
- **A chart of counts/breakdowns over a few categories → `data_visualization`**: a `title`
  (≤50) plus a `chart` that is either `pie` (`segments` of `{label, value}`, 1–6) or
  `bar`/`area`/`line` (`series` of `{name, data:[{label, value}]}`, 1–6, plus an
  `axis_config` whose `categories` list every data `label` used). Use for small summaries
  (e.g. tests passed vs failed), not large datasets.
- **A few labelled key/values → `section` with `fields`** (≤10 `mrkdwn`/`plain_text` items).
- **Muted metadata → `context`.** **A separator → `divider`.**
- **Status / urgency →** a `markdown` block led with an emoji: ⚠️ warning, ✅ success,
  ❌ error. (Slack's native `alert` block does not work in messages.)
- **Ask the user to choose or confirm → an `actions` block** (≤5 elements) with `button`s,
  a `static_select`, or an `overflow`. Buttons take `text` (`plain_text`, ≤75), an optional
  `style` of `primary` or `danger`, and a `value`.

## Handling the click

A button click or menu selection comes back to you later as a **`slack.block_action`** turn
carrying `elementType`, `actionId`, `value`, and `userId`. So put whatever you need to act
on into each element's **`value`** (e.g. `"value": "confirm-deploy"`). You don't manage any
IDs yourself — when the turn arrives, correlate its `value` with what you posted and continue.

## Limits

≤50 blocks per message · `actions` ≤5 elements · `card.actions` ≤3 buttons · button label
≤75 chars · card title/subtitle ≤150 · card body/subtext ≤200 · `markdown` ≤12000 chars ·
table ≤100 rows × 20 columns · chart title ≤50, ≤6 series/segments, data labels ≤20.
Inside text objects, `mrkdwn` is converted from your markdown
for you; `plain_text` is shown literally; a `markdown` block is rendered as-is.
If a reply would exceed 12,000 characters, split it across multiple `reply_with_blocks` messages rather than truncating.

## Example: a confirm gate

```json
[
  { "type": "markdown", "text": "About to deploy **v2** to prod. Proceed?" },
  { "type": "actions", "elements": [
    { "type": "button", "text": { "type": "plain_text", "text": "Yes, deploy" }, "style": "primary", "value": "confirm" },
    { "type": "button", "text": { "type": "plain_text", "text": "Cancel" }, "style": "danger", "value": "cancel" }
  ] }
]
```
