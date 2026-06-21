// Same-origin proxy for the Flue runner. The browser talks to this app's own
// server (see src/server.ts) under FLUE_PROXY_PATH, which forwards to the
// runner. This sidesteps CORS: the Flue runtime serves no CORS headers and
// rejects OPTIONS preflight on its agent route, so a cross-origin browser call
// can't reach it directly — but a server-to-server forward needs no CORS.

// No trailing slash, so the SDK can use it directly as a baseUrl suffix.
export const FLUE_PROXY_PATH = "/api/flue";

const PREFIX = `${FLUE_PROXY_PATH}/`;

export function isProxyPath(pathname: string): boolean {
  return pathname.startsWith(PREFIX);
}

/**
 * Map an incoming same-origin proxy request path to the absolute runner URL.
 * `runnerBase` is the server-side FLUE_RUNNER_URL. Pure so it can be tested
 * without a live server.
 */
export function resolveProxyTarget(
  pathname: string,
  search: string,
  runnerBase: string | undefined,
): string {
  if (!runnerBase) {
    throw new Error(
      "FLUE_RUNNER_URL is not set. Point it at your Flue runner, e.g. http://localhost:3583",
    );
  }
  if (!isProxyPath(pathname)) {
    throw new Error(`Not a Flue proxy path: ${pathname}`);
  }
  const rest = pathname.slice(PREFIX.length);
  return `${runnerBase.replace(/\/+$/, "")}/${rest}${search}`;
}

/**
 * Strip content-encoding/content-length from an upstream response's headers.
 *
 * Node's `fetch` (undici) transparently decompresses the runner's response body
 * when it carried `Content-Encoding: br|gzip`, but leaves the now-inaccurate
 * `content-encoding` (and `content-length`) headers on the Response. Returning
 * those verbatim makes the browser try to decode an already-decoded body and
 * fail with ERR_CONTENT_DECODING_FAILED. We must drop both so the browser reads
 * the body as-is. Returns a new Headers; the input is not mutated. Pure for
 * testability.
 */
export function sanitizeUpstreamHeaders(headers: Headers): Headers {
  const cleaned = new Headers(headers);
  cleaned.delete("content-encoding");
  cleaned.delete("content-length");
  return cleaned;
}
