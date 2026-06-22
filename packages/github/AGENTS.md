# AGENTS.md — @repo/github

Agent-facing companion for `@repo/github`. See [`README.md`](README.md) for the human overview.
GitHub logic that is unit-testable in isolation: URL/ref parsing, shell-safe clone-script assembly,
webhook decision logic, the outbound comment tool, and the channel factory. The bot's discovered
`channels/github.ts` is a thin shim that calls `createGitHubBotChannel` with bot-owned values
(enablement, the resolved secret/phrase, the agent name).

## What's in here

The package is grouped into three domain folders — `repo/` (resolving & fetching
repositories), `webhook/` (inbound delivery planning), and `channel/` (the Flue channel,
its outbound comment side, and the agent-registry wiring) — plus the public `index.ts`
barrel and the `skills/` tree. Files are named for their role within a folder; nothing
carries a redundant `github-` prefix.

```
src/
├─ index.ts                       # public export surface (see Public API)
├─ repo/
│  ├─ target.ts                   # pure helpers: parse URLs/refs, assemble the clone script (no network/sandbox)
│  └─ fetch-repo.ts               # the fetch_repo Flue tool (default export → re-exported as fetchRepoTool)
├─ webhook/
│  ├─ plan.ts                     # planDelivery() + Dispatch* types (pure inbound decision logic)
│  └─ plan.test.ts
├─ channel/
│  ├─ channel.ts                  # createGitHubBotChannel() — builds the Flue channel
│  ├─ comment.ts                  # commentOnIssue() outbound tool + lazy Octokit getClient()
│  ├─ agent-integration.ts        # tested core for the bot's registry entry
│  ├─ default-agent-integration.ts # ./agent-integration export; attaches instructions.md
│  ├─ instructions.md             # the agent's "When the turn comes from GitHub" prompt fragment (see below)
│  ├─ comment.test.ts
│  └─ agent-integration.test.ts
└─ skills/                        # reusable Flue skills exported by this package (see below)
   └─ explore-repo/SKILL.md       # clone + read-only inspect a repo
```

`skills/explore-repo/SKILL.md` is a reusable Flue **skill** that walks an agent through cloning a
GitHub repo or PR into its sandbox and inspecting it (read-only by default) to answer arbitrary
questions. It lives here because its whole procedure is built around `fetch_repo`, so the skill and
the tool it depends on version together. It is exposed via the package's `exports` map
(`"./skills/explore-repo/SKILL.md"`) and imported with `with { type: "skill" }`. The filename must
stay `SKILL.md` — that is what Flue's `*/SKILL.md` ambient types as a `SkillReference`; the skill's
descriptive name is the directory. Any agent that registers the skill must also register
`fetchRepoTool` (the skill calls `fetch_repo`). The d0lt-bot router and both subagents register it.
Add future skills as sibling directories under `skills/`.

`channel/instructions.md` is the GitHub-specific section of the agent's prompt, exposed via the
package's `exports` map (`"./instructions.md"`) and attached by the package's `./agent-integration`
export. Keeping it here puts the prose describing `comment_on_github_issue` and the GitHub event
shape next to the channel it documents. See the root AGENTS.md "Source-dependent prompt".

## Public API

From `repo/target.ts` (pure, no I/O):
- `parseGitHubTarget(url, refOverride?): GitHubTarget` — parse a repo or PR URL.
- `parsePrTarget(url)` — like above but rejects non-PR URLs.
- `assertSafeRef(ref): string` — reject refs that aren't shell-safe.
- `looksPrivate(gitError): boolean` — heuristic for auth/private-repo clone failures.
- `buildCloneScript(target): string` — the shell script a subagent runs to clone.
- type `GitHubTarget = { kind: "pr"; owner; repo; number } | { kind: "repo"; owner; repo; ref? }`.

From `repo/fetch-repo.ts`:
- `fetchRepoTool` — the `fetch_repo` Flue tool.

