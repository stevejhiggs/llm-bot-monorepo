const STORAGE_KEY = "d0lt-chat:conversation-id";

/**
 * Get the persisted conversation id, or create and persist a new one. `storage`
 * is injected so this is testable without a real `localStorage`.
 */
export function getOrCreateConversationId(
  storage: Pick<Storage, "getItem" | "setItem">,
  makeId: () => string = () => crypto.randomUUID(),
): string {
  const existing = storage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const id = makeId();
  storage.setItem(STORAGE_KEY, id);
  return id;
}
