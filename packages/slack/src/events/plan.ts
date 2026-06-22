// Pure Slack Events API decision logic. Kept separate from `channel/channel.ts`
// (which wires this into the Flue channel and dispatches) so the branching is
// unit-testable with Vitest, without loading the agent graph or its markdown imports.
// The side-effecting halves — thread-context fetch and the outbound tools — live
// under `channel/`, next to the Web API client they use.

import type { SlackEventsApiPayload, SlackThreadRef } from "@flue/slack";

/** The JSON turn delivered to the d0lt-bot agent for a handled Slack event. */
export interface SlackDispatchInput {
  type: "slack.app_mention" | "slack.message.im";
  eventId: string;
  text: string;
  // Earlier messages in the thread, oldest-first, attached by enrichWithThreadContext
  // when the turn is a reply inside an existing thread. Context only — the request is
  // still in `text`. Absent for top-level mentions and plain DMs.
  threadContext?: string;
}

/** What `channel/channel.ts` should dispatch: the bound thread + its turn. */
export interface SlackDispatchPlan {
  ref: SlackThreadRef;
  input: SlackDispatchInput;
  // The triggering message's own `ts`. `ref.threadTs` is the thread root, so the turn
  // is a reply inside an existing thread iff `ref.threadTs !== messageTs`. Used to
  // gate the thread-context fetch and to exclude the trigger from it; never sent to
  // the model.
  messageTs: string;
}

// The subset of message-event fields we read. Slack's message union spans many
// subtypes, so we read these structurally rather than narrowing the full union.
interface SlackMessageLike {
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  channel_type?: string;
  subtype?: string;
  bot_id?: string;
}

/**
 * Decide what (if anything) a verified Slack delivery should dispatch to d0lt-bot.
 * Returns `null` for everything the bot does not act on, so the channel answers an
 * empty `200`. Pure: no network, no dispatch, no channel coupling.
 *
 * Handled:
 * - `app_mention` — the bot was @-mentioned in a channel or thread.
 * - `message` in a DM (`channel_type === "im"`) from a real user — not a bot post
 *   (`bot_id`) and not an edit/system subtype.
 */
export function planSlackEvent(payload: SlackEventsApiPayload): SlackDispatchPlan | null {
  if (payload.type !== "event_callback") return null;
  const event = payload.event;
  // Slack's message union spans many subtypes; read the fields we need structurally.
  const message = event as unknown as SlackMessageLike;

  if (event.type === "app_mention") {
    return makePlan(payload.team_id, payload.event_id, message, "slack.app_mention");
  }

  if (event.type === "message") {
    // Skip the bot's own posts and edit/join/system subtypes so a reply can never
    // re-trigger the bot.
    if (message.bot_id || message.subtype) return null;
    // Only direct messages; channel messages are reached via app_mention instead.
    if (message.channel_type !== "im") return null;
    return makePlan(payload.team_id, payload.event_id, message, "slack.message.im");
  }

  return null;
}

function makePlan(
  teamId: string,
  eventId: string,
  event: SlackMessageLike,
  type: SlackDispatchInput["type"],
): SlackDispatchPlan {
  return {
    ref: { teamId, channelId: event.channel, threadTs: event.thread_ts ?? event.ts },
    input: { type, eventId, text: event.text ?? "" },
    messageTs: event.ts,
  };
}
