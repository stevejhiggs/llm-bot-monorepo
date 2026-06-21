import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { isProxyPath, resolveProxyTarget, sanitizeUpstreamHeaders } from "./lib/proxy.ts";

// Custom server entry: forward `/api/flue/*` to the Flue runner, and let
// everything else fall through to the normal TanStack Start handler. This
// server-to-server forward is what lets the browser reach the runner without
// CORS (see src/lib/proxy.ts for why a direct browser call can't work).
export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);
    if (!isProxyPath(url.pathname)) {
      return handler.fetch(request);
    }

    let target: string;
    try {
      target = resolveProxyTarget(url.pathname, url.search, process.env.FLUE_RUNNER_URL);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Proxy error";
      return new Response(message, { status: 500 });
    }

    // Strip Host so fetch sets it from the target; buffer any body so the
    // global fetch does not require the `duplex` streaming option.
    const headers = new Headers(request.headers);
    headers.delete("host");
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? await request.arrayBuffer() : undefined;

    try {
      const upstream = await fetch(target, { method: request.method, headers, body });
      // Node's fetch already decompressed the body but kept the upstream
      // content-encoding/content-length headers; returning them verbatim makes
      // the browser fail with ERR_CONTENT_DECODING_FAILED. Strip them.
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: sanitizeUpstreamHeaders(upstream.headers),
      });
    } catch (err) {
      // The runner is unreachable (down, or FLUE_RUNNER_URL points at the wrong
      // port). Log the detail server-side; don't leak the internal runner URL to
      // the client (a dev-only hint aids local debugging).
      const reason = err instanceof Error ? err.message : String(err);
      console.error("flue proxy: cannot reach runner", { target, reason });
      const hint =
        process.env.NODE_ENV === "production" ? "" : `: cannot reach ${target} (${reason})`;
      return new Response(`Upstream runner unavailable${hint}`, { status: 502 });
    }
  },
});
