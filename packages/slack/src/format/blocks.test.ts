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
  expect(blocks[0]).toEqual({
    type: "section",
    text: { type: "mrkdwn", text: "*bold* <https://y|x>" },
  });
});

test("plain_text is never converted", () => {
  const { blocks } = translateBlocks([
    { type: "header", text: { type: "plain_text", text: "**raw**" } },
  ]);
  expect(blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "**raw**" } });
});

test("assigns action_id to interactive elements missing one", () => {
  const { blocks } = translateBlocks([
    {
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "Go" }, value: "g" }],
    },
  ]);
  const el = (blocks[0] as any).elements[0];
  expect(typeof el.action_id).toBe("string");
  expect(el.action_id.length).toBeGreaterThan(0);
});

test("keeps a caller-provided action_id", () => {
  const { blocks } = translateBlocks([
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Go" }, value: "g", action_id: "mine" },
      ],
    },
  ]);
  expect((blocks[0] as any).elements[0].action_id).toBe("mine");
});

test("assigns action_id to a button nested inside card.actions", () => {
  const { blocks } = translateBlocks([
    {
      type: "card",
      title: { type: "plain_text", text: "Deploy" },
      actions: {
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "Go" }, value: "g" }],
      },
    },
  ]);
  const button = (blocks[0] as any).actions.elements[0];
  expect(typeof button.action_id).toBe("string");
  expect(button.action_id.length).toBeGreaterThan(0);
});

test("throws on duplicate caller-provided action_ids", () => {
  expect(() =>
    translateBlocks([
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "A" }, value: "a", action_id: "dup" },
          { type: "button", text: { type: "plain_text", text: "B" }, value: "b", action_id: "dup" },
        ],
      },
    ]),
  ).toThrow(/action_id/);
});

test("throws when a section has neither text nor fields", () => {
  expect(() => translateBlocks([{ type: "section" }])).toThrow(/section/);
});

test("throws when a card has none of title/body/hero_image/actions", () => {
  expect(() =>
    translateBlocks([{ type: "card", subtitle: { type: "plain_text", text: "s" } }]),
  ).toThrow(/card/);
});

test("throws when a chart data point label is not a declared category", () => {
  expect(() =>
    translateBlocks([
      {
        type: "data_visualization",
        title: "T",
        chart: {
          type: "bar",
          series: [{ name: "s", data: [{ label: "tue", value: 1 }] }],
          axis_config: { categories: ["mon"] },
        },
      },
    ]),
  ).toThrow(/categor/i);
});

test("throws on duplicate series names in a chart", () => {
  expect(() =>
    translateBlocks([
      {
        type: "data_visualization",
        title: "T",
        chart: {
          type: "line",
          series: [
            { name: "dup", data: [{ label: "mon", value: 1 }] },
            { name: "dup", data: [{ label: "mon", value: 2 }] },
          ],
          axis_config: { categories: ["mon"] },
        },
      },
    ]),
  ).toThrow(/series/i);
});

test("fallback is derived from the first text-bearing block", () => {
  const { fallback } = translateBlocks([
    { type: "divider" },
    { type: "markdown", text: "Deploy ready" },
  ]);
  expect(fallback).toBe("Deploy ready");
});

test("fallback uses a data_visualization title", () => {
  const { fallback } = translateBlocks([
    {
      type: "data_visualization",
      title: "Coverage",
      chart: { type: "pie", segments: [{ label: "x", value: 1 }] },
    },
  ]);
  expect(fallback).toBe("Coverage");
});

test("fallback defaults when no text block is present", () => {
  const { fallback } = translateBlocks([{ type: "divider" }]);
  expect(fallback).toBe("Interactive message");
});

test("throws a model-readable error on a schema violation", () => {
  expect(() => translateBlocks([{ type: "nope" }])).toThrow();
});
