# explore-repo Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make working with a GitHub repository a generic capability — so the bot can answer ad-hoc repo questions (e.g. "how many lines of code are in <repo>") instead of declining — by extracting clone-and-inspect into a shared Flue skill used by the router and both subagents.

**Architecture:** Add a Flue skill `explore-repo` (a `SKILL.md` procedure for cloning a repo into the sandbox and inspecting it, read-only by default). Register it on the router agent — which gains the `fetch_repo` tool and a rewritten prompt so it answers general repo questions itself — and on the existing `reviewer` / `test_runner` subagents, which keep their isolated child sessions and load the same skill for their clone/inspect step. No new subagents; the `reviewer`/`test_runner` split and the `ConversationTools { router, subagent }` shape are unchanged.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 24, pnpm 11, Turborepo. Flue runtime `@flue/runtime` (patched `1.0.0-beta.2`). Skills imported via `import x from "./.../SKILL.md" with { type: "skill" }` (ambient `*/SKILL.md` module from `@flue/runtime` types — same mechanism as the existing `with { type: "markdown" }` imports). Tests: Vitest (not used here — see Global Constraints).

## Global Constraints

- **No unit tests for the agent graph / skills / subagent profiles.** Per `AGENTS.md` and the spec, channel/agent/skill wiring is NOT unit-tested: `with { type: "markdown" }` / `with { type: "skill" }` imports don't resolve under Vitest without the Flue plugin. Do **not** add a Vitest test that imports the agent, a subagent profile, or a `SKILL.md`. Verification for every task is `pnpm typecheck` + `pnpm build` + `pnpm --filter d0lt-bot build:cf` (+ `pnpm lint`), plus the manual `pnpm connect` checks noted per task.
- **Both build gates are required.** This touches markdown/skill import wiring and subagent profiles; channel discovery and the workerd bundle only fail at build time. Run **both** `pnpm build` and `pnpm --filter d0lt-bot build:cf` — typecheck alone is insufficient.
- **Import sibling modules with explicit extensions**; markdown via `with { type: "markdown" }`, skills via `with { type: "skill" }`.
- **Conventional Commits** for commit messages (`feat:`, `refactor:`, etc.).
- **Outbound tools / destinations are unchanged** — do not touch `@repo/channel-registry`, `@repo/github` agent-integration, or `@repo/slack` agent-integration; the `{ router, subagent }` split stays because both subagents remain.
- Run from the repo root unless noted. Skill/prompt files live under `bots/d0lt-bot/src/`.

---

### Task 1: Add the `explore-repo` skill and let the router answer general repo questions

This task creates the skill, gives the router the `fetch_repo` tool, registers the skill on the router, and rewrites the base prompt. Deliverable: asking the bot "how many lines of code are in <repo URL>" makes it clone and answer instead of declining.

**Files:**
- Create: `bots/d0lt-bot/src/skills/explore-repo/SKILL.md`
- Modify: `bots/d0lt-bot/src/agents/d0lt-bot.ts`
- Modify: `bots/d0lt-bot/src/agents/d0lt-bot.md` (full rewrite of routing/notes)

**Interfaces:**
- Consumes: `fetchRepoTool` (default export of `packages/github/src/fetch-repo.ts`, re-exported as the named `fetchRepoTool` from `@repo/github`).
- Produces: a `SkillReference` at `bots/d0lt-bot/src/skills/explore-repo/SKILL.md`, importable elsewhere as
  `import exploreRepo from "../skills/explore-repo/SKILL.md" with { type: "skill" };`
  (Task 2 imports this exact path from `subagents/*.ts` — `skills/` and `subagents/` are siblings under `src/`, so the relative path is identical.)

- [ ] **Step 1: Create the skill file**

Create `bots/d0lt-bot/src/skills/explore-repo/SKILL.md` with this exact content:

