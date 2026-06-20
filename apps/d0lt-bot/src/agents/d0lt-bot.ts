import { createAgent, type AgentRouteHandler } from "@flue/runtime";
import { resolveSandboxKind } from "../lib/sandbox.ts";
import instructions from "./d0lt-bot.md" with { type: "markdown" };
import reviewer from "../subagents/reviewer.ts";
import testRunner from "../subagents/test-runner.ts";

export const description =
  "GitHub assistant: routes PR reviews and test runs to specialist subagents.";

export const route: AgentRouteHandler = async (_c, next) => next();

// Root router. It owns the sandbox; its two subagents share it. The sandbox
// implementation is selected at runtime: the node local() sandbox for dev
// (FLUE_SANDBOX unset), or a Cloudflare container sandbox when deployed
// (FLUE_SANDBOX=cloudflare). Dynamic import() keeps each target's sandbox
// module out of the other target's bundle.
export default createAgent(async ({ id, env }) => {
  const kind = resolveSandboxKind(process.env);

  const { sandbox, cwd } =
    kind === "cloudflare"
      ? await (
          await import("../lib/sandbox.cloudflare.ts")
        ).createCloudflareSandbox({
          id,
          env: {
            Sandbox: (env as any).Sandbox,
            GITHUB_TOKEN: (env as any).GITHUB_TOKEN,
          },
        })
      : await (
          await import("../lib/sandbox.node.ts")
        ).createNodeSandbox({ id });

  return {
    model: "anthropic/claude-sonnet-4-6",
    instructions,
    sandbox,
    cwd,
    subagents: [reviewer, testRunner],
  };
});
