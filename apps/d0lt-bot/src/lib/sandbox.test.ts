import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveSandboxKind } from "./sandbox.ts";

void test("defaults to local when FLUE_SANDBOX is unset", () => {
  assert.equal(resolveSandboxKind({}), "local");
});

void test("selects cloudflare when FLUE_SANDBOX=cloudflare", () => {
  assert.equal(resolveSandboxKind({ FLUE_SANDBOX: "cloudflare" }), "cloudflare");
});

void test("any other value falls back to local", () => {
  assert.equal(resolveSandboxKind({ FLUE_SANDBOX: "node" }), "local");
});
