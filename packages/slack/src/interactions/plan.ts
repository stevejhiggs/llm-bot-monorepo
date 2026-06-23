// Pure Slack interactivity decision logic, the inbound twin of `events/plan.ts`.
// Kept separate from `channel/channel.ts` (which wires it into the Flue channel and
// dispatches) so the branching is unit-testable without the agent graph. Returns
// null for everything the bot doesn't act on, so the channel answers an empty 200.

import type { SlackInteractionPayload, SlackThreadRef } from "@flue/slack";

/** The synthetic turn delivered to the agent when a user interacts with a block. */
export interface SlackBlockActionInput {
  type: "slack.block_action";
  elementType: "button" | "overflow" | "static_select";
  actionId: string;
  value: string;
  blockId: string;
  userId: string;
  // A natural-language rendering so the model handles it like any other turn.
  text: string;
}

export interface SlackInteractionPlan {
  ref: SlackThreadRef;
  input: SlackBlockActionInput;
}

const SUPPORTED = new Set(["button", "overflow", "static_select"]);

interface ActionLike {
  type?: string;
  action_id?: string;
  block_id?: string;
  value?: string;
  selected_option?: { value?: string };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Decide what (if anything) a verified interactivity delivery should dispatch.
 * Handles `block_actions` for button / overflow / static_select; returns null for
 * every other interaction type, malformed payload, or unsupported element. Pure.
 */
export function planSlackInteraction(
  payload: SlackInteractionPayload,
): SlackInteractionPlan | null {
  if (payload.type !== "block_actions") return null;

  const action = (payload.actions?.[0] ?? {}) as ActionLike;
  const elementType = action.type;
  if (!elementType || !SUPPORTED.has(elementType)) return null;

  const container = (payload.container ?? {}) as Record<string, unknown>;
  const channelInfo = (payload.channel ?? {}) as Record<string, unknown>;
  const message = (payload.message ?? {}) as Record<string, unknown>;

  const teamId = str(payload.team?.id);
  const channelId = str(container.channel_id) ?? str(channelInfo.id);
  const threadTs =
    str(container.thread_ts) ??
    str(message.thread_ts) ??
    str(container.message_ts) ??
    str(message.ts);
  const userId = str(payload.user?.id);

  if (!teamId || !channelId || !threadTs || !userId) return null;

  const value = str(action.value) ?? str(action.selected_option?.value) ?? "";
  const actionId = str(action.action_id) ?? "";
  const blockId = str(action.block_id) ?? "";

  const verb = elementType === "button" ? "clicked the button" : "selected an option from the menu";
  const text = `The user ${verb} (action_id: "${actionId}", value: "${value}").`;

  return {
    ref: { teamId, channelId, threadTs },
    input: {
      type: "slack.block_action",
      elementType: elementType as SlackBlockActionInput["elementType"],
      actionId,
      value,
      blockId,
      userId,
      text,
    },
  };
}
