/** The slice of a keyboard event the submit decision depends on. */
export interface SubmitKeyEvent {
  key: string;
  shiftKey: boolean;
  /** True while an IME composition is in progress (e.g. CJK candidate entry). */
  isComposing?: boolean;
}

/**
 * Enter sends the message; Shift+Enter inserts a newline. Never submit mid-IME
 * composition — pressing Enter there commits a candidate and must not also send.
 */
export function shouldSubmitOnKey(event: SubmitKeyEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
