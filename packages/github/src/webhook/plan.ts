// Pure webhook decision logic for the GitHub channel. Kept separate from
// `channel/channel.ts` (which wires this into the Flue channel and dispatches) so the
// branching is unit-testable with Vitest, without loading the agent graph or its
// markdown imports. The outbound side (the comment tool + Octokit client) lives in
// `channel/comment.ts`.

import type { GitHubIssueRef, GitHubWebhookDelivery } from "@flue/github";

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

/** What `channel/channel.ts` should dispatch: the bound conversation + its turn. */
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
