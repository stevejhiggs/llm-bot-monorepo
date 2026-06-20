import { createAgent, type AgentRouteHandler } from "@flue/runtime";
import { resolveSandboxKind } from "../lib/sandbox.ts";
import { channel } from "../channels/github.ts";
import { commentOnIssue } from "../lib/github-webhook.ts";
import instructions from "./d0lt-bot.md" with { type: "markdown" };
import reviewer from "../subagents/reviewer.ts";
import testRunner from "../subagents/test-runner.ts";

// When a turn arrives from the GitHub channel, the instance id is the channel's
// conversation key and parses back to the bound issue/PR — so the agent gets a
// comment tool fixed to that thread. Direct chat ids (e.g. "local") aren't keys
// and throw, leaving chat sessions with no GitHub tool. Read inside the deferred
// initializer to keep the channel ⇄ agent import cycle safe.
function githubTools(id: string) {
  try {
    return [commentOnIssue(channel.parseConversationKey(id))];
  } catch {
    return [];
  }
}

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
      : await (await import("../lib/sandbox.node.ts")).createNodeSandbox({ id });

  return {
    model: "anthropic/claude-sonnet-4-6",
    instructions,
    sandbox,
    cwd,
    subagents: [reviewer, testRunner],
    tools: githubTools(id),
  };
});
