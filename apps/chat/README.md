# chat

React chat interface to the `d0lt-bot` Flue agent, built with
[TanStack Start](https://tanstack.com/start/latest) and the
[Flue React SDK](https://flueframework.com/docs/guide/react/).

## Setup

```bash
cp .env.example .env   # set FLUE_RUNNER_URL to your Flue runner
pnpm --filter chat dev
```

The browser drives a single conversation with the `d0lt-bot` agent via
`useFlueAgent`. The conversation id is generated per browser and stored in
`localStorage`, so a refresh keeps history.

### Connection: same-origin server proxy

The browser does **not** call the runner directly. The Flue client points at
this app's own origin (`/api/flue`), and this app's server (`src/server.ts`)
forwards `/api/flue/*` to `FLUE_RUNNER_URL`.

This is required because the Flue runtime serves no CORS headers and rejects the
`OPTIONS` preflight on its agent route, so a cross-origin browser call cannot
reach it. A server-to-server forward needs no CORS, and it keeps the runner URL
off the client.

The `d0lt-bot` runner must run with `CHANNEL_HTTP_ENABLE=true` (otherwise the
agent route 404s).

**Security:** the runner's HTTP handler is an unauthenticated pass-through, and
this proxy adds no auth — use locally/POC only. Add auth before any non-local
deployment.

## Scripts

- `pnpm --filter chat dev` — dev server (port 3000)
- `pnpm --filter chat build` — production build
- `pnpm --filter chat test` — unit tests (Vitest)
- `pnpm --filter chat typecheck` — `tsc --noEmit`
