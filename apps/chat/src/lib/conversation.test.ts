import { describe, expect, it } from "vitest";
import { getOrCreateConversationId } from "./conversation.ts";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    dump: () => Object.fromEntries(map),
  };
}

describe("getOrCreateConversationId", () => {
  it("generates, stores, and returns a new id when none exists", () => {
    const storage = fakeStorage();
    const id = getOrCreateConversationId(storage, () => "generated-id");
    expect(id).toBe("generated-id");
    expect(storage.dump()["d0lt-chat:conversation-id"]).toBe("generated-id");
  });

  it("returns the existing id on subsequent calls", () => {
    const storage = fakeStorage({ "d0lt-chat:conversation-id": "existing-id" });
    const id = getOrCreateConversationId(storage, () => "should-not-be-used");
    expect(id).toBe("existing-id");
  });
});
