import type { SlackChannel } from "@flue/slack";
import instructions from "./instructions.md" with { type: "markdown" };
import {
  createSlackAgentIntegrationEntry,
  type SlackAgentIntegration,
} from "./agent-integration.ts";

export type { SlackAgentIntegration } from "./agent-integration.ts";

export function createSlackAgentIntegration(channel: SlackChannel): SlackAgentIntegration {
  return createSlackAgentIntegrationEntry(channel, instructions);
}
