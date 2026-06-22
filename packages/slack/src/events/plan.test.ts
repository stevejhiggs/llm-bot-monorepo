import type { SlackEventsApiPayload } from "@flue/slack";
import { expect, test } from "vitest";
import { planSlackEvent } from "./plan.ts";

// Minimal Events API payload builders. We populate only the fields planSlackEvent
// reads, then cast to the provider type — real payloads carry much more.
function eventCallback(event: Record<string, unknown>): SlackEventsApiPayload {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev123",
    event_time: 1,
    event,
  } as unknown as SlackEventsApiPayload;
}

function appMention(
  opts: { ts?: string; threadTs?: string; text?: string } = {},
): SlackEventsApiPayload {
  return eventCallback({
    type: "app_mention",
    channel: "C1",
    ts: opts.ts ?? "111.1",
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    text: opts.text ?? "<@U0BOT> review https://github.com/o/r/pull/1",
  });
}

function imMessage(
  opts: {
    channelType?: string;
    subtype?: string;
    botId?: string;
    threadTs?: string;
    text?: string;
  } = {},
): SlackEventsApiPayload {
  return eventCallback({
    type: "message",
    channel: "D1",
    ts: "222.2",
    channel_type: opts.channelType ?? "im",
    ...(opts.subtype ? { subtype: opts.subtype } : {}),
    ...(opts.botId ? { bot_id: opts.botId } : {}),
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    text: opts.text ?? "run the tests for https://github.com/o/r",
  });
}

test("app_mention plans a dispatch with the thread ref and text", () => {
  const plan = planSlackEvent(appMention({ text: "<@U0BOT> review it" }));
  expect(plan).not.toBeNull();
  expect(plan?.ref).toEqual({ teamId: "T1", channelId: "C1", threadTs: "111.1" });
  expect(plan?.input.type).toBe("slack.app_mention");
  expect(plan?.input.eventId).toBe("Ev123");
  expect(plan?.input.text).toBe("<@U0BOT> review it");
});

test("app_mention threadTs uses thread_ts when present", () => {
  const plan = planSlackEvent(appMention({ ts: "111.1", threadTs: "100.0" }));
  expect(plan).not.toBeNull();
  expect(plan?.ref.threadTs).toBe("100.0");
});

test("the plan carries the triggering message ts (messageTs)", () => {
  expect(planSlackEvent(appMention({ ts: "111.1", threadTs: "100.0" }))?.messageTs).toBe("111.1");
  expect(planSlackEvent(imMessage())?.messageTs).toBe("222.2");
});

test("a direct message plans a dispatch", () => {
  const plan = planSlackEvent(imMessage({ text: "run tests for https://github.com/o/r" }));
  expect(plan).not.toBeNull();
  expect(plan?.ref).toEqual({ teamId: "T1", channelId: "D1", threadTs: "222.2" });
  expect(plan?.input.type).toBe("slack.message.im");
  expect(plan?.input.text).toBe("run tests for https://github.com/o/r");
});

test("a message from a bot is ignored (loop prevention)", () => {
  expect(planSlackEvent(imMessage({ botId: "B1" }))).toBeNull();
});

test("a message subtype (edit/system) is ignored", () => {
  expect(planSlackEvent(imMessage({ subtype: "message_changed" }))).toBeNull();
});

test("a non-IM channel message without a mention is ignored", () => {
  expect(planSlackEvent(imMessage({ channelType: "channel" }))).toBeNull();
});

test("a non-event_callback payload (app_rate_limited) is ignored", () => {
  const payload = { type: "app_rate_limited", team_id: "T1" } as unknown as SlackEventsApiPayload;
  expect(planSlackEvent(payload)).toBeNull();
});

test("an unhandled event type is ignored", () => {
  expect(planSlackEvent(eventCallback({ type: "reaction_added" }))).toBeNull();
});
