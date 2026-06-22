import type { SandboxFactory, SessionEnv } from "@flue/runtime";

// Async methods of SessionEnv that touch the sandbox (shell + filesystem). The
// sync members (`cwd`, `resolvePath`) are pure and pass straight through.
const GATED_METHODS = [
  "exec",
  "readFile",
  "readFileBuffer",
  "writeFile",
  "stat",
  "readdir",
  "exists",
  "mkdir",
  "rm",
] as const satisfies readonly (keyof SessionEnv)[];

type AsyncMethod = (...args: unknown[]) => Promise<unknown>;

// Defers a sandbox's one-time, expensive setup — a container boot on Cloudflare,
// the scratch-dir mkdir on node — until the first shell/filesystem call. A turn
// that never touches the sandbox (a plain chat reply, a Slack message that isn't a
// review/test request) therefore never provisions it.
//
// `prepare` runs at most once, before the first delegated operation, so anything it
// sets up (e.g. injecting GITHUB_TOKEN into the container) is in place before that
// op runs. `cwd` and `resolvePath` are answered from the already-built inner env
// without triggering `prepare`, because the underlying adapters construct those
// without booting (just method closures + a known cwd).
export function lazySandbox(
  inner: SandboxFactory,
  prepare: (env: SessionEnv) => Promise<void>,
): SandboxFactory {
  return {
    tools: inner.tools,
    async createSessionEnv(options) {
      const env = await inner.createSessionEnv(options);
      let prepared: Promise<void> | undefined;
      const ready = () => (prepared ??= prepare(env));

      const gated: Record<string, AsyncMethod> = {};
      for (const name of GATED_METHODS) {
        const method = env[name] as AsyncMethod;
        gated[name] = async (...args) => {
          await ready();
          return method.apply(env, args);
        };
      }

      return {
        ...gated,
        cwd: env.cwd,
        resolvePath: (p: string) => env.resolvePath(p),
      } as SessionEnv;
    },
  };
}
