import { createAgent, type AgentRouteHandler, type ToolDefinition } from "@flue/runtime";
import { resolveSandboxKind } from "../lib/sandbox.ts";
import { channel as githubChannel } from "../channels/github.ts";
import { channel as slackChannel } from "../channels/slack.ts";
import { commentOnIssue } from "../lib/github-webhook.ts";
import { replyInThread } from "../lib/slack-events.ts";
import instructions from "./d0lt-bot.md" with { type: "markdown" };
import reviewer from "../subagents/reviewer.ts";
import testRunner from "../subagents/test-runner.ts";

// A turn can arrive from chat (id "local"), from the GitHub channel, or from the
// Slack channel. For a channel turn, the instance id is that channel's conversation
// key and parses back to its bound destination — so the agent gets an outbound tool
// fixed to that issue/PR or thread. Chat ids aren't keys and every parse throws,
// leaving chat sessions with no channel tool. Read inside the deferred initializer
// to keep the channel ⇄ agent import cycles safe.
function channelTools(id: string): ToolDefinition[] {
  try {
    return [commentOnIssue(githubChannel.parseConversationKey(id))];
  } catch {
    // not a GitHub conversation key
  }
  try {
    const { channelId, threadTs } = slackChannel.parseConversationKey(id);
    return [replyInThread({ channelId, threadTs })];
  } catch {
    // not a Slack conversation key
  }
  return [];
}

export const description =
  "GitHub assistant: routes PR reviews and test runs to specialist subagents.";

// Direct HTTP access is opt-in. The agent's public invocation surface
// (POST/GET/HEAD /agents/d0lt-bot/:id) exists only when this module exports a `route`
// function, so we export one only when ALLOW_HTTP_ACCESS is set. Unset (the default)
// → no public HTTP surface at all (the endpoint 404s and is absent from openapi.json),
// and the bot is reachable only through verified channel ingress (GitHub
// /channels/github/webhook, Slack /channels/slack/events), which dispatch internally,
// plus `flue connect` (private child-process IPC) for local dev. The handler is a
// pass-through; gate it further (e.g. a bearer check) if HTTP callers need authz.
export const route: AgentRouteHandler | undefined = process.env.ALLOW_HTTP_ACCESS
  ? async (_c, next) => next()
  : undefined;

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
    tools: channelTools(id),
  };
});
