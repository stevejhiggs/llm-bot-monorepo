// Construction + wiring for a bot's discovered Slack channel, factored out of the
// thin `channels/slack.ts` so the only things that stay in the bot are the
// enablement decision, the resolved signing secret, and the agent's name.
// @flue/slack verifies each request's X-Slack-Signature and timestamp against the
// exact bytes before `events` runs, and answers URL-verification challenges
// internally, so the handler below sees only authentic, non-challenge deliveries.

import { dispatch } from "@flue/runtime";
import { createSlackChannel, type SlackChannel } from "@flue/slack";
import { planSlackEvent } from "../events/plan.ts";
import { planSlackInteraction } from "../interactions/plan.ts";
import { enrichWithThreadContext } from "./thread-context.ts";
import { resolveInteractiveMessage } from "./interactions-ack.ts";

export interface SlackBotChannelOptions {
  // Whether the channel acts on events. When false it still constructs (Flue's
  // file-based discovery requires a valid `channel` export) but ignores every
  // event, so the bot can boot without a real signing secret.
  enabled: boolean;
  // The real Slack signing secret, resolved and passed by the bot — the package
  // never reads secrets from the environment. Required when `enabled`; ignored
  // when disabled (a non-secret placeholder is used so construction can't throw).
  signingSecret?: string;
  // The discovered name of the agent to dispatch to (the agent module's filename,
  // e.g. "d0lt-bot"). Dispatching by name — not by an imported agent reference —
  // is what lets the bot's channel shim avoid importing the agent, so there is no
  // channel ⇄ agent import cycle.
  agentName: string;
}

/**
 * Build the bot's Slack channel. The discovered `channels/slack.ts` is reduced to
 * choosing `enabled`, passing the resolved signing secret, and naming the agent to
 * dispatch to — everything below (secret gating, plan, dispatch) lives here.
 */
export function createSlackBotChannel(options: SlackBotChannelOptions): SlackChannel {
  const { enabled, signingSecret, agentName } = options;

  // createSlackChannel throws on an empty secret, so a disabled channel boots with
  // a non-secret placeholder; enabling it requires the real secret (an enabled
  // channel with a missing secret still throws, as before).
  const channel = createSlackChannel({
    signingSecret: enabled ? (signingSecret ?? "") : "disabled",

    async events({ payload }) {
      if (!enabled) return;
      const plan = planSlackEvent(payload);
      // Unhandled events return nothing → an empty 200, the fast ack Slack wants.
      // Handled work is dispatched durably and processed after we respond.
      if (!plan) return;

      // When the turn is a reply inside an existing thread, attach the prior
      // messages as context so references like "review that PR" resolve. Fail-quiet:
      // a fetch failure dispatches the turn without context rather than dropping it.
      const input = await enrichWithThreadContext(plan);

      await dispatch({
        agent: agentName,
        // One agent instance per Slack thread: all activity in the same thread
        // shares a conversation, so the bot keeps context across messages.
        id: channel.conversationKey(plan.ref),
        input,
      });
    },

    async interactions({ payload }) {
      if (!enabled) return;
      const plan = planSlackInteraction(payload);
      // Unhandled interaction types / malformed payloads → empty 200.
      if (!plan) return;

      // Disable the interacted message so it can't be re-clicked. Best-effort: a
      // failure here must not stop the dispatch.
      const responseUrl = (payload as { response_url?: string }).response_url;
      if (responseUrl) {
        const verb = plan.input.elementType === "button" ? "clicked" : "selected";
        await resolveInteractiveMessage(responseUrl, `✅ You ${verb}: ${plan.input.value}`);
      }

      // One agent instance per Slack thread: the click re-enters the same
      // conversation, which already holds the context of what it proposed.
      await dispatch({
        agent: agentName,
        id: channel.conversationKey(plan.ref),
        input: plan.input,
      });
    },
  });

  return channel;
}
