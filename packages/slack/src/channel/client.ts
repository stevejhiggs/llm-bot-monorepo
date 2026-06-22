// The shared Slack Web API client and the workerd compatibility shim it needs.
// Used by both the inbound thread-context fetch and the outbound reply/progress
// tools, so it lives in one place they both import.

import { WebClient } from "@slack/web-api";

// A fetch wrapper that makes @slack/web-api's HTTP client work on Cloudflare
// Workers, which mishandles it two ways:
//
//  1. Receiver: the WebClient stores the fetch impl and calls it as a method
//     (`this.fetchFn(url, …)`), so the receiver is the WebClient, not globalThis.
//     Node's undici fetch ignores its receiver, but workerd's fetch requires
//     `this === globalThis` and otherwise throws "Illegal invocation". The bound
//     default `baseFetch` keeps the call valid on both targets.
//  2. Redirect mode: @slack/web-api sets `redirect: "error"` on its requests, which
//     workerd rejects ("must be one of follow or manual"), failing every Slack call.
//     Slack's API never redirects, so we rewrite it to "manual" to pass validation.
//
// `baseFetch` is injectable so the unit test can assert the rewrite without a network.
export function workerdSafeFetch(
  baseFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return (input, init) => {
    const safeInit = init?.redirect === "error" ? { ...init, redirect: "manual" as const } : init;
    return baseFetch(input, safeInit);
  };
}

// Outbound Web API client. Authenticates as the bot user (SLACK_BOT_TOKEN).
export const client = new WebClient(process.env.SLACK_BOT_TOKEN, {
  fetch: workerdSafeFetch(),
});
