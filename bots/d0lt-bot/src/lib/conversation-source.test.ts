import { expect, test } from "vitest";
import { resolveConversationSource } from "./conversation-source.ts";

// Fake parsers mirror parseConversationKey: they return a ref for a key they own
// and throw otherwise. We only assert which source a key resolves to.
const parsers = {
  github: (id: string) => {
    if (id.startsWith("gh:")) return { id };
    throw new Error("not a github key");
  },
  slack: (id: string) => {
    if (id.startsWith("slack:")) return { id };
    throw new Error("not a slack key");
  },
};

test("a github conversation key resolves to github", () => {
  expect(resolveConversationSource("gh:o/r#1", parsers)).toBe("github");
});

test("a slack conversation key resolves to slack", () => {
  expect(resolveConversationSource("slack:T1/C1/100.0", parsers)).toBe("slack");
});

test("an unparseable id (chat) resolves to chat", () => {
  expect(resolveConversationSource("local", parsers)).toBe("chat");
});

test("github is tried before slack", () => {
  // A key both parsers would accept must resolve to github (tried first).
  const both = {
    github: () => ({ ok: true }),
    slack: () => ({ ok: true }),
  };
  expect(resolveConversationSource("ambiguous", both)).toBe("github");
});
