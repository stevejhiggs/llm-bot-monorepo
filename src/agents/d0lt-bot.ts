import { mkdir } from 'node:fs/promises';
import { createAgent, type AgentRouteHandler } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import instructions from './d0lt-bot.md' with { type: 'markdown' };
import reviewer from '../subagents/reviewer.ts';
import testRunner from '../subagents/test-runner.ts';
import { workDir } from '../lib/github.ts';

export const description = 'GitHub assistant: routes PR reviews and test runs to specialist subagents.';

// Exposes the agent over HTTP so `flue connect d0lt-bot <id>` can chat with it.
export const route: AgentRouteHandler = async (_c, next) => next();

// Root router. It owns the local() sandbox; its two subagents share it and do the
// clone/diff/install/test work there via their bash tool. This mirrors the eve
// original's root agent that routed to two specialist subagents.
export default createAgent(async ({ id }) => {
  // Each chat instance gets its own scratch dir. local() spawns shells with cwd set
  // to it, so it must exist before the harness initializes (an absent cwd surfaces
  // as `spawn /bin/bash ENOENT`).
  const cwd = workDir(id);
  await mkdir(cwd, { recursive: true });

  return {
    model: 'anthropic/claude-sonnet-4-6',
    instructions,
    // GITHUB_TOKEN (when set) is exposed to the sandbox so private clones can
    // authenticate via $GITHUB_TOKEN at run time, without the secret ever entering
    // the model's context. Undefined drops it (public repos clone anonymously).
    sandbox: local({ env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN } }),
    cwd,
    subagents: [reviewer, testRunner],
  };
});
