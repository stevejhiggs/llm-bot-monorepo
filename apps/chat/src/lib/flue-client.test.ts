import { describe, expect, it } from "vitest";
import { createChatClient, flueBaseUrl } from "./flue-client.ts";

describe("flueBaseUrl", () => {
  it("appends the proxy path to the given origin", () => {
    expect(flueBaseUrl("http://localhost:3000")).toBe("http://localhost:3000/api/flue");
  });

  it("falls back to a placeholder origin when none is available (SSR)", () => {
    expect(flueBaseUrl(undefined)).toBe("http://localhost/api/flue");
  });
});

describe("createChatClient", () => {
  it("returns a client for the same-origin proxy base", () => {
    const client = createChatClient("http://localhost:3000");
    expect(client).toBeDefined();
    expect(client.agents).toBeDefined();
  });
});
