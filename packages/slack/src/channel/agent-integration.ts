import type { SlackChannel, SlackThreadRef } from "@flue/slack";
import type { ChannelIntegration } from "@repo/channel-registry";
import { postProgressInThread, replyInThread } from "./reply.ts";

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
      return { router: [replyInThread(ref), progress], subagent: [progress] };
    },
  };
}
