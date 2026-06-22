import type { SlackEventsApiPayload } from "@flue/slack";
import type { WebClient } from "@slack/web-api";
import { expect, test } from "vitest";
import {
  enrichWithThreadContext,
  fetchThreadContext,
  planSlackEvent,
  postProgressInThread,
  replyInThread,
  type SlackDispatchPlan,
  workerdSafeFetch,
} from "./slack-events.ts";

// A fake WebClient whose conversations.replies returns a queue of responses (one
// per call, for pagination), recording the args it was called with.
function fakeRepliesClient(
  pages: Array<{ messages: Array<Record<string, unknown>>; nextCursor?: string }>,
) {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const client = {
    conversations: {
      replies: async (args: Record<string, unknown>) => {
        calls.push(args);
        const page = pages[i++] ?? { messages: [] };
        return {
          ok: true,
          messages: page.messages,
          ...(page.nextCursor ? { response_metadata: { next_cursor: page.nextCursor } } : {}),
        };
      },
    },
  } as unknown as WebClient;
  return { client, calls };
}

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

  expect(result.channel).toBe("D1");
  expect(result.ts).toBe("333.3");
  expect(calls.length).toBe(1);
  expect(calls[0]).toEqual({ channel: "D1", thread_ts: "222.2", text: "Tests passed." });
});

test("replyInThread converts the model's markdown to Slack mrkdwn", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeClient = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { ok: true, channel: "D1", ts: "1" };
      },
    },
  } as unknown as WebClient;

  const tool = replyInThread({ channelId: "D1", threadTs: "222.2" }, fakeClient);
  await tool.execute({ text: "**PASS** — see [repo](https://x/y)" });

  expect(calls[0]?.text).toBe("*PASS* — see <https://x/y|repo>");
});

test("post_slack_progress posts a converted note to the bound thread", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeClient = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { ok: true, channel: "D1", ts: "444.4" };
      },
    },
  } as unknown as WebClient;

  const tool = postProgressInThread({ channelId: "D1", threadTs: "222.2" }, fakeClient);
  const result = JSON.parse(await tool.execute({ text: "**Running** tests…" }));

  expect(result).toEqual({ ok: true, ts: "444.4" });
  expect(calls[0]).toEqual({ channel: "D1", thread_ts: "222.2", text: "*Running* tests…" });
});

test("post_slack_progress swallows a Slack error so the run is not aborted", async () => {
  const fakeClient = {
    chat: {
      postMessage: async () => {
        throw new Error("slack down");
      },
    },
  } as unknown as WebClient;

  const tool = postProgressInThread({ channelId: "D1", threadTs: "222.2" }, fakeClient);
  const result = JSON.parse(await tool.execute({ text: "Cloning…" }));

  expect(result).toEqual({ ok: false });
});

test("fetchThreadContext formats oldest-first, excludes the trigger, labels bot vs user", async () => {
  const { client, calls } = fakeRepliesClient([
    {
      messages: [
        { ts: "1", user: "U1", text: "look at https://github.com/o/r/pull/9" },
        { ts: "2", bot_id: "B1", text: "earlier bot reply" },
        { ts: "3", user: "U2", text: "<@U0BOT> review that PR" },
      ],
    },
  ]);

  const ctx = await fetchThreadContext({ channelId: "C1", threadTs: "1", excludeTs: "3" }, client);

  expect(ctx).toBe("[U1]: look at https://github.com/o/r/pull/9\n[bot]: earlier bot reply");
  expect(calls[0]).toMatchObject({ channel: "C1", ts: "1" });
});

test("fetchThreadContext keeps only the most recent `max` messages", async () => {
  const { client } = fakeRepliesClient([
    {
      messages: [
        { ts: "1", user: "U1", text: "one" },
        { ts: "2", user: "U1", text: "two" },
        { ts: "3", user: "U1", text: "three" },
        { ts: "4", user: "U1", text: "four" },
        { ts: "5", user: "U2", text: "trigger" },
      ],
    },
  ]);

  const ctx = await fetchThreadContext(
    { channelId: "C1", threadTs: "1", excludeTs: "5" },
    client,
    2,
  );

  expect(ctx).toBe("[U1]: three\n[U1]: four");
});

