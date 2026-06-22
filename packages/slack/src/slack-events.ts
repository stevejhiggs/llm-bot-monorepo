// Slack Events API decision logic and the outbound reply tool.
// Kept separate from `channels/slack.ts` (which wires these into the channel and
// the agent) so the branching logic and the Web API call are unit-testable with
// Vitest, without loading the agent graph or its markdown imports.

import { defineTool } from "@flue/runtime";
import type { SlackEventsApiPayload, SlackThreadRef } from "@flue/slack";
import { WebClient } from "@slack/web-api";
import * as v from "valibot";
import { toMrkdwn } from "./slack-format.ts";

// A fetch wrapper that makes @slack/web-api's HTTP client work on Cloudflare
// Workers, which mishandles it two ways:
//
//  1. Receiver: the WebClient stores the fetch impl and calls it as a method
//     (`this.fetchFn(url, …)`), so the receiver is the WebClient, not globalThis.
//     Node's undici fetch ignores its receiver, but workerd's fetch requires
//     `this === globalThis` and otherwise throws "Illegal invocation". The bound
//     default `baseFetch` keeps the call valid on both targets.
//  2. Redirect mode: @slack/web-api sets `redirect: "error"` on its requests, which
//     workerd rejects ("must be one of follow or manual"), failing every Slack call.
//     Slack's API never redirects, so we rewrite it to "manual" to pass validation.
//
// `baseFetch` is injectable so the unit test can assert the rewrite without a network.
export function workerdSafeFetch(
  baseFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return (input, init) => {
    const safeInit = init?.redirect === "error" ? { ...init, redirect: "manual" as const } : init;
    return baseFetch(input, safeInit);
  };
}

// Outbound Web API client. Authenticates as the bot user (SLACK_BOT_TOKEN).
export const client = new WebClient(process.env.SLACK_BOT_TOKEN, {
  fetch: workerdSafeFetch(),
});

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

type ThreadRef = { channelId: string; threadTs: string };

/** A non-empty `text` param schema with a tool-specific description. */
function threadTextParam(description: string) {
  return v.object({
    text: v.pipe(v.string(), v.minLength(1), v.description(description)),
  });
}

/** Post into the bound thread. The model writes GFM; Slack needs mrkdwn. */
function postToThread(slack: WebClient, ref: ThreadRef, text: string) {
  return slack.chat.postMessage({
    channel: ref.channelId,
    thread_ts: ref.threadTs,
    text: toMrkdwn(text),
  });
}

/**
 * The agent's one outbound capability: reply in the Slack thread bound to this
 * conversation. The destination is fixed at bind time from the verified event —
 * the model supplies only the text, never the channel/thread — so it cannot be
 * steered to post elsewhere. `slack` is injectable for tests.
 */
export function replyInThread(ref: ThreadRef, slack: WebClient = client) {
  return defineTool({
    name: "reply_in_slack_thread",
    description:
      "Reply in the Slack thread bound to this conversation. Use this to post your final result " +
      "(the review or the test outcome) back to Slack. Supply only the message text; the target " +
      "thread is fixed.",
    parameters: threadTextParam("The message text to post. Must be non-empty."),
    async execute({ text }) {
      const result = await postToThread(slack, ref, text);
      return JSON.stringify({ channel: result.channel, ts: result.ts });
    },
  });
}

/**
 * A best-effort progress note in the bound Slack thread, for narrating long runs
 * ("Cloning…", "Running tests…"). Like `reply_in_slack_thread`, the destination is
 * fixed at bind time and the model supplies only short text. Unlike the reply tool,
 * a failed post is swallowed (logged, `{ ok:false }` returned) — a transient Slack
 * hiccup mid-run must not abort the work. `slack` is injectable for tests.
 */
export function postProgressInThread(ref: ThreadRef, slack: WebClient = client) {
  return defineTool({
    name: "post_slack_progress",
    description:
      "Post a short progress update in the Slack thread while you work (e.g. 'Cloning the repo…', " +
      "'Running tests…'). Use it before each major phase so the user isn't left waiting in silence. " +
      "Keep it to a few words; do NOT post the final result here — use reply_in_slack_thread for that.",
    parameters: threadTextParam("A brief progress note, a few words. Must be non-empty."),
    async execute({ text }) {
      try {
        const result = await postToThread(slack, ref, text);
        return JSON.stringify({ ok: true, ts: result.ts });
      } catch (error) {
        console.warn("[slack] progress post failed:", error);
        return JSON.stringify({ ok: false });
      }
    },
  });
}
