# @repo/github

GitHub building blocks for the Flue bots in this monorepo: URL parsing, injection-safe clone-script
assembly, webhook decision logic, and the outbound comment tool. Everything here is **pure or
client-injectable**, so it can be unit-tested without a live Flue runtime or network — the reason
this logic lives in a package rather than in a bot's discovered `channels/*.ts` (which can't be
loaded in a test).

It is **source-only**: no build step. Consumers import the `.ts` directly via the package's
`exports`.

## What it gives a bot

- **`fetchRepoTool`** — a Flue tool the subagents call to turn a GitHub repo/PR URL into the exact,
  injection-safe shell command that clones it (and, for a PR, writes the diff). The tool never
  clones; it validates and returns the command for the agent's bash tool to run in the sandbox.
- **Webhook planning** — `planDelivery()` decides what (if anything) a verified webhook delivery
  should dispatch to the agent (PR review, repo test run, auto-review on open), returning
  `{ ref, input } | null`. Pure: no network, no dispatch.
- **`commentOnIssue`** — the agent's one outbound capability, bound at construction to the
  issue/PR from the verified delivery so the model can supply only the comment body, never the
  destination.
- **`createGitHubBotChannel`** — constructs the Flue channel, so the bot's discovered
  `channels/github.ts` is a thin shim that just passes `{ enabled, webhookSecret?, agentName,
  triggerPhrase? }`. It dispatches to the agent by name, so the shim never imports the agent (no
  channel ⇄ agent cycle); `triggerPhrase` defaults to `@<agentName>`.

## Webhook handling

`planDelivery(delivery, phrase)` is the pure decision: given a verified webhook delivery, it returns
`{ ref, input } | null` — `null` for everything the bot doesn't act on (the channel then answers an
empty 200). What it acts on:

- **A comment on a PR** containing the trigger phrase → review the PR, or run its tests if the
  comment asks.
- **A comment on a plain issue** containing the trigger phrase → run the tests for that repo.
- **A newly opened PR** (`pull_request.opened`) → an automatic review, no phrase needed.

Comments authored by bot accounts (`sender.type === "Bot"`) are filtered out, so the bot never
reacts to its own posts. GitHub expects a `2xx` within ten seconds and does not auto-retry, so the
channel acks immediately and processes the work asynchronously on the agent instance. Deliveries are
not deduplicated by `deliveryId` (GitHub doesn't auto-retry, and comments on the same PR already
serialize on one instance); the id is threaded through so dedup can be added if needed.

## Public API

```ts
import {
  // pure URL / clone helpers
  parseGitHubTarget, parsePrTarget, assertSafeRef, looksPrivate, buildCloneScript,
  type GitHubTarget,
  // webhook planning + outbound comment tool
  planDelivery, commentOnIssue, client,
  type DispatchPlan, type DispatchInput, type DispatchTarget,
  // the Flue channel factory
  createGitHubBotChannel, type GitHubBotChannelOptions,
  // the fetch_repo Flue tool
  fetchRepoTool,
} from "@repo/github";
```

## Tests

```bash
pnpm --filter @repo/github test       # vitest run
pnpm --filter @repo/github typecheck  # tsc --noEmit
```

See [`AGENTS.md`](AGENTS.md) for the security contracts (shell-injection safety, the
destination-fixed-at-bind-time guarantee) and how the bot's discovered channel wires these in.
Monorepo-wide conventions live in the [root `AGENTS.md`](../../AGENTS.md).
