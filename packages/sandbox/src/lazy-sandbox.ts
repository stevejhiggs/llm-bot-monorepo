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
type LazyInner = SandboxFactory | (() => SandboxFactory);

interface LazySandboxOptions {
  cwd: string;
  discoveryCwd?: string;
}

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
  inner: LazyInner,
  prepare: (env: SessionEnv) => Promise<void>,
  options: LazySandboxOptions,
): SandboxFactory {
  let innerFactory: SandboxFactory | undefined;
  const getInner = () => (innerFactory ??= typeof inner === "function" ? inner() : inner);

  return {
    tools: typeof inner === "function" ? undefined : inner.tools,
    async createSessionEnv(sessionOptions) {
      let env: SessionEnv | undefined;
      let envPromise: Promise<SessionEnv> | undefined;
      let prepared: Promise<SessionEnv> | undefined;

      const loadEnv = () =>
        env ? Promise.resolve(env) : (envPromise ??= getInner().createSessionEnv(sessionOptions));
      const ready = () =>
        (prepared ??= loadEnv().then(async (loaded) => {
          env = loaded;
          await prepare(loaded);
          return loaded;
        }));

      const gated: Record<string, AsyncMethod> = {};
      for (const name of GATED_METHODS) {
        gated[name] = async (...args) => {
          const lightweightResult =
            !env && !envPromise ? lightweightDiscoveryResult(name, args, options) : undefined;
          if (lightweightResult !== undefined) return lightweightResult;

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

function lightweightDiscoveryResult(
  name: keyof SessionEnv,
  args: unknown[],
  options: LazySandboxOptions,
): Promise<unknown> | undefined {
  if (!options.discoveryCwd || typeof args[0] !== "string") return undefined;

  const path = normalizePath(args[0]);
  const discoveryCwd = normalizePath(options.discoveryCwd);

  if (name === "exists" && isDiscoveryProbe(path, discoveryCwd)) {
    return Promise.resolve(false);
  }
  if (name === "readdir" && path === discoveryCwd) {
    return Promise.resolve([]);
  }

  return undefined;
}

function isDiscoveryProbe(path: string, discoveryCwd: string): boolean {
  return (
    path === joinPath(discoveryCwd, "AGENTS.md") ||
    path === joinPath(discoveryCwd, "CLAUDE.md") ||
    path === joinPath(discoveryCwd, ".agents/skills")
  );
}

function makeResolvePath(cwd: string) {
  return (path: string) => {
    if (path.startsWith("/")) return normalizePath(path);
    return normalizePath(cwd === "/" ? `/${path}` : `${cwd}/${path}`);
  };
}

function joinPath(base: string, path: string): string {
  return normalizePath(base === "/" ? `/${path}` : `${base}/${path}`);
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
