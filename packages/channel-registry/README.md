# @repo/channel-registry

Shared channel-registry types and resolver logic for Flue bots in this monorepo.
It is source-only: consumers import `.ts` sources directly via `workspace:*`; there
is no package build step.

The package is intentionally small. Channel packages own their channel-specific
prompt fragments, parsers, and tool binding; this package only defines the common
shape and resolves a conversation id against an ordered registry.

## Public API

```ts
import {
  resolveRegisteredConversation,
  type ChannelIntegration,
  type ChannelRegistry,
  type ConversationTools,
  type RegisteredConversation,
} from "@repo/channel-registry";
```

## Tests

```bash
pnpm --filter @repo/channel-registry test
pnpm --filter @repo/channel-registry typecheck
```

See [`AGENTS.md`](AGENTS.md) for the registry-order and chat-fallback contracts.
