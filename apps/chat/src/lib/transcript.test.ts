import { describe, expect, it } from "vitest";
import type { UIMessage } from "@flue/react";
import { mergeTranscript } from "./transcript.ts";

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}
function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

describe("mergeTranscript", () => {
  it("interleaves user and assistant messages by turn", () => {
    const out = mergeTranscript(
      [user("u1", "hi"), user("u2", "again")],
      [assistant("a1", "hello"), assistant("a2", "yo")],
    );
    expect(out.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("shows a pending user message before its reply arrives", () => {
    const out = mergeTranscript([user("u1", "hi")], []);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("drops user messages echoed back over the agent stream", () => {
    const out = mergeTranscript([], [user("x", "echo"), assistant("a1", "hello")]);
    expect(out.map((m) => m.id)).toEqual(["a1"]);
  });

  it("renders assistant-only history when there are no local user messages", () => {
    const out = mergeTranscript([], [assistant("a1", "one"), assistant("a2", "two")]);
    expect(out.map((m) => m.id)).toEqual(["a1", "a2"]);
  });
});
