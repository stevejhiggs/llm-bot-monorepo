import type { UIMessagePart } from "@flue/react";

/** The file variant of a message part. */
export type FilePart = Extract<UIMessagePart, { type: "file" }>;

export interface FileView {
  label: string;
  url: string;
  mediaType: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Project a file part into the fields the UI renders. The Flue/SDK part shape is
 * intentionally treated defensively so older and newer file metadata names still
 * produce a useful link.
 */
export function viewFile(part: FilePart): FileView {
  const data = asRecord(part);
  const url = typeof data.url === "string" ? data.url : "";
  const mediaType =
    typeof data.mediaType === "string"
      ? data.mediaType
      : typeof data.mimeType === "string"
        ? data.mimeType
        : "";
  const label =
    typeof data.filename === "string"
      ? data.filename
      : typeof data.name === "string"
        ? data.name
        : url || mediaType || "file";

  return { label, url, mediaType };
}
