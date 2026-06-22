import type { GitHubChannel } from "@flue/github";
import instructions from "./instructions.md" with { type: "markdown" };
import {
  createGitHubAgentIntegrationEntry,
  type GitHubAgentIntegration,
} from "./agent-integration.ts";

export type { GitHubAgentIntegration } from "./agent-integration.ts";

export function createGitHubAgentIntegration(channel: GitHubChannel): GitHubAgentIntegration {
  return createGitHubAgentIntegrationEntry(channel, instructions);
}
