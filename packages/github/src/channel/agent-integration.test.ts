import type { GitHubChannel } from "@flue/github";
import { expect, test } from "vitest";
import { createGitHubAgentIntegrationEntry } from "./agent-integration.ts";

test("creates a registry entry with GitHub-owned instructions, parser, and tools", () => {
  const channel = {
    parseConversationKey: (id: string) => {
      if (id !== "github-key") throw new Error("not github");
      return { owner: "owner", repo: "repo", issueNumber: 7 };
    },
  } as unknown as GitHubChannel;

  const integration = createGitHubAgentIntegrationEntry(
    channel,
    "## When the turn comes from GitHub\n",
  );
  const ref = integration.parseConversationKey("github-key");

  expect(integration.instructions).toContain("When the turn comes from GitHub");
  expect(ref).toEqual({ owner: "owner", repo: "repo", issueNumber: 7 });
  expect(integration.tools(ref).router.map((tool) => tool.name)).toEqual([
    "comment_on_github_issue",
  ]);
  expect(integration.tools(ref).subagent).toEqual([]);
});
