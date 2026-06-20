import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SlackEventsApiPayload } from "@flue/slack";
import type { WebClient } from "@slack/web-api";
import { planSlackEvent, replyInThread } from "./slack-events.ts";

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
  assert.ok(plan);
  assert.deepEqual(plan.ref, { teamId: "T1", channelId: "C1", threadTs: "111.1" });
  assert.equal(plan.input.type, "slack.app_mention");
  assert.equal(plan.input.eventId, "Ev123");
  assert.equal(plan.input.text, "<@U0BOT> review it");
});

test("app_mention threadTs uses thread_ts when present", () => {
  const plan = planSlackEvent(appMention({ ts: "111.1", threadTs: "100.0" }));
  assert.ok(plan);
  assert.equal(plan.ref.threadTs, "100.0");
});

test("a direct message plans a dispatch", () => {
  const plan = planSlackEvent(imMessage({ text: "run tests for https://github.com/o/r" }));
  assert.ok(plan);
  assert.deepEqual(plan.ref, { teamId: "T1", channelId: "D1", threadTs: "222.2" });
  assert.equal(plan.input.type, "slack.message.im");
  assert.equal(plan.input.text, "run tests for https://github.com/o/r");
});

test("a message from a bot is ignored (loop prevention)", () => {
  assert.equal(planSlackEvent(imMessage({ botId: "B1" })), null);
});

test("a message subtype (edit/system) is ignored", () => {
  assert.equal(planSlackEvent(imMessage({ subtype: "message_changed" })), null);
});

test("a non-IM channel message without a mention is ignored", () => {
  assert.equal(planSlackEvent(imMessage({ channelType: "channel" })), null);
});

test("a non-event_callback payload (app_rate_limited) is ignored", () => {
  const payload = { type: "app_rate_limited", team_id: "T1" } as unknown as SlackEventsApiPayload;
  assert.equal(planSlackEvent(payload), null);
});

test("an unhandled event type is ignored", () => {
  assert.equal(planSlackEvent(eventCallback({ type: "reaction_added" })), null);
});

test("replyInThread posts to the bound thread and returns channel and ts", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeClient = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { ok: true, channel: "D1", ts: "333.3" };
      },
    },
  } as unknown as WebClient;

  const tool = replyInThread({ channelId: "D1", threadTs: "222.2" }, fakeClient);
  const result = JSON.parse(await tool.execute({ text: "Tests passed." }));

  assert.equal(result.channel, "D1");
  assert.equal(result.ts, "333.3");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { channel: "D1", thread_ts: "222.2", text: "Tests passed." });
});