test("fetchThreadContext follows pagination cursors", async () => {
  const { client, calls } = fakeRepliesClient([
    { messages: [{ ts: "1", user: "U1", text: "first" }], nextCursor: "cur1" },
    { messages: [{ ts: "2", user: "U1", text: "second" }] },
  ]);

  const ctx = await fetchThreadContext({ channelId: "C1", threadTs: "1", excludeTs: "9" }, client);

  expect(ctx).toBe("[U1]: first\n[U1]: second");
  expect(calls.length).toBe(2);
  expect(calls[1]?.cursor).toBe("cur1");
});

test("fetchThreadContext returns null when only the trigger remains", async () => {
  const { client } = fakeRepliesClient([
    { messages: [{ ts: "3", user: "U2", text: "<@U0BOT> review that PR" }] },
  ]);

  expect(
    await fetchThreadContext({ channelId: "C1", threadTs: "3", excludeTs: "3" }, client),
  ).toBeNull();
});

function threadedPlan(overrides: Partial<SlackDispatchPlan> = {}): SlackDispatchPlan {
  return {
    ref: { teamId: "T1", channelId: "C1", threadTs: "100.0" },
    input: { type: "slack.app_mention", eventId: "Ev1", text: "<@U0BOT> review that PR" },
    messageTs: "111.1",
    ...overrides,
  };
}

test("enrichWithThreadContext skips the fetch when the turn is not in a thread", async () => {
  const fakeClient = {
    conversations: {
      replies: async () => {
        throw new Error("should not be called");
      },
    },
  } as unknown as WebClient;

  const plan = threadedPlan({
    ref: { teamId: "T1", channelId: "C1", threadTs: "111.1" },
    messageTs: "111.1",
  });
  const input = await enrichWithThreadContext(plan, fakeClient);

  expect(input).toEqual(plan.input);
  expect(input.threadContext).toBeUndefined();
});

test("enrichWithThreadContext attaches the fetched context for a threaded turn", async () => {
  const { client, calls } = fakeRepliesClient([
    { messages: [{ ts: "100.0", user: "U1", text: "https://github.com/o/r/pull/9" }] },
  ]);

  const input = await enrichWithThreadContext(threadedPlan(), client);

  expect(input.threadContext).toBe("[U1]: https://github.com/o/r/pull/9");
  expect(input.text).toBe("<@U0BOT> review that PR");
  expect(calls[0]).toMatchObject({ channel: "C1", ts: "100.0" });
});

test("enrichWithThreadContext fails quiet: a fetch error dispatches without context", async () => {
  const fakeClient = {
    conversations: {
      replies: async () => {
        throw new Error("slack down");
      },
    },
  } as unknown as WebClient;

  const input = await enrichWithThreadContext(threadedPlan(), fakeClient);

  expect(input).toEqual(threadedPlan().input);
  expect(input.threadContext).toBeUndefined();
});

test("workerdSafeFetch rewrites redirect:'error' to 'manual' (workerd rejects 'error')", async () => {
  let seen: RequestInit | undefined;
  const base: typeof fetch = async (_input, init) => {
    seen = init;
    return new Response("{}");
  };

  await workerdSafeFetch(base)("https://slack.test/api/chat.postMessage", {
    method: "POST",
    redirect: "error",
  });

  expect(seen?.redirect).toBe("manual");
});

test("workerdSafeFetch leaves a non-'error' redirect untouched", async () => {
  let seen: RequestInit | undefined;
  const base: typeof fetch = async (_input, init) => {
    seen = init;
    return new Response("{}");
  };

  await workerdSafeFetch(base)("https://slack.test/api/chat.postMessage", { redirect: "follow" });

  expect(seen?.redirect).toBe("follow");
});