```markdown
---
name: explore-repo
description: Clone a GitHub repository or pull request into the sandbox and inspect it to answer questions about the code — line counts, project structure, what a file or function does, where something is used, summaries. Use whenever a GitHub repo or PR URL is in play and you need to look at the actual code. Prefer read-only inspection.
---

You work with a GitHub repository inside your sandbox. Your goal is to clone it and inspect it to
complete the task you were given.

## Steps

1. Call `fetch_repo` with the repository or pull-request URL (pass a `ref` if the user named a
   specific branch, tag, or commit). Then run the command it returns **verbatim** with your bash
   tool. It clones the code into `./repo`; for a PR URL it also writes the unified diff to
   `./pr.diff`. Afterwards, work inside `repo/`.

2. **Prefer read-only inspection.** Answer with commands that read rather than change: `ls`,
   `find`, `grep`/`rg`, `wc -l`, `cat`, `git log`, `git diff`. Only run mutating, install, or build
   commands (`pnpm install`, `make`, compilers, …) when the task genuinely requires it — e.g.
   "does it build?". You may run any command; just don't install or build unless the task needs it.

3. Use what you find to complete the task, grounded in the actual code. When you are answering a
   question, be concise and show the commands or files that back up your answer.

If the clone fails because the repository is private and cannot be accessed (auth error / "not
found"), say so plainly and state that a `GITHUB_TOKEN` with repo read access must be set in the
app runtime.
```

- [ ] **Step 2: Wire the skill and tool into the router**

In `bots/d0lt-bot/src/agents/d0lt-bot.ts`:

Add the `fetchRepoTool` import. Change the existing line 7 region — it currently imports only the agent-integration subpath. Add a value import for the tool near the other `@repo/github` import:

```ts
import { fetchRepoTool } from "@repo/github";
```

Add the skill import alongside the other `with { type: "markdown" }` imports (after the `baseInstructions` import on line 9):

```ts
import exploreRepo from "../skills/explore-repo/SKILL.md" with { type: "skill" };
```

In the returned config object (currently lines 62-72), add `skills` and extend `tools`. Replace:

```ts
  return {
    model: "anthropic/claude-sonnet-4-6",
    instructions,
    sandbox,
    cwd,
    subagents: [
      createReviewer(conversation.tools.subagent),
      createTestRunner(conversation.tools.subagent),
    ],
    tools: conversation.tools.router,
  };
```

with:

```ts
  return {
    model: "anthropic/claude-sonnet-4-6",
    instructions,
    sandbox,
    cwd,
    skills: [exploreRepo],
    subagents: [
      createReviewer(conversation.tools.subagent),
      createTestRunner(conversation.tools.subagent),
    ],
    tools: [...conversation.tools.router, fetchRepoTool],
  };
```

- [ ] **Step 3: Rewrite the base prompt**

Replace the entire contents of `bots/d0lt-bot/src/agents/d0lt-bot.md` with:

```markdown
You are d0lt-bot, an assistant for working with GitHub repositories. You can work with a
repository directly inside your sandbox, and you delegate the two heavy specialist jobs — full PR
reviews and test runs — to subagents.

## Reviewing a pull request → the `reviewer` subagent

When the user nominates a pull request — by pasting a GitHub PR URL
(e.g. `https://github.com/owner/repo/pull/123`) or asking you to review one — delegate to the
`reviewer` subagent, passing the PR URL in its message. It clones the repo, reads the diff in
context, and returns a structured review (recommendation, summary, diff size, severity-tagged
findings). Relay it back clearly:

- Lead with the recommendation (approve / comment / request changes) and the summary.
- List findings by severity, each with its file (and line), the problem, and the fix.
- Mention the diff size (files changed, additions, deletions) for context.
- If there are no findings, say the change looks clean — don't manufacture issues.

## Running a repository's tests → the `test_runner` subagent

When the user gives a GitHub repo or PR URL and asks to run its tests, delegate to the
`test_runner` subagent. Pass it both the URL and the user's testing instruction in the message.
It clones the code, installs dependencies, runs the tests, and returns a structured pass/fail
result. Relay it back clearly:

- Lead with pass or fail, and what was run (the test command and the detected stack).
- Give the summary, including pass/fail counts when available.
- On failure, show the relevant output the subagent returned.

