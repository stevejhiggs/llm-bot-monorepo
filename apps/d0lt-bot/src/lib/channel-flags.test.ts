import { expect, test } from "vitest";
import { channelEnabled } from "./channel-flags.ts";

test("a channel is disabled when its env var is unset", () => {
  expect(channelEnabled("github", {})).toBe(false);
});

test("a channel is enabled when its env var is set", () => {
  expect(channelEnabled("github", { CHANNEL_GITHUB_ENABLE: "1" })).toBe(true);
});

test("each channel reads its own CHANNEL_<NAME>_ENABLE var", () => {
  const env = { CHANNEL_SLACK_ENABLE: "1" };
  expect(channelEnabled("slack", env)).toBe(true);
  expect(channelEnabled("github", env)).toBe(false);
  expect(channelEnabled("http", env)).toBe(false);
});

test("an empty value is treated as disabled", () => {
  expect(channelEnabled("http", { CHANNEL_HTTP_ENABLE: "" })).toBe(false);
});
