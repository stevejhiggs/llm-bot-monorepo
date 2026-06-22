// Inbound enrichment: read a Slack thread's prior messages and attach them to the
// turn before dispatch. This touches the Slack Web API (so it lives under `channel/`
// with the shared client), but it is kept out of the pure `events/plan.ts` decision
// so that stays unit-testable without a network.

import type { WebClient } from "@slack/web-api";
import type { SlackDispatchInput, SlackDispatchPlan } from "../events/plan.ts";
import { client } from "./client.ts";

// How many of a thread's most recent messages to attach as context, and the page-
// follow cap that keeps a pathological thread from fanning out unbounded API calls.
const MAX_THREAD_MESSAGES = 20;
const MAX_THREAD_PAGES = 5;

interface ThreadReply {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
}

/**
 * Fetch the prior messages of a Slack thread and format them as context. Reads the
 * thread via `conversations.replies` (following pagination cursors up to a cap),
 * drops the triggering message (`excludeTs`), keeps the most recent `max`, and
 * formats them oldest-first — one line per message, labelled `[bot]` for the bot's
 * own posts (those carrying `bot_id`) or `[<userId>]` otherwise. User ids are left
 * raw (no `users.info` resolution). Returns `null` when nothing remains.
 *
 * Needs the bot token to carry history scopes (`channels:history` / `groups:history`
 * / `im:history` / `mpim:history`). `slack` is injectable for tests.
 */
export async function fetchThreadContext(
  args: { channelId: string; threadTs: string; excludeTs: string },
  slack: WebClient = client,
  max = MAX_THREAD_MESSAGES,
): Promise<string | null> {
  const collected: ThreadReply[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const res = await slack.conversations.replies({
      channel: args.channelId,
      ts: args.threadTs,
      ...(cursor ? { cursor } : {}),
    });
    collected.push(...((res.messages as ThreadReply[] | undefined) ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  const relevant = collected.filter((m) => m.ts !== args.excludeTs).slice(-max);
  if (relevant.length === 0) return null;

  return relevant
    .map((m) => `[${m.bot_id ? "bot" : (m.user ?? "unknown")}]: ${m.text ?? ""}`)
    .join("\n");
}

/**
 * Return the turn to dispatch, enriched with prior thread context when the trigger
 * is a reply inside an existing thread (`ref.threadTs !== messageTs`). Top-level
 * mentions and plain DMs return `plan.input` unchanged with no API call. Fail-quiet:
 * a failed (or empty) fetch logs and dispatches the turn **without** context — a
 * Slack hiccup must never drop the turn. `slack` is injectable for tests.
 */
export async function enrichWithThreadContext(
  plan: SlackDispatchPlan,
  slack: WebClient = client,
): Promise<SlackDispatchInput> {
  if (plan.ref.threadTs === plan.messageTs) return plan.input;

  try {
    const threadContext = await fetchThreadContext(
      { channelId: plan.ref.channelId, threadTs: plan.ref.threadTs, excludeTs: plan.messageTs },
      slack,
    );
    return threadContext ? { ...plan.input, threadContext } : plan.input;
  } catch (error) {
    console.warn("[slack] thread context fetch failed:", error);
    return plan.input;
  }
}
