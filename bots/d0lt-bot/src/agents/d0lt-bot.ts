import { createAgent, type AgentRouteHandler, type ToolDefinition } from "@flue/runtime";
import { resolveSandboxKind } from "@repo/sandbox";
import { channel as githubChannel } from "../channels/github.ts";
import { channel as slackChannel } from "../channels/slack.ts";
import { channelEnabled } from "../lib/channel-flags.ts";
import { commentOnIssue } from "@repo/github";
import { postProgressInThread, replyInThread } from "@repo/slack";
import baseInstructions from "./d0lt-bot.md" with { type: "markdown" };
import githubInstructions from "@repo/github/instructions.md" with { type: "markdown" };
import slackInstructions from "@repo/slack/instructions.md" with { type: "markdown" };
import { type ConversationSource, resolveConversationSource } from "../lib/conversation-source.ts";
import { createReviewer } from "../subagents/reviewer.ts";
import { createTestRunner } from "../subagents/test-runner.ts";

// The base prompt applies to every turn; a channel turn additionally gets its
// channel's fragment appended, so the model sees only the section for where the turn
// came from (chat gets the base alone). The fragment lives in the channel's package
// (alongside its tools), keeping everything about a channel in one place.
const INSTRUCTION_FRAGMENTS: Record<ConversationSource, string> = {
  github: githubInstructions,
  slack: slackInstructions,
  chat: "",
};

// What a turn's conversation id resolves to: the router's own outbound tools, plus
// any tools to inject into the subagents. Slack is the only channel that gives
// subagents a tool today — `post_slack_progress`, so they can narrate progress
// while the router is blocked on its `task`.
interface ConversationTools {
  router: ToolDefinition[];
  subagent: ToolDefinition[];
}

// The channels' parseConversationKey methods, wrapped so `this` stays bound when
// passed to resolveConversationSource. Both the source classification and the tools
// below derive from these — the single place the agent reaches into the channels.
const parsers = {
  github: (id: string) => githubChannel.parseConversationKey(id),
  slack: (id: string) => slackChannel.parseConversationKey(id),
};

// A turn can arrive from chat (id "local"), from the GitHub channel, or from the
// Slack channel. For a channel turn, the instance id is that channel's conversation
// key and parses back to its bound destination — so the agent gets outbound tools
// fixed to that issue/PR or thread. Chat ids aren't keys, so they resolve to "chat"
// and get no channel tool. `source` is classified once by resolveConversationSource,
// so here we parse only the matching channel. Called inside the deferred initializer
// to keep the channel ⇄ agent import cycles safe.
function conversationTools(id: string, source: ConversationSource): ConversationTools {
  if (source === "github") {
    return { router: [commentOnIssue(parsers.github(id))], subagent: [] };
  }
  if (source === "slack") {
    const ref = parsers.slack(id);
    const progress = postProgressInThread(ref);
    // The router posts the opening ack and the final reply; the subagent posts the
    // phase milestones in between (the router is blocked on the task while it runs).
    return { router: [replyInThread(ref), progress], subagent: [progress] };
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
      ? (await import("@repo/sandbox/cloudflare")).createCloudflareSandbox({
          id,
          sandboxBinding: (env as any).Sandbox,
          secrets: { GITHUB_TOKEN: (env as any).GITHUB_TOKEN },
        })
      : (await import("@repo/sandbox/node")).createNodeSandbox({
          id,
          appName: "d0lt-bot",
          secrets: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
        });

  // Classify the turn's source once, then derive both the prompt fragment and the
  // outbound tool set from it.
  const source = resolveConversationSource(id, parsers);
  const { router, subagent } = conversationTools(id, source);
  const instructions = [baseInstructions, INSTRUCTION_FRAGMENTS[source]].filter(Boolean).join("\n");

  return {
    model: "anthropic/claude-sonnet-4-6",
    instructions,
    sandbox,
    cwd,
    subagents: [createReviewer(subagent), createTestRunner(subagent)],
    tools: router,
  };
});
