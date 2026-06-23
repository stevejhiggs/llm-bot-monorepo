// The channel's best-effort progress tool, bound to one verified thread. It shares
// the Web API client from `./client.ts` and converts the model's GFM to Slack mrkdwn
// via `../format/mrkdwn.ts` before posting. The final reply is posted separately via
// `reply_with_blocks` (see `./actions.ts`).

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
 * A best-effort progress note in the bound Slack thread, for narrating long runs
 * ("Cloning…", "Running tests…"). The destination is fixed at bind time from the
 * verified event and the model supplies only short text, so it cannot be steered to
 * post elsewhere. A failed post is swallowed (logged, `{ ok:false }` returned) — a
 * transient Slack hiccup mid-run must not abort the work. `slack` is injectable for
 * tests.
 */
export function postProgressInThread(ref: ThreadRef, slack: WebClient = client) {
  return defineTool({
    name: "post_slack_progress",
    description:
      "Post a short progress update in the Slack thread while you work (e.g. 'Cloning the repo…', " +
      "'Running tests…'). Use it before each major phase so the user isn't left waiting in silence. " +
      "Keep it to a few words; do NOT post the final result here — use reply_with_blocks for that.",
    input: threadTextParam("A brief progress note, a few words. Must be non-empty."),
    async run({ input: { text } }): Promise<{ ok: true; ts: string | null } | { ok: false }> {
      try {
        const result = await postToThread(slack, ref, text);
        return { ok: true, ts: result.ts ?? null };
      } catch (error) {
        console.warn("[slack] progress post failed:", error);
        return { ok: false };
      }
    },
  });
}
