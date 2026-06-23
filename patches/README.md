# patches

pnpm [patches](https://pnpm.io/cli/patch) applied to dependencies at install time,
wired up via `patchedDependencies` in `pnpm-workspace.yaml`.

## `@flue__cli@1.0.0-beta.3.patch`

Fixes `flue dev` (node target) failing to start with
`[flue] Unable to resolve skill import: @repo/github/skills/explore-repo/SKILL.md`.

In beta.3 the dev server registers `viteGeneratedEntryDependencyResolver(root, { external: true })`
as a `pre` Vite plugin to externalize the generated entry's runtime deps. Because the dev call omits
the `importers` filter (unlike the `flue build` call, which uses the resolver without `external`), it
externalizes **every** resolvable bare specifier — including the workspace skill subpath
`@repo/github/skills/explore-repo/SKILL.md`. Flue's own skill plugin then sees the import resolve as
`external` and throws. The patch makes that resolver skip `.md` imports (`return null`) so the skill
plugin and Vite's normal workspace-aware resolution handle them, matching the build path.

**Temporary — remove once upstream `@flue/cli` no longer externalizes `.md` skill imports in the dev
server.** Re-check on the next `@flue/cli` bump; if `flue dev` starts cleanly without it, delete this
patch file and its entry under `patchedDependencies` in `pnpm-workspace.yaml`.

## Removed

The former `@flue__runtime@1.0.0-beta.2.patch` (which dropped a `signal` option passed to the
Cloudflare Sandbox's `sandbox.exec` call) was removed when we bumped `@flue/runtime` to
`1.0.0-beta.3`, where the fix landed upstream.
