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
