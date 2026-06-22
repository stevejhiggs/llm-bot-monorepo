// Webhook decision logic and the outbound comment tool for the GitHub channel.
// Kept separate from `channels/github.ts` (which wires these into the channel and
// the agent) so the branching logic and the Octokit call are unit-testable with
// Vitest, without loading the agent graph or its markdown imports.

import { defineTool } from "@flue/runtime";
import type { GitHubIssueRef, GitHubWebhookDelivery } from "@flue/github";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import * as v from "valibot";

// Outbound API client. Authenticated by the same GITHUB_TOKEN used for cloning, so
// the bot comments as that account. Reused across tool instances.
const ThrottledOctokit = Octokit.plugin(throttling);

let client: Octokit | undefined;

export function getClient(): Octokit {
  return (client ??= new ThrottledOctokit({
    auth: process.env.GITHUB_TOKEN,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(`GitHub request quota exhausted for ${options.method} ${options.url}`);
        if (retryCount < 1) {
          octokit.log.info(`Retrying GitHub request after ${retryAfter} seconds`);
          return true;
        }
      },
      onSecondaryRateLimit: (_retryAfter, options, octokit) => {
        octokit.log.warn(`GitHub secondary rate limit for ${options.method} ${options.url}`);
      },
    },
  }));
}

/** Where the agent should point a subagent, plus a ready-to-use GitHub URL. */
export type DispatchTarget =
  | { kind: "pr"; owner: string; repo: string; number: number; url: string }
  | { kind: "repo"; owner: string; repo: string; url: string };

/** The JSON turn delivered to the d0lt-bot agent instance for a handled event. */
export interface DispatchInput {
  type: "github.issue_comment.created" | "github.pull_request.opened";
  deliveryId: string;
  target: DispatchTarget;
  instruction: string;
  sender: { login: string; type: string };
}

/** What `channels/github.ts` should dispatch: the bound conversation + its turn. */
export interface DispatchPlan {
  ref: GitHubIssueRef;
  input: DispatchInput;
}

function includesPhrase(body: string | undefined, phrase: string): boolean {
  return typeof body === "string" && body.toLowerCase().includes(phrase.toLowerCase());
}

/**
 * Decide what (if anything) a verified delivery should dispatch to d0lt-bot.
 * Returns `null` for every delivery the bot does not act on, so the channel
 * answers an empty `200`. Pure: no network, no dispatch, no channel coupling.
 *
 * Handled:
 * - `issue_comment.created` whose body contains `phrase`, from a non-bot sender —
 *   a PR comment routes to PR review/test runs; a plain-issue comment routes to a
 *   repo test run.
 * - `pull_request.opened` — an unprompted auto-review (bot-opened PRs included, so
 *   dependency-bump PRs get reviewed too).
 */
export function planDelivery(delivery: GitHubWebhookDelivery, phrase: string): DispatchPlan | null {
  if (delivery.name === "issue_comment" && delivery.payload.action === "created") {
    const p = delivery.payload;
    // Ignore the bot's own (and other bots') comments so a posted result can never
    // re-trigger the bot.
    if (p.sender?.type === "Bot") return null;
    if (!includesPhrase(p.comment.body, phrase)) return null;

    const owner = p.repository.owner.login;
    const repo = p.repository.name;
    const issueNumber = p.issue.number;
    // A PR is an issue; `issue.pull_request` is present only for pull requests.
    const target: DispatchTarget = p.issue.pull_request
      ? { kind: "pr", owner, repo, number: issueNumber, url: prUrl(owner, repo, issueNumber) }
      : { kind: "repo", owner, repo, url: repoUrl(owner, repo) };

    return {
      ref: { owner, repo, issueNumber },
      input: {
        type: "github.issue_comment.created",
        deliveryId: delivery.deliveryId,
        target,
        instruction: p.comment.body,
        sender: { login: p.sender.login, type: p.sender.type },
      },
    };
  }

  if (delivery.name === "pull_request" && delivery.payload.action === "opened") {
    const p = delivery.payload;
    const owner = p.repository.owner.login;
    const repo = p.repository.name;
    const number = p.pull_request.number;

    return {
      ref: { owner, repo, issueNumber: number },
      input: {
        type: "github.pull_request.opened",
        deliveryId: delivery.deliveryId,
        target: { kind: "pr", owner, repo, number, url: prUrl(owner, repo, number) },
        instruction: "Review this pull request.",
        sender: { login: p.sender.login, type: p.sender.type },
      },
    };
  }

  return null;
}

function prUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}

function repoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

/**
 * The agent's one outbound capability: comment on the issue or PR bound to this
 * conversation. The destination is fixed at bind time from the verified webhook —
 * the model supplies only the body, never the owner/repo/number — so it cannot be
 * steered to post elsewhere. `octokit` is injectable for tests.
 */
export function commentOnIssue(ref: GitHubIssueRef, octokit?: Octokit) {
  return defineTool({
    name: "comment_on_github_issue",
    description:
      "Comment on the GitHub issue or pull request bound to this conversation. Use this to post " +
      "your final result (the review or the test outcome) back to GitHub. Supply only the comment " +
      "body; the target issue/PR is fixed.",
    parameters: v.object({
      body: v.pipe(
        v.string(),
        v.minLength(1),
        v.description("The Markdown comment body to post. Must be non-empty."),
      ),
    }),
    async execute({ body }) {
      const github = octokit ?? getClient();
      const result = await github.rest.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        body,
      });
      return JSON.stringify({ commentId: result.data.id, url: result.data.html_url });
    },
  });
}
