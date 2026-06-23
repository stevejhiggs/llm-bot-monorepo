import type { SlackInteractionPayload } from "@flue/slack";
import { expect, test } from "vitest";
import { planSlackInteraction } from "./plan.ts";

function blockActions(
  action: Record<string, unknown>,
  over: Record<string, unknown> = {},
): SlackInteractionPayload {
  return {
    type: "block_actions",
    user: { id: "U1" },
    team: { id: "T1" },
    api_app_id: "A1",
    container: { type: "message", channel_id: "C1", message_ts: "5.5", thread_ts: "4.4" },
    actions: [action],
    ...over,
  } as unknown as SlackInteractionPayload;
}

test("plans a button click into a dispatch with the thread ref", () => {
  const plan = planSlackInteraction(
    blockActions({
      type: "button",
      action_id: "confirm",
      block_id: "b1",
      value: "deploy",
    }),
  );
  expect(plan).not.toBeNull();
  expect(plan!.ref).toEqual({ teamId: "T1", channelId: "C1", threadTs: "4.4" });
  expect(plan!.input.type).toBe("slack.block_action");
  expect(plan!.input.elementType).toBe("button");
  expect(plan!.input.actionId).toBe("confirm");
  expect(plan!.input.value).toBe("deploy");
  expect(plan!.input.userId).toBe("U1");
  expect(plan!.input.text).toContain("button");
});

test("falls back to message_ts when thread_ts is absent", () => {
  const plan = planSlackInteraction(
    blockActions(
      { type: "button", action_id: "a", block_id: "b", value: "v" },
      { container: { type: "message", channel_id: "C1", message_ts: "5.5" } },
    ),
  );
  expect(plan!.ref.threadTs).toBe("5.5");
});

test("reads selected_option.value for a static_select", () => {
  const plan = planSlackInteraction(
    blockActions({
      type: "static_select",
      action_id: "pick",
      block_id: "b",
      selected_option: { value: "staging", text: { type: "plain_text", text: "Staging" } },
    }),
  );
  expect(plan!.input.elementType).toBe("static_select");
  expect(plan!.input.value).toBe("staging");
});

test("reads selected_option.value for an overflow", () => {
  const plan = planSlackInteraction(
    blockActions({
      type: "overflow",
      action_id: "more",
      block_id: "b",
      selected_option: { value: "archive", text: { type: "plain_text", text: "Archive" } },
    }),
  );
  expect(plan!.input.value).toBe("archive");
});

test("returns null for a non-block_actions interaction", () => {
  expect(
    planSlackInteraction({ type: "view_submission" } as unknown as SlackInteractionPayload),
  ).toBeNull();
});

test("returns null when the channel or thread cannot be resolved", () => {
  const plan = planSlackInteraction(
    blockActions({ type: "button", action_id: "a", block_id: "b", value: "v" }, { container: {} }),
  );
  expect(plan).toBeNull();
});

test("returns null for an unsupported element type", () => {
  expect(
    planSlackInteraction(blockActions({ type: "datepicker", action_id: "a", block_id: "b" })),
  ).toBeNull();
});
