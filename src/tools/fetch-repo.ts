import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { buildCloneScript, parseGitHubTarget } from '../lib/github.ts';

// Shared by both subagents. A Flue tool's execute receives only validated args —
// no sandbox — so this tool does not clone; it validates the GitHub URL and returns
// the exact, injection-safe shell command for the agent to run with its bash tool.
// This keeps URL parsing and shell-safety in one tested place instead of letting the
// model assemble a git command from a raw URL.
export default defineTool({
  name: 'fetch_repo',
  description:
    'Resolve a GitHub repository or pull-request URL and return the exact shell command to ' +
    'clone it into ./repo (and, for a PR, write the unified diff to ./pr.diff). Call this first ' +
    'with the URL, then run the returned command verbatim with your bash tool. Returns the ' +
    'parsed target and the command.',
  parameters: v.object({
    url: v.pipe(
      v.string(),
      v.description('GitHub repo URL (https://github.com/owner/repo[/tree/<ref>]) or a PR URL.'),
    ),
    ref: v.optional(
      v.pipe(v.string(), v.description('Branch, tag, or commit to check out. Ignored for PR URLs.')),
    ),
  }),
  async execute({ url, ref }) {
    const target = parseGitHubTarget(url, ref);
    const command = buildCloneScript(target);
    const header =
      target.kind === 'pr'
        ? `Target: pull request ${target.owner}/${target.repo} #${target.number}.\n` +
          'Run the command below verbatim with bash. It clones the PR head into ./repo and writes ' +
          'the unified diff to ./pr.diff. Afterwards read pr.diff and open the changed files under ' +
          'repo/. The command prints the short HEAD, then after "---DIFF---" the numstat ' +
          '(added<TAB>deleted<TAB>file) — total it for the diff size.'
        : `Target: repository ${target.owner}/${target.repo}` +
          (target.ref ? ` @ ${target.ref}` : '') +
          '.\nRun the command below verbatim with bash. It clones the repo into ./repo; then work ' +
          'inside repo/.';
    return `${header}\n\n${command}`;
  },
});
