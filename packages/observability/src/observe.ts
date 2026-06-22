// Turns Flue's live `observe(...)` event stream into structured console logs.
// A bot registers it once at startup from its `app.ts`. On Cloudflare these
// lines land in Workers Logs (Workers > <bot> > Observability); on node they
// print to the process. This is intentionally a console sink, not an
// OpenTelemetry exporter: it gives a queryable activity trail (what tool ran,
// which subagent, where a turn failed) with zero external backend. See
// `@flue/opentelemetry` if/when rich distributed traces to an OTLP backend are
// wanted.
//
// Pure and unit-tested: the log sink is injected (defaults to `console`), so a
// test drives the observer with a fake sink — matching the injected-client
// pattern used across the `@repo/*` packages.

import type { FlueContext, FlueEvent, FlueEventSubscriber } from "@flue/runtime";

/** The console methods this observer uses; `console` satisfies it structurally. */
export interface LogSink {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface MetricPoint {
  name: string;
  count: number;
  durationMs?: number;
  tokens?: number;
  costUsd?: number;
  dimensions: Record<string, string>;
}

export interface MetricSink {
  write(point: MetricPoint, ctx: FlueContext): void;
}

export interface AnalyticsEngineDatasetLike {
  writeDataPoint(event?: {
    indexes?: ((ArrayBuffer | string) | null)[];
    doubles?: number[];
    blobs?: ((ArrayBuffer | string) | null)[];
  }): void;
}

// Operations slower than this are surfaced at warn so a stuck clone/test run is
// visible without trawling info-level activity.
const SLOW_OPERATION_MS = 30_000;

// Cap serialized error detail: a failed tool/task carries its reason in `result`,
// which can be a large payload (verbose stdout, a diff), so bound both the line
// size and the cost of stringifying it.
const MAX_ERROR_LEN = 500;

/** Render an unknown error value (Error | string | other) to a short string. */
function errorMessage(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (JSON.stringify(error) ?? String(error));
  return text.length > MAX_ERROR_LEN ? `${text.slice(0, MAX_ERROR_LEN)}…` : text;
}

// The error-bearing field for tool/task failures: those events have no `error`
// field, so the reason — when present — lives in `result`. Omitted when absent.
function errorField(result: unknown): Record<string, unknown> {
  return result === undefined ? {} : { error: errorMessage(result) };
}

// Correlation fields stamped on every line so activity can be traced back to a
// channel turn (dispatchId) or agent instance, and grouped by operation.
function ref(event: FlueEvent): Record<string, unknown> {
  return {
    instance: event.instanceId,
    dispatch: event.dispatchId,
    operationId: event.operationId,
  };
}

function dimensionFields(fields: Record<string, unknown>): Record<string, string> {
  const dimensions: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      dimensions[key] = String(value);
    }
  }
  return dimensions;
}

function metricRef(event: FlueEvent): Record<string, string> {
  return dimensionFields({
    instance: event.instanceId,
    dispatch: event.dispatchId,
    operationId: event.operationId,
  });
}

function outcome(isError: boolean): string {
  return isError ? "failure" : "success";
}

function usageFields(
  usage: { totalTokens?: number; cost?: { total?: number } } | undefined,
): Pick<MetricPoint, "tokens" | "costUsd"> {
  return {
    tokens: usage?.totalTokens,
    costUsd: usage?.cost?.total,
  };
}

function isAnalyticsEngineDataset(value: unknown): value is AnalyticsEngineDatasetLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "writeDataPoint" in value &&
    typeof value.writeDataPoint === "function"
  );
}

/**
 * Build the observer. Logs outcome-oriented signals (failures, slow work) plus
 * a one-line-per-step activity trail; ignores high-frequency streaming deltas.
 */
export function createConsoleObserver(sink: LogSink = console): FlueEventSubscriber {
  return (event) => {
    switch (event.type) {
      // A durable submission that recovery settled as failed — the dropped
      // alarm/interrupted-turn case that otherwise leaves no error trail.
      case "submission_settled":
        if (event.outcome === "failed") {
          sink.error("[flue] submission failed", {
            submissionId: event.submissionId,
            error: event.error,
            ...ref(event),
          });
        }
        return;

      // A prompt/skill/task/shell/compact boundary: the useful unit of agent work.
      case "operation":
        if (event.isError) {
          sink.error("[flue] operation failed", {
            kind: event.operationKind,
            ms: event.durationMs,
            error: errorMessage(event.error),
            ...ref(event),
          });
        } else if (event.durationMs >= SLOW_OPERATION_MS) {
          sink.warn("[flue] slow operation", {
            kind: event.operationKind,
            ms: event.durationMs,
            ...ref(event),
          });
        } else {
          sink.info("[flue] operation", {
            kind: event.operationKind,
            ms: event.durationMs,
            tokens: event.usage?.totalTokens,
            cost: event.usage?.cost.total,
            ...ref(event),
          });
        }
        return;

      // Model turn — only surfaced on failure (rate limit, provider error);
      // successful usage is already rolled up on the enclosing operation.
      case "turn":
        if (event.isError) {
          sink.error("[flue] model turn failed", {
            model: event.model,
            ms: event.durationMs,
            error: errorMessage(event.error),
            ...ref(event),
          });
        }
        return;

      // One line per tool call (clone, bash, fetch_repo, slack posts). On failure
      // include the reason from `result` (see errorField) so it isn't a bare line.
      case "tool":
        if (event.isError) {
          sink.error("[flue] tool failed", {
            tool: event.toolName,
            ms: event.durationMs,
            ...errorField(event.result),
            ...ref(event),
          });
        } else {
          sink.info("[flue] tool", { tool: event.toolName, ms: event.durationMs, ...ref(event) });
        }
        return;

      // Router -> subagent (reviewer / test_runner) delegation.
      case "task":
        if (event.isError) {
          sink.error("[flue] task failed", {
            agent: event.agent,
            ms: event.durationMs,
            ...errorField(event.result),
            ...ref(event),
          });
        } else {
          sink.info("[flue] task done", {
            agent: event.agent,
            ms: event.durationMs,
            ...ref(event),
          });
        }
        return;

      // Context compaction — only surfaced on failure. A failed compaction can
      // silently truncate history, so it must not be dropped; success is noise.
      case "compaction":
        if (event.isError) {
          sink.error("[flue] compaction failed", {
            ms: event.durationMs,
            error: errorMessage(event.error),
            ...ref(event),
          });
        }
        return;

      // Application logs emitted via ctx.log — forward at their own level.
      case "log":
        sink[event.level](event.message, { ...event.attributes, ...ref(event) });
        return;

      default:
        return;
    }
  };
}

