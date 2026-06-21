export type SandboxKind = "local" | "cloudflare";

// Selects the sandbox implementation at runtime. `FLUE_SANDBOX` is an explicit
// override ("cloudflare" / "local"); when it's unset or unrecognized we infer from
// the runtime. This matters because the node local() sandbox shells out via
// child_process, which workerd does not implement — so a deployed Worker that
// forgot to set FLUE_SANDBOX must still pick the container sandbox, not fall back
// to a node shell that throws on the first command. workerd self-identifies via
// `navigator.userAgent === "Cloudflare-Workers"`; `isWorkerd` is injectable for tests.
export function resolveSandboxKind(
  env: Record<string, string | undefined>,
  isWorkerd: boolean = globalThis.navigator?.userAgent === "Cloudflare-Workers",
): SandboxKind {
  if (env.FLUE_SANDBOX === "cloudflare") return "cloudflare";
  if (env.FLUE_SANDBOX === "local") return "local";
  return isWorkerd ? "cloudflare" : "local";
}
