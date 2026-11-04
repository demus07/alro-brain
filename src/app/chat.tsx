"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import Link from "next/link";
import { useEffect, useState } from "react";
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

/** Light Markdown: **bold** and #-headings (shown bold); lists and line breaks already read fine as text. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text
        .replace(/^#{1,4}\s+(.*)$/gm, "**$1**")
        .split(/\*\*(.+?)\*\*/g)
        .map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))}
    </>
  );
}

/** A citation: [n] opens a card with the excerpt and a link to the message in its conversation. */
function Cite({ n, source }: { n: number; source: Source }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="cite">
      <button type="button" className="cite-ref" aria-expanded={open} onClick={() => setOpen(!open)}>
        {n}
      </button>
      {open && (
        <span className="cite-card" role="dialog">
          <span className="small">
            <strong>{source.thread}</strong> <span className="muted">· {source.at}{source.author ? ` · ${source.author}` : ""}</span>
          </span>
          <span className="small cite-text">{source.text.length > 360 ? `${source.text.slice(0, 360)}…` : source.text}</span>
          <span className="chips">
            {source.messageId && (
              <Link className="link small" href={`/m/${source.messageId}#cited`}>
                Open conversation →
              </Link>
            )}
            {source.url && (
              <a className="link small" href={source.url} target="_blank" rel="noreferrer">
                Open in app ↗
              </a>
            )}
          </span>
        </span>
      )}
    </span>
  );
}

function Answer({ text, sources }: { text: string; sources: Map<string, Source> }) {
  const cited: Source[] = [];
  const pieces = text.split(/\[((?:S\d+)(?:\s*[,–-]\s*S\d+)*)\]/g).map((piece, i) => {
    if (i % 2 === 0) return <Rich key={i} text={piece} />;
    return piece.split(/\s*[,–-]\s*/).map((ref) => {
      const s = sources.get(ref);
      if (!s) return null;
      if (!cited.includes(s)) cited.push(s);
      return <Cite key={`${i}-${ref}`} n={cited.indexOf(s) + 1} source={s} />;
    });
  });
  return (
    <>
      <div className="answer">{pieces}</div>
      {cited.length > 0 && (
        <ol className="cites muted small">
          {cited.map((s) => (
            <li key={s.ref}>
              {s.messageId ? (
                <Link className="link" href={`/m/${s.messageId}#cited`}>
                  {s.thread}
                </Link>
              ) : (
                <strong>{s.thread}</strong>
              )}{" "}
              · {s.at}
              {s.author ? ` · ${s.author}` : ""}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** Follow-up questions for the latest answer, from the cheapest model. */
function FollowUps({ question, answer, onAsk }: { question: string; answer: string; onAsk: (q: string) => void }) {
  const [questions, setQuestions] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/followups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, answer }) })
      .then((r) => (r.ok ? r.json() : { questions: [] }))
      .then((r: { questions: string[] }) => !cancelled && setQuestions(r.questions))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [question, answer]);
  if (!questions.length) return null;
  return (
    <div className="suggestions left">
      {questions.map((q) => (
        <button key={q} type="button" className="ghost" onClick={() => onAsk(q)}>
          {q}
        </button>
      ))}
    </div>
  );
}

const textOf = (m: UIMessage) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

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
    <div className="chat">
      <div className="chat-log">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p className="label center">Ask ALRO</p>
            <p className="lead center">Anything said in Slack, email, WhatsApp, meetings or the CRM, answered with sources.</p>
            <div className="suggestions">
              {EXAMPLES.map((q) => (
                <button key={q} type="button" className="ghost" onClick={() => ask(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => {
          const sources = sourcesOf(m);
          return (
            <div key={m.id} className={m.role === "user" ? "turn you" : "turn card"}>
              {m.role !== "user" && <span className="label">ALRO</span>}
              {m.parts.map((part, i) => {
                if (part.type === "text") return m.role === "user" ? <div key={i}>{part.text}</div> : <Answer key={i} text={part.text} sources={sources} />;
                if (part.type.startsWith("tool-") && "state" in part && part.state !== "output-available") {
                  const name = part.type.slice(5);
                  return (
                    <div key={i} className="muted small mono">
                      {part.state === "output-error" ? `Couldn't finish ${name}` : `${TOOL_LABELS[name] ?? name}…`}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          );
        })}

        {status === "ready" && messages.length >= 2 && messages.at(-1)!.role === "assistant" && (
          <FollowUps key={messages.at(-1)!.id} question={textOf(messages.at(-2)!)} answer={textOf(messages.at(-1)!)} onAsk={ask} />
        )}

        {error && <p className="error">Something went wrong: {error.message}</p>}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <textarea
          rows={2}
          value={input}
          placeholder="Ask about anything your team has said"
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
    </div>
  );
}
