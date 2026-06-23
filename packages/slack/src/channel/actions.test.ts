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
  const result = await tool.run({
    input: { blocks: [{ type: "markdown", text: "Deploy ready" }] },
  });

  expect(result).toEqual({ channel: "C1", ts: "9.9" });
  expect(calls[0].channel).toBe("C1");
  expect(calls[0].thread_ts).toBe("5.5");
  expect(calls[0].text).toBe("Deploy ready");
  expect((calls[0].blocks as unknown[])[0]).toEqual({ type: "markdown", text: "Deploy ready" });
});

test("uses caller-supplied fallback text when provided", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tool = replyWithBlocks({ channelId: "C1", threadTs: "5.5" }, fake(calls));
  await tool.run({ input: { blocks: [{ type: "divider" }], text: "custom" } });
  expect(calls[0].text).toBe("custom");
});

test("returns an error (does not post) when blocks are invalid", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tool = replyWithBlocks({ channelId: "C1", threadTs: "5.5" }, fake(calls));
  const result = (await tool.run({ input: { blocks: [{ type: "carousel" }] } })) as {
    ok: boolean;
    error: string;
  };
  expect(result.ok).toBe(false);
  expect(typeof result.error).toBe("string");
  expect(calls.length).toBe(0);
});
