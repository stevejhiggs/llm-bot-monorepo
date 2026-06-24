# AGENTS.md — @repo/channel-registry

Agent-facing companion for `@repo/channel-registry`. See [`README.md`](README.md)
for the human overview.

This package contains the generic registry contract shared by bots and channel
packages. It knows nothing about GitHub, Slack, any concrete channel package, or
any bot.

## What's in here

```
src/
├─ index.ts                  # public API: registry types + resolver
└─ channel-registry.test.ts  # pure resolver tests
```

## Public API

- `resolveRegisteredConversation(id, registry)` — tries registry entries in
  insertion order. The first `parseConversationKey(id)` that returns identifies
  the source and supplies the ref passed into that entry's `tools(ref)` factory.
  If every parser throws, the turn is chat: no channel prompt fragment and no
  channel tools.
- `ChannelIntegration<Ref>` — one channel's prompt fragment, parser, and
  router/subagent tool factory.
- `ChannelRegistry` — ordered map of source name to `ChannelIntegration`.
- `ConversationTools` — `{ router, subagent }` tool lists.
- `RegisteredConversation` — resolved `{ source, instructions, tools }`.

## Contracts

### 1. Registry order is meaningful

The resolver uses `Object.entries(registry)` order. If two parsers can accept a
key, the first entry wins. Keep tests covering this because the bot relies on a
stable source decision.

### 2. Parsers signal non-ownership by throwing

Channel `parseConversationKey(id)` methods throw when an id is not theirs. The
resolver catches those errors and tries the next channel. Do not treat parser
errors as fatal unless the matched channel has already been selected; there is no
separate preflight parser.

### 3. Chat is the fallback, not a registered channel

An unparseable id resolves to `{ source: "chat", instructions: "", tools:
{ router: [], subagent: [] } }`. Keep chat out of the registry so channel packages
remain the only registry entries.

### 4. Keep this package generic

Do not import `@repo/github`, `@repo/slack`, bot modules, markdown fragments, or
channel implementations here. Channel packages can depend on this package for the
shared type shape; this package must not depend on them.

## Dependencies

None.

## Tests

```bash
pnpm --filter @repo/channel-registry test
pnpm --filter @repo/channel-registry typecheck
```
