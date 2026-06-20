// Discovered GitHub channel. Flue serves its single route at
// /channels/github/webhook (relative to the flue() mount). @flue/github verifies
// each delivery's X-Hub-Signature-256 against the exact request bytes before the
// handler runs, so everything below sees only authentic deliveries.
//
// This module is intentionally thin: the branching logic and the outbound comment
// tool live in ../lib/github-webhook.ts (unit-tested there). Here we only build the
// channel and bridge verified deliveries to the d0lt-bot agent via dispatch().

import { createGitHubChannel } from "@flue/github";
import { dispatch } from "@flue/runtime";
import d0ltBot from "../agents/d0lt-bot.ts";
import { planDelivery, triggerPhrase } from "../lib/github-webhook.ts";

// d0lt-bot.ts imports `channel` (and the comment tool) back from this module. That
// cycle is safe because every cross-module binding is read inside a deferred
// callback — `d0ltBot` only inside `webhook` below, and `channel` only inside the
// agent initializer — never at module-eval time.
export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,

  async webhook({ delivery }) {
    const plan = planDelivery(delivery, triggerPhrase());
    // Unhandled deliveries return nothing → an empty 200, the fast ack GitHub
    // wants. Handled work is dispatched durably and processed after we respond.
    if (!plan) return;

    await dispatch(d0ltBot, {
      // One agent instance per issue/PR: all activity on the same thread shares a
      // conversation, so the bot keeps context across comments.
      id: channel.conversationKey(plan.ref),
      input: plan.input,
    });
  },
});

export { commentOnIssue } from "../lib/github-webhook.ts";
