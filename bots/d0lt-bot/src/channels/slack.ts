// Discovered Slack channel — a thin shim. Flue's file-based discovery serves its
// Events API route at /channels/slack/events (relative to the flue() mount) and
// requires every channels/*.ts to export a `channel`, so this file must live in
// the bot. The construction + events→dispatch wiring lives in `@repo/slack`
// (createSlackBotChannel); here we only make the bot-owned decisions: whether the
// channel is enabled, the resolved signing secret, and the agent to dispatch to.

import { createSlackBotChannel } from "@repo/slack";
import { channelEnabled } from "../lib/channel-flags.ts";

// Opt-in via CHANNEL_SLACK_ENABLE. When disabled the channel still constructs
// (discovery needs the export) but ignores every event, so no real
// SLACK_SIGNING_SECRET is needed to boot. Enabling it requires the real secret.
const enabled = channelEnabled("slack");

// We dispatch to the agent by its discovered name rather than importing it, so
// this module has no import edge to the agent. d0lt-bot.ts still imports `channel`
// from here to parse conversation keys, but that is now one-directional — there is
// no channel ⇄ agent cycle. "d0lt-bot" is the agent module's filename.
export const channel = createSlackBotChannel({
  enabled,
  signingSecret: enabled ? process.env.SLACK_SIGNING_SECRET! : undefined,
  agentName: "d0lt-bot",
});
