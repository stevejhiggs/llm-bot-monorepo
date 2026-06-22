// Discovered GitHub channel. Flue serves its single route at
// /channels/github/webhook (relative to the flue() mount). @flue/github verifies
// each delivery's X-Hub-Signature-256 against the exact request bytes before the
// handler runs, so everything below sees only authentic deliveries.
//
// This module is intentionally thin: the branching logic and the outbound comment
// tool live in `@repo/github` (unit-tested there). Here we only build the
// channel and bridge verified deliveries to the d0lt-bot agent via dispatch().

import { createGitHubChannel } from "@flue/github";
import { dispatch } from "@flue/runtime";
import d0ltBot from "../agents/d0lt-bot.ts";
import { channelEnabled } from "../lib/channel-flags.ts";
import { planDelivery, triggerPhrase } from "@repo/github";

// Opt-in via CHANNEL_GITHUB_ENABLE. Flue discovers every channels/*.ts and requires
// a valid `channel` export, so a disabled channel can't be omitted — instead it
// constructs with a placeholder secret (no real GITHUB_WEBHOOK_SECRET needed to boot)
// and its handler ignores every delivery. Enabling it requires the real secret.
const enabled = channelEnabled("github");

// d0lt-bot.ts imports `channel` (and the comment tool) back from this module. That
// cycle is safe because every cross-module binding is read inside a deferred
// callback — `d0ltBot` only inside `webhook` below, and `channel` only inside the
// agent initializer — never at module-eval time.
export const channel = createGitHubChannel({
  webhookSecret: enabled ? process.env.GITHUB_WEBHOOK_SECRET! : "disabled",

  async webhook({ delivery }) {
    if (!enabled) return;
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

export { commentOnIssue } from "@repo/github";
