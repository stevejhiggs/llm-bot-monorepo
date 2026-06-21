# React chat interface to the Flue runner (`apps/chat`)

**Date:** 2026-06-21
**Status:** Implemented. Revised after the live test — the browser→runner
connection changed from "direct" to a same-origin server proxy (the Flue
runtime can't serve CORS); see "Connection" and "Implementation findings".

## Goal

Add a new, separate web app — a React-based chat interface that talks to the
`d0lt-bot` Flue agent. Built with [TanStack Start](https://tanstack.com/start/latest)
and the [Flue React SDK](https://flueframework.com/docs/guide/react/). The Flue
runner endpoint is configurable via an environment variable.

## Scope

- **Single conversation** with the `d0lt-bot` agent. A conversation id is
  generated per browser and persisted in `localStorage`, so a refresh resumes
  the same agent instance. (Caveat: only assistant history replays on reload —
  see "Implementation findings".)
- **Clean & minimal** UI (Tailwind): role-labelled message bubbles, a sticky
  input bar, a "thinking…" indicator while awaiting a reply, and a friendly
  error state.

Out of scope (YAGNI): multi-conversation sidebar, conversation list
management, authentication, theming/animation beyond basics.

## Architecture

### Placement

- New workspace app at **`apps/chat`**, automatically picked up by the existing
  `apps/*` glob in `pnpm-workspace.yaml` and Turborepo, so root scripts
  (`pnpm dev`, `pnpm build`, `pnpm typecheck`) fan out to it.
- Stack: TanStack Start (Vite + React 19), TypeScript ESM, Tailwind CSS. Tests
  with Vitest (matching the repo).

### Connection: same-origin server proxy

> The original design called for the browser to talk **directly** to the runner
> via a public `VITE_FLUE_RUNNER_URL`. The live test proved that can't work: the
> Flue runtime serves no CORS headers and rejects the `OPTIONS` preflight on its
> agent route *before* any user middleware runs, and there is no CORS/middleware
> hook in `flue.config.ts`. A cross-origin browser call is therefore impossible
> with this runtime. We pivoted to a proxy.

The browser does **not** call the runner directly. The Flue client points at
this app's own origin (`/api/flue`), and this app's server entry
(`src/server.ts`) forwards `/api/flue/*` to the runner. The runner URL is a
**server-side** env var (`FLUE_RUNNER_URL`, not Vite-exposed), so it never
reaches the client and no CORS is needed (the forward is server-to-server).

```ts
// client (same-origin, SSR-safe absolute URL)
createFlueClient({ baseUrl: `${origin}/api/flue`, fetch: globalThis.fetch.bind(globalThis) })
```

```
FLUE_RUNNER_URL=http://localhost:3583   (server-side only)

Browser ──▶ /api/flue/*  ──▶  this app's server  ──▶  runner
```

The chat is effectively a client-side component. During SSR the Flue hooks
return idle state; the client connects on hydration. The base URL is absolute
(origin + `/api/flue`) because the SDK rejects a relative `baseUrl` without a
browser origin (i.e. during SSR); the SSR value is never fetched.

### Prerequisites in the existing `d0lt-bot` app (NOT built here)

The runner must run with `CHANNEL_HTTP_ENABLE=true` (otherwise the agent exports
no `route` and `POST /agents/d0lt-bot/:id` 404s — see `AGENTS.md`). No CORS
config is needed on the runner, because the browser never reaches it directly.

**Security caveat (document, do not silently rely on):** the runner's HTTP
handler is an unauthenticated pass-through, and the proxy adds no auth. This is
acceptable for local/POC use only; production needs auth (in the proxy and/or in
front of the agent route). This spec does not add that auth.

## Components & data flow

Actual paths (the scaffold uses `src/`, not `app/`):

- `src/server.ts` — custom TanStack Start server entry (`createServerEntry`).
  Forwards `/api/flue/*` to `FLUE_RUNNER_URL` (buffers the body, strips `Host`,
  streams the response back); everything else falls through to the default
  handler. Thin wiring — not unit-tested.
- `src/lib/proxy.ts` — pure helpers: `isProxyPath()` and `resolveProxyTarget()`
  (path rewrite + missing-`FLUE_RUNNER_URL` guard). Tested.
- `src/lib/flue-client.ts` — `flueBaseUrl(origin)` builds the same-origin base
  (`origin + /api/flue`, placeholder origin during SSR); `createChatClient()`
  calls `createFlueClient` with that base **and a bound `fetch`** (see
  findings). Tested.
- `src/lib/conversation.ts` — pure get-or-create of a conversation id in
  `localStorage` (injectable storage for testing). Tested.
- `src/routes/__root.tsx` — mounts `FlueProvider` with the client (built once at
  module scope; needs no env var and never throws).
- `src/components/Chat.tsx` (rendered by `src/routes/index.tsx`):
  - `useFlueAgent({ name: 'd0lt-bot', id })` (agent name is a constant).
  - Resolves the conversation id in a client effect (SSR has no `localStorage`;
    the hook accepts a deferred `id`).
  - Maintains its **own transcript**: appends the user bubble on submit and
    merges the agent's assistant messages as they stream (see findings).
  - Sticky input `<form>`; clears input and calls `agent.sendMessage(input)` on
    submit. Sending is gated only by an in-flight turn (`submitted`/`streaming`),
    not by the background `connecting` state.
  - "thinking…" indicator during a turn; inline error from `agent.error`.

Agent name `d0lt-bot` is a hardcoded constant. Only the endpoint is env-driven,
per the requirement.

## Configuration

- `apps/chat/.env.example` documenting:
  - `FLUE_RUNNER_URL` — Flue runner base URL, **server-side only** (default
    `http://localhost:3583`).

## Error handling

- Missing `FLUE_RUNNER_URL` → the proxy returns a 500 with a clear message; the
  failure surfaces in the UI via `agent.error`, not a blank crash.
- Network/connection failure to the runner → surfaced via `agent.error`.

## Testing

Per repo convention (Vitest, pure and offline — no network, no live runtime):

- `conversation.ts`: new id when storage is empty; existing id on later calls.
- `proxy.ts`: `resolveProxyTarget` rewrites prefix→runner base preserving
  path/query, strips a trailing slash, throws on missing env, rejects non-proxy
  paths; `isProxyPath` matches only the prefix.
- `flue-client.ts`: `flueBaseUrl` appends the proxy path and falls back to a
  placeholder origin (SSR); `createChatClient` returns a usable client.

The UI component and `server.ts` stay thin; no agent-graph or live-runtime tests
(consistent with how channel logic is tested via pure functions).

## Implementation findings (from the live test)

Three non-obvious constraints in the Flue stack (`@flue/runtime@1.0.0-beta.2`,
`@flue/react`/`@flue/sdk@1.0.0-beta.1`) shaped the final design:

1. **No CORS / no `OPTIONS` on the runner.** The agent route validates the
   method and rejects anything but GET/HEAD/POST before user middleware, and
   there's no CORS hook. → drove the server-proxy connection above.
2. **The SDK calls its stored `fetch` as a method**, which native `fetch`
   rejects in the browser ("Illegal invocation"), breaking every request in a
   reconnect loop. → pass a bound `fetch` to `createFlueClient`.
3. **The runtime never echoes the user's message over the stream** (it appears
   only quoted inside the assistant turn), yet the `@flue/react` reducer deletes
   its optimistic user bubble when the assistant message arrives. → the client
   keeps its own transcript instead of rendering `agent.messages` directly.
   Consequence: on reload, only assistant history replays (the runtime never
   emitted the user messages, and the transcript is in-memory).

Both runtime betas behave the same on (1) and (3), so these are not version
mismatches.

## Open follow-ups (not in this spec)

- Auth in the proxy / in front of the agent's HTTP route before any non-local
  deployment.
- Deciding a deploy target for the chat app (Node/static/Cloudflare Pages).
- Revisit the user-message and reload handling if a newer Flue release echoes
  user messages over the stream (would let us render `agent.messages` directly).
