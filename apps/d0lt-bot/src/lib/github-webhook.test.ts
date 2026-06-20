import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { GitHubWebhookDelivery } from "@flue/github";
import { Octokit } from "@octokit/rest";
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

void test("PR comment with the trigger phrase plans a PR review dispatch", () => {
  const plan = planDelivery(issueComment({ isPr: true, number: 7 }), PHRASE);
  assert.ok(plan);
  assert.deepEqual(plan.ref, { owner: "owner", repo: "repo", issueNumber: 7 });
  assert.equal(plan.input.type, "github.issue_comment.created");
  assert.equal(plan.input.deliveryId, "delivery-1");
  assert.equal(plan.input.target.kind, "pr");
  assert.equal(plan.input.target.url, "https://github.com/owner/repo/pull/7");
  assert.equal(plan.input.instruction, `${PHRASE} review this`);
});

void test("plain-issue comment with the trigger phrase plans a repo dispatch", () => {
  const plan = planDelivery(issueComment({ isPr: false, number: 9 }), PHRASE);
  assert.ok(plan);
  assert.deepEqual(plan.ref, { owner: "owner", repo: "repo", issueNumber: 9 });
  assert.equal(plan.input.target.kind, "repo");
  assert.equal(plan.input.target.url, "https://github.com/owner/repo");
});

void test("pull_request.opened plans an auto-review dispatch", () => {
  const plan = planDelivery(pullRequestOpened({ number: 42 }), PHRASE);
  assert.ok(plan);
  assert.deepEqual(plan.ref, { owner: "owner", repo: "repo", issueNumber: 42 });
  assert.equal(plan.input.type, "github.pull_request.opened");
  assert.equal(plan.input.target.kind, "pr");
  assert.equal(plan.input.target.url, "https://github.com/owner/repo/pull/42");
  assert.match(plan.input.instruction, /review/i);
});

void test("comment without the trigger phrase is ignored", () => {
  assert.equal(planDelivery(issueComment({ body: "looks good to me" }), PHRASE), null);
});

void test("comment from a bot account is ignored (loop prevention)", () => {
  assert.equal(planDelivery(issueComment({ senderType: "Bot" }), PHRASE), null);
});

void test("non-created comment actions are ignored", () => {
  assert.equal(planDelivery(issueComment({ action: "edited" }), PHRASE), null);
});

void test("non-opened pull_request actions are ignored", () => {
  assert.equal(planDelivery(pullRequestOpened({ action: "synchronize" }), PHRASE), null);
});

void test("unhandled events are ignored", () => {
  const delivery = {
    name: "push",
    deliveryId: "d",
    payload: {},
  } as unknown as GitHubWebhookDelivery;
  assert.equal(planDelivery(delivery, PHRASE), null);
});

void test("trigger-phrase match is case-insensitive", () => {
  const plan = planDelivery(issueComment({ isPr: true, body: "@D0LT-BOT please review" }), PHRASE);
  assert.ok(plan);
});

void test("commentOnIssue posts to the bound issue and returns the comment id and url", async () => {
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

  assert.equal(result.commentId, 999);
  assert.equal(result.url, "https://github.com/owner/repo/issues/7#issuecomment-999");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/repos\/owner\/repo\/issues\/7\/comments$/);
  assert.deepEqual(calls[0].body, { body: "Looks good." });
});
