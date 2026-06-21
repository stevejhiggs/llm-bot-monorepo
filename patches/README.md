# patches

pnpm [patches](https://pnpm.io/cli/patch) applied to dependencies at install time,
wired up via `patchedDependencies` in `pnpm-workspace.yaml`.

## `@flue__runtime@1.0.0-beta.2.patch`

Drops the `signal: externalSignal` option passed to the Cloudflare Sandbox's
`sandbox.exec` call in `cfSandboxToSessionEnv`. The runtime still checks
`externalSignal?.aborted` after the call returns, so cancellation stays local — it
just isn't forwarded into the container, which the `@cloudflare/sandbox` version
we run doesn't handle cleanly.

**Temporary — remove once Flue beta 3 is released.** This is fixed upstream, so
when we bump `@flue/runtime` to `1.0.0-beta.3` (or later), delete this patch file
and its entry under `patchedDependencies` in `pnpm-workspace.yaml`.