## Any other question about a repository → the `explore-repo` skill

For anything else that involves a GitHub repo — how many lines of code, the project structure,
what a file or function does, where something is used, summarizing the codebase — load the
`explore-repo` skill and answer it yourself. The skill clones the repo into your sandbox and walks
you through inspecting it. Don't hand these to the subagents; the subagents are only for full PR
reviews and test runs.

When a turn arrives from a channel (GitHub, Slack) rather than chat, you are also
given a section describing how that channel delivers the turn and how to post your
answer back. Follow it in addition to the routing above.

## Notes

- For PR reviews and test runs, delegate to the subagents — don't do that work yourself.
- If a subagent or the `explore-repo` skill reports it could not access a private repository, tell
  the user a `GITHUB_TOKEN` with repo read access must be set in the app runtime.
- If the message is not about a repository at all, just respond normally.
```

- [ ] **Step 4: Verify it type-checks and builds**

Run:

```bash
pnpm typecheck && pnpm build && pnpm --filter d0lt-bot build:cf
```

Expected: all three succeed. `pnpm typecheck` passing confirms the `*/SKILL.md` ambient module resolved (no "Cannot find module './skills/explore-repo/SKILL.md'"). Both builds passing confirms the `with { type: "skill" }` loader resolves the skill on the node and workerd targets.

If typecheck reports the SKILL.md module is not found, confirm `@flue/runtime` is a dependency of `bots/d0lt-bot` (it is) — its `types/index.d.ts` references `skill-md.d.ts`. Do not add a manual `.d.ts`; resolve the import path instead.

- [ ] **Step 5: Lint**

Run:

```bash
pnpm lint
```

Expected: no errors. Keep formatting scoped to the files changed in this task.

- [ ] **Step 6: Manual smoke test (the original bug)**

Requires `bots/d0lt-bot/.env` with `ANTHROPIC_API_KEY` (and `GITHUB_TOKEN` for private repos). In one terminal `pnpm dev`; in another run `pnpm connect`, then ask:

```
how many lines of code are in https://github.com/stevejhiggs/llm-bot-monorepo
```

Expected: the agent loads the `explore-repo` skill, calls `fetch_repo`, clones, runs a read-only count (e.g. `find`/`wc -l`), and answers with a number — it does **not** say the request is out of its wheelhouse. (If you cannot run this locally, note it as un-run rather than claiming it passed.)

- [ ] **Step 7: Commit**

```bash
git add bots/d0lt-bot/src/skills/explore-repo/SKILL.md bots/d0lt-bot/src/agents/d0lt-bot.ts bots/d0lt-bot/src/agents/d0lt-bot.md
git commit -m "feat: add explore-repo skill so the router answers general repo questions"
```

---

### Task 2: Reuse the skill in the `reviewer` and `test_runner` subagents

Register the shared skill on both subagents and slim their prompts so the clone/inspect mechanics live only in the skill (DRY). The subagents keep their isolated sessions, the reviewer keeps `thinkingLevel: "high"`, and their specialization (read the diff / detect stack + run tests) stays in their own prompts.

**Files:**
- Modify: `bots/d0lt-bot/src/subagents/reviewer.ts`
- Modify: `bots/d0lt-bot/src/subagents/reviewer.md`
- Modify: `bots/d0lt-bot/src/subagents/test-runner.ts`
- Modify: `bots/d0lt-bot/src/subagents/test-runner.md`

**Interfaces:**
- Consumes: `exploreRepo` from Task 1, imported as
  `import exploreRepo from "../skills/explore-repo/SKILL.md" with { type: "skill" };`
- The factories `createReviewer(extraTools)` / `createTestRunner(extraTools)` keep their existing signatures and `tools: [fetchRepoTool, ...extraTools]`; only a `skills` field is added.

- [ ] **Step 1: Register the skill on the reviewer**

In `bots/d0lt-bot/src/subagents/reviewer.ts`, add the import after line 2 (the instructions import):

```ts
import exploreRepo from "../skills/explore-repo/SKILL.md" with { type: "skill" };
```

In the `defineAgentProfile({ ... })` object, add a `skills` field (keep `thinkingLevel`, `instructions`, `tools` as they are):

```ts
  return defineAgentProfile({
    name: "reviewer",
    description:
      "Reviews a GitHub pull request: clones it into the sandbox, reads the diff in context, and " +
      "returns a structured code review (summary, severity-tagged findings, recommendation).",
    thinkingLevel: "high",
    instructions,
    skills: [exploreRepo],
    tools: [fetchRepoTool, ...extraTools],
  });
