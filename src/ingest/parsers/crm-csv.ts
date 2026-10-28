import type { NormalizedBatch, NormalizedPerson, NormalizedRecord } from "../types";

/** RFC 4180 CSV: quoted fields may contain commas, newlines and doubled quotes. */
export function parseCsv(source: string): string[][] {
  const text = source.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

// Column names used by HubSpot, Zoho CRM and Salesforce exports, most specific first.
const ID_COLUMNS = ["record id", "id", "deal id", "contact id", "company id", "account id", "lead id", "task id", "ticket id", "record_id"];
const TITLE_COLUMNS = [
  "deal name",
  "opportunity name",
  "potential name",
  "account name",
  "company name",
  "ticket name",
  "subject",
  "title",
  "full name",
  "name",
];
const OWNER_COLUMNS = ["deal owner", "contact owner", "company owner", "account owner", "opportunity owner", "record owner", "owner", "assigned to"];
const OWNER_EMAIL_COLUMNS = ["owner email", "deal owner email", "record owner email"];
const UPDATED_COLUMNS = ["last modified date", "modified time", "last modified time", "last activity date", "updated at", "last modified"];

const find = (header: string[], names: string[]) => {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const n of names) {
    const i = lower.indexOf(n);
    if (i !== -1) return i;
  }
  return -1;
};

export interface CrmCsvOptions {
  /** e.g. "hubspot", "zoho", "salesforce". Becomes the connection provider "upload:crm:<crm>". */
  crm: string;
  /** deal | account | contact | lead | task | note | ticket. */
  type: string;
  /** The CRM instance (domain or org id), so re-imports update the same records. */
  account: string;
  /** Builds a link back to the record, e.g. id => `https://app.hubspot.com/contacts/123/deal/${id}`. */
  recordUrl?: (id: string) => string;
}

/**
 * Turns a CRM export (one object type per file) into records. Without an id
 * column, the title is the id, so renamed records show up as new ones.
 */
export function crmCsvToBatch(source: string, options: CrmCsvOptions): NormalizedBatch {
  const [header, ...rows] = parseCsv(source);
  if (!header) throw new Error("The CSV file is empty");
  const idCol = find(header, ID_COLUMNS);
  const titleCol = find(header, TITLE_COLUMNS);
  const firstCol = find(header, ["first name"]);
  const lastCol = find(header, ["last name"]);
  if (titleCol === -1 && firstCol === -1 && lastCol === -1) {
    throw new Error(`Couldn't find a name column. Expected one of: ${TITLE_COLUMNS.join(", ")}`);
  }
  const ownerCol = find(header, OWNER_COLUMNS);
  const ownerEmailCol = find(header, OWNER_EMAIL_COLUMNS);
  const updatedCol = find(header, UPDATED_COLUMNS);

  const people = new Map<string, NormalizedPerson>();
  const records: NormalizedRecord[] = [];
  for (const row of rows) {
    const cell = (i: number) => (i === -1 ? "" : (row[i] ?? "").trim());
    const title = cell(titleCol) || [cell(firstCol), cell(lastCol)].filter(Boolean).join(" ");
    if (!title) continue;
    const externalId = cell(idCol) || title;

    let ownerKey: string | undefined;
    const ownerName = cell(ownerCol);
    const ownerEmail = cell(ownerEmailCol).toLowerCase() || (ownerName.includes("@") ? ownerName.toLowerCase() : "");
    if (ownerName || ownerEmail) {
      ownerKey = `${options.crm}:${ownerEmail || ownerName.toLowerCase()}`;
      if (!people.has(ownerKey)) {
        people.set(ownerKey, {
          key: ownerKey,
          provider: options.crm,
          externalId: ownerEmail || ownerName.toLowerCase(),
          displayName: ownerName && !ownerName.includes("@") ? ownerName : ownerEmail,
          email: ownerEmail || undefined,
        });
      }
    }

    const fields = Object.fromEntries(
      header.map((h, i) => [h.trim(), (row[i] ?? "").trim()] as const).filter(([h]) => h !== ""),
    );
    const updated = cell(updatedCol);
    const updatedAt = updated ? new Date(updated) : undefined;
    records.push({
      type: options.type,
      externalId,
      title,
      fields,
      ownerKey,
      url: options.recordUrl?.(externalId),
      sourceUpdatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : undefined,
    });
  }

  return {
    connection: { provider: `upload:crm:${options.crm}`, scope: "org", externalAccountId: options.account },
    people: [...people.values()],
    threads: [],
    messages: [],
    records,
  };
}
