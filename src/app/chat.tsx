"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import Link from "next/link";
import { BorderBeam } from "border-beam";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Source } from "@/agent/tools";
import { useResolvedTheme } from "./theme-toggle";

const TOOL_LABELS: Record<string, string> = {
  searchMemory: "Searching",
  readThread: "Reading the thread",
  listCommitments: "Checking commitments",
  commitmentHistory: "Checking what happened",
  lookupEntity: "Looking up facts",
  dailySummaries: "Reading summaries",
  listInsights: "Checking what needs attention",
  askTeam: "The team is working on it",
  findProcedure: "Checking how it's done",
  readTracker: "Reading the tracker",
  rememberAboutMe: "Remembering that",
  saveNote: "Saving a note",
  scheduleTask: "Scheduling",
  listScheduledTasks: "Checking your schedule",
  cancelScheduledTask: "Cancelling",
  sheets_find: "Looking in Google Sheets",
  sheets_read: "Reading the sheet",
  hubspot_search: "Looking in HubSpot",
};

const EXAMPLES = ["What do I owe people this week?", "Who am I waiting on?", "What changed since yesterday?", "Draft a reminder for my oldest overdue promise", "Interview me so you know how I work"];

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

/** "To:" / "Subject:" lines and the body of a ```draft block. */
function parseDraft(block: string) {
  const to = block.match(/^To:\s*(.*)$/m)?.[1]?.trim() ?? "";
  const subject = block.match(/^Subject:\s*(.*)$/m)?.[1]?.trim() ?? "";
  const body = block.replace(/^(To|Subject):.*\n?/gm, "").trim();
  return { to, subject, body };
}

