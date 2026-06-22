import { mkdir } from "node:fs/promises";
import { local } from "@flue/runtime/node";
import { lazySandbox } from "./lazy-sandbox.ts";
import { workDir } from "./work-dir.ts";

// Node-target sandbox: real host shell in a per-instance scratch dir namespaced by
// `appName` (so two bots on one host never share scratch space). `secrets` (when
// provided) is exposed to the shell so e.g. private clones authenticate via
// $GITHUB_TOKEN without the secret entering the model's context. The scratch-dir
// mkdir is deferred (via lazySandbox) to the first shell/file op, so a turn that
// never touches the sandbox doesn't create one.
export function createNodeSandbox({
  id,
  appName,
  secrets,
}: {
  id: string;
  appName: string;
  secrets?: Record<string, string | undefined>;
}) {
  const cwd = workDir(appName, id);
  const sandbox = lazySandbox(local({ env: secrets ?? {} }), async () => {
    await mkdir(cwd, { recursive: true });
  });
  return { sandbox, cwd };
}