```

- [ ] **Step 2: Slim the reviewer prompt to use the skill**

In `bots/d0lt-bot/src/subagents/reviewer.md`, replace step 1 (the lines under "Steps:" that currently begin "1. Call `fetch_repo` with the PR URL, then run the command it returns verbatim …" through "… `git diff --numstat` — total those columns for the diff size (files changed, additions, deletions).") with:

```markdown
1. Load the `explore-repo` skill to clone the pull request into your sandbox. It checks the PR head
   out at `./repo` and writes the unified diff to `./pr.diff`. The clone command also prints the
   short HEAD and, after `---DIFF---`, the `git diff --numstat` — total those columns for the diff
   size (files changed, additions, deletions).
```

Leave steps 2-4, the `post_slack_progress` paragraph, and the private-repo paragraph unchanged.

- [ ] **Step 3: Register the skill on the test runner**

In `bots/d0lt-bot/src/subagents/test-runner.ts`, add the import after line 2:

```ts
import exploreRepo from "../skills/explore-repo/SKILL.md" with { type: "skill" };
```

Add the `skills` field to its `defineAgentProfile`:

```ts
  return defineAgentProfile({
    name: "test_runner",
    description:
      "Runs a repository’s tests: clones the code into the sandbox, detects the stack, installs " +
      "dependencies, runs the tests, and returns a structured pass/fail result.",
    instructions,
    skills: [exploreRepo],
    tools: [fetchRepoTool, ...extraTools],
  });
```

- [ ] **Step 4: Slim the test-runner prompt to use the skill**

In `bots/d0lt-bot/src/subagents/test-runner.md`, replace step 1 (currently "1. Call `fetch_repo` with the URL (and a `ref` if the user named a branch/tag/commit), then run the command it returns verbatim with your bash tool. That checks the code out at `./repo`.") with:

```markdown
1. Load the `explore-repo` skill to clone the code into your sandbox at `./repo` (pass a `ref` if
   the user named a branch, tag, or commit). Installing dependencies and running the tests below is
   exactly the kind of work that skill's read-only preference allows you to do here.
