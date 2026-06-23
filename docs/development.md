# Development Guide

This guide collects the file-by-file recipes that are easy to forget when working
in this repo. The root `README.md` is the quickstart; package `README.md` files are
public API references; `AGENTS.md` files document contracts and footguns.

## Common Commands

Run commands from the repo root unless noted.

```bash
pnpm install
pnpm dev
pnpm connect
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm build
pnpm --filter d0lt-bot build:cf
```

Use Node 24 and pnpm 11. A different Node version may still run tests, but pnpm
will warn because `package.json` pins the engine to `24.x`.

## Add A Channel

1. Create or update a package under `packages/<channel>/` for the testable logic:
   pure event planning, outbound tools, channel factory, agent-integration factory,
   and `instructions.md`.
2. Export the package API from `src/index.ts` and expose `./agent-integration` and
   `./instructions.md` in the package `exports` map. Keep the bot-facing
   `./agent-integration` wrapper responsible for attaching the package-owned
   markdown fragment.
3. Add a thin discovered shim in `bots/d0lt-bot/src/channels/<channel>.ts`. It
   should resolve env/config, call the package's channel factory, and export
   `channel`.
4. Add the channel to `CHANNEL_REGISTRY` in
   `bots/d0lt-bot/src/agents/d0lt-bot.ts` by calling the package's
   `create<Channel>AgentIntegration(channel)` factory. Do not assemble that
   channel's prompt/tools in the bot.
5. Document enable flags and secrets in `bots/d0lt-bot/.env.example`,
   `bots/d0lt-bot/README.md`, and the root `AGENTS.md` if the contract matters to
   future agents.
6. Add package tests for the pure planning function, outbound tools, and
   agent-integration core with fake clients/channels. Do not import the agent graph
   in these tests.
7. Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and
   `pnpm --filter d0lt-bot build:cf`.

The channel factory should dispatch by agent name:

```ts
await dispatch({ agent: agentName, id: channel.conversationKey(ref), input });
```

Do not import the agent from the channel package or the channel shim.

## Add An Outbound Tool

1. Put the tool factory next to the integration that owns the destination.
2. Bind destination identifiers at factory time from a verified delivery or event.
   The model should supply only the message/body/action payload.
3. Keep the network client injectable so tests can use a fake client.
4. Add the tool to the relevant `CHANNEL_REGISTRY` entry in
   the owning package's agent-integration factory.
5. Decide whether the tool belongs to the router, subagents, or both.

Slack progress is the existing example of a tool injected into both router and
subagents. Final reply tools usually belong only to the router.

## Add A Subagent

1. Add a directory `bots/d0lt-bot/src/subagents/<name>/` containing an `agent.ts`
   (the profile/factory) and an `instructions.md` alongside it for the profile's
   instructions.
2. Export a factory, not a static profile, when the subagent needs channel-injected
   tools.
3. Add the factory to the `subagents` array in
   `bots/d0lt-bot/src/agents/d0lt-bot.ts`.
4. Keep clone/test/review helpers in shared packages when they are bot-agnostic.
5. Add tests around pure routing or helper logic; avoid importing the full agent
   graph into Vitest.

## Change Sandbox Behavior

1. Read `packages/sandbox/AGENTS.md` first.
2. Keep `packages/sandbox/src/index.ts` target-agnostic. It must not export node or
   Cloudflare adapters.
3. Keep adapter imports behind dynamic imports in the consuming bot.
4. Preserve lazy provisioning: constructing a sandbox factory, or creating its
   session env, should not boot a container or do expensive I/O. The first async
   shell/file operation should pay that cost.
5. Preserve the lightweight discovery facade in `lazySandbox()`: Flue's startup
   probes for `AGENTS.md`, `CLAUDE.md`, `.agents/skills`, and the cwd listing must
   not boot the full sandbox. Non-discovery filesystem checks and shell/file
   operations must still delegate to the real sandbox.
6. Run both bundle gates after changes:

```bash
pnpm build
pnpm --filter d0lt-bot build:cf
```

Typecheck alone is not enough for sandbox changes because static graph mistakes
usually fail only at bundle time.

## Change Chat Stream Rendering

1. Put projection and normalization logic in `apps/chat/src/lib/`.
2. Keep `apps/chat/src/components/Chat.tsx` thin.
3. Handle every `UIMessagePart` variant: `text`, `reasoning`, `dynamic-tool`, and
   `file`.
4. Add or update colocated `*.test.ts` files for stream projection behavior.
5. Verify against a real runner when changing how live tool streams appear.

Tool results may be MCP-shaped and shell output may contain ANSI color codes; normalize
those outside the React component.

## Change Documentation

Use these roles to avoid repeating the same rule in five places:

- Root `README.md`: repository overview, quickstart, command index, active doc index.
- `docs/README.md`: distinguishes maintained docs from historical plans/specs.
- `docs/architecture.md`: request flows and runtime wiring.
- `docs/development.md`: change recipes and verification gates.
- Bot/package `README.md`: user-facing usage and public API.
- `AGENTS.md`: agent-facing contracts that must be followed while editing.

When a rule is both user-facing and agent-critical, keep the full explanation in one
place and link to it from the other.
