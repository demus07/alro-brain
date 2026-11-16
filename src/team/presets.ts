/**
 * Ready-made departments for the agent team. Each specialist sees only the tools its job
 * needs (prefixes match every tool of a connected app, e.g. "xero_"). Tools of apps that
 * aren't connected are simply absent. Admins add departments and specialists on the Team page.
 */
export interface SpecialistPreset {
  name: string;
  job: string;
  tools: string[];
  /** Model steps it may take on one task when the usual eight aren't enough (one lookup per customer, then a draft each). */
  steps?: number;
}

export interface DepartmentPreset {
  id: string;
  label: string;
  lead: string;
  specialists: SpecialistPreset[];
}

const MEMORY = ["searchMemory", "readThread", "lookupEntity", "dailySummaries"];
const PROMISES = ["listCommitments", "commitmentHistory"];
const EMAIL = ["gmail_send_email", "outlook_send_email"];
const ACCOUNTS = ["xero_", "quickbooks_", "stripe_", "razorpay_", "sheets_"];
const CRM = ["hubspot_", "pipedrive_", "zoho_", "salesforce_"];
const STORE = ["shopify_"];
const SUPPORT = ["freshdesk_", "intercom_"];

export const DEPARTMENTS: DepartmentPreset[] = [
  {
    id: "finance",
    label: "Finance",
    lead: "CFO",
    specialists: [
      {
        name: "Collections",
        job: "Chase overdue payments. Find unpaid invoices past their due date in the accounting and payment tools, biggest first. For each customer, check memory for what they last said about paying (a promised date, a dispute). Draft a short, polite chaser for each that names the invoice number, amount and due date and mentions what they last said, and propose it as an email for approval. Don't chase anyone who disputed the invoice or promised a date that hasn't passed yet: list them separately with why.",
        tools: [...ACCOUNTS, ...MEMORY, ...PROMISES, ...EMAIL],
        steps: 12,
      },
      {
        name: "Reconciliation",
        job: "Match payments received to invoices. List payments in the period with the invoice each one paid. Flag payments with no matching invoice, part payments, and invoices still open although the customer says they paid (check memory).",
        tools: [...ACCOUNTS, ...MEMORY],
      },
      {
        name: "Cash report",
        job: "Write the cash report: cash in the bank per account, money in and out over the last 7 days, receivables and payables due in the next 14 days, the five biggest overdue receivables, and the three biggest risks you can see in the numbers or in what people said. Numbers first, short.",
        tools: [...ACCOUNTS, ...MEMORY, ...PROMISES],
      },
    ],
  },
  {
    id: "sales",
    label: "Sales",
    lead: "Head of Sales",
    specialists: [
      {
        name: "Quotes",
        job: "When a customer asks for a price or a quote, pull their past orders for the same product or grade (online store, CRM, sheets, emails), the price they last paid and any terms agreed. Draft the quote reply at consistent pricing and propose it as an email for approval. Say what they paid before and where that came from.",
        tools: [...STORE, ...CRM, "sheets_", ...MEMORY, ...EMAIL],
        steps: 12,
      },
      {
        name: "Pipeline",
        job: "Review the open pipeline: deals stuck in a stage, deals whose next step is overdue, proposals or documents promised but not sent. One line each with the owner and the next step.",
        tools: [...CRM, ...MEMORY, ...PROMISES],
      },
      {
        name: "Follow-ups",
        job: "Find customer conversations and meetings from the last week that are waiting on us: unanswered questions, promised documents, next steps nobody took. Draft each follow-up and propose it for approval (email, or a CRM note or task).",
        tools: [...CRM, ...MEMORY, ...PROMISES, ...EMAIL],
        steps: 12,
      },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    lead: "COO",
    specialists: [
      {
        name: "What slipped",
        job: "Find what slipped: promises past due, tasks overdue, threads where someone has waited more than two days for a reply. Who owns each and what they last said.",
        tools: [...MEMORY, ...PROMISES],
      },
      {
        name: "Procedures",
        job: "Answer how things are done here from the written-up procedures and the conversations behind them. Point out where people do the same thing differently, and steps that keep going wrong.",
        tools: ["findProcedure", ...MEMORY],
      },
      {
        name: "Trackers",
        job: "Report from the trackers (sales log, stock, receivables, turnaround times): totals, what changed since last week, and anything unusual.",
        tools: ["readTracker", ...MEMORY],
      },
    ],
  },
  {
    id: "marketing",
    label: "Marketing",
    lead: "CMO",
    specialists: [
      {
        name: "Customer voice",
        job: "Read support tickets, calls and emails for what customers praise, complain about and ask for. Group them into themes with a count and one quote each.",
        tools: [...SUPPORT, ...MEMORY],
      },
      {
        name: "Content",
        job: "Turn recent wins, launches and customer stories into short post drafts in the founder's voice. Say which conversation each idea came from.",
        tools: MEMORY,
      },
    ],
  },
  {
    id: "tech",
    label: "Tech",
    lead: "CTO",
    specialists: [
      {
        name: "Delivery",
        job: "Report on engineering work: what shipped, what is blocked, what is late against what was promised, from issue trackers, code reviews and chat.",
        tools: [...MEMORY, ...PROMISES, "linear_create_issue"],
      },
    ],
  },
];

export const departmentOf = (id: string) => DEPARTMENTS.find((d) => d.id === id);
export const departmentLabel = (id: string) => departmentOf(id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1);
