import { describe, expect, it } from "vitest";

import { shouldSubmitOnKey } from "./input-key.ts";

describe("shouldSubmitOnKey", () => {
  it("submits on Enter alone", () => {
    expect(shouldSubmitOnKey({ key: "Enter", shiftKey: false })).toBe(true);
  });

  it("inserts a newline on Shift+Enter (does not submit)", () => {
    expect(shouldSubmitOnKey({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("ignores other keys", () => {
    expect(shouldSubmitOnKey({ key: "a", shiftKey: false })).toBe(false);
  });

  it("does not submit while an IME composition is in progress", () => {
    // Pressing Enter to commit a CJK candidate must not also send the message.
    expect(shouldSubmitOnKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });
});
