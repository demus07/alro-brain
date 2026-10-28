"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useState } from "react";
import type { Source } from "@/agent/tools";

const TOOL_LABELS: Record<string, string> = {
  searchMemory: "Searching",
  readThread: "Reading the thread",
  listCommitments: "Checking commitments",
  commitmentHistory: "Checking what happened",
  lookupEntity: "Looking up facts",
  dailySummaries: "Reading summaries",
};

const EXAMPLES = ["What do I owe people this week?", "Who am I waiting on?", "What's our current pricing, and how did it change?", "What's overdue?"];

/** Every cited source in a message's tool results, by ref. */
function sourcesOf(message: UIMessage): Map<string, Source> {
  const found = new Map<string, Source>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    const v = value as Record<string, unknown>;
    if (typeof v.ref === "string" && /^S\d+$/.test(v.ref) && typeof v.thread === "string") found.set(v.ref, v as unknown as Source);
    Object.values(v).forEach(walk);
  };
  for (const part of message.parts) if (part.type.startsWith("tool-") && "output" in part) walk(part.output);
  return found;
}

function Answer({ text, sources }: { text: string; sources: Map<string, Source> }) {
  const cited: Source[] = [];
  const pieces = text.split(/\[((?:S\d+)(?:\s*,\s*S\d+)*)\]/g).map((piece, i) => {
    if (i % 2 === 0) return <span key={i}>{piece}</span>;
    return piece.split(/\s*,\s*/).map((ref) => {
      const s = sources.get(ref);
      if (!s) return null;
      if (!cited.includes(s)) cited.push(s);
      const n = cited.indexOf(s) + 1;
      return (
        <sup key={`${i}-${ref}`} title={`${s.thread} · ${s.at}${s.author ? ` · ${s.author}` : ""}\n${s.text}`}>
          {s.url ? (
            <a className="link" href={s.url} target="_blank" rel="noreferrer">
              [{n}]
            </a>
          ) : (
            <a className="link" href={`#src-${s.ref}`}>
              [{n}]
            </a>
          )}
        </sup>
      );
    });
  });
  return (
    <>
      <div style={{ whiteSpace: "pre-wrap" }}>{pieces}</div>
      {cited.length > 0 && (
        <ol className="muted" style={{ fontSize: 13, paddingLeft: 20, marginTop: 8 }}>
          {cited.map((s) => (
            <li key={s.ref} id={`src-${s.ref}`}>
              <strong>{s.thread}</strong> · {s.at}
              {s.author ? ` · ${s.author}` : ""}: “{s.text.length > 220 ? `${s.text.slice(0, 220)}…` : s.text}”
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

export function Chat() {
  const { messages, sendMessage, status, error } = useChat({ transport: new DefaultChatTransport({ api: "/api/chat" }) });
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";
  const ask = (text: string) => {
    if (!text.trim() || busy) return;
    sendMessage({ text });
    setInput("");
  };

  return (
    <>
      {messages.length === 0 && (
        <div className="row">
          {EXAMPLES.map((q) => (
            <button key={q} type="button" onClick={() => ask(q)} style={{ background: "transparent", color: "inherit", flex: "0 1 auto" }}>
              {q}
            </button>
          ))}
        </div>
      )}

      {messages.map((m) => {
        const sources = sourcesOf(m);
        return (
          <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <strong>{m.role === "user" ? "You" : "ALRO"}</strong>
            {m.parts.map((part, i) => {
              if (part.type === "text") return m.role === "user" ? <div key={i}>{part.text}</div> : <Answer key={i} text={part.text} sources={sources} />;
              if (part.type.startsWith("tool-") && "state" in part && part.state !== "output-available") {
                const name = part.type.slice(5);
                return (
                  <div key={i} className="muted">
                    {part.state === "output-error" ? `Couldn't finish ${name}` : `${TOOL_LABELS[name] ?? name}…`}
                  </div>
                );
              }
              return null;
            })}
          </div>
        );
      })}

      {error && <p className="error">Something went wrong: {error.message}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <textarea
          rows={2}
          value={input}
          placeholder="Ask about anything said in Slack, email, WhatsApp, meetings or the CRM"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(input);
            }
          }}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>
    </>
  );
}
