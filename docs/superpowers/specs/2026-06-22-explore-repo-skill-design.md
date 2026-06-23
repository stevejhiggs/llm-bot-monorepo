# Design: shared `explore-repo` skill for generic repository work

**Date:** 2026-06-22

## Problem

Asking the bot a general question about a repository — e.g. "how many lines of code are in
https://github.com/stevejhiggs/llm-bot-monorepo" — makes it give up ("out of my wheelhouse").

The router agent (`bots/d0lt-bot/src/agents/d0lt-bot.ts` + `d0lt-bot.md`) only knows two routes:
review a PR (`reviewer` subagent) and run tests (`test_runner` subagent). Its prompt explicitly
says *"Do not fetch repos, diffs, or run tests yourself; that is the subagents' job"* and *"If the
message is not about reviewing a PR or running tests, just respond normally."* A general repo
question maps to neither route, so it declines.

The router actually *can* do repo work — bash/read/fs are built-in session capabilities it already
has via its sandbox (the subagents never declared a `bash` tool; they just use the router's
sandbox). The only things missing are the `fetch_repo` URL helper and a prompt that lets it work.

Working with a repository should be a **generic capability usable everywhere** — by the router for
ad-hoc questions, and by the specialist subagents that already do repo work.

## Approach (Option Z: shared skill)

Make "clone a GitHub repo and inspect it" a **Flue skill** (`explore-repo`) — a reusable
`SKILL.md` procedure — and register it on everyone who works with repos: the **router** and the
**`reviewer` / `test_runner` subagents**.

- The **router** loads `explore-repo` directly to answer arbitrary repo questions (line counts,
  structure, "what does X do") — this fixes the original complaint.
