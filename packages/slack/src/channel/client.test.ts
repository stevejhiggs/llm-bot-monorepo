import { expect, test } from "vitest";
import { workerdSafeFetch } from "./client.ts";

test("workerdSafeFetch rewrites redirect:'error' to 'manual' (workerd rejects 'error')", async () => {
  let seen: RequestInit | undefined;
  const base: typeof fetch = async (_input, init) => {
    seen = init;
    return new Response("{}");
  };

  await workerdSafeFetch(base)("https://slack.test/api/chat.postMessage", {
    method: "POST",
    redirect: "error",
  });

  expect(seen?.redirect).toBe("manual");
});

test("workerdSafeFetch leaves a non-'error' redirect untouched", async () => {
  let seen: RequestInit | undefined;
  const base: typeof fetch = async (_input, init) => {
    seen = init;
    return new Response("{}");
  };

  await workerdSafeFetch(base)("https://slack.test/api/chat.postMessage", { redirect: "follow" });

  expect(seen?.redirect).toBe("follow");
});
