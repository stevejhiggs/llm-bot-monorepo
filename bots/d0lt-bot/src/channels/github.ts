// Discovered GitHub channel — a thin shim. Flue's file-based discovery serves its
// single route at /channels/github/webhook (relative to the flue() mount) and
// requires every channels/*.ts to export a `channel`, so this file must live in
// the bot. The construction + webhook→dispatch wiring lives in `@repo/github`
// (createGitHubBotChannel); here we only make the bot-owned decisions: whether the
// channel is enabled, the resolved secret/phrase, and the agent to dispatch to.

import { createGitHubBotChannel } from "@repo/github";
import { channelEnabled } from "../lib/channel-flags.ts";
import { BOT_NAME } from "../config.ts";

// Opt-in via CHANNEL_GITHUB_ENABLE. When disabled the channel still constructs
// (discovery needs the export) but ignores every delivery, so no real
// GITHUB_WEBHOOK_SECRET is needed to boot. Enabling it requires the real secret.
const enabled = channelEnabled("github");

// We dispatch to the agent by its discovered name rather than importing it, so
// this module has no import edge to the agent. d0lt-bot.ts still imports `channel`
// from here to parse conversation keys, but that is now one-directional — there is
// no channel ⇄ agent cycle. BOT_NAME is the agent module's filename.
export const channel = createGitHubBotChannel({
  enabled,
  webhookSecret: enabled ? process.env.GITHUB_WEBHOOK_SECRET! : undefined,
  agentName: BOT_NAME,
  // Optional override; unset → the factory defaults to "@d0lt-bot".
  triggerPhrase: process.env.GITHUB_TRIGGER_PHRASE,
});
