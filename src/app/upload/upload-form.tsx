"use client";

import { useState } from "react";

interface Result {
  provider: string;
  threads: number;
  messages: { inserted: number; skipped: number };
  records?: { upserted: number; changed: number };
}

export function UploadForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [results, setResults] = useState<Result[]>();
  const [hasCsv, setHasCsv] = useState(false);
  const [hasWhatsApp, setHasWhatsApp] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setResults(undefined);
    try {
      const response = await fetch("/api/uploads", { method: "POST", body: new FormData(event.currentTarget) });
      const body = await response.json();
      if (!response.ok) setError(body.error ?? `Upload failed (${response.status})`);
      else setResults(body.results);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>
        Files
        <input
          type="file"
          name="files"
          multiple
          required
          accept=".zip,.txt,.eml,.mbox,.vtt,.csv"
          onChange={(e) => {
            const names = [...(e.currentTarget.files ?? [])].map((f) => f.name.toLowerCase());
            setHasCsv(names.some((n) => n.endsWith(".csv")));
            setHasWhatsApp(names.some((n) => n.endsWith(".txt") || n.startsWith("whatsapp chat")));
          }}
        />
      </label>

      {hasWhatsApp && (
        <div className="row">
          <label>
            Your name in these chats (if different from your ALRO name)
            <input name="whatsAppName" placeholder="e.g. Rohan K" />
          </label>
          <label>
            Your phone&apos;s time zone offset
            <input name="utcOffset" placeholder="+05:30" pattern="[+-]\d{2}:?\d{2}" />
          </label>
        </div>
      )}

      {hasCsv && (
        <div className="row">
          <label>
            CRM
            <select name="crm" required defaultValue="hubspot">
              <option value="hubspot">HubSpot</option>
              <option value="zoho">Zoho CRM</option>
              <option value="salesforce">Salesforce</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>
            What the file holds
            <select name="crmType" required defaultValue="deal">
              <option value="deal">Deals</option>
              <option value="account">Accounts / companies</option>
              <option value="contact">Contacts</option>
              <option value="lead">Leads</option>
              <option value="task">Tasks</option>
              <option value="note">Notes</option>
              <option value="ticket">Tickets</option>
            </select>
          </label>
          <label>
            CRM account (domain or org id)
            <input name="crmAccount" placeholder="e.g. acme.zoho.in" />
          </label>
        </div>
      )}

      <button type="submit" disabled={busy}>
        {busy ? "Uploading…" : "Upload"}
      </button>

      {error && <p className="error">{error}</p>}
      {results && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Threads</th>
                <th>New messages</th>
                <th>Already there</th>
                <th>Records (changed)</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td>{r.provider}</td>
                  <td>{r.threads}</td>
                  <td>{r.messages.inserted}</td>
                  <td>{r.messages.skipped}</td>
                  <td>{r.records ? `${r.records.upserted} (${r.records.changed})` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">New messages are searchable after the next processing run.</p>
        </div>
      )}
    </form>
  );
}
