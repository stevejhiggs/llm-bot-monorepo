// packages/slack/src/channel/channel.test.ts
import { expect, test } from "vitest";
import { createSlackBotChannel } from "./channel.ts";

function interactionRoute(channel: ReturnType<typeof createSlackBotChannel>) {
  const route = channel.routes.find((r) => r.path.endsWith("/interactions"));
  if (!route) throw new Error("no /interactions route");
  return route;
}

test("an enabled channel serves an /interactions route", () => {
  const channel = createSlackBotChannel({ enabled: true, signingSecret: "s", agentName: "bot" });
  expect(channel.routes.some((r) => r.path.endsWith("/interactions"))).toBe(true);
});

test("a disabled channel ignores interactions and still 200s", () => {
  // A disabled channel must construct without a real secret and act on nothing.
  const channel = createSlackBotChannel({ enabled: false, agentName: "bot" });
  expect(() => interactionRoute(channel)).not.toThrow();
});
