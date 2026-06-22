// Bot-wide configuration constants.

// The bot's name. This MUST match the agent module's filename
// (`src/agents/d0lt-bot.ts`), because Flue discovers agents by filename and the
// channels dispatch to the agent by that discovered name (`dispatch({ agent:
// BOT_NAME, ... })`) rather than importing it. It also names the node sandbox's
// per-app working directory. If you rename the agent module, update this too.
export const BOT_NAME = "d0lt-bot";
