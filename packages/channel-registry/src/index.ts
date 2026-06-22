import type { ToolDefinition } from "@flue/runtime";

export interface ConversationTools {
  router: ToolDefinition[];
  subagent: ToolDefinition[];
}

export interface ChannelIntegration<Ref = unknown> {
  instructions: string;
  parseConversationKey: (id: string) => Ref;
  tools: (ref: Ref) => ConversationTools;
}

export type ChannelRegistry = Record<string, ChannelIntegration<any>>;

export interface RegisteredConversation {
  source: string;
  instructions: string;
  tools: ConversationTools;
}

const CHAT_TOOLS: ConversationTools = { router: [], subagent: [] };

export function resolveRegisteredConversation(
  id: string,
  registry: ChannelRegistry,
): RegisteredConversation {
  for (const [source, integration] of Object.entries(registry)) {
    try {
      const ref = integration.parseConversationKey(id);
      return {
        source,
        instructions: integration.instructions,
        tools: integration.tools(ref),
      };
    } catch {
      // not this channel's conversation key
    }
  }

  return {
    source: "chat",
    instructions: "",
    tools: CHAT_TOOLS,
  };
}