From `webhook/plan.ts`:
- `planDelivery(delivery, phrase): DispatchPlan | null` — pure decision logic.
- types `DispatchPlan`, `DispatchInput`, `DispatchTarget`.

From `channel/comment.ts`:
- `commentOnIssue(ref, octokit?)` — Flue tool factory bound to one issue/PR (`octokit` injectable).
- `getClient()` — lazily creates the shared throttled Octokit authenticated by `GITHUB_TOKEN`. Do
  not create the Octokit client at module scope: `@octokit/plugin-throttling` starts Bottleneck
  timers during client construction, and Cloudflare Workers reject timers during global scope
  evaluation.

From `channel/channel.ts`:
- `createGitHubBotChannel(options): GitHubChannel` — builds the Flue channel. `options` is
  `{ enabled, agentName, webhookSecret?, triggerPhrase? }`; the package reads no env. The handler
  runs `planDelivery` then dispatches by name (`dispatch({ agent: agentName, ... })`).
  `triggerPhrase` defaults to `@<agentName>`.
- type `GitHubBotChannelOptions`.

From `./agent-integration` (`channel/default-agent-integration.ts`):
- `createGitHubAgentIntegration(channel): GitHubAgentIntegration` — returns the bot's registry entry
  for GitHub: package-owned prompt fragment, `channel.parseConversationKey`, and the
  `comment_on_github_issue` router tool.
- type `GitHubAgentIntegration`.

Skill subpath export (not from `index.ts`):
- `@repo/github/skills/explore-repo/SKILL.md` — the `explore-repo` skill, imported with
  `with { type: "skill" }`. Pairs with `fetchRepoTool`.

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

A new field on `GitHubTarget` or `buildCloneScript` must pass the same charset/`assertSafeRef`
validation before it reaches the script string.

### 2. `fetch_repo` validates and returns — it does not clone

A Flue tool's `execute` receives only validated args (no sandbox), so `fetchRepoTool` parses the URL
and returns the exact command for the subagent to run with its **bash tool** in the router's
sandbox. Keep cloning out of the tool; keep URL parsing + shell-safety here (one tested place).

### 3. `planDelivery` is pure; `commentOnIssue`'s destination is fixed at bind time

`planDelivery` returns `null` for everything the bot doesn't act on (the channel then answers an
empty 200) and never dispatches or touches the network. `commentOnIssue(ref)` binds the
owner/repo/issue number from the **verified** delivery, so the model supplies only the body and
cannot redirect a post. Bot-authored comments are filtered in `planDelivery` (`sender.type ===
"Bot"`) so a posted result can't re-trigger the bot.

### 4. The channel dispatches by name, never by an agent import

`createGitHubBotChannel` dispatches with `dispatch({ agent: agentName, ... })`, so the shim has no
import edge to the agent (the agent imports `channel` for `parseConversationKey`, one-directional).
Don't import the agent into a channel.

## How the bot consumes it

`channels/github.ts` calls `createGitHubBotChannel(...)` and exports the result as `channel`. The
agent binds `commentOnIssue` per conversation; the subagents import `fetchRepoTool`.

## Dependencies

`@flue/runtime` + `@flue/github` (catalog `flue`; `@flue/runtime` must resolve to the patched
`1.0.0-beta.2`), `@repo/channel-registry` for the shared agent-integration type shape,
`@octokit/rest`, `@octokit/plugin-throttling`, and `valibot` (catalog `external`). No dependency on
`@repo/sandbox` or `@repo/slack`.

## Tests

```bash
pnpm --filter @repo/github test       # vitest run — pure, offline
pnpm --filter @repo/github typecheck  # tsc --noEmit
```

`webhook/plan.test.ts` drives `planDelivery` with hand-built payloads; `channel/comment.test.ts`
exercises `commentOnIssue` with an **injected fake Octokit** (and asserts importing the module
starts no throttling timers). Follow that pattern: test the pure functions directly and inject the
client into the tool factories.
