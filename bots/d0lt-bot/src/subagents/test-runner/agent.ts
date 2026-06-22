import { defineAgentProfile, type ToolDefinition } from "@flue/runtime";
import instructions from "./instructions.md" with { type: "markdown" };
import exploreRepo from "@repo/github/skills/explore-repo/SKILL.md" with { type: "skill" };
import { fetchRepoTool } from "@repo/github";

// Subagent profile delegated to by d0lt-bot via its built-in `task` capability.
// Shares the router's local() sandbox; clones, installs, and runs tests there.
//
// A factory (not a static profile) so the router can inject conversation-scoped
// tools — e.g. the thread-bound `post_slack_progress` for a Slack turn, so the
// subagent can narrate progress while the router is blocked on the task.
export function createTestRunner(extraTools: ToolDefinition[] = []) {
  return defineAgentProfile({
    name: "test_runner",
    description:
      "Runs a repository’s tests: clones the code into the sandbox, detects the stack, installs " +
      "dependencies, runs the tests, and returns a structured pass/fail result.",
    instructions,
    skills: [exploreRepo],
    tools: [fetchRepoTool, ...extraTools],
  });
}
