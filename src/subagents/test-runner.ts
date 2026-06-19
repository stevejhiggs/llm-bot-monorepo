import { defineAgentProfile } from '@flue/runtime';
import instructions from './test-runner.md' with { type: 'markdown' };
import fetchRepo from '../tools/fetch-repo.ts';

// Subagent profile delegated to by d0lt-bot via its built-in `task` capability.
// Shares the router's local() sandbox; clones, installs, and runs tests there.
export default defineAgentProfile({
  name: 'test_runner',
  description:
    'Runs a repository’s tests: clones the code into the sandbox, detects the stack, installs ' +
    'dependencies, runs the tests, and returns a structured pass/fail result.',
  instructions,
  tools: [fetchRepo],
});
