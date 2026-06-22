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
    "reply_in_slack_thread",
    "post_slack_progress",
  ]);
  expect(tools.subagent.map((tool) => tool.name)).toEqual(["post_slack_progress"]);
});
