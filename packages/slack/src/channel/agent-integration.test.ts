import type { SlackChannel } from "@flue/slack";
import { expect, test } from "vitest";
import { createSlackAgentIntegrationEntry } from "./agent-integration.ts";

test("creates a registry entry with Slack-owned instructions, parser, and tools", () => {
  const channel = {
    parseConversationKey: (id: string) => {
      if (id !== "slack-key") throw new Error("not slack");
      return { teamId: "T1", channelId: "C1", threadTs: "100.0" };
    },
  } as unknown as SlackChannel;

  const integration = createSlackAgentIntegrationEntry(
    channel,
    "## When the turn comes from Slack\n",
  );
  const ref = integration.parseConversationKey("slack-key");
  const tools = integration.tools(ref);

  expect(integration.instructions).toContain("When the turn comes from Slack");
  expect(ref).toEqual({ teamId: "T1", channelId: "C1", threadTs: "100.0" });
  expect(tools.router.map((tool) => tool.name)).toEqual([
    "reply_with_blocks",
    "post_slack_progress",
  ]);
  expect(tools.subagent.map((tool) => tool.name)).toEqual(["post_slack_progress"]);
});

test("router toolset includes reply_with_blocks bound to the thread", () => {
  const channel = {
    parseConversationKey: (id: string) => ({ teamId: "T", channelId: "C", threadTs: id }),
  } as unknown as SlackChannel;
  const entry = createSlackAgentIntegrationEntry(channel, "instructions");
  const names = entry
    .tools({ teamId: "T", channelId: "C", threadTs: "1.1" })
    .router.map((t) => t.name);
  expect(names).toContain("reply_with_blocks");
});
