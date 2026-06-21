import { createAgent, type AgentRouteHandler, type ToolDefinition } from "@flue/runtime";
import { resolveSandboxKind } from "../lib/sandbox.ts";
import { channel as githubChannel } from "../channels/github.ts";
import { channel as slackChannel } from "../channels/slack.ts";
import { channelEnabled } from "../lib/channel-flags.ts";
import { commentOnIssue } from "../lib/github-webhook.ts";
import { postProgressInThread, replyInThread } from "../lib/slack-events.ts";
import instructions from "./d0lt-bot.md" with { type: "markdown" };
import { createReviewer } from "../subagents/reviewer.ts";
import { createTestRunner } from "../subagents/test-runner.ts";

// What a turn's conversation id resolves to: the router's own outbound tools, plus
// any tools to inject into the subagents. Slack is the only channel that gives
// subagents a tool today — `post_slack_progress`, so they can narrate progress
// while the router is blocked on its `task`.
interface ConversationTools {
  router: ToolDefinition[];
  subagent: ToolDefinition[];
}

// A turn can arrive from chat (id "local"), from the GitHub channel, or from the
// Slack channel. For a channel turn, the instance id is that channel's conversation
// key and parses back to its bound destination — so the agent gets outbound tools
// fixed to that issue/PR or thread. Chat ids aren't keys and every parse throws,
// leaving chat sessions with no channel tool. Read inside the deferred initializer
// to keep the channel ⇄ agent import cycles safe.
function conversationTools(id: string): ConversationTools {
  try {
    return { router: [commentOnIssue(githubChannel.parseConversationKey(id))], subagent: [] };
  } catch {
    // not a GitHub conversation key
  }
  try {
    const ref = slackChannel.parseConversationKey(id);
    const progress = postProgressInThread(ref);
    // The router posts the opening ack and the final reply; the subagent posts the
    // phase milestones in between (the router is blocked on the task while it runs).
    return { router: [replyInThread(ref), progress], subagent: [progress] };
  } catch {
    // not a Slack conversation key
  }
  return { router: [], subagent: [] };
}

export const description =
  "GitHub assistant: routes PR reviews and test runs to specialist subagents.";

// Direct HTTP access is opt-in via CHANNEL_HTTP_ENABLE. The agent's public invocation
// surface (POST/GET/HEAD /agents/d0lt-bot/:id) exists only when this module exports a
// `route` function, so we export one only when the flag is set. Unset (the default) →
// no public HTTP surface at all (the endpoint 404s and is absent from openapi.json),
// and the bot is reachable only through enabled channel ingress (GitHub/Slack), which
// dispatch internally, plus `flue connect` (private child-process IPC) for local dev.
// The handler is a pass-through; gate it further (e.g. a bearer check) if HTTP callers
// need authz.
export const route: AgentRouteHandler | undefined = channelEnabled("http")
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
      ? (await import("../lib/sandbox.cloudflare.ts")).createCloudflareSandbox({
          id,
          env: {
            Sandbox: (env as any).Sandbox,
            GITHUB_TOKEN: (env as any).GITHUB_TOKEN,
          },
        })
      : (await import("../lib/sandbox.node.ts")).createNodeSandbox({ id });

  const { router, subagent } = conversationTools(id);

  return {
    model: "anthropic/claude-sonnet-4-6",
    instructions,
    sandbox,
    cwd,
    subagents: [createReviewer(subagent), createTestRunner(subagent)],
    tools: router,
  };
});
