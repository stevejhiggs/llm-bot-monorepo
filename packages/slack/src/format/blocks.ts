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
        if (state.seen.has(obj.action_id))
          throw new Error(`Duplicate action_id "${obj.action_id}".`);
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
    if (
      block.type === "card" &&
      !(block.title || block.body || block.hero_image || block.actions)
    ) {
      throw new Error("A card block requires one of `title`, `body`, `hero_image`, or `actions`.");
    }
    if (block.type === "data_visualization" && block.chart.type !== "pie") {
      const categories = new Set(block.chart.axis_config.categories);
      const names = new Set<string>();
      for (const series of block.chart.series) {
        if (names.has(series.name))
          throw new Error(`Duplicate chart series name "${series.name}".`);
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
    if (block.type === "data_visualization" && typeof block.title === "string")
      return block.title.trim();
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
