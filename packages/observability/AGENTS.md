# AGENTS.md — @repo/observability

Agent-facing companion for `@repo/observability`. See [`README.md`](README.md) for the human
overview. This package holds the observability logic that must be unit-testable in isolation: the
console observer that projects Flue's `observe(...)` event stream into structured logs, plus the
metrics observer/sinks that project the same event stream into bounded metric points. It does not
call `observe(...)` itself — the bot's `app.ts` does that at startup and passes in the observers
this package builds.

## What's in here

```
src/
├─ index.ts        # public export surface (see Public API)
├─ observe.ts      # console + metrics observers/sinks for FlueEvents
└─ observe.test.ts
```

## Public API

From `observe.ts`:
- `createConsoleObserver(sink: LogSink = console): FlueEventSubscriber` — builds the observer a bot
  passes to `observe(...)`. The sink defaults to `console` and is injectable for tests.
- `createMetricsObserver(sink: MetricSink): FlueEventSubscriber` — builds an observer that writes
  bounded metric points for completed Flue activity and ignores streaming deltas.
- `createAnalyticsEngineMetricsSink(bindingName = "OBSERVABILITY"): MetricSink` — writes metric
  points to a Cloudflare Workers Analytics Engine binding on `ctx.env` when present, and skips when
  absent.
- `createCompositeObserver(...observers): FlueEventSubscriber` — fans each event out to multiple
  observers.
- type `LogSink` — the `{ info, warn, error }` subset of `console` the observer uses; `console`
  satisfies it structurally.
- type `MetricSink` / `MetricPoint` — the injected metrics sink and bounded metric shape.

## Contracts (do not break these)

### 1. The sink is injected; the observer is pure

`createConsoleObserver` takes a `LogSink` (defaulting to `console`) and returns a synchronous
subscriber that only calls `sink.{info,warn,error}` — no global state. `createMetricsObserver` takes
a `MetricSink` and only calls `sink.write(point, ctx)`. Unit tests drive both with fake sinks,
matching the injected-client pattern used across the `@repo/*` packages. Keep new projections
sink-injected and testable; do not hide I/O behind globals.

### 2. Log outcomes and a trail; drop the firehose

The observer is outcome-oriented. It logs at **error** on failures (`submission_settled` failed;
`operation`/`turn`/`tool`/`task`/`compaction` with `isError`), at **warn** on operations slower than
`SLOW_OPERATION_MS` (30s), and at **info** for the normal operation/tool/task activity trail. It
forwards application `log` events at their own level. It **ignores** high-frequency streaming events
(text/reasoning deltas, turn start) — do not start logging those; they are the firehose this sink
exists to avoid. Successful `turn`/`compaction` events are intentionally dropped (usage is rolled up
on the enclosing operation; a successful compaction is noise) — only their failures surface.

### 3. Bound the error detail

Failed tool/task events carry their reason in `result`, which can be a large payload (verbose
stdout, a diff). `errorMessage` caps serialized detail at `MAX_ERROR_LEN` (500 chars) and
`errorField` omits the field entirely when `result` is absent. Keep both bounds — an unbounded line
can blow up log volume and stringify cost.

### 4. Keep metrics bounded and content-free

Metric points may include counts, durations, token totals, cost totals, and safe low-cardinality
dimensions (outcome, operation kind, tool name, subagent name, model/provider/api, instance,
dispatch, operationId, selected primitive `ctx.log` attributes). Do not put prompts, model output,
tool args/results, shell stdout/stderr, raw errors, secrets, request bodies, or arbitrary objects in
metrics. The Analytics Engine adapter currently maps each point to `indexes: [name]`, blobs
`[name, outcome, primary, level, channel, instance, dispatch, operationId]`, and doubles
`[count, durationMs, tokens, costUsd]`; keep that schema stable unless migrations/dashboard updates
are coordinated.

## How the bot consumes it

A bot's `app.ts` calls `observe(...)` at module-eval time — before any request or alarm delivers
work — and mounts `flue()` at `/`. `d0lt-bot` uses `createCompositeObserver(createConsoleObserver(),
createMetricsObserver(createAnalyticsEngineMetricsSink("OBSERVABILITY")))`. The `observe()`
registration and the `flue()` mount are the bot's entrypoint concerns; only the observer projection
lives here.

## Dependencies

None.

## Tests

```bash
pnpm --filter @repo/observability test       # vitest run — pure, offline
pnpm --filter @repo/observability typecheck  # tsc --noEmit
```

`observe.test.ts` drives `createConsoleObserver` with a **fake sink** and hand-built events,
asserting the level routing (error/warn/info), the bounded error detail, and that streaming events
are ignored. No network, no live runtime.
