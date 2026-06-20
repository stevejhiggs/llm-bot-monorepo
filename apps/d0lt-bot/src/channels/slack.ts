// Discovered Slack channel. Flue serves its Events API route at
// /channels/slack/events (relative to the flue() mount). @flue/slack verifies
// each request's X-Slack-Signature and timestamp against the exact bytes before
// the handler runs, and answers URL-verification challenges internally — so the
// handler below sees only authentic, non-challenge deliveries.
//
// Thin by design: the branching logic and the outbound reply tool live in
// ../lib/slack-events.ts (unit-tested there). Here we only build the channel and
// bridge verified events to the d0lt-bot agent via dispatch().

import { dispatch } from "@flue/runtime";
import { createSlackChannel } from "@flue/slack";
import d0ltBot from "../agents/d0lt-bot.ts";
import { planSlackEvent } from "../lib/slack-events.ts";

// d0lt-bot.ts imports `channel` (and the reply tool) back from this module. That
// cycle is safe because every cross-module binding is read inside a deferred
// callback — `d0ltBot` only inside `events` below, and `channel` only inside the
// agent initializer — never at module-eval time.
//
// Only the `events` handler is configured, so only POST /events is mounted;
// interactivity and slash-command routes are intentionally absent.
export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,

  async events({ payload }) {
    const plan = planSlackEvent(payload);
    // Unhandled events return nothing → an empty 200, the fast ack Slack wants.
    // Handled work is dispatched durably and processed after we respond.
    if (!plan) return;

    await dispatch(d0ltBot, {
      // One agent instance per Slack thread: all activity in the same thread
      // shares a conversation, so the bot keeps context across messages.
      id: channel.conversationKey(plan.ref),
      input: plan.input,
    });
  },
});

export { replyInThread } from "../lib/slack-events.ts";
