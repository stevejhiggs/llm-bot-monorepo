// Channels and the direct HTTP route are opt-in. Each is enabled only when its
// `CHANNEL_<NAME>_ENABLE` env var is set to a non-empty value; unset means disabled,
// so the app boots without that channel's secret. Centralized here so the naming
// convention lives in one place.

export type ChannelName = "github" | "slack" | "http";

export function channelEnabled(
  name: ChannelName,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env[`CHANNEL_${name.toUpperCase()}_ENABLE`]);
}
