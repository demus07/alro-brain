import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { activeFaqs, chatMessages, listChats } from "@/business/assistant";
import { deskSettings } from "@/business/settings";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";
import { isAdmin } from "@/platform/roles";
import { ActionForm, RowButton } from "../desk-form";
import { dropFaq, handBack, newFaq, replyToCustomer, saveAssistant } from "../desk-actions";

export const metadata: Metadata = { title: "Customers · ALRO" };

export default function CustomersPage() {
  return (
    <>
      <h1>Customers</h1>
      <p className="muted">
        When this is on, people who message your WhatsApp number get answers from the approved answers below and nothing else. Anything it can&apos;t answer is handed to you, and the customer is told a person will reply.
        Customers can send STOP at any time.
      </p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Customers />
      </Suspense>
    </>
  );
}

async function Customers() {
  await connection();
  const viewer = await getViewer();
  if (!isAdmin(viewer)) return <p className="muted">Only owners and admins can manage customer chats.</p>;
  const db = getDb();
  const [desk, faqs, chats] = await Promise.all([deskSettings(db, viewer.orgId), activeFaqs(db, viewer.orgId), listChats(db, viewer.orgId)]);
  const threads = await Promise.all(chats.slice(0, 15).map(async (c) => ({ c, messages: (await chatMessages(db, viewer.orgId, c.id)).slice(-8) })));
  return (
    <div className="split">
      <section className="column">
        <p className="label">Conversations</p>
        {threads.length === 0 && <p className="muted">No customer has written yet.</p>}
        {threads.map(({ c, messages }) => (
          <article key={c.id} className="card">
            <header className="card-head">
              <strong>{c.name ?? `+${c.externalUser}`}</strong> · {c.status === "waiting" ? "needs you" : c.status === "human" ? "you're handling it" : c.handoffReason === "opted out" ? "opted out" : "assistant"}
            </header>
            {messages.map((m) => (
              <p key={m.id} className={m.sender === "customer" ? undefined : "muted"}>
                {m.sender === "customer" ? "Customer" : m.sender === "bot" ? "Assistant" : "You"}: {m.text}
              </p>
            ))}
            {c.handoffReason !== "opted out" && (
              <ActionForm action={replyToCustomer} button="Send reply" className="stack">
                <input type="hidden" name="id" value={c.id} />
                <textarea name="text" rows={2} placeholder="Your reply (sent on WhatsApp as you wrote it)" required />
              </ActionForm>
            )}
            {(c.status === "waiting" || c.status === "human") && c.handoffReason !== "opted out" && <RowButton action={handBack} id={c.id} label="Let the assistant take over again" />}
          </article>
        ))}
      </section>
      <section className="column">
        <p className="label">The assistant</p>
        <ActionForm action={saveAssistant} button="Save" className="stack">
          <label>
            <input type="checkbox" name="enabled" defaultChecked={Boolean(desk.customerAssistant)} /> Answer customers on WhatsApp
          </label>
          <label>
            Facts it may state (hours, address, how to reach you)
            <textarea name="info" rows={4} defaultValue={desk.businessInfo ?? ""} />
          </label>
        </ActionForm>
        <p className="label">Approved answers · {faqs.length}</p>
        {faqs.map((f) => (
          <article key={f.id} className="card">
            <strong>{f.question}</strong>
            <p>{f.answer}</p>
            <RowButton action={dropFaq} id={f.id} label="Remove" />
          </article>
        ))}
        <ActionForm action={newFaq} button="Add answer" className="stack">
          <input name="question" placeholder="Do you deliver?" required />
          <textarea name="answer" rows={3} placeholder="Yes, within Mumbai the next working day." required />
        </ActionForm>
      </section>
    </div>
  );
}
