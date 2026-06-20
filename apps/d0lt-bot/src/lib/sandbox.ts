export type SandboxKind = "local" | "cloudflare";

// Selects the sandbox implementation at runtime. Local dev (env unset) keeps the
// node local() sandbox; the Cloudflare build sets FLUE_SANDBOX=cloudflare.
export function resolveSandboxKind(
  env: Record<string, string | undefined>,
): SandboxKind {
  return env.FLUE_SANDBOX === "cloudflare" ? "cloudflare" : "local";
}
