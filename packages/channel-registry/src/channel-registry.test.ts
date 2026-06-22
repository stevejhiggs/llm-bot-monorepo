import { expect, test } from "vitest";
import {
  resolveRegisteredConversation,
  type ChannelRegistry,
  type ConversationTools,
} from "./index.ts";

const emptyTools: ConversationTools = { router: [], subagent: [] };

const registry = {
  github: {
    instructions: "github instructions",
    parseConversationKey: (id: string) => {
      if (id.startsWith("gh:")) return { id, issue: 1 };
      throw new Error("not github");
    },
    tools: (ref) => ({
      router: [{ name: `github:${ref.issue}` } as never],
      subagent: [],
    }),
  },
  slack: {
    instructions: "slack instructions",
    parseConversationKey: (id: string) => {
      if (id.startsWith("slack:")) return { id, thread: "100.0" };
      throw new Error("not slack");
    },
    tools: (ref) => ({
      router: [{ name: `slack:${ref.thread}` } as never],
      subagent: [{ name: "slack-progress" } as never],
    }),
  },
} satisfies ChannelRegistry;

test("resolves the first registry entry whose parser accepts the id", () => {
  const conversation = resolveRegisteredConversation("gh:o/r#1", registry);

  expect(conversation.source).toBe("github");
  expect(conversation.instructions).toBe("github instructions");
  expect(conversation.tools).toEqual({
    router: [{ name: "github:1" }],
    subagent: [],
  });
});

test("returns channel tools for both router and subagent", () => {
  const conversation = resolveRegisteredConversation("slack:T1/C1/100.0", registry);

  expect(conversation.source).toBe("slack");
  expect(conversation.instructions).toBe("slack instructions");
  expect(conversation.tools).toEqual({
    router: [{ name: "slack:100.0" }],
    subagent: [{ name: "slack-progress" }],
  });
});

test("returns chat defaults when no registry parser accepts the id", () => {
  expect(resolveRegisteredConversation("local", registry)).toEqual({
    source: "chat",
    instructions: "",
    tools: emptyTools,
  });
});

test("preserves registry order for ambiguous ids", () => {
  const ambiguous = {
    github: {
      instructions: "github",
      parseConversationKey: () => ({ issue: 1 }),
      tools: () => emptyTools,
    },
    slack: {
      instructions: "slack",
      parseConversationKey: () => ({ thread: "100.0" }),
      tools: () => emptyTools,
    },
  } satisfies ChannelRegistry;

  expect(resolveRegisteredConversation("ambiguous", ambiguous).source).toBe("github");
});
