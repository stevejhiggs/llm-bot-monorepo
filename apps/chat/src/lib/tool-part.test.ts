import { describe, expect, it } from "vitest";
import { type ToolPart, viewTool } from "./tool-part.ts";

function call(toolName: string, input: unknown): ToolPart {
  return { type: "dynamic-tool", toolName, toolCallId: "c1", state: "input-available", input };
}

describe("viewTool", () => {
  it("summarises a bash call by its command's first line", () => {
    const view = viewTool(
      call("bash", { command: "set -euo pipefail\ngit clone …", timeout: 120 }),
    );
    expect(view.name).toBe("bash");
    expect(view.preview).toBe("set -euo pipefail");
    expect(view.status).toBe("running");
  });

  it("prefers url, then path, then prompt for the preview", () => {
    expect(viewTool(call("fetch_repo", { url: "https://x/y" })).preview).toBe("https://x/y");
    expect(viewTool(call("read", { path: "./repo" })).preview).toBe("./repo");
    expect(viewTool(call("task", { agent: "test_runner", prompt: "run the tests" })).preview).toBe(
      "run the tests",
    );
  });

  it("truncates a long preview line", () => {
    const view = viewTool(call("bash", { command: "x".repeat(200) }));
    expect(view.preview.endsWith("…")).toBe(true);
    expect(view.preview.length).toBe(100);
  });

  it("extracts text from an MCP-style content result and marks it done", () => {
    const view = viewTool({
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "c1",
      state: "output-available",
      input: { command: "node -v" },
      output: { content: [{ type: "text", text: "v24.17.0" }], details: {} },
    });
    expect(view.status).toBe("done");
    expect(view.output).toBe("v24.17.0");
  });

  it("surfaces the error text on a failed call", () => {
    const view = viewTool({
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "c1",
      state: "output-error",
      input: { command: "false" },
      errorText: "exit code 1",
    });
    expect(view.status).toBe("error");
    expect(view.output).toBe("exit code 1");
  });

  it("strips ANSI colour codes from output", () => {
    const view = viewTool({
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "c1",
      state: "output-available",
      input: { command: "vitest run" },
      output: { content: [{ type: "text", text: "[32m✓[39m passed" }] },
    });
    expect(view.output).toBe("✓ passed");
  });
});
