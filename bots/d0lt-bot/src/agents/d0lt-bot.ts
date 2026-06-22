import { createAgent, type AgentRouteHandler } from "@flue/runtime";
import { resolveRegisteredConversation, type ChannelRegistry } from "@repo/channel-registry";
import { resolveSandboxKind } from "@repo/sandbox";
import { channel as githubChannel } from "../channels/github.ts";
import { channel as slackChannel } from "../channels/slack.ts";
import { channelEnabled } from "../lib/channel-flags.ts";
import { BOT_NAME } from "../config.ts";
import { fetchRepoTool } from "@repo/github";
import { createGitHubAgentIntegration } from "@repo/github/agent-integration";
import { createSlackAgentIntegration } from "@repo/slack/agent-integration";
import baseInstructions from "./instructions.md" with { type: "markdown" };
import exploreRepo from "@repo/github/skills/explore-repo/SKILL.md" with { type: "skill" };
import { createReviewer } from "../subagents/reviewer/agent.ts";
import { createTestRunner } from "../subagents/test-runner/agent.ts";

// The base prompt applies to every turn; a channel turn additionally gets its
// package-owned fragment appended, and gets outbound tools bound to the verified
// channel destination encoded in the conversation key. Chat ids do not parse as a
// channel key, so they get no fragment and no channel tools.
const CHANNEL_REGISTRY = {
  github: createGitHubAgentIntegration(githubChannel),
  slack: createSlackAgentIntegration(slackChannel),
} satisfies ChannelRegistry;

export const description =
  "GitHub assistant: answers repo questions directly and routes PR reviews and test runs to " +
  "specialist subagents.";

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

// Root router. It owns a lightweight sandbox facade; its two subagents share it.
// The facade answers Flue's startup context probes without booting the real
// sandbox, then provisions the full node/cloudflare implementation on first real
// workspace operation. Dynamic import() keeps each target's sandbox module out of
// the other target's bundle.
export default createAgent(async ({ id, env }) => {
  // Classify the turn's source once, then derive both the prompt fragment and the
  // outbound tool set from the same registry entry.
  const conversation = resolveRegisteredConversation(id, CHANNEL_REGISTRY);
  const instructions = [baseInstructions, conversation.instructions].filter(Boolean).join("\n");

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
          appName: BOT_NAME,
          secrets: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
        });

  return {
    model: "anthropic/claude-sonnet-4-6",
    instructions,
    sandbox,
    cwd,
    skills: [exploreRepo],
    subagents: [
      createReviewer(conversation.tools.subagent),
      createTestRunner(conversation.tools.subagent),
    ],
    tools: [...conversation.tools.router, fetchRepoTool],
  };
});
