import { expect, test } from "vitest";
import { resolveInteractiveMessage } from "./interactions-ack.ts";

test("POSTs a replace_original payload to the response_url", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof url === "string" ? url : url instanceof Request ? url.url : url.toString();
    let bodyStr = "";
    if (typeof init?.body === "string") {
      bodyStr = init.body;
    } else if (init?.body instanceof Blob) {
      bodyStr = await init.body.text();
    }
    calls.push({ url: urlStr, body: JSON.parse(bodyStr) });
    return new Response("ok");
  }) as unknown as typeof fetch;

  const result = await resolveInteractiveMessage(
    "https://hooks.slack/x",
    "✅ You chose: Deploy",
    doFetch,
  );

  expect(result).toEqual({ ok: true });
  expect(calls[0].url).toBe("https://hooks.slack/x");
  expect(calls[0].body).toMatchObject({ replace_original: true, text: "✅ You chose: Deploy" });
});

test("swallows a fetch failure and returns ok:false", async () => {
  const doFetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  expect(await resolveInteractiveMessage("https://hooks.slack/x", "done", doFetch)).toEqual({
    ok: false,
  });
});
