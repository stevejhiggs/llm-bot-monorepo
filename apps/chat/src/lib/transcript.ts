import type { UIMessage } from "@flue/react";

export type DisplayMessage = Pick<UIMessage, "id" | "role" | "parts">;

/**
 * Build the rendered transcript from our own user messages plus the agent's
 * messages.
 *
 * The runtime never echoes the user's message back over the stream, and the SDK
 * reducer drops its optimistic user bubble when the assistant reply arrives — so
 * user messages must be held by the caller. We interleave them with the agent's
 * (non-user) messages by turn order: user[i] then reply[i]. A pending user
 * message therefore shows immediately, before its reply exists; on reload (no
 * local user messages) only the agent's history renders.
 */
export function mergeTranscript(
  userMessages: readonly DisplayMessage[],
  agentMessages: readonly UIMessage[],
): DisplayMessage[] {
  const replies = agentMessages.filter((m) => m.role !== "user");
  const merged: DisplayMessage[] = [];
  for (let i = 0; i < Math.max(userMessages.length, replies.length); i++) {
    const user = userMessages[i];
    if (user) merged.push(user);
    const reply = replies[i];
    if (reply) merged.push({ id: reply.id, role: reply.role, parts: reply.parts });
  }
  return merged;
}
