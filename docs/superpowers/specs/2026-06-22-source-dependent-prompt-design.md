# Source-dependent agent prompt

**Date:** 2026-06-22
**Status:** Approved

## Problem

`d0lt-bot`'s instructions are a single static `d0lt-bot.md` that contains a "When
the turn comes from X" section for *every* channel. The model sees all of them on
every turn (chat included), which adds cross-channel noise, and adding a channel
means editing the monolith — even though the agent already knows the source at init
time (`conversationTools(id)` parses the conversation key into github / slack /
chat).

Goal (both): show the model only the relevant channel's section, and make adding a
channel a matter of dropping in a fragment rather than editing one big file.

## Approach

Compose the prompt from a channel-agnostic **base** plus a per-source **fragment**,
selected by the source resolved from the conversation id. Fragments live in their
**channel packages** (`@repo/github`, `@repo/slack`) as real `.md` files imported
via the markdown loader — matching the repo's channel-ownership pattern (the package
already owns the channel factory, `plan*()`, and the outbound tools; it now also
owns the prose describing those tools).

### Why package-owned markdown works

The `*.md` type is a global ambient declaration (`declare module '*.md'`) pulled in
by `@flue/runtime` via triple-slash reference (`types/markdown-md.d.ts`). The
wildcard matches any specifier ending in `.md`, so
`import x from "@repo/slack/instructions.md" with { type: "markdown" }`
type-checks like a local import — no per-package `.d.ts` needed. The package exposes
the file in its `exports` map; `flue build` (esbuild) resolves the subpath and the
`type: "markdown"` attribute triggers the markdown loader.

**Build-only risk:** whether flue's markdown loader processes a `.md` resolved from a
workspace package (not an app-local file) can only be confirmed at build time —
hence the gate runs both `pnpm build` and `build:cf`. Fallback if it fails: keep the
fragments in the bot (`src/agents/instructions/*.md`); everything else is identical.

## Structure

- **Base** — `bots/d0lt-bot/src/agents/d0lt-bot.md`: intro, the two subagent-routing
  sections (Reviewing a PR, Running tests), Notes. Channel-agnostic; applies to chat.
- **Fragments** — `packages/github/src/instructions.md` and
  `packages/slack/src/instructions.md`: the respective "When the turn comes from X"
  sections (the Slack one keeps the new `threadContext` note). Each added to the
  package `exports` map as `"./instructions.md": "./src/instructions.md"`.
- **Composition** — the agent initializer imports `base`, `githubInstructions`,
  `slackInstructions` (all markdown, static — just strings) and sets
  `instructions = base + FRAGMENT[source]`. Chat → base only.

## Source resolution

- `bots/d0lt-bot/src/lib/conversation-source.ts`:
  ```ts
  export type ConversationSource = "github" | "slack" | "chat";
  export function resolveConversationSource(
    id: string,
    parsers: { github: (id: string) => unknown; slack: (id: string) => unknown },
  ): ConversationSource
  ```
  Tries `github` then `slack` (each `parseConversationKey` throws on a non-match),
  returns `"chat"` if both throw. This is the single id→source decision.
- The agent initializer calls it once, passing the real channel parse methods, and
  derives both the fragment and the tool set from the result. `conversationTools`
  keeps building tools from the parsed ref (it still parses to get the ref); the
  duplicated inline try/catch for *classification* is removed in favour of the
  resolver.

## Testing

- `lib/conversation-source.test.ts` (pure, offline): github key → `"github"`; slack
  key → `"slack"`; unparseable id (e.g. `"local"`) → `"chat"`; github tried before
  slack. Uses fake parser fns — no markdown, no agent graph.
- The agent initializer (markdown import) stays untested, as today; it shrinks to
  resolve → pick fragment → pick tools.

## Docs

- Root `AGENTS.md`: update the "To add a channel end to end" checklist — instead of
  "add a section to `d0lt-bot.md`", it becomes "add `src/instructions.md` to the
  channel package, expose it in `exports`, and add a branch to the source resolver /
  fragment map".
- `packages/github/AGENTS.md` & `packages/slack/AGENTS.md`: note the new
  `instructions.md` and its `exports` entry in the file map / public surface.

## Gate

`pnpm typecheck`, the new lib test (`pnpm test`), `pnpm lint`, **and both**
`pnpm build` and `pnpm --filter d0lt-bot build:cf` (the package-markdown import is
confirmed only by the builds).

## Out of scope

- Per-source model/temperature selection (only instructions vary).
- Moving the subagent-routing or Notes sections out of the base.
- Any change to channel enablement, dispatch, or tool wiring.
