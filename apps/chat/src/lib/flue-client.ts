import { createFlueClient } from "@flue/sdk";

import { FLUE_PROXY_PATH } from "./proxy.ts";

// The browser reaches the runner through this app's own same-origin server
// proxy (src/server.ts), so the client base is this app's origin plus the proxy
// path. An absolute URL is used (not a bare relative path) because the SDK
// rejects a relative baseUrl without a browser origin — i.e. during SSR. The
// SSR value is never fetched: the Flue hooks stay idle until hydration, by which
// point `globalThis.location` is the real origin.
export function flueBaseUrl(origin: string | undefined = globalThis.location?.origin): string {
  return `${origin ?? "http://localhost"}${FLUE_PROXY_PATH}`;
}

export function createChatClient(baseUrl: string = flueBaseUrl()) {
  return createFlueClient({
    baseUrl,
    // The SDK calls its stored fetch as `this.fetchImpl(...)`. Native `fetch`
    // rejects that ("Illegal invocation" in the browser), so pass a bound fetch.
    fetch: globalThis.fetch.bind(globalThis),
  });
}
