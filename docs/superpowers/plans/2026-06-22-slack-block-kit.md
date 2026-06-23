# Slack Block Kit (rich authoring + interactivity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the d0lt-bot agent post rich Slack messages (markdown, table, card, buttons, menus) via a validated `reply_with_blocks` tool, and react to clicks by re-entering the agent as a new turn through `@flue/slack`'s native `/interactions` route.

**Architecture:** Symmetric with the existing Slack *events* path. A pure DSL (valibot schema mirroring Block Kit) is translated to Slack JSON and posted by one thread-bound tool. Interactions get a pure `planSlackInteraction` decision function wired into `createSlackChannel`'s `interactions` handler, dispatching into the same per-thread agent conversation. A `slack-block-kit` skill owned by `@repo/slack` teaches block usage.

**Tech Stack:** TypeScript (Node 24 / workerd), `@flue/runtime` (`defineTool`, `dispatch`), `@flue/slack` (`createSlackChannel`), `@slack/web-api` (`WebClient`), `valibot`, `vitest`.

## Global Constraints

- Package: `@repo/slack` at `packages/slack`. One consumer edit in `bots/d0lt-bot/src/agents/d0lt-bot.ts`.
- All new modules are `.ts` with explicit `.ts` import specifiers (match existing files, e.g. `./client.ts`).
- Schemas use `valibot` imported as `import * as v from "valibot"` (matches `channel/reply.ts`).
- Tools use `defineTool` from `@flue/runtime`; `execute` returns a **string** (JSON), matching `channel/reply.ts`.
- The model writes GitHub-flavored markdown. `mrkdwn` text objects are converted with the existing `toMrkdwn` from `format/mrkdwn.ts`; `markdown` blocks pass text **verbatim** (Slack renders GFM); `plain_text` is never converted.
- Outbound destination is **fixed at bind time** from the verified thread `ref`; tools accept only content, never channel/thread.
- Handlers must **never throw**: unhandled/malformed interactions return `null` → empty `200`. Best-effort side calls (response_url) swallow + log errors, like `postProgressInThread`.
- v1 block subset: `markdown`, `header`, `section` (+`fields`/accessory), `context`, `divider`, `image`, `table` (raw_text cells), `card`, `data_visualization`; container `actions`. Interactive elements: `button`, `overflow`, `static_select`. **`alert` is excluded** (modal-only — cannot render in a message); **`plan` is deferred** (nests the deferred `task_card` block).
- Limits (enforced in schema or translator): ≤50 blocks/message; `actions` ≤5 elements; `card.actions` ≤3 buttons (buttons only); button label ≤75; card `title`/`subtitle` ≤150, `body`/`subtext` ≤200; `markdown` text ≤12000; `table` ≤100 rows × ≤20 cols; `action_id` ≤255; `data_visualization` title ≤50, ≤6 series/segments, chart-data labels ≤20, axis labels ≤50.
- Never put secrets in the skill directory (Flue rejects them at packaging).
- Run a single test file from the package dir: `cd packages/slack && pnpm exec vitest run <relpath>`. Run all package tests: `pnpm --filter @repo/slack test`. Typecheck: `pnpm --filter @repo/slack typecheck`.

---

## Task 1: Spike — confirm `card`/`markdown`/`table` render in a real message

De-risks the unverified assumption: Slack's per-block reference pages don't restate surface support, and the marketing docs proved unreliable (`alert` is modal-only despite the blog implying otherwise). Confirm the v1 blocks — including the two whose surface support is unconfirmed, `card` and `data_visualization` — actually render in a `chat.postMessage` thread before building the schema around them. **No unit test — this is an external-API spike.**

**Files:**
- Create (temporary, deleted at end): `packages/slack/scripts/blockkit-spike.mjs`

- [ ] **Step 1: Write a throwaway spike script**

```js
// packages/slack/scripts/blockkit-spike.mjs
// Run: SLACK_BOT_TOKEN=xoxb-... SPIKE_CHANNEL=C0XXXX node packages/slack/scripts/blockkit-spike.mjs
import { WebClient } from "@slack/web-api";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const res = await slack.chat.postMessage({
  channel: process.env.SPIKE_CHANNEL,
  text: "block kit spike",
  blocks: [
    { type: "markdown", text: "**Hello** from a `markdown` block\n\n| A | B |\n|---|---|\n| 1 | 2 |" },
    { type: "table", rows: [
      [{ type: "raw_text", text: "Header A" }, { type: "raw_text", text: "Header B" }],
      [{ type: "raw_text", text: "Data 1" }, { type: "raw_text", text: "Data 2" }],
    ] },
    { type: "card",
      title: { type: "plain_text", text: "Deploy v2" },
      body: { type: "mrkdwn", text: "Ready to ship to *prod*." },
      actions: { type: "actions", elements: [
        { type: "button", text: { type: "plain_text", text: "Deploy" }, value: "confirm", style: "primary", action_id: "spike_confirm" },
      ] } },
    { type: "data_visualization", title: "Test results",
      chart: { type: "pie", segments: [
        { label: "passed", value: 42 }, { label: "failed", value: 3 },
      ] } },
  ],
});
console.log(JSON.stringify({ ok: res.ok, ts: res.ts }, null, 2));
```

- [ ] **Step 2: Run it against a test channel**

Run: `SLACK_BOT_TOKEN=xoxb-... SPIKE_CHANNEL=C0XXXX node packages/slack/scripts/blockkit-spike.mjs`
Expected: `{ "ok": true, "ts": "..." }` and a Slack message showing a formatted markdown table, a native table, a card with a Deploy button, and a pie chart.

- [ ] **Step 3: Record the result and handle failure**

If `markdown`, `table`, `card`, or `data_visualization` is rejected (`invalid_blocks`) or renders as raw JSON, that block is not message-capable on this workspace — **stop and report** which block failed so the subset can be revised (e.g. fall back to `section`+`fields` for tables, or drop `data_visualization`). If all four render, proceed.

- [ ] **Step 4: Delete the spike script and commit nothing**

```bash
rm packages/slack/scripts/blockkit-spike.mjs
```

No commit (the script was never committed). Note the outcome in the task tracker.

---

## Task 2: Block Kit DSL schema

The valibot schema the model fills. Purely structural (shapes, enums, lengths, counts). Cross-field rules (`section` needs text-or-fields; `card` needs one-of) live in the translator (Task 3) so the discriminated `variant` options stay plain objects.

**Files:**
- Create: `packages/slack/src/format/block-schema.ts`
- Test: `packages/slack/src/format/block-schema.test.ts`

**Interfaces:**
- Produces: `BlocksSchema` (a valibot schema; `v.parse(BlocksSchema, x)` validates a `blocks` array), and types `Block`, `Blocks` (`v.InferOutput`). Also exports `ImageElement`, `Button`, `Overflow`, `StaticSelect` schemas for reuse/testing.

