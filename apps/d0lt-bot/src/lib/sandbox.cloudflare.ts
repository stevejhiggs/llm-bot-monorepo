import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";

type SandboxEnv = { Sandbox: Parameters<typeof getSandbox>[0] };

// Cloudflare-target sandbox: a per-instance container with git/node/shell at
// /workspace. GITHUB_TOKEN (a Worker secret) is injected into the container env
// so private clones authenticate via $GITHUB_TOKEN, matching local behavior.
export async function createCloudflareSandbox({
  id,
  env,
}: {
  id: string;
  env: SandboxEnv & { GITHUB_TOKEN?: string };
}) {
  const stub = getSandbox(env.Sandbox, id);
  // Inject GITHUB_TOKEN into the container environment via setEnvVars().
  // getSandbox() SandboxOptions does not accept envVars; injection is via the
  // stub method after the stub is created.
  if (env.GITHUB_TOKEN) {
    await stub.setEnvVars({ GITHUB_TOKEN: env.GITHUB_TOKEN });
  }
  return { sandbox: cloudflareSandbox(stub), cwd: "/workspace" };
}
