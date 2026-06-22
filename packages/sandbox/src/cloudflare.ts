import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";
import { lazySandbox } from "./lazy-sandbox.ts";

type SandboxBinding = Parameters<typeof getSandbox>[0];

// Cloudflare-target sandbox: a per-instance container with git/node/shell at
// /workspace. `secrets` (Worker secrets) are injected into the container env so
// e.g. private clones authenticate via $GITHUB_TOKEN, matching local behavior.
export function createCloudflareSandbox({
  id,
  sandboxBinding,
  secrets,
}: {
  id: string;
  sandboxBinding: SandboxBinding;
  secrets?: Record<string, string | undefined>;
}) {
  let stub: ReturnType<typeof getSandbox> | undefined;
  // setEnvVars() boots the container, so defer it (via lazySandbox) to the first
  // shell/file op: a turn that never touches the sandbox doesn't spin one up. The
  // secrets are injected before that first op, so $GITHUB_TOKEN clones still
  // authenticate. (getSandbox() SandboxOptions does not accept envVars; injection
  // is via the stub method after the stub is created.)
  const sandbox = lazySandbox(
    () => {
      stub = getSandbox(sandboxBinding, id);
      return cloudflareSandbox(stub);
    },
    async () => {
      // Skip undefined secrets, and skip setEnvVars entirely when none remain — an
      // empty call would boot the container for nothing.
      const defined = Object.entries(secrets ?? {}).filter(([, value]) => value != null);
      if (defined.length > 0) await stub?.setEnvVars(Object.fromEntries(defined));
    },
    { cwd: "/", discoveryCwd: "/workspace" },
  );
  return { sandbox, cwd: "/workspace" };
}
