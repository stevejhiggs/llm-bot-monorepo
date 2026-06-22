import { expect, test } from "vitest";
import { resolveSandboxKind } from "./sandbox.ts";

test("explicit FLUE_SANDBOX=cloudflare selects cloudflare", () => {
  // Explicit wins regardless of runtime.
  expect(resolveSandboxKind({ FLUE_SANDBOX: "cloudflare" }, false)).toBe("cloudflare");
});

test("explicit FLUE_SANDBOX=local selects local even on workerd", () => {
  // An explicit override beats runtime inference.
  expect(resolveSandboxKind({ FLUE_SANDBOX: "local" }, true)).toBe("local");
});

test("unset on workerd infers cloudflare", () => {
  // The foot-gun guard: a deployed Worker that forgot FLUE_SANDBOX still gets the
  // container sandbox instead of the node shell (which can't spawn on workerd).
  expect(resolveSandboxKind({}, true)).toBe("cloudflare");
});

test("unset off workerd (node dev) infers local", () => {
  expect(resolveSandboxKind({}, false)).toBe("local");
});

test("an unrecognized value falls back to runtime inference", () => {
  expect(resolveSandboxKind({ FLUE_SANDBOX: "node" }, true)).toBe("cloudflare");
  expect(resolveSandboxKind({ FLUE_SANDBOX: "node" }, false)).toBe("local");
});
