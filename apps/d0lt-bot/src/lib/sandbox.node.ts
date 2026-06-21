import { mkdir } from "node:fs/promises";
import { local } from "@flue/runtime/node";
import { lazySandbox } from "./lazy-sandbox.ts";
import { workDir } from "./github.ts";

// Node-target sandbox: real host shell in a per-instance scratch dir. GITHUB_TOKEN
// (when set) is exposed to the shell so private clones authenticate via
// $GITHUB_TOKEN without the secret entering the model's context. The scratch-dir
// mkdir is deferred (via lazySandbox) to the first shell/file op, so a turn that
// never touches the sandbox doesn't create one.
export function createNodeSandbox({ id }: { id: string }) {
  const cwd = workDir(id);
  const sandbox = lazySandbox(
    local({ env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN } }),
    async () => {
      await mkdir(cwd, { recursive: true });
    },
  );
  return { sandbox, cwd };
}