export function createMetricsObserver(sink: MetricSink): FlueEventSubscriber {
  return (event, ctx) => {
    switch (event.type) {
      case "submission_settled":
        sink.write(
          {
            name: "flue.submission",
            count: 1,
            dimensions: {
              outcome: event.outcome === "failed" ? "failure" : "success",
              submissionId: event.submissionId,
              ...metricRef(event),
            },
          },
          ctx,
        );
        return;

      case "operation":
        sink.write(
          {
            name: "flue.operation",
            count: 1,
            durationMs: event.durationMs,
            ...usageFields(event.usage),
            dimensions: {
              kind: event.operationKind,
              outcome: outcome(event.isError),
              ...metricRef(event),
            },
          },
          ctx,
        );
        return;

      case "turn":
        sink.write(
          {
            name: "flue.turn",
            count: 1,
            durationMs: event.durationMs,
            ...usageFields(event.usage),
            dimensions: {
              outcome: outcome(event.isError),
              ...dimensionFields({
                model: event.model,
                provider: event.provider,
                api: event.api,
                stopReason: event.stopReason,
              }),
              ...metricRef(event),
            },
          },
          ctx,
        );
        return;

      case "tool":
        sink.write(
          {
            name: "flue.tool",
            count: 1,
            durationMs: event.durationMs,
            dimensions: {
              tool: event.toolName,
              outcome: outcome(event.isError),
              ...metricRef(event),
            },
          },
          ctx,
        );
        return;

      case "task":
        sink.write(
          {
            name: "flue.task",
            count: 1,
            durationMs: event.durationMs,
            dimensions: {
              outcome: outcome(event.isError),
              ...dimensionFields({ agent: event.agent }),
              ...metricRef(event),
            },
          },
          ctx,
        );
        return;

      case "compaction":
        sink.write(
          {
            name: "flue.compaction",
            count: 1,
            durationMs: event.durationMs,
            ...usageFields(event.usage),
            dimensions: {
              outcome: outcome(event.isError),
              ...metricRef(event),
            },
          },
          ctx,
        );
        return;

      case "log":
        sink.write(
          {
            name: "flue.log",
            count: 1,
            dimensions: {
              ...dimensionFields(event.attributes ?? {}),
              level: event.level,
              ...metricRef(event),
            },
          },
          ctx,
        );
        return;

      case "run_end":
        sink.write(
          {
            name: "flue.run",
            count: 1,
            durationMs: event.durationMs,
            dimensions: {
              outcome: outcome(event.isError),
              runId: event.runId,
              ...metricRef(event),
            },
          },
          ctx,
        );
        return;

      default:
        return;
    }
  };
}

export function createAnalyticsEngineMetricsSink(bindingName = "OBSERVABILITY"): MetricSink {
  return {
    write(point, ctx) {
      const dataset = (ctx.env as Record<string, unknown>)[bindingName];
      if (!isAnalyticsEngineDataset(dataset)) return;

      const dimensions = point.dimensions;
      const primary =
        dimensions.kind ?? dimensions.tool ?? dimensions.agent ?? dimensions.model ?? "";
      dataset.writeDataPoint({
        indexes: [point.name],
        blobs: [
          point.name,
          dimensions.outcome ?? "",
          primary,
          dimensions.level ?? "",
          dimensions.channel ?? "",
          dimensions.instance ?? "",
          dimensions.dispatch ?? "",
          dimensions.operationId ?? "",
        ],
        doubles: [point.count, point.durationMs ?? 0, point.tokens ?? 0, point.costUsd ?? 0],
      });
    },
  };
}

export function createCompositeObserver(...observers: FlueEventSubscriber[]): FlueEventSubscriber {
  return (event, ctx) => {
    const pending: Promise<void>[] = [];
    for (const observer of observers) {
      const result = observer(event, ctx);
      if (result instanceof Promise) {
        pending.push(result);
      }
    }
    if (pending.length > 0) {
      return Promise.all(pending).then(() => undefined);
    }
  };
}
