# AGENTS.md — @repo/github

Agent-facing companion for `@repo/github`. See [`README.md`](README.md) for the human overview.
This package holds the GitHub logic that must be unit-testable in isolation: URL/ref parsing,
shell-safe clone-script assembly, webhook decision logic, and the outbound comment tool. It does not
construct or own a Flue channel — the bot's discovered `bots/d0lt-bot/src/channels/github.ts` does
that and imports from here.

## What's in here

```
src/
├─ index.ts            # public export surface (see Public API)
├─ github.ts           # pure helpers: parse URLs/refs, assemble the clone script (no network/sandbox)
├─ github-webhook.ts   # planDelivery(), triggerPhrase(), commentOnIssue(), Octokit client + types
├─ fetch-repo.ts       # the fetch_repo Flue tool (default export → re-exported as fetchRepoTool)
└─ github-webhook.test.ts
```

## Public API

From `github.ts` (pure, no I/O):
- `parseGitHubTarget(url: string, refOverride?: string): GitHubTarget` — parse a repo or PR URL.
- `parsePrTarget(url: string)` — like above but rejects non-PR URLs.
- `assertSafeRef(ref: string): string` — reject refs that aren't shell-safe.
- `looksPrivate(gitError: string): boolean` — heuristic for auth/private-repo clone failures.
- `buildCloneScript(target: GitHubTarget): string` — the shell script a subagent runs to clone.
- type `GitHubTarget = { kind: "pr"; owner; repo; number } | { kind: "repo"; owner; repo; ref? }`.

From `github-webhook.ts`:
- `planDelivery(delivery, phrase): DispatchPlan | null` — pure decision logic.
- `triggerPhrase(): string` — the activating phrase (`GITHUB_TRIGGER_PHRASE` or `@d0lt-bot`).
- `commentOnIssue(ref, octokit?)` — Flue tool factory bound to one issue/PR (`octokit` injectable).
- `client` — a shared Octokit authenticated by `GITHUB_TOKEN` (the default for `commentOnIssue`).
- types `DispatchPlan`, `DispatchInput`, `DispatchTarget`.

From `fetch-repo.ts`:
- `fetchRepoTool` — the `fetch_repo` Flue tool (the file's `default` export, re-exported by name).

## Contracts (do not break these)

### 1. Shell-injection safety is the whole point of `buildCloneScript`

`fetch_repo` exists so the model never assembles a git command from a raw URL. The safety chain:

- `owner`/`repo` are charset-constrained by `parseGitHubTarget`'s regexes (GitHub's allowed
  characters only), so they can't carry shell metacharacters.
- Any branch/tag/commit ref is validated by `assertSafeRef` (rejects metacharacters and a leading
  `-`, which git would read as a flag) before interpolation.
- The PR number is digits-only.
- `GITHUB_TOKEN` is referenced **by name** (`$GITHUB_TOKEN`) in the emitted script, never
  interpolated — so it appears in neither the returned string nor the model's context. The
  `-c http.extraheader` form keeps the credential per-command, never touching global git config.

If you add a new field to `GitHubTarget` or `buildCloneScript`, it must pass through the same
charset/`assertSafeRef` validation before it reaches the script string.

### 2. `fetch_repo` validates and returns — it does not clone

A Flue tool's `execute` receives only validated args (no sandbox), so `fetchRepoTool` parses the URL
and returns the exact command for the subagent to run with its **bash tool** inside the router's
sandbox. Keep cloning out of the tool; keep URL parsing + shell-safety here (one tested place)
rather than in the agent prompt.

### 3. `planDelivery` is pure; `commentOnIssue`'s destination is fixed at bind time

`planDelivery` returns `null` for everything the bot doesn't act on (so the channel answers an empty
200) and never dispatches or touches the network itself. `commentOnIssue(ref)` binds the
owner/repo/issue number from the **verified** delivery, so the model supplies only the body and
cannot redirect a post elsewhere. Bot-authored comments are filtered in `planDelivery`
(`sender.type === "Bot"`) so a posted result can't re-trigger the bot.

## How the bot consumes it

`bots/d0lt-bot/src/channels/github.ts` (thin, Flue-discovered) imports `planDelivery` +
`triggerPhrase` and, on a verified webhook, dispatches `{ id: conversationKey(plan.ref), input:
plan.input }` to the agent. It re-exports `commentOnIssue` for the agent to bind per conversation.
The subagents import `fetchRepoTool`. The channel file stays in the bot because Flue's file-based
discovery requires `channels/*.ts` there and it imports the agent to `dispatch()`.

## Dependencies

`@flue/runtime` + `@flue/github` (catalog `flue`; `@flue/runtime` must resolve to the patched
`1.0.0-beta.2`), `@octokit/rest` + `valibot` (catalog `external`). No dependency on `@repo/sandbox`
or `@repo/slack`.

## Tests

```bash
pnpm --filter @repo/github test       # vitest run — pure, offline
pnpm --filter @repo/github typecheck  # tsc --noEmit
```

`github-webhook.test.ts` drives `planDelivery` with minimal hand-built delivery payloads and
exercises `commentOnIssue` with an **injected fake Octokit** — no network, no live runtime. Follow
that pattern: test the pure functions directly and inject the client into the tool factories.