- [ ] **Step 1: Write the failing test**

```ts
// packages/slack/src/format/block-schema.test.ts
import { expect, test } from "vitest";
import * as v from "valibot";
import { BlocksSchema } from "./block-schema.ts";

test("accepts a markdown + actions message", () => {
  const blocks = [
    { type: "markdown", text: "**hi**" },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Yes" }, value: "y", style: "primary" },
    ] },
  ];
  expect(() => v.parse(BlocksSchema, blocks)).not.toThrow();
});

test("accepts a card with up to 3 buttons", () => {
  const blocks = [{
    type: "card",
    title: { type: "plain_text", text: "T" },
    body: { type: "mrkdwn", text: "b" },
    actions: { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "A" }, value: "a" },
      { type: "button", text: { type: "plain_text", text: "B" }, value: "b" },
      { type: "button", text: { type: "plain_text", text: "C" }, value: "c" },
    ] },
  }];
  expect(() => v.parse(BlocksSchema, blocks)).not.toThrow();
});

test("accepts a pie and a bar data_visualization", () => {
  const blocks = [
    { type: "data_visualization", title: "Results",
      chart: { type: "pie", segments: [{ label: "ok", value: 9 }] } },
    { type: "data_visualization", title: "Trend",
      chart: { type: "bar",
        series: [{ name: "runs", data: [{ label: "mon", value: 3 }] }],
        axis_config: { categories: ["mon"] } } },
  ];
  expect(() => v.parse(BlocksSchema, blocks)).not.toThrow();
});

test("rejects a pie chart with more than 6 segments", () => {
  const seg = { label: "x", value: 1 };
  const blocks = [{ type: "data_visualization", title: "T",
    chart: { type: "pie", segments: Array(7).fill(seg) } }];
  expect(() => v.parse(BlocksSchema, blocks)).toThrow();
});

test("accepts a table and a static_select", () => {
  const blocks = [
    { type: "table", rows: [[{ type: "raw_text", text: "A" }], [{ type: "raw_text", text: "1" }]] },
    { type: "actions", elements: [
      { type: "static_select", placeholder: { type: "plain_text", text: "Pick" },
        options: [{ text: { type: "plain_text", text: "One" }, value: "1" }] },
    ] },
  ];
  expect(() => v.parse(BlocksSchema, blocks)).not.toThrow();
});

test("rejects an unknown block type", () => {
  expect(() => v.parse(BlocksSchema, [{ type: "carousel" }])).toThrow();
});

test("rejects a button label longer than 75 chars", () => {
  const blocks = [{ type: "actions", elements: [
    { type: "button", text: { type: "plain_text", text: "x".repeat(76) }, value: "v" },
  ] }];
  expect(() => v.parse(BlocksSchema, blocks)).toThrow();
});

test("rejects an actions block with 6 elements", () => {
  const button = { type: "button", text: { type: "plain_text", text: "b" }, value: "v" };
  expect(() => v.parse(BlocksSchema, [{ type: "actions", elements: Array(6).fill(button) }])).toThrow();
});

test("rejects card actions with 4 buttons", () => {
  const button = { type: "button", text: { type: "plain_text", text: "b" }, value: "v" };
  const blocks = [{ type: "card", title: { type: "plain_text", text: "T" },
    actions: { type: "actions", elements: Array(4).fill(button) } }];
  expect(() => v.parse(BlocksSchema, blocks)).toThrow();
});

test("rejects more than 50 blocks", () => {
  const divider = { type: "divider" };
  expect(() => v.parse(BlocksSchema, Array(51).fill(divider))).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/slack && pnpm exec vitest run src/format/block-schema.test.ts`
Expected: FAIL — cannot resolve `./block-schema.ts`.

- [ ] **Step 3: Write the schema**

