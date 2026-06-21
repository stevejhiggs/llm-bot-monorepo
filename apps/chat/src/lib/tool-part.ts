import type { UIMessagePart } from "@flue/react";

/** The tool-call variant of a message part: an invocation plus its result. */
export type ToolPart = Extract<UIMessagePart, { type: "dynamic-tool" }>;

export type ToolStatus = "running" | "done" | "error";

export interface ToolView {
  name: string;
  status: ToolStatus;
  /** One-line summary of the call's salient argument, for the collapsed header. */
  preview: string;
  /** Pretty-printed call input. */
  input: string;
  /** Tool output, or the error text when the call failed; empty while running. */
  output: string;
}

const STATUS: Record<ToolPart["state"], ToolStatus> = {
  "input-available": "running",
  "output-available": "done",
  "output-error": "error",
};

// Argument keys, in priority order, that best summarise a call on one line — the
// bash command, the repo URL, the path read, the delegated prompt, a query.
const PREVIEW_KEYS = ["command", "url", "path", "prompt", "query"] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** First non-empty line of a string, capped — what fits a collapsed header. */
function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

function previewInput(input: unknown): string {
  if (typeof input === "string") return firstLine(input);
  const obj = asRecord(input);
  if (!obj) return "";
  for (const key of PREVIEW_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return firstLine(value);
  }
  return firstLine(JSON.stringify(obj));
}

// Strip ANSI SGR colour codes. Tools that shell out (vitest, pnpm) emit coloured
// output; the escape sequences are noise in a plain <pre>.
const ANSI = /\[[0-9;]*m/g;

/**
 * Coerce a tool result to displayable text. Runner/MCP tool results arrive as
 * `{ content: [{ type: "text", text }] }`; strings pass through; anything else
 * is pretty-printed JSON. ANSI colour codes are stripped.
 */
function outputText(output: unknown): string {
  if (typeof output === "string") return output.replace(ANSI, "");
  const obj = asRecord(output);
  if (obj && Array.isArray(obj.content)) {
    const text = obj.content
      .map((block) => asRecord(block)?.text)
      .filter((t): t is string => typeof t === "string")
      .join("\n");
    if (text) return text.replace(ANSI, "");
  }
  return output === undefined ? "" : JSON.stringify(output, null, 2);
}

/** Project a tool-call part into the fields the UI renders. Pure, for testing. */
export function viewTool(part: ToolPart): ToolView {
  let output = "";
  if (part.state === "output-available") output = outputText(part.output);
  else if (part.state === "output-error") output = part.errorText;

  return {
    name: part.toolName,
    status: STATUS[part.state],
    preview: previewInput(part.input),
    input: part.input === undefined ? "" : JSON.stringify(part.input, null, 2),
    output,
  };
}
