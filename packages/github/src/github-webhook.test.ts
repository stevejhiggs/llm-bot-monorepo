import type { GitHubWebhookDelivery } from "@flue/github";
import { Octokit } from "@octokit/rest";
import { expect, test } from "vitest";
import { commentOnIssue, planDelivery } from "./github-webhook.ts";

const PHRASE = "@d0lt-bot";

// Minimal delivery builders. We only populate the fields planDelivery reads, then
// cast to the provider type — the real payloads carry far more we don't touch.
function issueComment(opts: {
  action?: string;
  body?: string;
  isPr?: boolean;
  senderType?: string;
  number?: number;
}): GitHubWebhookDelivery {
  return {
    name: "issue_comment",
    deliveryId: "delivery-1",
    payload: {
      action: opts.action ?? "created",
      repository: { name: "repo", owner: { login: "owner" } },
      issue: {
        number: opts.number ?? 7,
        ...(opts.isPr ? { pull_request: { url: "https://api.github.com/pulls/7" } } : {}),
      },
      comment: { id: 100, body: opts.body ?? `${PHRASE} review this` },
      sender: { login: "alice", type: opts.senderType ?? "User" },
    },
  } as unknown as GitHubWebhookDelivery;
}

function pullRequestOpened(opts: { action?: string; number?: number } = {}): GitHubWebhookDelivery {
  return {
    name: "pull_request",
    deliveryId: "delivery-2",
    payload: {
      action: opts.action ?? "opened",
      repository: { name: "repo", owner: { login: "owner" } },
      pull_request: { number: opts.number ?? 42 },
      sender: { login: "bob", type: "User" },
    },
  } as unknown as GitHubWebhookDelivery;
}

test("PR comment with the trigger phrase plans a PR review dispatch", () => {
  const plan = planDelivery(issueComment({ isPr: true, number: 7 }), PHRASE);
  expect(plan).not.toBeNull();
  expect(plan?.ref).toEqual({ owner: "owner", repo: "repo", issueNumber: 7 });
  expect(plan?.input.type).toBe("github.issue_comment.created");
  expect(plan?.input.deliveryId).toBe("delivery-1");
  expect(plan?.input.target.kind).toBe("pr");
  expect(plan?.input.target.url).toBe("https://github.com/owner/repo/pull/7");
  expect(plan?.input.instruction).toBe(`${PHRASE} review this`);
});

test("plain-issue comment with the trigger phrase plans a repo dispatch", () => {
  const plan = planDelivery(issueComment({ isPr: false, number: 9 }), PHRASE);
  expect(plan).not.toBeNull();
  expect(plan?.ref).toEqual({ owner: "owner", repo: "repo", issueNumber: 9 });
  expect(plan?.input.target.kind).toBe("repo");
  expect(plan?.input.target.url).toBe("https://github.com/owner/repo");
});

test("pull_request.opened plans an auto-review dispatch", () => {
  const plan = planDelivery(pullRequestOpened({ number: 42 }), PHRASE);
  expect(plan).not.toBeNull();
  expect(plan?.ref).toEqual({ owner: "owner", repo: "repo", issueNumber: 42 });
  expect(plan?.input.type).toBe("github.pull_request.opened");
  expect(plan?.input.target.kind).toBe("pr");
  expect(plan?.input.target.url).toBe("https://github.com/owner/repo/pull/42");
  expect(plan?.input.instruction).toMatch(/review/i);
});

test("comment without the trigger phrase is ignored", () => {
  expect(planDelivery(issueComment({ body: "looks good to me" }), PHRASE)).toBeNull();
});

test("comment from a bot account is ignored (loop prevention)", () => {
  expect(planDelivery(issueComment({ senderType: "Bot" }), PHRASE)).toBeNull();
});

test("non-created comment actions are ignored", () => {
  expect(planDelivery(issueComment({ action: "edited" }), PHRASE)).toBeNull();
});

test("non-opened pull_request actions are ignored", () => {
  expect(planDelivery(pullRequestOpened({ action: "synchronize" }), PHRASE)).toBeNull();
});

test("unhandled events are ignored", () => {
  const delivery = {
    name: "push",
    deliveryId: "d",
    payload: {},
  } as unknown as GitHubWebhookDelivery;
  expect(planDelivery(delivery, PHRASE)).toBeNull();
});

test("trigger-phrase match is case-insensitive", () => {
  const plan = planDelivery(issueComment({ isPr: true, body: "@D0LT-BOT please review" }), PHRASE);
  expect(plan).not.toBeNull();
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
