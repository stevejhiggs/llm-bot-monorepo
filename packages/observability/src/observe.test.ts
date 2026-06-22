import { describe, expect, test, vi } from "vitest";
import type { FlueContext, FlueEvent } from "@flue/runtime";
import {
  createAnalyticsEngineMetricsSink,
  createCompositeObserver,
  createConsoleObserver,
  createMetricsObserver,
  type LogSink,
  type MetricSink,
} from "./observe.ts";

// A fake sink capturing calls, in place of `console`.
function fakeSink() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// Build a decorated event from a variant, adding the envelope fields every
// FlueEvent carries. Cast keeps the test concise over the large event union.
function ev(variant: Record<string, unknown>): FlueEvent {
  return {
    v: 1,
    eventIndex: 0,
    timestamp: "",
    instanceId: "inst",
    ...variant,
  } as unknown as FlueEvent;
}

// Drive the observer with one or more events. The subscriber type returns
// `void | Promise<void>`; ours is synchronous, so discard the result.
function run(sink: ReturnType<typeof fakeSink>, ...events: FlueEvent[]) {
  const observer = createConsoleObserver(sink as LogSink);
  for (const event of events) void observer(event, {} as never);
}

function ctx(env: Record<string, unknown> = {}): FlueContext {
  return { env } as FlueContext;
}

describe("createConsoleObserver", () => {
  test("logs a failed durable submission at error", () => {
    const sink = fakeSink();
    run(
      sink,
      ev({ type: "submission_settled", submissionId: "s1", outcome: "failed", error: "boom" }),
    );
    expect(sink.error).toHaveBeenCalledWith(
      "[flue] submission failed",
      expect.objectContaining({ submissionId: "s1", error: "boom" }),
    );
  });

  test("ignores a completed submission", () => {
    const sink = fakeSink();
    run(sink, ev({ type: "submission_settled", submissionId: "s1", outcome: "completed" }));
    expect(sink.error).not.toHaveBeenCalled();
    expect(sink.info).not.toHaveBeenCalled();
  });

  test("a normal operation logs at info with token/cost usage", () => {
    const sink = fakeSink();
    run(
      sink,
      ev({
        type: "operation",
        operationKind: "prompt",
        durationMs: 1200,
        isError: false,
        usage: { totalTokens: 4321, cost: { total: 0.012 } },
      }),
    );
    expect(sink.info).toHaveBeenCalledWith(
      "[flue] operation",
      expect.objectContaining({ kind: "prompt", ms: 1200, tokens: 4321, cost: 0.012 }),
    );
  });

  test("a failed operation logs at error with the error message", () => {
    const sink = fakeSink();
    run(
      sink,
      ev({
        type: "operation",
        operationKind: "task",
        durationMs: 50,
        isError: true,
        error: new Error("nope"),
      }),
    );
    expect(sink.error).toHaveBeenCalledWith(
      "[flue] operation failed",
      expect.objectContaining({ kind: "task", error: "nope" }),
    );
  });

  test("a slow operation logs at warn", () => {
    const sink = fakeSink();
    run(
      sink,
      ev({ type: "operation", operationKind: "shell", durationMs: 45_000, isError: false }),
    );
    expect(sink.warn).toHaveBeenCalledWith(
      "[flue] slow operation",
      expect.objectContaining({ ms: 45_000 }),
    );
    expect(sink.info).not.toHaveBeenCalled();
  });

  test("a failed tool logs at error, a successful tool at info", () => {
    const sink = fakeSink();
    run(
      sink,
      ev({ type: "tool", toolName: "bash", toolCallId: "t1", isError: true, durationMs: 10 }),
      ev({ type: "tool", toolName: "fetch_repo", toolCallId: "t2", isError: false, durationMs: 5 }),
    );
    expect(sink.error).toHaveBeenCalledWith(
      "[flue] tool failed",
      expect.objectContaining({ tool: "bash" }),
    );
    expect(sink.info).toHaveBeenCalledWith(
      "[flue] tool",
      expect.objectContaining({ tool: "fetch_repo" }),
    );
  });

  test("a failed tool includes the error detail from its result", () => {
    const sink = fakeSink();
    run(
      sink,
      ev({
        type: "tool",
        toolName: "reply_in_slack_thread",
        toolCallId: "t1",
        isError: true,
        durationMs: 10,
        result: "Invalid redirect value, must be one of follow or manual",
      }),
    );
    expect(sink.error).toHaveBeenCalledWith(
      "[flue] tool failed",
      expect.objectContaining({
        tool: "reply_in_slack_thread",
        error: "Invalid redirect value, must be one of follow or manual",
      }),
    );
  });

  test("a failed task includes the error detail from its result", () => {
    const sink = fakeSink();
    run(
      sink,
      ev({
        type: "task",
        agent: "reviewer",
        taskId: "k1",
        isError: true,
        durationMs: 20,
        result: "subagent failed to clone",
      }),
    );
    expect(sink.error).toHaveBeenCalledWith(
      "[flue] task failed",
      expect.objectContaining({ agent: "reviewer", error: "subagent failed to clone" }),
    );
  });

  test("a failed compaction logs at error (was previously dropped)", () => {
    const sink = fakeSink();
    run(
      sink,
      ev({
        type: "compaction",
        messagesBefore: 10,
        messagesAfter: 3,
        durationMs: 30,
        isError: true,
        error: new Error("compaction boom"),
      }),
    );
    expect(sink.error).toHaveBeenCalledWith(
      "[flue] compaction failed",
      expect.objectContaining({ error: "compaction boom" }),
    );
  });

  test("forwards application logs at their own level", () => {
    const sink = fakeSink();
    run(sink, ev({ type: "log", level: "warn", message: "heads up", attributes: { repo: "x/y" } }));
    expect(sink.warn).toHaveBeenCalledWith("heads up", expect.objectContaining({ repo: "x/y" }));
  });

  test("ignores high-frequency streaming events", () => {
    const sink = fakeSink();
    run(sink, ev({ type: "text_delta", text: "hi" }), ev({ type: "turn_start", turnId: "u1" }));
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).not.toHaveBeenCalled();
    expect(sink.error).not.toHaveBeenCalled();
  });
});

