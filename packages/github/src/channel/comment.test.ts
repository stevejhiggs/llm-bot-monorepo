import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { afterEach, expect, test, vi } from "vitest";
import { commentOnIssue, getClient } from "./comment.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("importing the comment module does not start throttling timers", async () => {
  vi.resetModules();
  vi.stubGlobal("setInterval", (() => {
    throw new Error("setInterval called during module import");
  }) as typeof setInterval);

  await expect(import("./comment.ts")).resolves.toHaveProperty("commentOnIssue");
});

test("shared GitHub client is created with throttling enabled", () => {
  const client = getClient();
  const plugins = (client.constructor as typeof Octokit & { plugins?: unknown[] }).plugins ?? [];
  expect(plugins).toContain(throttling);
});

test("commentOnIssue posts to the bound issue and returns the comment id and url", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(
      JSON.stringify({
        id: 999,
        html_url: "https://github.com/owner/repo/issues/7#issuecomment-999",
      }),
      {
        status: 201,
        headers: { "content-type": "application/json" },
      },
    );
  };
  const octokit = new Octokit({ auth: "test-token", request: { fetch: fakeFetch } });

  const tool = commentOnIssue({ owner: "owner", repo: "repo", issueNumber: 7 }, octokit);
  const result = JSON.parse(await tool.execute({ body: "Looks good." }));

  expect(result.commentId).toBe(999);
  expect(result.url).toBe("https://github.com/owner/repo/issues/7#issuecomment-999");
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe("POST");
  expect(calls[0].url).toMatch(/\/repos\/owner\/repo\/issues\/7\/comments$/);
  expect(calls[0].body).toEqual({ body: "Looks good." });
});
