import type { WebClient } from "@slack/web-api";
import { expect, test } from "vitest";
import { postProgressInThread } from "./reply.ts";

test("post_slack_progress posts a converted note to the bound thread", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeClient = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { ok: true, channel: "D1", ts: "444.4" };
      },
    },
  } as unknown as WebClient;

  const tool = postProgressInThread({ channelId: "D1", threadTs: "222.2" }, fakeClient);
  const result = await tool.run({ input: { text: "**Running** tests…" }, emitData: () => {} });

  expect(result).toEqual({ ok: true, ts: "444.4" });
  expect(calls[0]).toEqual({ channel: "D1", thread_ts: "222.2", text: "*Running* tests…" });
});

test("post_slack_progress swallows a Slack error so the run is not aborted", async () => {
  const fakeClient = {
    chat: {
      postMessage: async () => {
        throw new Error("slack down");
      },
    },
  } as unknown as WebClient;

  const tool = postProgressInThread({ channelId: "D1", threadTs: "222.2" }, fakeClient);
  const result = await tool.run({ input: { text: "Cloning…" }, emitData: () => {} });

  expect(result).toEqual({ ok: false });
});