describe("createMetricsObserver", () => {
  test("records operation outcomes with duration, usage, and correlation dimensions", () => {
    const sink = { write: vi.fn() };
    const observer = createMetricsObserver(sink as MetricSink);
    const event = ev({
      type: "operation",
      operationKind: "prompt",
      operationId: "op1",
      dispatchId: "dispatch1",
      durationMs: 1200,
      isError: false,
      usage: { totalTokens: 4321, cost: { total: 0.012 } },
    });

    void observer(event, ctx());

    expect(sink.write).toHaveBeenCalledWith(
      {
        name: "flue.operation",
        count: 1,
        durationMs: 1200,
        tokens: 4321,
        costUsd: 0.012,
        dimensions: {
          dispatch: "dispatch1",
          instance: "inst",
          kind: "prompt",
          operationId: "op1",
          outcome: "success",
        },
      },
      expect.anything(),
    );
  });

  test("records failed tools and tasks without copying error payloads into metrics", () => {
    const sink = { write: vi.fn() };
    const observer = createMetricsObserver(sink as MetricSink);

    void observer(
      ev({
        type: "tool",
        toolName: "bash",
        toolCallId: "tool1",
        dispatchId: "dispatch1",
        isError: true,
        durationMs: 10,
        result: "very large stdout that should stay out of metrics",
      }),
      ctx(),
    );
    void observer(
      ev({
        type: "task",
        taskId: "task1",
        agent: "reviewer",
        dispatchId: "dispatch1",
        isError: true,
        durationMs: 20,
        result: "subagent details that should stay out of metrics",
      }),
      ctx(),
    );

    expect(sink.write).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        name: "flue.tool",
        durationMs: 10,
        dimensions: expect.objectContaining({ outcome: "failure", tool: "bash" }),
      }),
      expect.anything(),
    );
    expect(sink.write).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        name: "flue.task",
        durationMs: 20,
        dimensions: expect.objectContaining({ agent: "reviewer", outcome: "failure" }),
      }),
      expect.anything(),
    );
    expect(JSON.stringify(sink.write.mock.calls)).not.toContain("very large stdout");
    expect(JSON.stringify(sink.write.mock.calls)).not.toContain("subagent details");
  });

  test("records application logs with safe primitive attributes as dimensions", () => {
    const sink = { write: vi.fn() };
    const observer = createMetricsObserver(sink as MetricSink);

    void observer(
      ev({
        type: "log",
        level: "warn",
        message: "channel delivery failed",
        dispatchId: "dispatch1",
        attributes: { channel: "slack", repo: "owner/repo", retryable: true, payload: { raw: 1 } },
      }),
      ctx(),
    );

    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "flue.log",
        dimensions: expect.objectContaining({
          channel: "slack",
          dispatch: "dispatch1",
          level: "warn",
          repo: "owner/repo",
          retryable: "true",
        }),
      }),
      expect.anything(),
    );
    expect(JSON.stringify(sink.write.mock.calls)).not.toContain("payload");
  });

  test("does not let application log attributes override reserved dimensions", () => {
    const sink = { write: vi.fn() };
    const observer = createMetricsObserver(sink as MetricSink);

    void observer(
      ev({
        type: "log",
        level: "error",
        message: "delivery failed",
        dispatchId: "actual-dispatch",
        attributes: { level: "info", dispatch: "fake-dispatch" },
      }),
      ctx(),
    );

    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: expect.objectContaining({
          dispatch: "actual-dispatch",
          level: "error",
        }),
      }),
      expect.anything(),
    );
  });

  test("ignores high-frequency streaming events", () => {
    const sink = { write: vi.fn() };
    const observer = createMetricsObserver(sink as MetricSink);

    void observer(ev({ type: "text_delta", text: "hi" }), ctx());
    void observer(ev({ type: "turn_start", turnId: "turn1" }), ctx());

    expect(sink.write).not.toHaveBeenCalled();
  });
});

