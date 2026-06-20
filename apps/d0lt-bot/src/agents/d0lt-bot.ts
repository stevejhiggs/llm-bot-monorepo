import { createAgent, type AgentRouteHandler } from "@flue/runtime";
import instructions from "./d0lt-bot.md" with { type: "markdown" };
import reviewer from "../subagents/reviewer.ts";
import testRunner from "../subagents/test-runner.ts";

export const description =
  "GitHub assistant: routes PR reviews and test runs to specialist subagents.";

export const route: AgentRouteHandler = async (_c, next) => next();

// Root router. It owns the sandbox; its two subagents share it. The sandbox is
// chosen at runtime: local() for node dev, Cloudflare Sandbox when deployed.
export default createAgent(async ({ id }) => {
  // Sandbox is chosen via resolveSandboxKind(process.env) in Task 4; for now the
  // node factory is loaded directly. Dynamic import() establishes the pattern that
  // keeps each target's sandbox module out of the other target's bundle.
  const { createNodeSandbox } = await import("../lib/sandbox.node.ts");
  const { sandbox, cwd } = await createNodeSandbox({ id });

  return {
    model: "anthropic/claude-sonnet-4-6",
    instructions,
    sandbox,
    cwd,
    subagents: [reviewer, testRunner],
  };
});