```ts
// packages/slack/src/format/block-schema.ts
// The validated Block Kit subset the agent authors through `reply_with_blocks`.
// Mirrors Slack's field names so the skill can lean on Slack's reference. Purely
// structural: cross-field rules (section text|fields, card one-of) and action_id
// assignment live in `./blocks.ts`, keeping the discriminated `variant` options as
// plain objects (valibot `variant` inspects object entries for the discriminator).

import * as v from "valibot";

const bounded = (max?: number) =>
  max ? v.pipe(v.string(), v.minLength(1), v.maxLength(max)) : v.pipe(v.string(), v.minLength(1));

const plainText = (max?: number) =>
  v.object({ type: v.literal("plain_text"), text: bounded(max), emoji: v.optional(v.boolean()) });
const mrkdwn = (max?: number) => v.object({ type: v.literal("mrkdwn"), text: bounded(max) });
const textObject = (max?: number) => v.variant("type", [plainText(max), mrkdwn(max)]);

const ActionId = v.pipe(v.string(), v.minLength(1), v.maxLength(255));
const Value = v.pipe(v.string(), v.minLength(1), v.maxLength(2000));

export const ImageElement = v.object({
  type: v.literal("image"),
  image_url: v.pipe(v.string(), v.minLength(1), v.maxLength(3000)),
  alt_text: v.pipe(v.string(), v.minLength(1)),
});

export const Button = v.object({
  type: v.literal("button"),
  text: plainText(75),
  value: v.optional(Value),
  action_id: v.optional(ActionId),
  style: v.optional(v.picklist(["primary", "danger"])),
  url: v.optional(v.pipe(v.string(), v.maxLength(3000))),
});

const SelectOption = v.object({ text: plainText(75), value: Value });

export const Overflow = v.object({
  type: v.literal("overflow"),
  action_id: v.optional(ActionId),
  options: v.pipe(v.array(SelectOption), v.minLength(2), v.maxLength(5)),
});

export const StaticSelect = v.object({
  type: v.literal("static_select"),
  action_id: v.optional(ActionId),
  placeholder: plainText(150),
  options: v.pipe(v.array(SelectOption), v.minLength(1), v.maxLength(100)),
});

const InteractiveElement = v.variant("type", [Button, Overflow, StaticSelect]);
const Accessory = v.variant("type", [Button, Overflow, StaticSelect, ImageElement]);

const MarkdownBlock = v.object({ type: v.literal("markdown"), text: bounded(12000) });
const HeaderBlock = v.object({ type: v.literal("header"), text: plainText(150) });
const SectionBlock = v.object({
  type: v.literal("section"),
  text: v.optional(textObject(3000)),
  fields: v.optional(v.pipe(v.array(textObject(2000)), v.minLength(1), v.maxLength(10))),
  accessory: v.optional(Accessory),
});
const ContextBlock = v.object({
  type: v.literal("context"),
  elements: v.pipe(
    v.array(v.variant("type", [plainText(), mrkdwn(), ImageElement])),
    v.minLength(1),
    v.maxLength(10),
  ),
});
const DividerBlock = v.object({ type: v.literal("divider") });
const ImageBlock = v.object({
  type: v.literal("image"),
  image_url: v.pipe(v.string(), v.minLength(1), v.maxLength(3000)),
  alt_text: v.pipe(v.string(), v.minLength(1)),
  title: v.optional(plainText(2000)),
});
const ActionsBlock = v.object({
  type: v.literal("actions"),
  elements: v.pipe(v.array(InteractiveElement), v.minLength(1), v.maxLength(5)),
});
const TableCell = v.object({ type: v.literal("raw_text"), text: v.string() });
const TableBlock = v.object({
  type: v.literal("table"),
  rows: v.pipe(
    v.array(v.pipe(v.array(TableCell), v.minLength(1), v.maxLength(20))),
    v.minLength(1),
    v.maxLength(100),
  ),
});
const CardActions = v.object({
  type: v.literal("actions"),
  elements: v.pipe(v.array(Button), v.minLength(1), v.maxLength(3)),
});
const CardBlock = v.object({
  type: v.literal("card"),
  title: v.optional(textObject(150)),
  subtitle: v.optional(textObject(150)),
  body: v.optional(textObject(200)),
  subtext: v.optional(textObject(200)),
  icon: v.optional(ImageElement),
  hero_image: v.optional(ImageElement),
  actions: v.optional(CardActions),
});

const PositiveNumber = v.pipe(v.number(), v.check((n) => n > 0, "value must be greater than 0"));
const PieSegment = v.object({ label: bounded(20), value: PositiveNumber });
const PieChart = v.object({
  type: v.literal("pie"),
  segments: v.pipe(v.array(PieSegment), v.minLength(1), v.maxLength(6)),
});
const DataPoint = v.object({ label: bounded(20), value: v.number() });
const Series = v.object({
  name: bounded(20),
  data: v.pipe(v.array(DataPoint), v.minLength(1)),
});
const AxisConfig = v.object({
  categories: v.pipe(v.array(bounded(20)), v.minLength(1)),
  x_label: v.optional(bounded(50)),
  y_label: v.optional(bounded(50)),
});
const CartesianChart = v.object({
  type: v.picklist(["bar", "area", "line"]),
  series: v.pipe(v.array(Series), v.minLength(1), v.maxLength(6)),
  axis_config: AxisConfig,
});
const DataVisualizationBlock = v.object({
  type: v.literal("data_visualization"),
  title: bounded(50),
  chart: v.union([PieChart, CartesianChart]),
});

const BlockSchema = v.variant("type", [
  MarkdownBlock, HeaderBlock, SectionBlock, ContextBlock, DividerBlock,
  ImageBlock, ActionsBlock, TableBlock, CardBlock, DataVisualizationBlock,
]);

export const BlocksSchema = v.pipe(v.array(BlockSchema), v.minLength(1), v.maxLength(50));

export type Block = v.InferOutput<typeof BlockSchema>;
export type Blocks = v.InferOutput<typeof BlocksSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/slack && pnpm exec vitest run src/format/block-schema.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/slack/src/format/block-schema.ts packages/slack/src/format/block-schema.test.ts
git commit -m "feat(slack): add Block Kit DSL schema for reply_with_blocks"
```

---

## Task 3: DSL → Slack translation

Parses untrusted input against the schema, enforces cross-field rules, converts `mrkdwn` text to Slack mrkdwn, assigns `action_id`s to interactive elements, and derives a notification fallback.

**Files:**
- Create: `packages/slack/src/format/blocks.ts`
- Test: `packages/slack/src/format/blocks.test.ts`

**Interfaces:**
- Consumes: `BlocksSchema`, `Blocks` from `./block-schema.ts`; `toMrkdwn` from `./mrkdwn.ts`.
- Produces:
  - `translateBlocks(input: unknown): { blocks: OutputBlock[]; fallback: string }` — throws `Error` (message safe to surface to the model) on schema or semantic failure.
  - `type OutputBlock = Record<string, unknown>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/slack/src/format/blocks.test.ts
import { expect, test } from "vitest";
import { translateBlocks } from "./blocks.ts";

test("markdown block passes GFM text through verbatim", () => {
  const { blocks } = translateBlocks([{ type: "markdown", text: "**a** | b" }]);
  expect(blocks[0]).toEqual({ type: "markdown", text: "**a** | b" });
});

test("section mrkdwn is converted to Slack mrkdwn", () => {
  const { blocks } = translateBlocks([
    { type: "section", text: { type: "mrkdwn", text: "**bold** [x](https://y)" } },
  ]);
  expect(blocks[0]).toEqual({ type: "section", text: { type: "mrkdwn", text: "*bold* <https://y|x>" } });
});

test("plain_text is never converted", () => {
  const { blocks } = translateBlocks([{ type: "header", text: { type: "plain_text", text: "**raw**" } }]);
  expect(blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "**raw**" } });
});

test("assigns action_id to interactive elements missing one", () => {
  const { blocks } = translateBlocks([
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Go" }, value: "g" }] },
  ]);
  const el = (blocks[0] as any).elements[0];
  expect(typeof el.action_id).toBe("string");
  expect(el.action_id.length).toBeGreaterThan(0);
});

test("keeps a caller-provided action_id", () => {
  const { blocks } = translateBlocks([
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Go" }, value: "g", action_id: "mine" },
    ] },
  ]);
  expect((blocks[0] as any).elements[0].action_id).toBe("mine");
});

test("throws on duplicate caller-provided action_ids", () => {
  expect(() => translateBlocks([
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "A" }, value: "a", action_id: "dup" },
      { type: "button", text: { type: "plain_text", text: "B" }, value: "b", action_id: "dup" },
    ] },
  ])).toThrow(/action_id/);
});

test("throws when a section has neither text nor fields", () => {
  expect(() => translateBlocks([{ type: "section" }])).toThrow(/section/);
});

test("throws when a card has none of title/body/hero_image/actions", () => {
  expect(() => translateBlocks([{ type: "card", subtitle: { type: "plain_text", text: "s" } }])).toThrow(/card/);
});

test("throws when a chart data point label is not a declared category", () => {
  expect(() => translateBlocks([{
    type: "data_visualization", title: "T",
    chart: { type: "bar",
      series: [{ name: "s", data: [{ label: "tue", value: 1 }] }],
      axis_config: { categories: ["mon"] } },
  }])).toThrow(/categor/i);
});

test("throws on duplicate series names in a chart", () => {
  expect(() => translateBlocks([{
    type: "data_visualization", title: "T",
    chart: { type: "line",
      series: [
        { name: "dup", data: [{ label: "mon", value: 1 }] },
        { name: "dup", data: [{ label: "mon", value: 2 }] },
      ],
      axis_config: { categories: ["mon"] } },
  }])).toThrow(/series/i);
});

test("fallback is derived from the first text-bearing block", () => {
  const { fallback } = translateBlocks([
    { type: "divider" },
    { type: "markdown", text: "Deploy ready" },
  ]);
  expect(fallback).toBe("Deploy ready");
});

test("fallback uses a data_visualization title", () => {
  const { fallback } = translateBlocks([{
    type: "data_visualization", title: "Coverage",
    chart: { type: "pie", segments: [{ label: "x", value: 1 }] },
  }]);
  expect(fallback).toBe("Coverage");
});

test("fallback defaults when no text block is present", () => {
  const { fallback } = translateBlocks([{ type: "divider" }]);
  expect(fallback).toBe("Interactive message");
});

test("throws a model-readable error on a schema violation", () => {
  expect(() => translateBlocks([{ type: "nope" }])).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/slack && pnpm exec vitest run src/format/blocks.test.ts`
