import type { SandboxFactory, SessionEnv } from "@flue/runtime";

// Async methods of SessionEnv that touch the sandbox (shell + filesystem). The
// sync members (`cwd`, `resolvePath`) are served from a configured base cwd so
// they can answer without constructing the inner env.
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

// Defers a sandbox's inner env construction and one-time expensive setup — a
// container boot on Cloudflare, the scratch-dir mkdir on node — until the first
// shell/filesystem call. A turn that never touches the sandbox (a plain chat
// reply, a Slack message that isn't a review/test request) therefore never
// provisions it.
//
// `prepare` runs at most once, before the first delegated operation, so anything it
// sets up (e.g. injecting GITHUB_TOKEN into the container) is in place before that
// op runs. `cwd` and `resolvePath` are answered from `options.cwd`, without
// calling the wrapped factory.
export function lazySandbox(
  inner: SandboxFactory,
  prepare: (env: SessionEnv) => Promise<void>,
  options: { cwd: string },
): SandboxFactory {
  return {
    tools: inner.tools,
    async createSessionEnv(sessionOptions) {
      let env: SessionEnv | undefined;
      let envPromise: Promise<SessionEnv> | undefined;
      let prepared: Promise<SessionEnv> | undefined;

      const loadEnv = () =>
        env ? Promise.resolve(env) : (envPromise ??= inner.createSessionEnv(sessionOptions));
      const ready = () =>
        (prepared ??= loadEnv().then(async (loaded) => {
          env = loaded;
          await prepare(loaded);
          return loaded;
        }));

      const gated: Record<string, AsyncMethod> = {};
      for (const name of GATED_METHODS) {
        gated[name] = async (...args) => {
          const loaded = await ready();
          const method = loaded[name] as AsyncMethod;
          return method.apply(loaded, args);
        };
      }

      return {
        ...gated,
        cwd: options.cwd,
        resolvePath: makeResolvePath(options.cwd),
      } as SessionEnv;
    },
  };
}

function makeResolvePath(cwd: string) {
  return (path: string) => {
    if (path.startsWith("/")) return normalizePath(path);
    return normalizePath(cwd === "/" ? `/${path}` : `${cwd}/${path}`);
  };
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
