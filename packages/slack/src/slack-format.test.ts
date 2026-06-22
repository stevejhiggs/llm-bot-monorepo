import { describe, expect, it } from "vitest";
import { toMrkdwn } from "./slack-format.ts";

describe("toMrkdwn", () => {
  it("converts bold to single-asterisk", () => {
    expect(toMrkdwn("**Result: PASS** and __also__")).toBe("*Result: PASS* and *also*");
  });

  it("converts links to Slack syntax", () => {
    expect(toMrkdwn("see [the repo](https://github.com/x/y)")).toBe(
      "see <https://github.com/x/y|the repo>",
    );
  });

  it("turns headings into bold lines", () => {
    expect(toMrkdwn("## ✅ Result: PASS")).toBe("*✅ Result: PASS*");
  });

  it("converts strikethrough", () => {
    expect(toMrkdwn("~~old~~")).toBe("~old~");
  });

  it("normalises bullets", () => {
    expect(toMrkdwn("- one\n- two")).toBe("• one\n• two");
  });

  it("degrades a two-column table to key: value bullets, dropping the header", () => {
    const md = ["| Field | Value |", "| --- | --- |", "| Stack | NestJS |", "| Pkg | pnpm |"].join(
      "\n",
    );
    expect(toMrkdwn(md)).toBe("• Stack: NestJS\n• Pkg: pnpm");
  });

  it("joins wider table rows with a separator", () => {
    const md = ["| A | B | C |", "| --- | --- | --- |", "| 1 | 2 | 3 |"].join("\n");
    expect(toMrkdwn(md)).toBe("• 1 · 2 · 3");
  });

  it("leaves inline and fenced code untouched, including $ sequences", () => {
    expect(toMrkdwn("run `pnpm **test**` now")).toBe("run `pnpm **test**` now");
    expect(toMrkdwn("```\nclone $GITHUB_TOKEN\n```")).toBe("```\nclone $GITHUB_TOKEN\n```");
  });

  it("does not treat a shell pipe as a table", () => {
    expect(toMrkdwn("a || b")).toBe("a || b");
  });
});
