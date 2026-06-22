// The channel's outbound capabilities: the reply and progress tools, each bound to
// one verified thread. They share the Web API client from `./client.ts` and convert
// the model's GFM to Slack mrkdwn via `../format/mrkdwn.ts` before posting.

import { defineTool } from "@flue/runtime";
import type { WebClient } from "@slack/web-api";
import * as v from "valibot";
import { toMrkdwn } from "../format/mrkdwn.ts";
import { client } from "./client.ts";

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
