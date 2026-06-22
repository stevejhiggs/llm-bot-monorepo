import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("importing the GitHub webhook module does not start throttling timers", async () => {
  vi.resetModules();
  vi.stubGlobal("setInterval", (() => {
    throw new Error("setInterval called during module import");
  }) as typeof setInterval);

  await expect(import("./github-webhook.ts")).resolves.toHaveProperty("commentOnIssue");
});
