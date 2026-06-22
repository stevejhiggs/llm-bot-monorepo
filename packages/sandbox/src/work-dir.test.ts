import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { workDir } from "./work-dir.ts";

test("namespaces the run dir under <tmpdir>/<appName>/<runId>", () => {
  expect(workDir("d0lt-bot", "01ARZ3NDEKTSV4")).toBe(`${tmpdir()}/d0lt-bot/01ARZ3NDEKTSV4`);
});

test("two app names never share a scratch namespace", () => {
  const a = workDir("bot-a", "run1");
  const b = workDir("bot-b", "run1");
  expect(a).not.toBe(b);
  expect(a).toBe(`${tmpdir()}/bot-a/run1`);
  expect(b).toBe(`${tmpdir()}/bot-b/run1`);
});

test("strips path/shell metacharacters from both segments", () => {
  expect(workDir("my bot!", "a/b;c")).toBe(`${tmpdir()}/mybot/abc`);
});

test("falls back when a segment sanitizes to empty", () => {
  expect(workDir("", "")).toBe(`${tmpdir()}/app/run`);
});
