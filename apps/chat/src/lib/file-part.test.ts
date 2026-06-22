import { describe, expect, it } from "vitest";
import { type FilePart, viewFile } from "./file-part.ts";

describe("viewFile", () => {
  it("uses filename, URL, and media type when present", () => {
    const out = viewFile({
      type: "file",
      filename: "report.txt",
      url: "https://example.com/report.txt",
      mediaType: "text/plain",
    } as FilePart);

    expect(out).toEqual({
      label: "report.txt",
      url: "https://example.com/report.txt",
      mediaType: "text/plain",
    });
  });

  it("falls back across older metadata names", () => {
    const out = viewFile({
      type: "file",
      name: "artifact.json",
      mimeType: "application/json",
    } as unknown as FilePart);

    expect(out).toEqual({
      label: "artifact.json",
      url: "",
      mediaType: "application/json",
    });
  });
});