- **`reviewer`** and **`test_runner`** stay as subagents (preserving their isolated context windows
  and the reviewer's `thinkingLevel: "high"`) and load the *same* skill for their clone/inspect
  step, instead of each re-describing the clone mechanics. The shared procedure lives in one place.

A Flue skill is a `SKILL.md` file (frontmatter `name` + `description`, then the procedure) imported
with `with { type: "skill" }` (the `*/SKILL.md` ambient module from `@flue/runtime` types it as a
`SkillReference`) and registered via `skills: [...]` on an agent profile / runtime config. The model
loads a registered skill on demand and follows it **in its own session, using that session's
tools** — no separate child session. So the same skill object can be registered on the router and
on subagents simultaneously.

### Rejected alternatives
- **`repo_explorer` as its own subagent that `reviewer` delegates to (nested `task`).** The
  reviewer would only get the explorer's returned text, not what it saw (separate context windows),
  despite sharing the sandbox files; two LLM hops and task-depth management for no real gain.
- **Convert `reviewer`/`test_runner` themselves into skills (drop the subagents).** Loses their
  isolated context and the reviewer's high thinking level — repo cloning + large diffs would land
  in the main conversation's context. Rejected after weighing the context-isolation tradeoff.

## Components

### 1. New skill `explore-repo`

`bots/d0lt-bot/src/skills/explore-repo/SKILL.md`:

- Frontmatter: `name: explore-repo`, a `description` that makes the model reach for it whenever a
  GitHub repo/PR URL is in play and it needs to clone or inspect code.
- Procedure:
  - Call `fetch_repo` with the URL (and a `ref` if the user named a branch/tag/commit), then run
    the returned command verbatim with bash. It clones into `./repo`; for a PR URL it also writes
    the unified diff to `./pr.diff`. Work inside `repo/`.
  - **Prefer read-only inspection** — reading files, `grep`, `find`, `wc -l`, `git log`, listing
    directories. Only run mutating or build/install commands when the question genuinely requires
    it. The skill is allowed to run commands; it is not sandboxed to read-only.
  - Private/inaccessible repo → say so and state that a `GITHUB_TOKEN` with repo read access must
    be set in the app runtime.

The skill references the `fetch_repo` tool, so every agent that loads it must have `fetchRepoTool`
in its `tools` (router gains it below; the subagents already have it).

### 2. Register the skill + give the router the tool (`bots/d0lt-bot/src/agents/d0lt-bot.ts`)

- `import exploreRepo from "../skills/explore-repo/SKILL.md" with { type: "skill" };`
- Add `skills: [exploreRepo]` to the `createAgent` config.
- Add `fetchRepoTool` (from `@repo/github`) to the router's `tools` alongside
  `conversation.tools.router`.
- Keep `subagents: [createReviewer(...), createTestRunner(...)]` and the existing sandbox / channel
  wiring unchanged.

### 3. Subagents load the shared skill (`subagents/reviewer.ts`, `test-runner.ts` + their `.md`)

- Each factory imports `exploreRepo` and adds `skills: [exploreRepo]` to its `defineAgentProfile`.
- `reviewer.md` / `test-runner.md`: replace the inline "call `fetch_repo`, run it, clone to
  `./repo`" mechanics with "load the `explore-repo` skill to clone and inspect the repository,"
  then keep their specialization — reviewer reads `./pr.diff` and reviews; test_runner detects the
  stack, installs, and runs tests. The progress-narration and private-repo guidance stay.
- `reviewer` keeps `thinkingLevel: "high"`; `test_runner` keeps its default.

### 4. Rewrite the base prompt (`bots/d0lt-bot/src/agents/d0lt-bot.md`)

- The router now works with repos itself. New framing:
  - **Review a PR** → delegate to the `reviewer` subagent (unchanged).
  - **Run a repository's tests** → delegate to the `test_runner` subagent (unchanged).
  - **Any other question about a repository** (line counts, structure, "what does X do", summarize)
    → load the `explore-repo` skill and answer directly.
  - Plain conversation with no repo involved → respond normally.
- Remove the "do not fetch repos / that is the subagents' job" and "otherwise respond normally"
  clauses that caused the bot to decline.

## Data flow

Unchanged plumbing. The router classifies the turn's source via `CHANNEL_REGISTRY`, composes its
prompt, owns the lazy sandbox facade. For a PR review or test run it still delegates via `task` to
the subagent (which shares the router's sandbox and now loads `explore-repo` for cloning). For a
general repo question the router loads `explore-repo` itself and works in its own session. Channel
behavior (opening ack, progress narration, final reply through `toMrkdwn` on Slack) is unchanged;
the `ConversationTools` `{ router, subagent }` split stays as-is because the subagents remain.

## Error handling

Same contracts as today: private/inaccessible repo → report it and name the missing
`GITHUB_TOKEN`; toolchain/command failures → report what failed plainly. The handling lives in the
`explore-repo` skill (shared) plus each subagent's specialization.

## Testing

Consistent with the repo's rule that the agent graph, `channels/*`, and subagent profiles are not
unit-tested (the `with { type: "markdown" }` / `with { type: "skill" }` imports don't resolve under
Vitest without the Flue plugin), this change adds **no new unit tests** — it is a skill file, prompt
edits, and wiring. Verification:

- `pnpm typecheck` — confirms the `*/SKILL.md` ambient module resolves and the wiring type-checks.
- `pnpm test`, `pnpm lint` — existing suites stay green.
- `pnpm build` **and** `pnpm --filter d0lt-bot build:cf` — the `with { type: "skill" }` loader (like
  the markdown loader) is only exercised at build time, on both targets.
- Manual `pnpm connect`: ask "how many lines of code are in <repo URL>" and confirm the router loads
  `explore-repo` and answers; re-run a PR review and a test run to confirm the subagents still work
  via the shared skill.

## Open risk

`with { type: "skill" }` resolution and the `*/SKILL.md` ambient type are confirmed only by
`pnpm typecheck` + the two builds. If the ambient declaration is not picked up automatically, add a
reference to `@flue/runtime`'s `skill-md.d.ts` the same way the project handles the `*.md` ambient.
