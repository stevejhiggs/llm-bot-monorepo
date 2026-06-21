import { describe, expect, it } from "vitest";
import { isProxyPath, resolveProxyTarget, sanitizeUpstreamHeaders } from "./proxy.ts";

describe("isProxyPath", () => {
  it("matches only the proxy prefix", () => {
    expect(isProxyPath("/api/flue/agents/d0lt-bot/x")).toBe(true);
    expect(isProxyPath("/")).toBe(false);
    expect(isProxyPath("/api/other")).toBe(false);
  });
});

describe("resolveProxyTarget", () => {
  it("throws a clear error when the runner base is missing", () => {
    expect(() => resolveProxyTarget("/api/flue/agents/d0lt-bot/x", "", undefined)).toThrow(
      /FLUE_RUNNER_URL/,
    );
  });

  it("rewrites the prefix to the runner base, preserving path and query", () => {
    expect(
      resolveProxyTarget("/api/flue/agents/d0lt-bot/abc", "?wait=result", "http://localhost:3583"),
    ).toBe("http://localhost:3583/agents/d0lt-bot/abc?wait=result");
  });

  it("strips a trailing slash from the runner base", () => {
    expect(resolveProxyTarget("/api/flue/openapi.json", "", "http://localhost:3583/")).toBe(
      "http://localhost:3583/openapi.json",
    );
  });

  it("rejects a path outside the proxy prefix", () => {
    expect(() => resolveProxyTarget("/api/other", "", "http://localhost:3583")).toThrow(
      /Not a Flue proxy path/,
    );
  });
});

describe("sanitizeUpstreamHeaders", () => {
  it("drops content-encoding and content-length (body is already decompressed)", () => {
    const cleaned = sanitizeUpstreamHeaders(
      new Headers({
        "content-encoding": "br",
        "content-length": "8171",
        "content-type": "application/json",
      }),
    );
    expect(cleaned.has("content-encoding")).toBe(false);
    expect(cleaned.has("content-length")).toBe(false);
    expect(cleaned.get("content-type")).toBe("application/json");
  });

  it("does not mutate the input headers", () => {
    const input = new Headers({ "content-encoding": "gzip" });
    sanitizeUpstreamHeaders(input);
    expect(input.get("content-encoding")).toBe("gzip");
  });
});