/** A message the agent wrote. ALRO never sends anything: copy it, or open it in the app that will. */
function Draft({ block }: { block: string }) {
  const { to, subject, body } = parseDraft(block);
  const [copied, setCopied] = useState(false);
  const email = /\S+@\S+/.exec(to)?.[0] ?? "";
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return (
    <div className="draft">
      <div className="draft-head small">
        <span className="label">Draft</span>
        {to && <span>To {to}</span>}
        {subject && <span className="muted truncate">{subject}</span>}
      </div>
      <p className="draft-body">{body}</p>
      <div className="chips">
        <button
          type="button"
          className="chip-button"
          onClick={() => {
            navigator.clipboard.writeText(body).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <a className="chip-button" href={gmail} target="_blank" rel="noreferrer">
          Open in Gmail ↗
        </a>
        <a className="chip-button" href={`https://wa.me/?text=${encodeURIComponent(body)}`} target="_blank" rel="noreferrer">
          Send on WhatsApp ↗
        </a>
      </div>
    </div>
  );
}

function Answer({ text, sources }: { text: string; sources: Map<string, Source> }) {
  const cited: Source[] = [];
  // A draft block may still be arriving, so its closing fence is optional.
  const blocks = text.split(/```draft\n([\s\S]*?)(?:```|$)/g);
  const inline = (chunk: string) => chunk.split(/\[((?:S\d+)(?:\s*[,–-]\s*S\d+)*)\]/g).map((piece, i) => {
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
      {blocks.map((b, i) =>
        i % 2 ? (
          <Draft key={i} block={b} />
        ) : b.trim() ? (
          <div key={i} className="answer">
            {inline(b)}
          </div>
        ) : null,
      )}
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

/** Hold-to-talk for the composer: records, sends the audio for speech-to-text, and hands back the words. */
function Mic({ onText, disabled }: { onText: (text: string) => void; disabled: boolean }) {
  const [state, setState] = useState<"idle" | "recording" | "working">("idle");
  const [problem, setProblem] = useState<string>();
  const recorder = useRef<MediaRecorder | null>(null);

  const start = async () => {
    setProblem(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState("working");
        try {
          const res = await fetch("/api/transcribe", { method: "POST", body: new Blob(chunks, { type: rec.mimeType }) });
          const json = (await res.json()) as { text?: string; error?: string };
          if (!res.ok) throw new Error(json.error ?? "Couldn't transcribe that.");
          if (json.text) onText(json.text);
        } catch (e) {
          setProblem((e as Error).message);
        }
        setState("idle");
      };
      recorder.current = rec;
      rec.start();
      setState("recording");
    } catch {
      setProblem("Microphone access is blocked.");
    }
  };

  return (
    <button
      type="button"
      className={`mic${state === "recording" ? " recording" : ""}`}
      disabled={disabled || state === "working"}
      title={problem ?? (state === "recording" ? "Stop and transcribe" : "Speak instead of typing")}
      aria-label={state === "recording" ? "Stop recording" : "Record a voice note"}
      onClick={() => (state === "recording" ? recorder.current?.stop() : start())}
    >
      <svg viewBox="0 0 24 24" aria-hidden>
        {state === "recording" ? <rect x="7" y="7" width="10" height="10" rx="2" /> : <path d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v3" />}
      </svg>
      {state === "working" ? "…" : state === "recording" ? "Stop" : problem ? "Mic off" : "Speak"}
    </button>
  );
}

/**
 * Headings for a new chat, one picked per visit. "{name}" becomes the first name when someone is
 * signed in; without one, the ", {name}" (or " {name}") around it drops out.
 */
const GREETINGS = [
  "I remember so you don't have to, {name}",
  "Who said what, and when? Ask away, {name}",
  "Every thread, every meeting. What's the question, {name}?",
  "Somebody promised something. Let's find out who, {name}",
  "Lost in a 200-message thread, {name}? I've read it",
  "What did we decide, {name}? I was listening",
  "Your company's memory, at your service, {name}",
  "Name the meeting, {name}. I'll tell you what was said",
  "The inbox forgets. I don't, {name}",
  "Ask me what everyone else forgot, {name}",
  "Receipts on request, {name}",
  "Let's dig something up, {name}",
];
const MORNING = ["Morning, {name}. Here's what slipped overnight, if you ask", "Coffee first, {name}? I've already read everything"];
const EVENING = ["Still at it, {name}? I never clocked out", "Late one, {name}? I remember the whole day"];

function pickGreeting(firstName: string | undefined): string {
  const hour = new Date().getHours();
  const pool = [...GREETINGS, ...(hour >= 5 && hour < 11 ? MORNING : []), ...(hour >= 21 || hour < 5 ? EVENING : [])];
  const line = pool[Math.floor(Math.random() * pool.length)]!;
  return firstName ? line.replace("{name}", firstName) : line.replace(/,? \{name\}/, "");
}

/** The new-chat heading: a line about what ALRO does, with the first name when someone is signed in. */
function Greeting({ firstName }: { firstName?: string }) {
  // Random and clock-based, so chosen in the browser after hydration (the server's pick would differ).
  const [line, setLine] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- picked once in the browser, after hydration
  useEffect(() => setLine(pickGreeting(firstName)), [firstName]);
  return (
    <h1 className="chat-title center greeting" data-ready={line !== null}>
      {line ?? "\u00a0"}
    </h1>
  );
}

export function Chat({ firstName }: { firstName?: string }) {
  const { messages, sendMessage, status, error } = useChat({ transport: new DefaultChatTransport({ api: "/api/chat" }) });
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";
  const theme = useResolvedTheme();
  const ask = (text: string) => {
    if (!text.trim() || busy) return;
    sendMessage({ text });
    setInput("");
  };
  // A link like /?ask=… (the interview link in Settings) asks once on arrival.
  const preset = useSearchParams().get("ask");
  const asked = useRef(false);
  useEffect(() => {
    if (!preset || asked.current) return;
    asked.current = true;
    sendMessage({ text: preset });
    window.history.replaceState(null, "", "/");
  }, [preset, sendMessage]);

  return (
    <div className="chat">
      <div className="chat-log">
        {messages.length === 0 && (
          <div className="chat-empty">
            <Greeting firstName={firstName} />
            <p className="muted center">What do you want to know? Anything said across your chats, email and meetings, answered with sources.</p>
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

      {/* The composer stays pinned to the bottom while the conversation scrolls behind it. Its border
          carries an animated beam (border-beam, libraries.dev/beam): a slow welcome on a new, empty
          chat that fades out once the first question is asked. */}
      <div className="composer-dock">
        <BorderBeam className="composer-beam" size="md" colorVariant="colorful" strength={0.7} duration={4} active={messages.length === 0} theme={theme}>
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
              aria-label="Ask ALRO"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  ask(input);
                }
              }}
            />
            <div className="composer-bar">
              <Mic disabled={busy} onText={(text) => setInput((current) => (current ? `${current} ${text}` : text))} />
              <span className="composer-hint">
                <kbd className="kbd">↵</kbd> to ask · <kbd className="kbd">⇧</kbd>
                <kbd className="kbd">↵</kbd> new line
              </span>
              <button type="submit" className="composer-send" disabled={busy || !input.trim()} aria-label={busy ? "Thinking" : "Ask"} title={busy ? "Thinking…" : "Ask"}>
                {busy ? (
                  <span className="composer-spinner" aria-hidden />
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden>
                    <path d="M12 19V5M6 11l6-6 6 6" />
                  </svg>
                )}
              </button>
            </div>
          </form>
        </BorderBeam>
      </div>
    </div>
  );
}