Expected: FAIL — cannot resolve `./blocks.ts`.

- [ ] **Step 3: Write the translator**

```ts
// packages/slack/src/format/blocks.ts
// Validate the agent-authored Block Kit DSL, then turn it into Slack-ready blocks:
// convert `mrkdwn` text (GFM → Slack mrkdwn), leave `plain_text` and `markdown`
// blocks verbatim, assign `action_id`s to interactive elements so clicks can be
// routed, enforce the cross-field rules the schema can't, and derive a notification
// fallback. Pure and unit-tested; no Slack client coupling.

import * as v from "valibot";
import { BlocksSchema, type Blocks } from "./block-schema.ts";
import { toMrkdwn } from "./mrkdwn.ts";

export type OutputBlock = Record<string, unknown>;

const INTERACTIVE = new Set(["button", "overflow", "static_select"]);

/** Deep-copy, converting every `{ type: "mrkdwn", text }` node via toMrkdwn. */
function convertMrkdwn(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convertMrkdwn);
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.type === "mrkdwn" && typeof obj.text === "string") {
      return { ...obj, text: toMrkdwn(obj.text) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, value] of Object.entries(obj)) out[k] = convertMrkdwn(value);
    return out;
  }
  return node;
}

/** Walk interactive elements; assign missing action_ids; reject duplicates. */
function assignActionIds(node: unknown, state: { n: number; seen: Set<string> }): void {
  if (Array.isArray(node)) {
    for (const item of node) assignActionIds(item, state);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.type === "string" && INTERACTIVE.has(obj.type)) {
      if (typeof obj.action_id === "string") {
        if (state.seen.has(obj.action_id)) throw new Error(`Duplicate action_id "${obj.action_id}".`);
        state.seen.add(obj.action_id);
      } else {
        let id = `act_${state.n++}`;
        while (state.seen.has(id)) id = `act_${state.n++}`;
        obj.action_id = id;
        state.seen.add(id);
      }
    }
    for (const value of Object.values(obj)) assignActionIds(value, state);
  }
}

/** Cross-field rules the discriminated schema can't express. */
function checkSemantics(blocks: Blocks): void {
  for (const block of blocks) {
    if (block.type === "section" && block.text === undefined && block.fields === undefined) {
      throw new Error("A section block requires `text` or `fields`.");
    }
    if (block.type === "card" && !(block.title || block.body || block.hero_image || block.actions)) {
      throw new Error("A card block requires one of `title`, `body`, `hero_image`, or `actions`.");
    }
    if (block.type === "data_visualization" && block.chart.type !== "pie") {
      const categories = new Set(block.chart.axis_config.categories);
      const names = new Set<string>();
      for (const series of block.chart.series) {
        if (names.has(series.name)) throw new Error(`Duplicate chart series name "${series.name}".`);
        names.add(series.name);
        for (const point of series.data) {
          if (!categories.has(point.label)) {
            throw new Error(`Chart data label "${point.label}" is not a declared axis category.`);
          }
        }
      }
    }
  }
}

function pickText(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const obj = node as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  if (obj.text && typeof obj.text === "object") return pickText(obj.text);
  return undefined;
}

/** First human-readable line, for the notification/accessibility fallback. */
function deriveFallback(blocks: OutputBlock[]): string {
  for (const block of blocks) {
    if (block.type === "markdown" && typeof block.text === "string") return block.text.trim();
    if (block.type === "data_visualization" && typeof block.title === "string") return block.title.trim();
    if (block.type === "header" || block.type === "section") {
      const t = pickText(block);
      if (t) return t.trim();
    }
  }
  return "Interactive message";
}

/**
 * Validate untrusted DSL input and produce Slack-ready blocks plus a fallback.
 * Throws an `Error` whose message is safe to return to the model so it can retry.
 */
export function translateBlocks(input: unknown): { blocks: OutputBlock[]; fallback: string } {
  const parsed = v.safeParse(BlocksSchema, input);
  if (!parsed.success) {
    const first = parsed.issues[0];
    const path = first.path?.map((p) => p.key).join(".") ?? "blocks";
    throw new Error(`Invalid blocks at "${path}": ${first.message}`);
  }
  checkSemantics(parsed.output);
  const converted = convertMrkdwn(parsed.output) as OutputBlock[];
  assignActionIds(converted, { n: 0, seen: new Set() });
  return { blocks: converted, fallback: deriveFallback(converted) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/slack && pnpm exec vitest run src/format/blocks.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/slack/src/format/blocks.ts packages/slack/src/format/blocks.test.ts
git commit -m "feat(slack): translate Block Kit DSL to Slack blocks with action_ids"
```

---

## Task 4: The `reply_with_blocks` tool

A thread-bound outbound tool (sibling of `replyInThread`). Validates + translates the DSL and posts via `chat.postMessage`. Destination fixed at bind time.

**Files:**
- Create: `packages/slack/src/channel/actions.ts`
- Test: `packages/slack/src/channel/actions.test.ts`

**Interfaces:**
- Consumes: `translateBlocks` from `../format/blocks.ts`; `client` from `./client.ts`; `defineTool` from `@flue/runtime`; `WebClient` from `@slack/web-api`.
- Produces: `replyWithBlocks(ref: { channelId: string; threadTs: string }, slack?: WebClient)` → a tool named `reply_with_blocks`. `execute({ blocks, text? })` returns JSON string `{ channel, ts }` on success or `{ ok: false, error }` on a translation failure.

- [ ] **Step 1: Write the failing test**

