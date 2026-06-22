// Where a turn came from, derived from its conversation id. A channel turn's id is
// that channel's conversation key (parses back to its bound destination); a chat id
// (e.g. "local") is not a key and every channel's parse throws. This is the single
// id→source decision — both the prompt fragment and the outbound tool set derive
// from it — kept pure (no markdown, no agent graph) so it is unit-testable.

export type ConversationSource = "github" | "slack" | "chat";

/**
 * Classify a conversation id by trying each channel's `parseConversationKey` in a
 * fixed order (github, then slack). The first that parses names the source; if none
 * does, the turn is chat. `parsers` are the channels' `parseConversationKey` methods,
 * injected so this stays testable without the channel objects.
 */
export function resolveConversationSource(
  id: string,
  parsers: { github: (id: string) => unknown; slack: (id: string) => unknown },
): ConversationSource {
  try {
    parsers.github(id);
    return "github";
  } catch {
    // not a github key
  }
  try {
    parsers.slack(id);
    return "slack";
  } catch {
    // not a slack key
  }
  return "chat";
}
