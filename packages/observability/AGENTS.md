# AGENTS.md — @repo/observability

Agent-facing companion for `@repo/observability`. See [`README.md`](README.md) for the human
overview. This package holds the observability logic that must be unit-testable in isolation: the
console observer that projects Flue's `observe(...)` event stream into structured logs. It does not
call `observe(...)` itself — the bot's `app.ts` does that at startup and passes in the observer this
package builds.

## What's in here

```
src/
├─ index.ts        # public export surface (see Public API)
├─ observe.ts      # createConsoleObserver(), LogSink — projects FlueEvents to console logs
└─ observe.test.ts
```

## Public API

From `observe.ts`:
- `createConsoleObserver(sink: LogSink = console): FlueEventSubscriber` — builds the observer a bot
  passes to `observe(...)`. The sink defaults to `console` and is injectable for tests.
- type `LogSink` — the `{ info, warn, error }` subset of `console` the observer uses; `console`
  satisfies it structurally.

## Contracts (do not break these)

### 1. The sink is injected; the observer is pure

`createConsoleObserver` takes a `LogSink` (defaulting to `console`) and returns a synchronous
subscriber that only calls `sink.{info,warn,error}` — no other I/O, no network, no global state. The
unit test drives it with a fake sink, matching the injected-client pattern used across the `@repo/*`
packages. Keep it that way: anything that needs real I/O belongs in the bot, not here.

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

## How the bot consumes it

A bot's `app.ts` is the authored application entrypoint (Flue generates a default when it's absent);
it exists to call `observe(createConsoleObserver())` at module-eval time — before any request or
alarm delivers work — and otherwise mounts `flue()` at `/` exactly like the default. `app.ts` stays
in the bot because the `observe()` registration and the `flue()` mount are the bot's entrypoint
concerns; only the observer projection lives here.

## Dependencies

`@flue/runtime` only (catalog `flue`; must resolve to the patched `1.0.0-beta.2`), and only for its
`FlueEvent` / `FlueEventSubscriber` types. No dependency on `@repo/sandbox`, `@repo/github`, or
`@repo/slack`.

## Tests

```bash
pnpm --filter @repo/observability test       # vitest run — pure, offline
pnpm --filter @repo/observability typecheck  # tsc --noEmit
```

`observe.test.ts` drives `createConsoleObserver` with a **fake sink** and hand-built events,
asserting the level routing (error/warn/info), the bounded error detail, and that streaming events
are ignored. No network, no live runtime.
