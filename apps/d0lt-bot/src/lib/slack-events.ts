// Slack Events API decision logic and the outbound reply tool.
// Kept separate from `channels/slack.ts` (which wires these into the channel and
// the agent) so the branching logic and the Web API call are unit-testable with
// Vitest, without loading the agent graph or its markdown imports.

import { defineTool } from "@flue/runtime";
import type { SlackEventsApiPayload, SlackThreadRef } from "@flue/slack";
import { WebClient } from "@slack/web-api";
import * as v from "valibot";

// Outbound Web API client. Authenticates as the bot user (SLACK_BOT_TOKEN).
export const client = new WebClient(process.env.SLACK_BOT_TOKEN);

/** The JSON turn delivered to the d0lt-bot agent for a handled Slack event. */
export interface SlackDispatchInput {
  type: "slack.app_mention" | "slack.message.im";
  eventId: string;
  text: string;
}

/** What `channels/slack.ts` should dispatch: the bound thread + its turn. */
export interface SlackDispatchPlan {
  ref: SlackThreadRef;
  input: SlackDispatchInput;
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
  };
}

/**
 * The agent's one outbound capability: reply in the Slack thread bound to this
 * conversation. The destination is fixed at bind time from the verified event —
 * the model supplies only the text, never the channel/thread — so it cannot be
 * steered to post elsewhere. `slack` is injectable for tests.
 */
export function replyInThread(
  ref: { channelId: string; threadTs: string },
  slack: WebClient = client,
) {
  return defineTool({
    name: "reply_in_slack_thread",
    description:
      "Reply in the Slack thread bound to this conversation. Use this to post your final result " +
      "(the review or the test outcome) back to Slack. Supply only the message text; the target " +
      "thread is fixed.",
    parameters: v.object({
      text: v.pipe(
        v.string(),
        v.minLength(1),
        v.description("The message text to post. Must be non-empty."),
      ),
    }),
    async execute({ text }) {
      const result = await slack.chat.postMessage({
        channel: ref.channelId,
        thread_ts: ref.threadTs,
        text,
      });
      return JSON.stringify({ channel: result.channel, ts: result.ts });
    },
  });
}
