import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";
import { lazySandbox } from "./lazy-sandbox.ts";

type SandboxEnv = { Sandbox: Parameters<typeof getSandbox>[0] };

// Cloudflare-target sandbox: a per-instance container with git/node/shell at
// /workspace. GITHUB_TOKEN (a Worker secret) is injected into the container env
// so private clones authenticate via $GITHUB_TOKEN, matching local behavior.
export function createCloudflareSandbox({
  id,
  env,
}: {
  id: string;
  env: SandboxEnv & { GITHUB_TOKEN?: string };
}) {
  const stub = getSandbox(env.Sandbox, id);
  // setEnvVars() boots the container, so defer it (via lazySandbox) to the first
  // shell/file op: a turn that never touches the sandbox doesn't spin one up. The
  // token is injected before that first op, so $GITHUB_TOKEN clones still
  // authenticate. (getSandbox() SandboxOptions does not accept envVars; injection
  // is via the stub method after the stub is created.)
  const sandbox = lazySandbox(cloudflareSandbox(stub), async () => {
    if (env.GITHUB_TOKEN) await stub.setEnvVars({ GITHUB_TOKEN: env.GITHUB_TOKEN });
  });
  return { sandbox, cwd: "/workspace" };
}
