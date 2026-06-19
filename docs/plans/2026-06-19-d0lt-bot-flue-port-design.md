# Porting d0lt-bot from eve to Flue — design

Date: 2026-06-19

## Goal

Recreate the `d0lt-bot` proof-of-concept — a GitHub assistant that reviews pull requests and
runs repository test suites in a sandbox — on the [Flue](https://flueframework.com/) framework
instead of [eve](https://www.npmjs.com/package/eve). Keep it feature-equivalent: the same two
capabilities, direct-Anthropic model calls, and `GITHUB_TOKEN` handling for private repos. Like
the original, it is a POC and does not post results back to GitHub.

## Framework mapping

| Concern              | eve                                            | Flue                                                              |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| Define an agent      | `defineAgent({ model, instructions })`         | `createAgent(() => ({ model, instructions, subagents, sandbox }))` |
| Model specifier      | `anthropic("claude-sonnet-4-6")`               | `'anthropic/claude-sonnet-4-6'` (string)                         |
| Define a subagent    | subagent directory with `outputSchema`         | `defineAgentProfile({ name, description, instructions, tools })` |
| Delegate             | declared subagents                             | built-in `task` capability over `subagents: [...]`              |
| Schemas              | zod                                            | valibot (for tool `parameters`)                                  |
| Define a tool        | `defineTool({ inputSchema, execute(args, ctx) })` | `defineTool({ name, parameters, execute(args) })`             |
| Tool sandbox access  | `ctx.getSandbox().run()`                       | **none** — `execute` gets only validated args                    |
| Sandbox              | `defineSandbox({ onSession })`                 | `local()` from `@flue/runtime/node` (host); remote via `flue add` |
| Chat entry           | `eveChannel({ auth })` HTTP                     | agent `route` export + `flue connect <agent> <id>`               |
| Model credentials    | `ANTHROPIC_API_KEY` (direct)                   | `ANTHROPIC_API_KEY` in `.env` (direct, Pi catalog provider)      |

## The decisive constraint

In eve, the `fetch_repo` **tool** clones into the sandbox via `ctx.getSandbox().run()`. Flue's
tool contract is narrower — confirmed from the installed types:

```ts
execute: (args: ToolArgs<TParams>, signal?: AbortSignal) => Promise<string>
```

No harness, no sandbox, no `fs`/`shell`. The only things that can touch a sandbox are a
**workflow's** `run(ctx)` (via `harness.shell`/`fs`) or an **agent** running bash itself as a
built-in capability. So the clone/diff/test work cannot live in a tool.

## Architecture (chosen: subagents only)

A root router agent owns a `local()` sandbox and delegates to two subagent profiles via Flue's
built-in `task` capability — the same shape as the eve original.

```
you ──chat (flue connect)──▶ d0lt-bot (router agent, owns local() sandbox)
                                │ delegates via `task`
                ┌───────────────┴────────────────┐
                ▼                                 ▼
            reviewer                        test_runner
   fetch_repo → bash: clone + diff   fetch_repo → bash: clone → install → test
   → reads pr.diff + files           → detects stack, runs tests
   → structured review               → pass/fail + output
```

- **`src/agents/d0lt-bot.ts`** — `createAgent(async ({ id }) => …)`. `route` export exposes
  `POST /agents/d0lt-bot/:id`, which `flue connect` drives. Owns `sandbox: local(...)` and a
  per-instance `cwd`; declares `subagents: [reviewer, testRunner]`. Routing instructions live in
  `d0lt-bot.md` (imported `with { type: 'markdown' }`).
- **`src/subagents/{reviewer,test-runner}.ts`** — `defineAgentProfile`s sharing the router's
  harness/sandbox. Each has the `fetch_repo` tool and instructions to clone, then review / test.
- **`src/tools/fetch-repo.ts`** — one shared tool. It validates the URL with the shared helpers
  and returns the exact, injection-safe clone **command string**; the subagent runs it with its
  bash tool. (A tool can't clone — no sandbox — so it hands the model a vetted command instead of
  letting the model assemble a `git` command from a raw URL.)
- **`src/lib/github.ts`** — pure, shared: URL parsing, ref validation, clone-script builder,
  private-repo heuristic.

### Why this over the alternatives

This was a two-step decision. The first pass chose a **hybrid**: a chat router whose tools
POST to two `review-pr` / `run-tests` **workflows** (`harness.shell` clones deterministically)
via the framework's `POST /workflows/:name?wait=result` route. That worked and kept a
deterministic clone, but the self-HTTP bridge (`invoke-workflow.ts`, `FLUE_SELF_URL`,
"server must be running") was the least elegant part and diverged from eve's structure.

The second pass dropped the workflows and bridge entirely for **subagents only**:
- Removes the bridge — `task` returns the subagent's result in-process.
- Structurally identical to eve (root → two subagents, one shared sandbox); less code.

The trade-off it accepts: `harness.shell` is workflow-only, so cloning is now **agent-driven**
(the model runs the `fetch_repo` command via bash) rather than a deterministic workflow step.
For a POC over public repos with a vetted command string, that cost is low.

## Structured outputs

`AgentProfile` has no `outputSchema` field, and model-initiated `task` delegation has no place
to inject a valibot result schema (that exists only for programmatic `session.task(..., {
result })` calls inside workflows). So subagents return **well-structured markdown** — review
(recommendation, summary, diff size, severity-tagged findings) and test run (pass/fail, commands,
summary, output tail) — which the router relays. valibot remains only for tool `parameters`.

## Error handling & secret handling

- The subagent instructions handle operational failures (private repo, missing toolchain, no
  tests) by reporting them in prose, including the "set a `GITHUB_TOKEN`" hint — no thrown
  errors to leak as generic 500s.
- Private-repo auth: `GITHUB_TOKEN` is exposed to the sandbox via `local({ env })` and consumed
  as `$GITHUB_TOKEN` inside the clone command (`git -c http.<host>.extraheader=…`). The token is
  referenced by name, never interpolated, so it appears in neither the command string nor the
  model's context. Per-command `-c` avoids mutating the host's global git config (this is a host
  sandbox). `GIT_TERMINAL_PROMPT=0` makes private-without-token fail fast.

## Sandbox & isolation

Flue `local()` runs on the host, so each chat instance clones into an isolated
`os.tmpdir()/d0lt-bot/<id>` scratch dir. That dir is created with `fs.mkdir` inside the async
`createAgent` initializer, **before** `local()` spawns any shell there — an absent cwd otherwise
surfaces as `spawn /bin/bash ENOENT`. Stronger isolation is a `local()` → remote-sandbox swap
(`flue add sandbox daytona|vercel|…`).

## Validation performed

- `tsc --noEmit` clean; `flue build` discovers `d0lt-bot` (no workflows).
- Live agent endpoint: a `POST /agents/d0lt-bot/:id` confirmed the async initializer runs (it
  created the per-instance scratch dir) and the `local()` sandbox + cwd initialize without
  `ENOENT`; the only failure is the model call when no `ANTHROPIC_API_KEY` is set.
- The relative clone script (public form) and the token-auth `-c extraheader` form (bash syntax
  + runtime header transmission) against a real public PR, including `merge-base` diff +
  `--numstat`.
- Not exercised (needs `ANTHROPIC_API_KEY`, as in the original): the live model review/test and
  `task` delegation.

## Out of scope (matches the original POC)

Posting reviews/results to GitHub; webhook/GitHub channel ingress; auth beyond local dev;
scratch-dir cleanup; production deployment.
