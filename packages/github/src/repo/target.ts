// Pure GitHub URL/ref parsing and shell-safe clone-script assembly.
// No sandbox or network access — values are validated here so they are safe
// to interpolate into a shell command before being handed off to the caller.

// Restrict owner/repo to GitHub's allowed characters so the values are always
// safe to interpolate into a shell command (no shell metacharacters possible).
const PR_URL =
  /^https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/pull\/(\d+)(?:[/?#].*)?$/;
const REPO_URL =
  /^https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/tree\/([^/?#]+))?\/?(?:[?#].*)?$/;

export type GitHubTarget =
  | { kind: "pr"; owner: string; repo: string; number: number }
  | { kind: "repo"; owner: string; repo: string; ref?: string };

/**
 * Parse a GitHub repo URL or PR URL into a target. A PR URL resolves to the PR
 * head; a repo URL resolves to the repo (optionally a `/tree/<ref>` or an
 * explicit `refOverride`). Throws on anything that is not a github.com URL.
 */
export function parseGitHubTarget(url: string, refOverride?: string): GitHubTarget {
  const trimmed = url.trim();
  const pr = PR_URL.exec(trimmed);
  if (pr) {
    const [, owner, repo, number] = pr;
    return { kind: "pr", owner, repo, number: Number(number) };
  }
  const repoMatch = REPO_URL.exec(trimmed);
  if (!repoMatch) {
    throw new Error(
      `Not a GitHub repo or PR URL: ${url}. Expected https://github.com/<owner>/<repo>[/tree/<ref>] or a /pull/<number> URL.`,
    );
  }
  const [, owner, repo, treeRef] = repoMatch;
  const ref = refOverride ?? treeRef;
  return ref ? { kind: "repo", owner, repo, ref } : { kind: "repo", owner, repo };
}

/** Parse a PR URL specifically, rejecting non-PR GitHub URLs. */
export function parsePrTarget(url: string): Extract<GitHubTarget, { kind: "pr" }> {
  const target = parseGitHubTarget(url);
  if (target.kind !== "pr") {
    throw new Error(`Expected a GitHub pull-request URL, got: ${url}`);
  }
  return target;
}

/** Git refs we are willing to interpolate into a shell command. */
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

/**
 * Validate a branch/tag/commit before it is interpolated into a shell command.
 * Rejects metacharacters and a leading `-` (which git would read as a flag).
 */
export function assertSafeRef(ref: string): string {
  if (!SAFE_REF.test(ref) || ref.startsWith("-")) {
    throw new Error(`Unsafe git ref: ${ref}`);
  }
  return ref;
}

/** Heuristic: does a failed `git clone` look like a private/auth failure? */
export function looksPrivate(gitError: string): boolean {
  return /authentication|could not read username|terminal prompts disabled|repository not found|access denied|403|permission denied/i.test(
    gitError,
  );
}

/**
 * Build the shell script a subagent runs (via its bash tool) to clone a target
 * into `./repo` and, for a PR, write the unified diff to `./pr.diff` — relative
 * to the agent's working directory. After "---DIFF---" it prints the
 * `git diff --numstat` so the reviewer can total the diff size.
 *
 * Security:
 * - owner/repo are charset-constrained by {@link parseGitHubTarget}, the ref is
 *   validated by {@link assertSafeRef}, and the PR number is digits-only, so
 *   nothing interpolated here can inject shell syntax.
 * - For private repos, auth is supplied by `$GITHUB_TOKEN` from the sandbox env
 *   (exposed via `local({ env })`) at run time. The token is referenced by name,
 *   never interpolated — so it appears in neither this string nor the model's
 *   context. `-c` keeps the credential per-command, so the host's global git
 *   config (this is a host sandbox) is never touched.
 */
export function buildCloneScript(target: GitHubTarget): string {
  const repoUrl = `https://github.com/${target.owner}/${target.repo}.git`;
  // Only attach the auth header when a token is configured; an empty header would
  // make GitHub reject otherwise-anonymous public clones.
  const auth = process.env.GITHUB_TOKEN
    ? ' -c http.https://github.com/.extraheader="Authorization: Basic ' +
      "$(printf 'x-access-token:%s' \"$GITHUB_TOKEN\" | base64 | tr -d '\\n')\""
    : "";
  const lines = [
    "set -euo pipefail",
    "export GIT_TERMINAL_PROMPT=0", // fail fast on private-without-token instead of prompting
    "rm -rf repo pr.diff",
    `git${auth} clone --filter=blob:none --quiet ${repoUrl} repo`,
    "cd repo",
  ];
  if (target.kind === "pr") {
    lines.push(
      `git${auth} fetch --quiet origin pull/${target.number}/head:pr`,
      "git checkout --quiet pr",
      'BASE="$(git merge-base origin/HEAD pr)"',
      'git diff "$BASE" pr > ../pr.diff',
    );
  } else if (target.ref) {
    lines.push(`git checkout --quiet "${assertSafeRef(target.ref)}"`);
  }
  lines.push("git rev-parse --short HEAD");
  if (target.kind === "pr") {
    lines.push('echo "---DIFF---"', 'git diff --numstat "$BASE" pr');
  }
  return lines.join("\n");
}