```ts
// packages/slack/src/channel/actions.test.ts
import type { WebClient } from "@slack/web-api";
import { expect, test } from "vitest";
import { replyWithBlocks } from "./actions.ts";

function fake(captured: Array<Record<string, unknown>>): WebClient {
  return {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        captured.push(args);
        return { ok: true, channel: "C1", ts: "9.9" };
      },
    },
  } as unknown as WebClient;
}

test("posts translated blocks to the bound thread with a fallback text", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tool = replyWithBlocks({ channelId: "C1", threadTs: "5.5" }, fake(calls));
  const result = JSON.parse(await tool.execute({
    blocks: [{ type: "markdown", text: "Deploy ready" }],
  }));

  expect(result).toEqual({ channel: "C1", ts: "9.9" });
  expect(calls[0].channel).toBe("C1");
  expect(calls[0].thread_ts).toBe("5.5");
  expect(calls[0].text).toBe("Deploy ready");
  expect((calls[0].blocks as unknown[])[0]).toEqual({ type: "markdown", text: "Deploy ready" });
});

test("uses caller-supplied fallback text when provided", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tool = replyWithBlocks({ channelId: "C1", threadTs: "5.5" }, fake(calls));
  await tool.execute({ blocks: [{ type: "divider" }], text: "custom" });
  expect(calls[0].text).toBe("custom");
});

test("returns an error (does not post) when blocks are invalid", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tool = replyWithBlocks({ channelId: "C1", threadTs: "5.5" }, fake(calls));
  const result = JSON.parse(await tool.execute({ blocks: [{ type: "carousel" }] }));
  expect(result.ok).toBe(false);
  expect(typeof result.error).toBe("string");
  expect(calls.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/slack && pnpm exec vitest run src/channel/actions.test.ts`
Expected: FAIL — cannot resolve `./actions.ts`.

- [ ] **Step 3: Write the tool**

```ts
// packages/slack/src/channel/actions.ts
// The agent's rich outbound capability: post a Block Kit message into the bound
// Slack thread. Sibling of `reply_in_slack_thread` — the destination is fixed at
// bind time, so the model supplies only block content, never the channel/thread.
// The model's DSL is validated and translated by `../format/blocks.ts`; an invalid
// payload is reported back to the model (not thrown) so it can correct and retry.

import { defineTool } from "@flue/runtime";
import type { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/web-api";
import * as v from "valibot";
import { translateBlocks } from "../format/blocks.ts";
import { client } from "./client.ts";

type ThreadRef = { channelId: string; threadTs: string };

export function replyWithBlocks(ref: ThreadRef, slack: WebClient = client) {
  return defineTool({
    name: "reply_with_blocks",
    description:
      "Post a rich Block Kit message in the Slack thread bound to this conversation: markdown, " +
      "tables, cards, status, buttons, and select menus. Supply a `blocks` array (see the " +
      "slack-block-kit skill for which block to use and the limits) and an optional `text` " +
      "notification fallback. Buttons/menus you add come back to you later as a " +
      "`slack.block_action` turn, so put correlation info in each element's `value`. The target " +
      "thread is fixed; you supply only the message content.",
    parameters: v.object({
      blocks: v.pipe(v.array(v.unknown()), v.minLength(1), v.description("A Block Kit blocks array.")),
      text: v.optional(v.pipe(v.string(), v.description("Notification/accessibility fallback text."))),
    }),
    async execute({ blocks, text }) {
      let translated;
      try {
        translated = translateBlocks(blocks);
      } catch (error) {
        return JSON.stringify({ ok: false, error: (error as Error).message });
      }
      const result = await slack.chat.postMessage({
        channel: ref.channelId,
        thread_ts: ref.threadTs,
        text: text ?? translated.fallback,
        blocks: translated.blocks as unknown as KnownBlock[],
      });
      return JSON.stringify({ channel: result.channel, ts: result.ts });
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/slack && pnpm exec vitest run src/channel/actions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/slack/src/channel/actions.ts packages/slack/src/channel/actions.test.ts
git commit -m "feat(slack): add reply_with_blocks tool"
```

---

## Task 5: Interaction planning

Pure decision logic for inbound interactivity, mirroring `events/plan.ts`. Narrows to `block_actions`, normalizes the triggering element, reconstructs the thread ref from the signed payload, and synthesizes the agent turn.

**Files:**
- Create: `packages/slack/src/interactions/plan.ts`
- Test: `packages/slack/src/interactions/plan.test.ts`

**Interfaces:**
- Consumes: `SlackInteractionPayload`, `SlackThreadRef` from `@flue/slack`.
- Produces:
  - `type SlackBlockActionInput = { type: "slack.block_action"; elementType: "button" | "overflow" | "static_select"; actionId: string; value: string; blockId: string; userId: string; text: string }`.
  - `type SlackInteractionPlan = { ref: SlackThreadRef; input: SlackBlockActionInput }`.
  - `planSlackInteraction(payload: SlackInteractionPayload): SlackInteractionPlan | null`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/slack/src/interactions/plan.test.ts
import type { SlackInteractionPayload } from "@flue/slack";
import { expect, test } from "vitest";
import { planSlackInteraction } from "./plan.ts";

function blockActions(action: Record<string, unknown>, over: Record<string, unknown> = {}): SlackInteractionPayload {
  return {
    type: "block_actions",
    user: { id: "U1" },
    team: { id: "T1" },
    api_app_id: "A1",
    container: { type: "message", channel_id: "C1", message_ts: "5.5", thread_ts: "4.4" },
    actions: [action],
    ...over,
  } as unknown as SlackInteractionPayload;
}

test("plans a button click into a dispatch with the thread ref", () => {
  const plan = planSlackInteraction(blockActions({
    type: "button", action_id: "confirm", block_id: "b1", value: "deploy",
  }));
  expect(plan).not.toBeNull();
  expect(plan!.ref).toEqual({ teamId: "T1", channelId: "C1", threadTs: "4.4" });
  expect(plan!.input.type).toBe("slack.block_action");
  expect(plan!.input.elementType).toBe("button");
  expect(plan!.input.actionId).toBe("confirm");
  expect(plan!.input.value).toBe("deploy");
  expect(plan!.input.userId).toBe("U1");
  expect(plan!.input.text).toContain("button");
});

test("falls back to message_ts when thread_ts is absent", () => {
  const plan = planSlackInteraction(blockActions(
    { type: "button", action_id: "a", block_id: "b", value: "v" },
    { container: { type: "message", channel_id: "C1", message_ts: "5.5" } },
  ));
  expect(plan!.ref.threadTs).toBe("5.5");
});

test("reads selected_option.value for a static_select", () => {
  const plan = planSlackInteraction(blockActions({
    type: "static_select", action_id: "pick", block_id: "b",
    selected_option: { value: "staging", text: { type: "plain_text", text: "Staging" } },
  }));
  expect(plan!.input.elementType).toBe("static_select");
  expect(plan!.input.value).toBe("staging");
});

test("reads selected_option.value for an overflow", () => {
  const plan = planSlackInteraction(blockActions({
    type: "overflow", action_id: "more", block_id: "b",
    selected_option: { value: "archive", text: { type: "plain_text", text: "Archive" } },
  }));
  expect(plan!.input.value).toBe("archive");
});

