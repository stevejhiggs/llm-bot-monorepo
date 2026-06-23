import { useFlueAgent } from "@flue/react";
import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { getOrCreateConversationId } from "../lib/conversation.ts";
import { type FilePart, viewFile } from "../lib/file-part.ts";
import { shouldSubmitOnKey } from "../lib/input-key.ts";
import { type ToolPart, viewTool } from "../lib/tool-part.ts";
import { type DisplayMessage, mergeTranscript } from "../lib/transcript.ts";

const AGENT_NAME = "d0lt-bot";

export function Chat() {
  // Resolve the conversation id on the client only — `localStorage` is not
  // available during SSR. `useFlueAgent` accepts a deferred (undefined) id.
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  useEffect(() => {
    setConversationId(getOrCreateConversationId(window.localStorage));
  }, []);

  const [input, setInput] = useState("");
  // We hold our own user messages (the runtime never echoes them, and the SDK
  // drops its optimistic bubble) and merge them with the agent's replies for
  // display. See lib/transcript.ts.
  const [userMessages, setUserMessages] = useState<DisplayMessage[]>([]);
  const agent = useFlueAgent({ name: AGENT_NAME, id: conversationId });
  const messages = mergeTranscript(userMessages, agent.messages);

  const ready = conversationId !== undefined;
  // Only the active turn counts as "thinking". `connecting` is the background
  // stream attaching (it rests there for a fresh conversation), so it must NOT
  // block sending — `sendMessage` works regardless of connection status.
  const thinking = agent.status === "submitted" || agent.status === "streaming";

  // Keep the latest message in view when a message is added or a turn starts/
  // ends — not on every streaming token.
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, thinking]);

  // Autofocus the composer once the conversation is ready, so the page is
  // usable from the keyboard without a click.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (ready) inputRef.current?.focus();
  }, [ready]);

  // Auto-grow the textarea to fit its content (capped by a max-height in CSS),
  // and shrink it back down after a send clears the value. `scrollHeight`
  // measures content + padding only; with `box-sizing: border-box` we must add
  // the border back, otherwise the box is a couple px short and shows a stray
  // scrollbar. Run before paint so the height never flashes.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + border}px`;
  }, [input]);

  function send() {
    const text = input.trim();
    if (!text || thinking || !ready) return;
    setInput("");
    setUserMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] },
    ]);
    void agent.sendMessage(text);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    send();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSubmitOnKey(event.nativeEvent)) {
      event.preventDefault();
      send();
    }
  }

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col font-sans">
      <header className="border-b px-4 py-3 text-sm font-semibold text-gray-700">d0lt-bot</header>

      <div
        className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
        role="log"
        aria-label="Conversation with d0lt-bot"
        aria-live="polite"
        aria-busy={thinking}
      >
        {messages.length === 0 && (
          <p className="text-center text-sm text-gray-400">
            Ask d0lt-bot to review a PR or run a repo's tests.
          </p>
        )}
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {thinking && <p className="text-left text-sm text-gray-400">d0lt-bot is thinking…</p>}
        {agent.status === "error" && agent.error && (
          <p className="text-left text-sm text-red-600" role="alert">
            {agent.error.message}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <form onSubmit={submit} className="flex items-end gap-2 border-t px-4 py-3">
        <textarea
          ref={inputRef}
          rows={1}
          className="max-h-40 flex-1 resize-none rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring"
          value={input}
          placeholder={
            ready ? "Message d0lt-bot…  (Enter to send, Shift+Enter for a new line)" : "Connecting…"
          }
          disabled={!ready}
          aria-label="Message d0lt-bot"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          disabled={!input.trim() || thinking || !ready}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </main>
  );
}

function Message({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";
  // Spoken parts (the model's words) go in a chat bubble; tool calls render as
  // their own activity blocks below, and file parts render as attachment rows.
  // Splitting them means non-text turns show their work instead of an empty bubble.
  const speech = message.parts.filter((p) => p.type === "text" || p.type === "reasoning");
  const tools = message.parts.filter((p): p is ToolPart => p.type === "dynamic-tool");
  const files = message.parts.filter((p): p is FilePart => p.type === "file");

  return (
    <div className={isUser ? "text-right" : "text-left"}>
      <span className="mb-1 block text-xs uppercase tracking-wide text-gray-400">
        {message.role}
      </span>
      {speech.length > 0 && (
        <div
          className={
            "inline-block max-w-full rounded-lg px-3 py-2 text-left text-sm " +
            (isUser ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-900")
          }
        >
          {speech.map((part, i) => {
            // Assistant replies are markdown; the user's own input is shown
            // verbatim. Reasoning is shown muted, as plain text.
            if (part.type === "text" && !isUser)
              return (
                <div key={i} className="prose prose-sm max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
                </div>
              );
            if (part.type === "text")
              return (
                <span key={i} className="whitespace-pre-wrap">
                  {part.text}
                </span>
              );
            return (
              <span key={i} className="block whitespace-pre-wrap italic opacity-60">
                {part.text}
              </span>
            );
          })}
        </div>
      )}
      {tools.map((part, i) => (
        <ToolCall key={i} part={part} />
      ))}
      {files.map((part, i) => (
        <FileAttachment key={i} part={part} />
      ))}
    </div>
  );
}

const TOOL_ICON: Record<ReturnType<typeof viewTool>["status"], string> = {
  running: "…",
  done: "✓",
  error: "✗",
};

function ToolCall({ part }: { part: ToolPart }) {
  const tool = viewTool(part);
  return (
    <details className="my-1 rounded-md border border-gray-200 bg-white text-xs text-gray-700">
      <summary className="cursor-pointer px-2 py-1 font-mono">
        <span className={tool.status === "error" ? "text-red-600" : "text-gray-500"}>
          {TOOL_ICON[tool.status]}
        </span>{" "}
        <span className="font-semibold">{tool.name}</span>
        {tool.preview && <span className="text-gray-400"> · {tool.preview}</span>}
      </summary>
      <div className="space-y-2 px-2 pb-2">
        {tool.input && (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-gray-700">
            {tool.input}
          </pre>
        )}
        {tool.output && (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-gray-500">
            {tool.output}
          </pre>
        )}
      </div>
    </details>
  );
}

function FileAttachment({ part }: { part: FilePart }) {
  const file = viewFile(part);
  const label = file.mediaType ? `${file.label} · ${file.mediaType}` : file.label;
  return (
    <div className="my-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700">
      {file.url ? (
        <a
          className="font-medium text-blue-700 underline"
          href={file.url}
          target="_blank"
          rel="noreferrer"
        >
          {label}
        </a>
      ) : (
        <span className="font-medium">{label}</span>
      )}
    </div>
  );
}
