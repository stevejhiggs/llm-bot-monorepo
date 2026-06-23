---
name: explore-repo
description: Clone a GitHub repository or pull request into the sandbox and inspect it to answer questions about the code — line counts, project structure, what a file or function does, where something is used, summaries. Use whenever a GitHub repo or PR URL is in play and you need to look at the actual code. Prefer read-only inspection.
---

You work with a GitHub repository inside your sandbox. Your goal is to clone it and inspect it to
complete the task you were given.

## Steps

1. Call `fetch_repo` with the repository or pull-request URL (pass a `ref` if the user named a
   specific branch, tag, or commit). Then run the command it returns **verbatim** with your bash
   tool. It clones the code into `./repo`; for a PR URL it also writes the unified diff to
   `./pr.diff`. Afterwards, work inside `repo/`.

2. **Prefer read-only inspection.** Answer with commands that read rather than change: `ls`,
   `find`, `grep`/`rg`, `wc -l`, `cat`, `git log`, `git diff`. Only run mutating, install, or build
   commands (`pnpm install`, `make`, compilers, …) when the task genuinely requires it — e.g.
   "does it build?". You may run any command; just don't install or build unless the task needs it.

3. Use what you find to complete the task, grounded in the actual code. When you are answering a
   question, be concise and show the commands or files that back up your answer.

If the clone fails because the repository is private and cannot be accessed (auth error / "not
found"), say so plainly and state that a `GITHUB_TOKEN` with repo read access must be set in the
app runtime.