test("returns null for a non-block_actions interaction", () => {
  expect(planSlackInteraction({ type: "view_submission" } as unknown as SlackInteractionPayload)).toBeNull();
});

test("returns null when the channel or thread cannot be resolved", () => {
  const plan = planSlackInteraction(blockActions(
    { type: "button", action_id: "a", block_id: "b", value: "v" },
    { container: {} },
  ));
  expect(plan).toBeNull();
});

test("returns null for an unsupported element type", () => {
  expect(planSlackInteraction(blockActions({ type: "datepicker", action_id: "a", block_id: "b" }))).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/slack && pnpm exec vitest run src/interactions/plan.test.ts`
Expected: FAIL — cannot resolve `./plan.ts`.

- [ ] **Step 3: Write the planner**

```ts
// packages/slack/src/interactions/plan.ts
// Pure Slack interactivity decision logic, the inbound twin of `events/plan.ts`.
// Kept separate from `channel/channel.ts` (which wires it into the Flue channel and
// dispatches) so the branching is unit-testable without the agent graph. Returns
// null for everything the bot doesn't act on, so the channel answers an empty 200.

import type { SlackInteractionPayload, SlackThreadRef } from "@flue/slack";

/** The synthetic turn delivered to the agent when a user interacts with a block. */
export interface SlackBlockActionInput {
  type: "slack.block_action";
  elementType: "button" | "overflow" | "static_select";
  actionId: string;
  value: string;
  blockId: string;
  userId: string;
  // A natural-language rendering so the model handles it like any other turn.
  text: string;
}

export interface SlackInteractionPlan {
  ref: SlackThreadRef;
  input: SlackBlockActionInput;
}

const SUPPORTED = new Set(["button", "overflow", "static_select"]);

interface ActionLike {
  type?: string;
  action_id?: string;
  block_id?: string;
  value?: string;
  selected_option?: { value?: string };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Decide what (if anything) a verified interactivity delivery should dispatch.
 * Handles `block_actions` for button / overflow / static_select; returns null for
 * every other interaction type, malformed payload, or unsupported element. Pure.
 */
export function planSlackInteraction(payload: SlackInteractionPayload): SlackInteractionPlan | null {
  if (payload.type !== "block_actions") return null;

  const action = (payload.actions?.[0] ?? {}) as ActionLike;
  const elementType = action.type;
  if (!elementType || !SUPPORTED.has(elementType)) return null;

  const container = (payload.container ?? {}) as Record<string, unknown>;
  const channelInfo = (payload.channel ?? {}) as Record<string, unknown>;
  const message = (payload.message ?? {}) as Record<string, unknown>;

  const teamId = str(payload.team?.id);
  const channelId = str(container.channel_id) ?? str(channelInfo.id);
  const threadTs =
    str(container.thread_ts) ?? str(message.thread_ts) ?? str(container.message_ts) ?? str(message.ts);
  const userId = str(payload.user?.id);

  if (!teamId || !channelId || !threadTs || !userId) return null;

  const value = str(action.value) ?? str(action.selected_option?.value) ?? "";
  const actionId = str(action.action_id) ?? "";
  const blockId = str(action.block_id) ?? "";

  const verb = elementType === "button" ? "clicked the button" : "selected an option from the menu";
  const text = `The user ${verb} (action_id: "${actionId}", value: "${value}").`;

  return {
    ref: { teamId, channelId, threadTs },
    input: {
      type: "slack.block_action",
      elementType: elementType as SlackBlockActionInput["elementType"],
      actionId,
      value,
      blockId,
      userId,
      text,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/slack && pnpm exec vitest run src/interactions/plan.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/slack/src/interactions/plan.ts packages/slack/src/interactions/plan.test.ts
git commit -m "feat(slack): add planSlackInteraction decision logic"
```

---

## Task 6: Interaction acknowledgement (disable buttons after click)

Best-effort `response_url` update so a resolved message can't be re-clicked. Pure HTTP; injectable `fetch` for tests; failures swallowed + logged.

**Files:**
- Create: `packages/slack/src/channel/interactions-ack.ts`
- Test: `packages/slack/src/channel/interactions-ack.test.ts`

**Interfaces:**
- Produces: `resolveInteractiveMessage(responseUrl: string, summary: string, doFetch?: typeof fetch): Promise<{ ok: boolean }>` — POSTs `{ replace_original: true, text, blocks:[markdown summary] }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/slack/src/channel/interactions-ack.test.ts
import { expect, test } from "vitest";
import { resolveInteractiveMessage } from "./interactions-ack.ts";

test("POSTs a replace_original payload to the response_url", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("ok");
  }) as unknown as typeof fetch;

  const result = await resolveInteractiveMessage("https://hooks.slack/x", "✅ You chose: Deploy", doFetch);

  expect(result).toEqual({ ok: true });
  expect(calls[0].url).toBe("https://hooks.slack/x");
  expect(calls[0].body).toMatchObject({ replace_original: true, text: "✅ You chose: Deploy" });
});

test("swallows a fetch failure and returns ok:false", async () => {
  const doFetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  expect(await resolveInteractiveMessage("https://hooks.slack/x", "done", doFetch)).toEqual({ ok: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/slack && pnpm exec vitest run src/channel/interactions-ack.test.ts`
Expected: FAIL — cannot resolve `./interactions-ack.ts`.

- [ ] **Step 3: Write the helper**

```ts
// packages/slack/src/channel/interactions-ack.ts
// After a user interacts with a message, replace it via Slack's `response_url`
// (a short-lived, pre-authorized webhook — no token needed) so the buttons are gone
// and can't be clicked again. Best-effort: a failure here must never break the
// dispatch, so it is swallowed and logged, like `postProgressInThread`.
//
// `doFetch` is injectable so the unit test can assert the payload without a network.

export async function resolveInteractiveMessage(
  responseUrl: string,
  summary: string,
  doFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<{ ok: boolean }> {
  try {
    await doFetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        replace_original: true,
        text: summary,
        blocks: [{ type: "markdown", text: summary }],
      }),
    });
    return { ok: true };
  } catch (error) {
    console.warn("[slack] interaction ack failed:", error);
    return { ok: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/slack && pnpm exec vitest run src/channel/interactions-ack.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/slack/src/channel/interactions-ack.ts packages/slack/src/channel/interactions-ack.test.ts
git commit -m "feat(slack): add best-effort interaction acknowledgement"
```

---

## Task 7: Wire the interactions handler into the channel

Add the `interactions` handler to `createSlackChannel`, factoring the shared dispatch out of the existing `events` handler. `@flue/slack` auto-serves the signature-verified `/interactions` route once the handler is present.

**Files:**
- Modify: `packages/slack/src/channel/channel.ts`
- Test: `packages/slack/src/channel/channel.test.ts` (create)

**Interfaces:**
- Consumes: `planSlackInteraction`, `SlackInteractionPlan` from `../interactions/plan.ts`; `resolveInteractiveMessage` from `./interactions-ack.ts`; existing `planSlackEvent`, `enrichWithThreadContext`, `dispatch`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/slack/src/channel/channel.test.ts
import type { SlackInteractionPayload } from "@flue/slack";
import { expect, test } from "vitest";
import { createSlackBotChannel } from "./channel.ts";

function interactionRoute(channel: ReturnType<typeof createSlackBotChannel>) {
  const route = channel.routes.find((r) => r.path.endsWith("/interactions"));
  if (!route) throw new Error("no /interactions route");
  return route;
}

test("an enabled channel serves an /interactions route", () => {
  const channel = createSlackBotChannel({ enabled: true, signingSecret: "s", agentName: "bot" });
  expect(channel.routes.some((r) => r.path.endsWith("/interactions"))).toBe(true);
});

test("a disabled channel ignores interactions and still 200s", () => {
  // A disabled channel must construct without a real secret and act on nothing.
  const channel = createSlackBotChannel({ enabled: false, agentName: "bot" });
  expect(() => interactionRoute(channel)).not.toThrow();
});
```

> Note: `createSlackChannel` registers the `/interactions` route whenever an `interactions` handler is passed. Because the handler is now always passed (it early-returns when `enabled` is false), the route exists in both cases; the disabled test asserts construction + presence only. If asserting dispatch behavior end-to-end proves easier by exporting the handler, keep the dispatch logic in a small exported `planAndDispatchInteraction(payload)` and unit-test that directly instead — but do not add export surface the bot doesn't need.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/slack && pnpm exec vitest run src/channel/channel.test.ts`
Expected: FAIL — the `/interactions` route does not exist yet.

- [ ] **Step 3: Modify `channel.ts`**

Replace the existing `createSlackBotChannel` body. Current `events` handler (for reference) lives in `packages/slack/src/channel/channel.ts`. New version factors a shared `dispatchPlan` helper and adds the `interactions` handler:

```ts
// packages/slack/src/channel/channel.ts  (imports section — add these to the existing imports)
import { dispatch } from "@flue/runtime";
import { createSlackChannel, type SlackChannel } from "@flue/slack";
import { planSlackEvent } from "../events/plan.ts";
import { planSlackInteraction } from "../interactions/plan.ts";
import { enrichWithThreadContext } from "./thread-context.ts";
import { resolveInteractiveMessage } from "./interactions-ack.ts";
```

```ts
// Replace the `createSlackBotChannel` function body with this:
export function createSlackBotChannel(options: SlackBotChannelOptions): SlackChannel {
  const { enabled, signingSecret, agentName } = options;

  const channel = createSlackChannel({
    signingSecret: enabled ? (signingSecret ?? "") : "disabled",

    async events({ payload }) {
      if (!enabled) return;
      const plan = planSlackEvent(payload);
      if (!plan) return;
      const input = await enrichWithThreadContext(plan);
      await dispatch({ agent: agentName, id: channel.conversationKey(plan.ref), input });
    },

    async interactions({ payload }) {
      if (!enabled) return;
      const plan = planSlackInteraction(payload);
      // Unhandled interaction types / malformed payloads → empty 200.
      if (!plan) return;

      // Disable the interacted message so it can't be re-clicked. Best-effort: a
      // failure here must not stop the dispatch.
      const responseUrl = (payload as { response_url?: string }).response_url;
      if (responseUrl) {
        const verb = plan.input.elementType === "button" ? "clicked" : "selected";
        await resolveInteractiveMessage(responseUrl, `✅ You ${verb}: ${plan.input.value}`);
      }

      // One agent instance per Slack thread: the click re-enters the same
      // conversation, which already holds the context of what it proposed.
      await dispatch({ agent: agentName, id: channel.conversationKey(plan.ref), input: plan.input });
    },
  });

  return channel;
}
```

Keep the existing file header comment and the `SlackBotChannelOptions` interface unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/slack && pnpm exec vitest run src/channel/channel.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole package suite + typecheck**

Run: `pnpm --filter @repo/slack test && pnpm --filter @repo/slack typecheck`
Expected: all tests PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/slack/src/channel/channel.ts packages/slack/src/channel/channel.test.ts
git commit -m "feat(slack): wire /interactions handler to dispatch block actions"
```

---

## Task 8: Expose the tool, export the surface, document the turn

Bind `reply_with_blocks` into the router toolset, export the new public API, and teach the agent (in `instructions.md`) about the new turn type.

**Files:**
- Modify: `packages/slack/src/channel/agent-integration.ts`
- Modify: `packages/slack/src/index.ts`
- Modify: `packages/slack/src/channel/instructions.md`
- Test: extend `packages/slack/src/channel/agent-integration.test.ts` (exists)

**Interfaces:**
- Consumes: `replyWithBlocks` from `./actions.ts`.
- Produces: the router toolset returned by `tools(ref)` now includes a `reply_with_blocks` tool alongside `reply_in_slack_thread` and `post_slack_progress`.

- [ ] **Step 1: Write the failing test**

Add to `packages/slack/src/channel/agent-integration.test.ts`:

```ts
import { expect, test } from "vitest";
import type { SlackChannel } from "@flue/slack";
import { createSlackAgentIntegrationEntry } from "./agent-integration.ts";

test("router toolset includes reply_with_blocks bound to the thread", () => {
  const channel = { parseConversationKey: (id: string) => ({ teamId: "T", channelId: "C", threadTs: id }) } as unknown as SlackChannel;
  const entry = createSlackAgentIntegrationEntry(channel, "instructions");
  const names = entry.tools({ teamId: "T", channelId: "C", threadTs: "1.1" }).router.map((t) => t.name);
  expect(names).toContain("reply_with_blocks");
  expect(names).toContain("reply_in_slack_thread");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/slack && pnpm exec vitest run src/channel/agent-integration.test.ts`
Expected: FAIL — `router` does not contain `reply_with_blocks`.

- [ ] **Step 3: Add the tool in `agent-integration.ts`**

In `packages/slack/src/channel/agent-integration.ts`, add the import and include the tool in the `router` array:

```ts
import { postProgressInThread, replyInThread } from "./reply.ts";
import { replyWithBlocks } from "./actions.ts";
```

```ts
    tools: (ref) => {
      const progress = postProgressInThread(ref);
      return { router: [replyInThread(ref), replyWithBlocks(ref), progress], subagent: [progress] };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/slack && pnpm exec vitest run src/channel/agent-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Export the new public surface in `index.ts`**

Add to `packages/slack/src/index.ts`:

```ts
export { replyWithBlocks } from "./channel/actions.ts";
export { translateBlocks, type OutputBlock } from "./format/blocks.ts";
export { BlocksSchema, type Block, type Blocks } from "./format/block-schema.ts";
export {
  planSlackInteraction,
  type SlackBlockActionInput,
  type SlackInteractionPlan,
} from "./interactions/plan.ts";
```

- [ ] **Step 6: Document the new turn in `instructions.md`**

Append this section to `packages/slack/src/channel/instructions.md`:

```markdown

## Posting rich Slack messages and handling clicks

- To post a rich message (markdown, a table, a card, status, or buttons/menus), call
  `reply_with_blocks` instead of `reply_in_slack_thread`. Consult the **slack-block-kit**
  skill for which block to use for what and the limits. Plain prose still goes through
  `reply_in_slack_thread`.
- When you add buttons or a menu, put the information you'll need to act on the click into
  each element's `value`. A click arrives later as a **`slack.block_action`** turn with
  `elementType`, `actionId`, `value`, and `userId`. Treat it as the user's response to what
  you posted: you already have the thread's context, so correlate it with what you proposed
  (e.g. a `value` of `confirm` on a deploy you offered) and continue.
- Any member of the thread can click; `userId` tells you who did. The clicked message's
  buttons are removed automatically once clicked.
```

- [ ] **Step 7: Run the whole package suite + typecheck**

Run: `pnpm --filter @repo/slack test && pnpm --filter @repo/slack typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/slack/src/channel/agent-integration.ts packages/slack/src/channel/agent-integration.test.ts packages/slack/src/index.ts packages/slack/src/channel/instructions.md
git commit -m "feat(slack): expose reply_with_blocks and document block_action turns"
```

---

## Task 9: The `slack-block-kit` skill

Author the load-on-demand skill (owned by `@repo/slack`, mirroring `@repo/github`'s `explore-repo`), export its `SKILL.md`, and register it on the d0lt-bot agent.

**Files:**
- Create: `packages/slack/src/skills/slack-block-kit/SKILL.md`
- Modify: `packages/slack/package.json` (add an `exports` entry)
- Modify: `bots/d0lt-bot/src/agents/d0lt-bot.ts` (import + register)

- [ ] **Step 1: Write `SKILL.md`**

```markdown
---
name: slack-block-kit
description: Use when composing a rich Slack message with the `reply_with_blocks` tool — choosing which block to use (markdown, table, card, section/fields, context, header, buttons, menus) for what purpose, and staying within Slack's limits. Not needed for plain prose replies (use reply_in_slack_thread).
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
```

- [ ] **Step 2: Export the skill from `package.json`**

In `packages/slack/package.json`, add to the `exports` object (after the `./instructions.md` entry), mirroring `@repo/github`:

```json
    "./instructions.md": "./src/channel/instructions.md",
    "./skills/slack-block-kit/SKILL.md": "./src/skills/slack-block-kit/SKILL.md"
```

- [ ] **Step 3: Register the skill on the agent — only for Slack turns**

The skill teaches `reply_with_blocks`, which is bound only on Slack-channel turns (its
tool, and the Slack instructions fragment, are already conditional via the channel
registry). So register the skill **only when the conversation came in via Slack**, keyed
off the `conversation.source` the registry already returns. `exploreRepo` stays
unconditional — the bot inspects repos from any channel.

In `bots/d0lt-bot/src/agents/d0lt-bot.ts`, add the import next to the existing skill import:

```ts
import exploreRepo from "@repo/github/skills/explore-repo/SKILL.md" with { type: "skill" };
import slackBlockKit from "@repo/slack/skills/slack-block-kit/SKILL.md" with { type: "skill" };
```

The agent builder already computes `const conversation = resolveRegisteredConversation(id, CHANNEL_REGISTRY)`.
Just below it, derive the skill list, and pass it to the returned config:

```ts
  // The block-kit skill is only useful when the Slack outbound tools are bound, i.e.
  // for Slack-channel turns. Keep exploreRepo on every turn (repo inspection is
  // cross-channel); add slackBlockKit only for Slack.
  const skills = conversation.source === "slack" ? [exploreRepo, slackBlockKit] : [exploreRepo];
```

```ts
    // in the returned agent config, replace `skills: [exploreRepo],` with:
    skills,
```

- [ ] **Step 4: Verify the skill loads (typecheck + build the bot)**

Run: `pnpm --filter @repo/slack typecheck && pnpm --filter d0lt-bot build`
Expected: no type errors; the build succeeds, confirming Flue accepts the `SKILL.md`
frontmatter (valid `name`/`description`) and packages the skill. If the build reports an
invalid skill name, ensure `name: slack-block-kit` matches the directory name exactly.

- [ ] **Step 5: Run the full monorepo test suite**

Run: `pnpm test`
Expected: all packages PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/slack/src/skills/slack-block-kit/SKILL.md packages/slack/package.json bots/d0lt-bot/src/agents/d0lt-bot.ts
git commit -m "feat(slack): add slack-block-kit skill and register it on d0lt-bot"
```

---

## Done — verification checklist

- [ ] `pnpm --filter @repo/slack test` — all unit tests pass.
- [ ] `pnpm --filter @repo/slack typecheck` — no type errors.
- [ ] `pnpm --filter d0lt-bot build` — bot builds with the skill packaged.
- [ ] Manual end-to-end (optional, needs a connected workspace): in a thread, prompt the bot
      to confirm an action; verify it posts a card/buttons via `reply_with_blocks`, that
      clicking removes the buttons, and that the agent continues with the click as a
      `slack.block_action` turn.

## Spec coverage map

- Native `/interactions` wiring → Task 7.
- Validated Block Kit DSL (mirror Slack shapes) → Tasks 2–3.
- `markdown` as default text vehicle; `mrkdwn` converted, `plain_text` literal → Task 3.
- `reply_with_blocks` tool, destination fixed at bind time, fallback text → Task 4.
- Click normalization (button/overflow/static_select) + ref reconstruction → Task 5.
- `response_url` button-disable, best-effort → Tasks 6–7.
- `slack.block_action` turn shape + instructions → Tasks 5, 8.
- `card` + `data_visualization` in v1; `alert` excluded (modal-only); `plan` deferred (nests `task_card`) → Tasks 2–3, 9; surface smoke-test of `card`/`data_visualization` → Task 1.
- Skill owned by `@repo/slack`, exported like `explore-repo`, registered **only on Slack-channel turns** (`conversation.source === "slack"`) → Task 9.
- Error handling (never throw; empty 200; swallow best-effort) → Tasks 5–7.
- Deferred (alert, plan/task_card, carousel, data_table, modals, advanced selects/pickers) → not implemented, reachable via the same handler + schema extension.
