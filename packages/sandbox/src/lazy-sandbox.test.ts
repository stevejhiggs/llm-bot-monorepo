import { expect, test, vi } from "vitest";
import type { SandboxFactory, SessionEnv } from "@flue/runtime";
import { lazySandbox } from "./lazy-sandbox.ts";

// A fake SessionEnv that records the order of method calls into `log` and returns
// canned values. Stands in for a real adapter env (node local() / CF container).
function fakeEnv(log: string[] = []): SessionEnv {
  const record = <T>(name: string, value: T) => {
    log.push(name);
    return Promise.resolve(value);
  };
  return {
    cwd: "/workspace",
    resolvePath: (p) => (p.startsWith("/") ? p : `/workspace/${p}`),
    exec: () => record("exec", { stdout: "ok", stderr: "", exitCode: 0 }),
    readFile: () => record("readFile", "contents"),
    readFileBuffer: () => record("readFileBuffer", new Uint8Array()),
    writeFile: () => record("writeFile", undefined),
    stat: () =>
      record("stat", {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        size: 0,
        mtime: new Date(0),
      }),
    readdir: () => record("readdir", []),
    exists: () => record("exists", true),
    mkdir: () => record("mkdir", undefined),
    rm: () => record("rm", undefined),
  } as SessionEnv;
}

function innerFactory(env: SessionEnv, tools?: SandboxFactory["tools"]): SandboxFactory {
  return { createSessionEnv: () => Promise.resolve(env), tools };
}

test("does not create the inner env until an operation is performed", async () => {
  const createSessionEnv = vi.fn(() => Promise.resolve(fakeEnv()));
  const factory = lazySandbox({ createSessionEnv }, async () => {}, { cwd: "/workspace" });

  await factory.createSessionEnv({ id: "abc" });

  expect(createSessionEnv).not.toHaveBeenCalled();
});

test("does not run prepare until an operation is performed", async () => {
  const prepare = vi.fn(async () => {});
  const factory = lazySandbox(innerFactory(fakeEnv()), prepare, { cwd: "/workspace" });

  await factory.createSessionEnv({ id: "abc" });

  // Building the env must not boot the sandbox — a chat turn that never shells out
  // should never pay for it.
  expect(prepare).not.toHaveBeenCalled();
});

test("cwd and resolvePath answer without triggering prepare", async () => {
  const prepare = vi.fn(async () => {});
  const createSessionEnv = vi.fn(() => Promise.resolve(fakeEnv()));
  const env = await lazySandbox({ createSessionEnv }, prepare, {
    cwd: "/workspace",
  }).createSessionEnv({ id: "abc" });

  expect(env.cwd).toBe("/workspace");
  expect(env.resolvePath("repo")).toBe("/workspace/repo");
  expect(prepare).not.toHaveBeenCalled();
  expect(createSessionEnv).not.toHaveBeenCalled();
});

test("answers Flue workspace discovery probes without creating the inner env", async () => {
  const prepare = vi.fn(async () => {});
  const createSessionEnv = vi.fn(() => Promise.resolve(fakeEnv()));
  const env = await lazySandbox({ createSessionEnv }, prepare, {
    cwd: "/",
    discoveryCwd: "/workspace",
  }).createSessionEnv({ id: "abc" });

  await expect(env.exists("/workspace/AGENTS.md")).resolves.toBe(false);
  await expect(env.exists("/workspace/CLAUDE.md")).resolves.toBe(false);
  await expect(env.exists("/workspace/.agents/skills")).resolves.toBe(false);
  await expect(env.readdir("/workspace")).resolves.toEqual([]);

  expect(prepare).not.toHaveBeenCalled();
  expect(createSessionEnv).not.toHaveBeenCalled();
});

test("delegates real filesystem checks after lightweight discovery", async () => {
  const log: string[] = [];
  const prepare = vi.fn(async () => {
    log.push("prepare");
  });
  const env = await lazySandbox(innerFactory(fakeEnv(log)), prepare, {
    cwd: "/",
    discoveryCwd: "/workspace",
  }).createSessionEnv({ id: "abc" });

  await env.exists("/workspace/AGENTS.md");
  const result = await env.exists("/workspace/package.json");

  expect(result).toBe(true);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(log).toEqual(["prepare", "exists"]);
});

test("can defer inner factory construction until a real operation", async () => {
  const log: string[] = [];
  const createInner = vi.fn(() => innerFactory(fakeEnv(log)));
  const env = await lazySandbox(
    createInner,
    async () => {
      log.push("prepare");
    },
    {
      cwd: "/",
      discoveryCwd: "/workspace",
    },
  ).createSessionEnv({ id: "abc" });

  await env.exists("/workspace/AGENTS.md");
  expect(createInner).not.toHaveBeenCalled();

  await env.exec("echo hi");
  expect(createInner).toHaveBeenCalledTimes(1);
  expect(log).toEqual(["prepare", "exec"]);
});

test("runs prepare exactly once, before the first delegated operation", async () => {
  const log: string[] = [];
  const prepare = vi.fn(async () => {
    log.push("prepare");
  });
  const env = await lazySandbox(innerFactory(fakeEnv(log)), prepare, {
    cwd: "/workspace",
  }).createSessionEnv({ id: "abc" });

  const result = await env["exec"]("echo hi");
  await env.readFile("/etc/hosts");
  await env.writeFile("/tmp/x", "y");

  // Prepared once, and the very first thing that ran was prepare (so e.g. a token
  // is injected before the first clone command).
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(log).toEqual(["prepare", "exec", "readFile", "writeFile"]);
  // The operation result is the inner env's result, passed through untouched.
  expect(result).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
});

test("preserves the inner factory's tools", () => {
  const tools = (() => []) as SandboxFactory["tools"];
  expect(
    lazySandbox(innerFactory(fakeEnv(), tools), async () => {}, { cwd: "/workspace" }).tools,
  ).toBe(tools);
});
