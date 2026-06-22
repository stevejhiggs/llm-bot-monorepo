// The GitHub channel's one outbound capability: the throttled Octokit client and the
// `comment_on_github_issue` tool bound to a single issue/PR. Split from the inbound
// webhook planning in `webhook/plan.ts` so the network-touching code lives next to the
// channel that uses it; both halves stay unit-testable with an injected fake client.

import { defineTool } from "@flue/runtime";
import type { GitHubIssueRef } from "@flue/github";
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
