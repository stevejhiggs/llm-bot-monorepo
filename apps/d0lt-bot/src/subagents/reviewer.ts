import { defineAgentProfile, type ToolDefinition } from "@flue/runtime";
import instructions from "./reviewer.md" with { type: "markdown" };
import fetchRepo from "../tools/fetch-repo.ts";

// Subagent profile delegated to by d0lt-bot via its built-in `task` capability.
// Shares the router's local() sandbox; clones and reads the PR there. Inherits the
// router's model unless overridden — here we ask for more reasoning effort.
//
// A factory (not a static profile) so the router can inject conversation-scoped
// tools — e.g. the thread-bound `post_slack_progress` for a Slack turn, so the
// subagent can narrate progress while the router is blocked on the task.
export function createReviewer(extraTools: ToolDefinition[] = []) {
  return defineAgentProfile({
    name: "reviewer",
    description:
      "Reviews a GitHub pull request: clones it into the sandbox, reads the diff in context, and " +
      "returns a structured code review (summary, severity-tagged findings, recommendation).",
    thinkingLevel: "high",
    instructions,
    tools: [fetchRepo, ...extraTools],
  });
}
