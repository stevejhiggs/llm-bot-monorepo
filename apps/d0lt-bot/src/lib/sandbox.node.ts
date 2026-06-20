import { mkdir } from "node:fs/promises";
import { local } from "@flue/runtime/node";
import { workDir } from "./github.ts";

// Node-target sandbox: real host shell in a per-instance scratch dir. GITHUB_TOKEN
// (when set) is exposed to the shell so private clones authenticate via
// $GITHUB_TOKEN without the secret entering the model's context.
export async function createNodeSandbox({ id }: { id: string }) {
  const cwd = workDir(id);
  await mkdir(cwd, { recursive: true });
  return {
    sandbox: local({ env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN } }),
    cwd,
  };
}
