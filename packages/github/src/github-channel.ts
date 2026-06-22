// Construction + wiring for a bot's discovered GitHub channel, factored out of the
// thin `channels/github.ts` so the only things that stay in the bot are the
// enablement decision, the resolved secret/phrase, and the agent's name.
// @flue/github verifies each delivery's X-Hub-Signature-256 against the exact
// request bytes before `webhook` runs, so the handler below sees only authentic
// deliveries.

import { createGitHubChannel, type GitHubChannel } from "@flue/github";
import { dispatch } from "@flue/runtime";
import { planDelivery } from "./github-webhook.ts";

export interface GitHubBotChannelOptions {
  // Whether the channel acts on deliveries. When false it still constructs (Flue's
  // file-based discovery requires a valid `channel` export) but ignores every
  // delivery, so the bot can boot without a real webhook secret.
  enabled: boolean;
  // The real GitHub webhook secret, resolved and passed by the bot — the package
  // never reads secrets from the environment. Required when `enabled`; ignored
  // when disabled (a non-secret placeholder is used so construction can't throw).
  webhookSecret?: string;
  // The discovered name of the agent to dispatch to (the agent module's filename,
  // e.g. "d0lt-bot"). Dispatching by name — not by an imported agent reference —
  // is what lets the bot's channel shim avoid importing the agent, so there is no
  // channel ⇄ agent import cycle.
  agentName: string;
  // The comment phrase that activates the bot. Optional; defaults to `@<agentName>`
  // (e.g. `@d0lt-bot`). The bot passes an override when it wants a different phrase.
  triggerPhrase?: string;
}

/**
 * Build the bot's GitHub channel. The discovered `channels/github.ts` is reduced
 * to choosing `enabled`, passing the resolved secret/phrase, and naming the agent
 * to dispatch to — everything below (secret gating, plan, dispatch) lives here.
 */
export function createGitHubBotChannel(options: GitHubBotChannelOptions): GitHubChannel {
  const { enabled, webhookSecret, agentName } = options;
  // Default the activating phrase to a mention of the agent (e.g. `@d0lt-bot`).
  const triggerPhrase = options.triggerPhrase ?? `@${agentName}`;

  // createGitHubChannel throws on an empty secret, so a disabled channel boots
  // with a non-secret placeholder; enabling it requires the real secret (an
  // enabled channel with a missing secret still throws, as before).
  const channel = createGitHubChannel({
    webhookSecret: enabled ? (webhookSecret ?? "") : "disabled",

    async webhook({ delivery }) {
      if (!enabled) return;
      const plan = planDelivery(delivery, triggerPhrase);
      // Unhandled deliveries return nothing → an empty 200, the fast ack GitHub
      // wants. Handled work is dispatched durably and processed after we respond.
      if (!plan) return;

      await dispatch({
        agent: agentName,
        // One agent instance per issue/PR: all activity on the same thread shares
        // a conversation, so the bot keeps context across comments.
        id: channel.conversationKey(plan.ref),
        input: plan.input,
      });
    },
  });

  return channel;
}
