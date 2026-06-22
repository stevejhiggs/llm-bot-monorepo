import type { WebClient } from "@slack/web-api";
import { expect, test } from "vitest";
import type { SlackDispatchPlan } from "../events/plan.ts";
import { enrichWithThreadContext, fetchThreadContext } from "./thread-context.ts";

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
