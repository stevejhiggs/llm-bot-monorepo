import { expect, test } from "vitest";
import * as v from "valibot";
import { BlocksSchema } from "./block-schema.ts";

test("accepts a markdown + actions message", () => {
  const blocks = [
    { type: "markdown", text: "**hi**" },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Yes" }, value: "y", style: "primary" },
      ],
    },
  ];
  expect(() => v.parse(BlocksSchema, blocks)).not.toThrow();
});

test("accepts a card with up to 3 buttons", () => {
  const blocks = [
    {
      type: "card",
      title: { type: "plain_text", text: "T" },
      body: { type: "mrkdwn", text: "b" },
      actions: {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "A" }, value: "a" },
          { type: "button", text: { type: "plain_text", text: "B" }, value: "b" },
          { type: "button", text: { type: "plain_text", text: "C" }, value: "c" },
        ],
      },
    },
  ];
  expect(() => v.parse(BlocksSchema, blocks)).not.toThrow();
});

test("accepts a pie and a bar data_visualization", () => {
  const blocks = [
    {
      type: "data_visualization",
      title: "Results",
      chart: { type: "pie", segments: [{ label: "ok", value: 9 }] },
    },
    {
      type: "data_visualization",
      title: "Trend",
      chart: {
        type: "bar",
        series: [{ name: "runs", data: [{ label: "mon", value: 3 }] }],
        axis_config: { categories: ["mon"] },
      },
    },
  ];
  expect(() => v.parse(BlocksSchema, blocks)).not.toThrow();
});

test("rejects a pie chart with more than 6 segments", () => {
  const seg = { label: "x", value: 1 };
  const blocks = [
    {
      type: "data_visualization",
      title: "T",
      chart: { type: "pie", segments: Array(7).fill(seg) },
    },
  ];
  expect(() => v.parse(BlocksSchema, blocks)).toThrow();
});

test("accepts a table and a static_select", () => {
  const blocks = [
    { type: "table", rows: [[{ type: "raw_text", text: "A" }], [{ type: "raw_text", text: "1" }]] },
    {
      type: "actions",
      elements: [
        {
          type: "static_select",
          placeholder: { type: "plain_text", text: "Pick" },
          options: [{ text: { type: "plain_text", text: "One" }, value: "1" }],
        },
      ],
    },
  ];
  expect(() => v.parse(BlocksSchema, blocks)).not.toThrow();
});

test("rejects an unknown block type", () => {
  expect(() => v.parse(BlocksSchema, [{ type: "carousel" }])).toThrow();
});

test("rejects a button label longer than 75 chars", () => {
  const blocks = [
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "x".repeat(76) }, value: "v" },
      ],
    },
  ];
  expect(() => v.parse(BlocksSchema, blocks)).toThrow();
});

test("rejects an actions block with 6 elements", () => {
  const button = { type: "button", text: { type: "plain_text", text: "b" }, value: "v" };
  expect(() =>
    v.parse(BlocksSchema, [{ type: "actions", elements: Array(6).fill(button) }]),
  ).toThrow();
});

test("rejects card actions with 4 buttons", () => {
  const button = { type: "button", text: { type: "plain_text", text: "b" }, value: "v" };
  const blocks = [
    {
      type: "card",
      title: { type: "plain_text", text: "T" },
      actions: { type: "actions", elements: Array(4).fill(button) },
    },
  ];
  expect(() => v.parse(BlocksSchema, blocks)).toThrow();
});

test("rejects more than 50 blocks", () => {
  const divider = { type: "divider" };
  expect(() => v.parse(BlocksSchema, Array(51).fill(divider))).toThrow();
});
