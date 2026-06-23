import type { SlackChannel, SlackThreadRef } from "@flue/slack";
import type { ChannelIntegration } from "@repo/channel-registry";
import { postProgressInThread } from "./reply.ts";
import { replyWithBlocks } from "./actions.ts";

export type SlackAgentIntegration = ChannelIntegration<SlackThreadRef>;

export function createSlackAgentIntegrationEntry(
  channel: SlackChannel,
  instructions: string,
): SlackAgentIntegration {
  return {
    instructions,
    parseConversationKey: (id) => channel.parseConversationKey(id),
    tools: (ref) => {
      const progress = postProgressInThread(ref);
      return { router: [replyWithBlocks(ref), progress], subagent: [progress] };
    },
  };
}
