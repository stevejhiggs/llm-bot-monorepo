# GitHub channel integration for d0lt-bot

Date: 2026-06-20
Status: approved

## Goal

Close the gap the README calls out — "Posting results back to GitHub is not wired
up." Add verified GitHub webhook ingress so d0lt-bot reacts to GitHub activity and
posts its results back as PR/issue comments, following the Flue GitHub channel
blueprint (`flue add channel github`, `channel/github@1`).

## Trigger model (decided)

- **Mention on a comment.** React to `issue_comment.created` whose body contains a
  configured trigger phrase (`GITHUB_TRIGGER_PHRASE`, default `@d0lt-bot`).
  - On a **pull request** (`issue.pull_request` present) → route to the
    `reviewer` or `test_runner` subagent based on the comment's intent.
  - On a **plain issue** → route to `test_runner` for the issue's repository.
- **Auto-review new PRs.** React to `pull_request.opened` (no trigger phrase
  needed) → `reviewer`, post the review back.
- Ignore everything else (empty `200`). Ignore comments authored by bot accounts
  (`sender.type === 'Bot'`) to prevent comment loops.

## Architecture (Approach A — reuse the existing router agent)

The webhook dispatches to the **existing `d0lt-bot` agent**, which already owns the
sandbox and the `reviewer` / `test_runner` subagents. No second agent.

```
GitHub ──webhook──▶ POST /channels/github/webhook  (HMAC-verified by @flue/github)
                         │  branch on delivery.name + action + trigger phrase
                         │  dispatch(d0ltBot, { id: conversationKey(ref), input })
                         ▼
                    d0lt-bot agent instance (one per PR/issue, keyed by conversationKey)
                         │  reads the GitHub event JSON turn
                         │  routes to reviewer / test_runner (as today)
                         ▼  posts the final result back
                    comment_on_github_issue tool ──Octokit──▶ GitHub comment
```

Why reuse: smallest change, reuses the router/subagent + sandbox wiring already in
place, and matches the blueprint's "bind the destination inside the initializer"
pattern. A channel→agent import cycle is supported because the bindings are read
only inside deferred callbacks/initializers.

## Components

### `src/channels/github.ts` (new)
- `export const client = new Octokit({ auth: process.env.GITHUB_TOKEN })`.
- `export const channel = createGitHubChannel({ webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!, async webhook({ delivery }) { ... } })`.
- Handler branches (in order), each ending the turn:
  1. `delivery.name === 'issue_comment' && action === 'created'`, sender not a bot,
     body contains the trigger phrase:
     - PR (`issue.pull_request`): dispatch with
       `target: { kind: 'pr', url: <pull-url>, owner, repo, number }`.
     - plain issue: dispatch with
       `target: { kind: 'repo', url: <repo-url>, owner, repo }`.
  2. `delivery.name === 'pull_request' && action === 'opened'`: dispatch with
     `target: { kind: 'pr', url, owner, repo, number }` and a synthesized
     instruction `"Review this pull request."`.
- Dispatch shape:
  ```ts
  await dispatch(d0ltBot, {
    id: channel.conversationKey({ owner, repo, issueNumber }),
    input: {
      type,                 // e.g. 'github.issue_comment.created' | 'github.pull_request.opened'
      deliveryId,
      target,               // { kind, url, owner, repo, number? } — url is ready to hand to a subagent
      instruction,          // comment.body, or the synthesized auto-review instruction
      sender: { login, type },
    },
  });
  ```
- `export function commentOnIssue(ref)` — `defineTool` named `comment_on_github_issue`
  that calls `client.rest.issues.createComment(...)` and returns
  `{ commentId, url }`. Bound to the conversation's `ref` (never model-chosen).
- Trigger phrase helper reads `process.env.GITHUB_TRIGGER_PHRASE ?? '@d0lt-bot'`.

### `src/agents/d0lt-bot.ts` (edit)
In the initializer, attempt `channel.parseConversationKey(id)`:
- success → append `commentOnIssue(ref)` to `tools` (GitHub-triggered instance).
- throws (`InvalidGitHubConversationKeyError`, e.g. chat id `local`) → no tool
  added; chat behavior unchanged.

### `src/agents/d0lt-bot.md` (edit)
Add a "When invoked from GitHub" section: the turn is a GitHub event JSON; use
`target.url` + `instruction`; route to the right subagent exactly as for chat;
plain-issue events are test runs (no diff to review); **post the final result by
calling `comment_on_github_issue`** rather than only narrating.

### Config / secrets (edit)
- `.env.example`, `.dev.vars`: add `GITHUB_WEBHOOK_SECRET` (required for ingress)
  and `GITHUB_TRIGGER_PHRASE` (optional).
- `README.md`: document the webhook URL (`/channels/github/webhook`), content type
  `application/json`, the event subscriptions (Issue comments, Pull requests), and
  `wrangler secret put GITHUB_WEBHOOK_SECRET`. Note `nodejs_compat` already lets
  Octokit run on Cloudflare.

### Dependencies
`@flue/github` and `@octokit/rest@^22.0.1`.

## Testing (`src/channels/github.test.ts`)

Drive the channel's `POST /webhook` handler with crafted requests; no network.
- Valid `X-Hub-Signature-256` HMAC for `issue_comment` (PR) → dispatches with the
  PR conversation key and `target.kind === 'pr'` + correct PR url.
- Valid HMAC `issue_comment` on a plain issue → `target.kind === 'repo'`.
- Valid HMAC `pull_request.opened` → dispatches an auto-review.
- Invalid signature → rejected, no dispatch.
- Bot sender, and comment without the trigger phrase → no dispatch.
- One `commentOnIssue` Octokit call through a fake fetch transport returns the
  comment id/url.

Run the project's `typecheck` and the Flue build for both targets after.

## Out of scope (YAGNI)

- Inline `pull_request_review_comment` thread replies — d0lt-bot does whole-PR
  review / test runs, not targeted inline Q&A.
- GitHub App installation auth — a single `GITHUB_TOKEN` is sufficient.
- Persistent `deliveryId` dedup — GitHub does not auto-retry and same-PR dispatches
  already serialize on one agent instance. Documented as a known limitation; the
  `deliveryId` is threaded through the input so dedup can be added later.
