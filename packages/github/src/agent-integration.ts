import type { GitHubChannel, GitHubIssueRef } from "@flue/github";
import type { ChannelIntegration } from "@repo/channel-registry";
import { commentOnIssue } from "./github-webhook.ts";

export type GitHubAgentIntegration = ChannelIntegration<GitHubIssueRef>;

export function createGitHubAgentIntegrationEntry(
  channel: GitHubChannel,
  instructions: string,
): GitHubAgentIntegration {
  return {
    instructions,
    parseConversationKey: (id) => channel.parseConversationKey(id),
    tools: (ref) => ({ router: [commentOnIssue(ref)], subagent: [] }),
  };
}
