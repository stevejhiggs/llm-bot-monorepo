// After a user interacts with a message, replace it via Slack's `response_url`
// (a short-lived, pre-authorized webhook — no token needed) so the buttons are gone
// and can't be clicked again. Best-effort: a failure here must never break the
// dispatch, so it is swallowed and logged, like `postProgressInThread`.
//
// `doFetch` is injectable so the unit test can assert the payload without a network.

export async function resolveInteractiveMessage(
  responseUrl: string,
  summary: string,
  doFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<{ ok: boolean }> {
  try {
    await doFetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        replace_original: true,
        text: summary,
        blocks: [{ type: "markdown", text: summary }],
      }),
    });
    return { ok: true };
  } catch (error) {
    console.warn("[slack] interaction ack failed:", error);
    return { ok: false };
  }
}