describe("createAnalyticsEngineMetricsSink", () => {
  test("writes metrics to the configured Analytics Engine binding", () => {
    const dataset = { writeDataPoint: vi.fn() };
    const sink = createAnalyticsEngineMetricsSink("OBSERVABILITY");

    sink.write(
      {
        name: "flue.operation",
        count: 1,
        durationMs: 1200,
        tokens: 4321,
        costUsd: 0.012,
        dimensions: {
          dispatch: "dispatch1",
          instance: "inst",
          kind: "prompt",
          operationId: "op1",
          outcome: "success",
        },
      },
      ctx({ OBSERVABILITY: dataset }),
    );

    expect(dataset.writeDataPoint).toHaveBeenCalledWith({
      indexes: ["flue.operation"],
      blobs: ["flue.operation", "success", "prompt", "", "", "inst", "dispatch1", "op1"],
      doubles: [1, 1200, 4321, 0.012],
    });
  });

  test("skips writes when the binding is absent", () => {
    const sink = createAnalyticsEngineMetricsSink("OBSERVABILITY");

    expect(() =>
      sink.write({ name: "flue.operation", count: 1, dimensions: { outcome: "success" } }, ctx()),
    ).not.toThrow();
  });
});

describe("createCompositeObserver", () => {
  test("forwards each event to all observers", () => {
    const first = vi.fn();
    const second = vi.fn();
    const observer = createCompositeObserver(first, second);
    const event = ev({ type: "idle" });
    const context = ctx();

    void observer(event, context);

    expect(first).toHaveBeenCalledWith(event, context);
    expect(second).toHaveBeenCalledWith(event, context);
  });
});
