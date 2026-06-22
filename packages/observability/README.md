# @repo/observability

Observability building blocks for the Flue bots in this monorepo. Flue emits no telemetry on its
own — a bot must register an observer at startup. This package provides a **console** observer that
turns Flue's `observe(...)` event stream into structured logs: failures, slow operations, and a
one-line-per-step activity trail. Everything here is **pure and sink-injectable**, so it can be
unit-tested without a live Flue runtime — the reason this logic lives in a package rather than in a
bot's `app.ts`.

It is **source-only**: no build step. Consumers import the `.ts` directly via the package's
`exports`.

## What it gives a bot

- **`createConsoleObserver(sink = console)`** — builds the `FlueEventSubscriber` a bot passes to
  `observe(...)`. It logs outcome-oriented signals (failed submissions/operations/turns/tools/tasks/
  compactions, operations slower than 30s) plus an info-level activity trail, forwards application
  `ctx.log` lines at their own level, and ignores high-frequency streaming deltas. Every line is
  stamped with correlation fields (instance, dispatch, operationId).

This is deliberately a console sink, not OpenTelemetry: on Cloudflare the lines land in Workers Logs
(gated by `observability.enabled` in `wrangler.jsonc`), queryable in the dashboard, with no external
backend. For rich OTLP traces, add `@flue/opentelemetry` instead.

## Public API

```ts
import { createConsoleObserver, type LogSink } from "@repo/observability";
```

## How a bot consumes it

A bot's `app.ts` registers the observer at module-eval time — before any request or alarm delivers
work — then mounts `flue()`:

```ts
import { observe } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";
import { createConsoleObserver } from "@repo/observability";

observe(createConsoleObserver());

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
