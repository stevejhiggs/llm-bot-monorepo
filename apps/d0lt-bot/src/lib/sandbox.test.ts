import { expect, test } from "vitest";
import { resolveSandboxKind } from "./sandbox.ts";

test("defaults to local when FLUE_SANDBOX is unset", () => {
  expect(resolveSandboxKind({})).toBe("local");
});

test("selects cloudflare when FLUE_SANDBOX=cloudflare", () => {
  expect(resolveSandboxKind({ FLUE_SANDBOX: "cloudflare" })).toBe("cloudflare");
});

test("any other value falls back to local", () => {
  expect(resolveSandboxKind({ FLUE_SANDBOX: "node" })).toBe("local");
});