```

Leave steps 2-5, the `post_slack_progress` paragraph, and the failure/private-repo paragraph unchanged.

- [ ] **Step 5: Verify type-check and both builds**

Run:

```bash
pnpm typecheck && pnpm build && pnpm --filter d0lt-bot build:cf
```

Expected: all succeed (the skill now imported from three modules resolves on both targets).

- [ ] **Step 6: Lint and existing tests**

Run:

```bash
pnpm lint && pnpm test
```

Expected: lint clean; the existing Vitest suites (channel-flags, package tests) still pass — none were touched, so they stay green.

- [ ] **Step 7: Manual smoke test (subagents still work via the skill)**

With `pnpm dev` + `pnpm connect` running (see Task 1 Step 6), confirm both specialist paths still work end to end:

```
review https://github.com/<owner>/<repo>/pull/<n>
```
Expected: delegates to `reviewer`, which loads `explore-repo`, clones, reads `./pr.diff`, and returns a structured review.

```
run the tests for https://github.com/<owner>/<small-node-repo>
```
Expected: delegates to `test_runner`, which loads `explore-repo`, clones, installs, runs tests, and returns PASS/FAIL. (If you can't run locally, note it as un-run rather than claiming it passed.)

- [ ] **Step 8: Commit**

```bash
git add bots/d0lt-bot/src/subagents/reviewer.ts bots/d0lt-bot/src/subagents/reviewer.md bots/d0lt-bot/src/subagents/test-runner.ts bots/d0lt-bot/src/subagents/test-runner.md
git commit -m "refactor: reuse the explore-repo skill in the reviewer and test_runner subagents"
```

---

### Task 3: Update agent-facing docs

Document the new skill and the router's direct repo capability in `AGENTS.md` so future agents don't re-introduce the "subagents only" framing.

**Files:**
- Modify: `AGENTS.md`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Update the "One agent, three entry points" / routing description**

In `AGENTS.md`, find the paragraph in the architecture section that says the router "delegates to two **subagents** (`reviewer`, `test_runner`) … Subagents never clone directly". Update it to state that the router also owns a generic `explore-repo` skill: it answers ad-hoc repo questions itself (clone + read-only inspect) and delegates only full PR reviews and test runs to the two subagents, which load the **same** `explore-repo` skill for their clone step. Keep the surrounding contracts (fetchRepoTool injection-safe clone command, the facade) intact.

Concretely, replace the sentence:

```
The router attaches a lightweight sandbox facade and delegates to two **subagents** (`reviewer`,
`test_runner` under `src/subagents/`) via Flue's built-in `task` capability. Subagents never clone
directly: the shared `fetchRepoTool` (from `@repo/github`) validates a GitHub URL and returns an
injection-safe shell command that the subagent runs with its bash tool inside the router's sandbox.
```

with:

```
The router attaches a lightweight sandbox facade. It works with repositories two ways: it loads the
shared **`explore-repo` skill** (`src/skills/explore-repo/SKILL.md`) to answer ad-hoc repo questions
itself (clone + read-only inspect), and it delegates the two heavy jobs — full PR reviews and test
runs — to the **subagents** (`reviewer`, `test_runner` under `src/subagents/`) via Flue's built-in
`task` capability. The router and both subagents register the same `explore-repo` skill, so the
clone/inspect procedure lives in one place. Nobody assembles git commands from a raw URL: the shared
`fetchRepoTool` (from `@repo/github`) validates a GitHub URL and returns an injection-safe shell
command that the skill runs with the bash tool inside the router's sandbox.
```

- [ ] **Step 2: Note the skill import in the source-dependent prompt / build-gate guidance**

In the section that warns the markdown loader is "confirmed only by `pnpm build` / `build:cf`", add one sentence noting that the same applies to the `with { type: "skill" }` import of `SKILL.md` files — run both builds when adding or moving a skill.

- [ ] **Step 3: Verify docs only, then commit**

No build needed (markdown docs). Re-read the edited sections to confirm they read correctly and don't contradict the rest of the file.

```bash
git add AGENTS.md
git commit -m "docs: document the explore-repo skill and router repo capability"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-06-22-explore-repo-skill-design.md`):
- Component 1 (new `explore-repo` skill) → Task 1 Step 1. ✓
- Component 2 (register skill + add `fetch_repo` on router) → Task 1 Steps 2-3. ✓
- Component 3 (subagents load the shared skill, prompts slimmed) → Task 2. ✓
- Component 4 (rewrite base prompt) → Task 1 Step 3. ✓
- Testing (typecheck/test/lint + both builds + manual connect) → verification steps in Tasks 1 & 2. ✓
- Open risk (`*/SKILL.md` ambient resolution) → addressed: confirmed wired via `@flue/runtime` `types/index.d.ts`, verified by Task 1 Step 4 typecheck. ✓
- Docs (`AGENTS.md` framing) → Task 3 (added so the "subagents only" guidance doesn't get reintroduced). ✓

**Placeholder scan:** No TBD/TODO; all file contents and edits are given verbatim; commands have expected output. ✓

**Type/name consistency:** `exploreRepo` import path `../skills/explore-repo/SKILL.md` is identical from `agents/` and `subagents/` (both siblings of `skills/` under `src/`). `fetchRepoTool` named import matches `@repo/github` re-export (`packages/github/src/index.ts:18`). Factory signatures `createReviewer`/`createTestRunner` unchanged. Skill `name: explore-repo` matches every prose reference to "the `explore-repo` skill". ✓
