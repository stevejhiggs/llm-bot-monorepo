# @repo/observability

Observability building blocks for the Flue bots in this monorepo. Flue emits no telemetry on its
own — a bot must register an observer at startup. This package provides a **console** observer for
structured logs and a **metrics** observer for bounded production signals. Everything here is
sink-injectable, so it can be unit-tested without a live Flue runtime — the reason this logic lives
in a package rather than in a bot's `app.ts`.

It is **source-only**: no build step. Consumers import the `.ts` directly via the package's
`exports`.

## What it gives a bot

- **`createConsoleObserver(sink = console)`** — builds the `FlueEventSubscriber` a bot passes to
  `observe(...)`. It logs outcome-oriented signals (failed submissions/operations/turns/tools/tasks/
  compactions, operations slower than 30s) plus an info-level activity trail, forwards application
  `ctx.log` lines at their own level, and ignores high-frequency streaming deltas. Every line is
  stamped with correlation fields (instance, dispatch, operationId).
- **`createMetricsObserver(sink)`** — records one bounded metric point per completed
  submission/operation/turn/tool/task/compaction/run and per application log event. Points include
  `count`, duration, token, and cost fields where available, plus safe string dimensions such as
  outcome, operation kind, tool, subagent, model, instance, dispatch, and operation id. It does not
  copy raw errors, tool results, prompts, or shell output.
- **`createAnalyticsEngineMetricsSink(binding = "OBSERVABILITY")`** — adapts metric points to a
  Cloudflare Workers Analytics Engine binding available through Flue's observer context (`ctx.env`).
  If the binding is absent, writes are skipped, so node/local runs keep working.
- **`createCompositeObserver(...observers)`** — forwards each Flue event to multiple observers.

The console observer is deliberately not an OpenTelemetry exporter: on Cloudflare those lines land
in Workers Logs (gated by `observability.enabled` in `wrangler.jsonc`). Production metrics use
Workers Analytics Engine. For long-term retention, alerting, or external dashboards, configure
Cloudflare's OTLP export or Logpush outside this package.

## Public API

```ts
import {
  createAnalyticsEngineMetricsSink,
  createCompositeObserver,
  createConsoleObserver,
  createMetricsObserver,
  type LogSink,
  type MetricSink,
} from "@repo/observability";
```

## How a bot consumes it

A bot's `app.ts` registers the observer at module-eval time — before any request or alarm delivers
work — then mounts `flue()`:

```ts
import { observe } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";
import {
  createAnalyticsEngineMetricsSink,
  createCompositeObserver,
  createConsoleObserver,
  createMetricsObserver,
} from "@repo/observability";

observe(
  createCompositeObserver(
    createConsoleObserver(),
    createMetricsObserver(createAnalyticsEngineMetricsSink("OBSERVABILITY")),
  ),
);

const app = new Hono();
app.route("/", flue());
export default app;
```

## Tests

```bash
pnpm --filter @repo/observability test       # vitest run — pure, offline
pnpm --filter @repo/observability typecheck  # tsc --noEmit
```

See [`AGENTS.md`](AGENTS.md) for the contracts (sink injection, what's logged vs ignored, the
console-not-OTLP choice). Monorepo-wide conventions live in the [root `AGENTS.md`](../../AGENTS.md).
