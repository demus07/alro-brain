import {
  auth,
  createMCPClient,
  UnauthorizedError,
  type ListToolsResult,
  type MCPClient,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import { and, eq, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { mcpServers, type LiveToolInfo } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { isPrivateHost } from "@/lib/net";
import { deleteSecret, readSecret, saveSecret, sign, verify } from "@/lib/secrets";

/**
 * Live tools: MCP servers the agent queries at the moment someone asks (a CRM, sheets,
 * accounting, the online store). Nothing is copied into memory. A server is reached with
 * a pasted token, or by signing in when it supports OAuth with dynamic registration.
 * Tools that read are switched on by default. Tools that change things are off until someone
 * switches them on, and even then each call waits for the asker's approval (src/approvals).
 */
type ServerRow = typeof mcpServers.$inferSelect;

interface McpSecret {
  /** A pasted bearer token. */
  token?: string;
  tokens?: OAuthTokens;
  client?: OAuthClientInformation;
  verifier?: string;
  state?: string;
  authServer?: OAuthAuthorizationServerInformation;
}

const CONNECT_TIMEOUT_MS = 8000;
const MAX_RESULT_CHARS = 12_000;
const READ_VERBS = /^(get|list|search|read|fetch|find|query|lookup|describe|count|show|view|retrieve)([_\-A-Z]|$)/;

/** Tools on by default: ones the server marks read-only, or unmarked ones whose name starts with a reading verb. */
export function defaultEnabled(t: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): boolean {
  if (t.annotations?.readOnlyHint === true) return true;
  if (t.annotations?.readOnlyHint === false || t.annotations?.destructiveHint === true) return false;
  return READ_VERBS.test(t.name);
}

/** Tools that change things (or might: unmarked, without a reading verb). When switched on, every call waits for approval. */
export const changesThings = (t: LiveToolInfo) => t.readOnly === false || (t.readOnly === null && !READ_VERBS.test(t.name));

/** A switched-on tool that changes things, offered to the agent only as a proposal. */
export interface WriteTool {
  /** The agent-facing name, e.g. "stripe_create_refund". */
  name: string;
  tool: string;
  server: string;
  serverId: string;
  description?: string;
  /** The server's JSON Schema for the tool's input. */
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
}

/** The server's current tools, keeping any on/off choice already made. */
export function mergeTools(listed: ListToolsResult["tools"], stored: LiveToolInfo[]): LiveToolInfo[] {
  const before = new Map(stored.map((t) => [t.name, t]));
  return listed.map((t) => {
    const readOnly = t.annotations?.readOnlyHint ?? (t.annotations?.destructiveHint ? false : null);
    const info = { name: t.name, description: t.description?.slice(0, 300), readOnly };
    return { ...info, enabled: before.get(t.name)?.enabled ?? defaultEnabled(t) };
  });
}

/** Only https servers on public hosts: this URL is fetched from ALRO's own server. */
export function checkServerUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("That isn't a valid URL.");
  }
  // Local servers are allowed while developing, never once deployed.
  if (process.env.NODE_ENV !== "development" && (url.protocol !== "https:" || isPrivateHost(url.hostname))) throw new Error("Live-tool servers must be public https URLs.");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Live-tool servers must be https URLs.");
  return url;
}

export const mcpRedirect = (origin: string) => `${(process.env.ALRO_APP_URL ?? origin).replace(/\/$/, "")}/api/mcp/callback`;

/** OAuth state for one server, kept encrypted in `secrets`. */
class StoredSignIn implements OAuthClientProvider {
  /** Set when the server asks the person to sign in. */
  redirectTo?: URL;
  constructor(
    private db: Db,
    private server: Pick<ServerRow, "id" | "orgId">,
    private origin: string,
    private data: McpSecret,
  ) {}
  private save = () => saveSecret(this.db, this.server.orgId, "mcp", this.server.id, this.data);
  get redirectUrl() {
    return mcpRedirect(this.origin);
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "ALRO", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  tokens = () => this.data.tokens;
  saveTokens = async (tokens: OAuthTokens) => {
    this.data.tokens = tokens;
    await this.save();
  };
  redirectToAuthorization = (url: URL) => {
    this.redirectTo = url;
  };
  saveCodeVerifier = async (verifier: string) => {
    this.data.verifier = verifier;
    await this.save();
  };
  codeVerifier = () => {
    if (!this.data.verifier) throw new Error("No sign-in in progress");
    return this.data.verifier;
  };
  clientInformation = () => this.data.client;
  saveClientInformation = async (client: OAuthClientInformation) => {
    this.data.client = client;
    await this.save();
  };
  isClientInformationDynamicallyRegistered = () => true;
  authorizationServerInformation = () => this.data.authServer;
  saveAuthorizationServerInformation = async (info: OAuthAuthorizationServerInformation) => {
    this.data.authServer = info;
    await this.save();
  };
  // The state names the server, so the callback knows which sign-in it's finishing.
  state = () => sign({ s: this.server.id }, 10 * 60 * 1000);
  saveState = async (state: string) => {
    this.data.state = state;
    await this.save();
  };
  storedState = () => this.data.state;
  invalidateCredentials = async (scope: "all" | "client" | "tokens" | "verifier") => {
    if (scope === "all" || scope === "tokens") this.data.tokens = undefined;
    if (scope === "all" || scope === "client") this.data.client = undefined;
    if (scope === "all" || scope === "verifier") this.data.verifier = undefined;
    await this.save();
  };
}

async function open(db: Db, server: ServerRow, origin: string): Promise<{ client?: MCPClient; signIn?: URL }> {
  const secret = (await readSecret<McpSecret>(db, "mcp", server.id)) ?? {};
  const provider = secret.token ? undefined : new StoredSignIn(db, server, origin, secret);
  try {
    const client = await createMCPClient({
      clientName: "ALRO",
      transport: { type: "http", url: server.url, headers: secret.token ? { authorization: `Bearer ${secret.token}` } : undefined, authProvider: provider },
      initializationOptions: { timeout: CONNECT_TIMEOUT_MS },
    });
    return { client };
  } catch (e) {
    if (provider?.redirectTo && (e instanceof UnauthorizedError || /unauthori[sz]ed/i.test(String(e)))) return { signIn: provider.redirectTo };
    throw e;
  }
}

/**
 * Connects to a server and stores what it offers. Returns a sign-in URL when the
 * server wants the person to authorise ALRO first.
 */
export async function refreshServer(db: Db, server: ServerRow, origin: string): Promise<{ signIn?: string }> {
  try {
    const { client, signIn } = await open(db, server, origin);
    if (!client) {
      await db.update(mcpServers).set({ status: "needs_auth", authKind: "oauth", lastError: null }).where(eq(mcpServers.id, server.id));
      return { signIn: signIn?.toString() };
    }
    try {
      const listed = await client.listTools();
      await db.update(mcpServers).set({ status: "active", lastError: null, tools: mergeTools(listed.tools, server.tools) }).where(eq(mcpServers.id, server.id));
    } finally {
      await client.close();
    }
    return {};
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.update(mcpServers).set({ status: "error", lastError: message.slice(0, 500) }).where(eq(mcpServers.id, server.id));
    throw new Error(`Couldn't reach that server: ${message.slice(0, 200)}`);
  }
}

export async function addServer(db: Db, viewer: Viewer, input: { name: string; url: string; token?: string; scope: "org" | "personal" }, origin: string): Promise<{ id: string; signIn?: string }> {
  const url = checkServerUrl(input.url);
  const [server] = await db
    .insert(mcpServers)
    .values({ orgId: viewer.orgId, scope: input.scope, ownerPersonId: viewer.personId, name: input.name.trim() || url.hostname, url: url.toString(), authKind: input.token ? "bearer" : "none" })
    .returning();
  if (input.token) await saveSecret(db, viewer.orgId, "mcp", server.id, { token: input.token } satisfies McpSecret);
  try {
    return { id: server.id, ...(await refreshServer(db, server, origin)) };
  } catch (e) {
    // Nothing useful was added: don't leave a dead entry behind.
    await removeServer(db, viewer, server.id);
    throw e;
  }
}

/** The server sent the person back with a code: finish the sign-in and load its tools. */
export async function finishSignIn(db: Db, viewer: Viewer, state: string, code: string, origin: string) {
  const claim = verify<{ s: string }>(state);
  const server = claim && (await visibleServer(db, viewer, claim.s));
  if (!server) throw new Error("That sign-in link expired. Add the server again.");
  const provider = new StoredSignIn(db, server, origin, (await readSecret<McpSecret>(db, "mcp", server.id)) ?? {});
  await auth(provider, { serverUrl: server.url, authorizationCode: code, callbackState: state });
  await refreshServer(db, server, origin);
}

const visibleTo = (viewer: Viewer) => and(eq(mcpServers.orgId, viewer.orgId), or(eq(mcpServers.scope, "org"), eq(mcpServers.ownerPersonId, viewer.personId)));

async function visibleServer(db: Db, viewer: Viewer, id: string): Promise<ServerRow | undefined> {
  const [server] = await db.select().from(mcpServers).where(and(eq(mcpServers.id, id), visibleTo(viewer)));
  return server;
}

export const listServers = (db: Db, viewer: Viewer) => db.select().from(mcpServers).where(visibleTo(viewer)).orderBy(mcpServers.name);

/** Only whoever added a server can remove it or change its tools. */
async function ownServer(db: Db, viewer: Viewer, id: string): Promise<ServerRow> {
  const server = await visibleServer(db, viewer, id);
  if (!server || server.ownerPersonId !== viewer.personId) throw new Error("Only the person who added this server can change it.");
  return server;
}

export async function removeServer(db: Db, viewer: Viewer, id: string) {
  const server = await ownServer(db, viewer, id);
  await db.delete(mcpServers).where(eq(mcpServers.id, server.id));
  await deleteSecret(db, "mcp", server.id);
}

export async function setToolEnabled(db: Db, viewer: Viewer, id: string, tool: string, enabled: boolean) {
  const server = await ownServer(db, viewer, id);
  const tools = server.tools.map((t) => (t.name === tool ? { ...t, enabled } : t));
  await db.update(mcpServers).set({ tools }).where(eq(mcpServers.id, server.id));
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) || "tool";

/** Very large results cost a lot and crowd out the answer: cut long text parts. */
function clip(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return result;
  let budget = MAX_RESULT_CHARS;
  const content = result.content.map((part: { type?: string; text?: string }) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    const text = part.text.length > budget ? `${part.text.slice(0, Math.max(budget, 0))}\n[cut: result too long, ask for less]` : part.text;
    budget -= text.length;
    return { ...part, text };
  });
  return { ...result, content };
}

const agentName = (server: string, tool: string) => `${slug(server)}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/**
 * Calls one tool on a server, after its proposal was approved. Returns the result as text.
 */
export async function callMcpTool(db: Db, server: ServerRow, name: string, input: unknown): Promise<string> {
  const { client } = await open(db, server, process.env.ALRO_APP_URL ?? "http://localhost:3000");
  if (!client) throw new Error(`${server.name} needs signing in again`);
  try {
    const listed = await client.listTools();
    const def = listed.tools.find((t) => t.name === name);
    if (!def) throw new Error(`${server.name} no longer offers ${name}`);
    const set = client.toolsFromDefinitions({ ...listed, tools: [def] }) as ToolSet;
    const run = Object.values(set)[0]?.execute as ((input: unknown, options: unknown) => Promise<unknown>) | undefined;
    if (!run) throw new Error(`${name} can't be called`);
    const out = clip(await run(input, { toolCallId: "approved", messages: [] })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (out.content ?? []).flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n").slice(0, 2000);
    if (out.isError) throw new Error(text || `${name} failed`);
    return text || "Done";
  } finally {
    await client.close();
  }
}

/**
 * The switched-on tools of every live-tool server the member can use, ready for the agent.
 * Reading tools run directly; tools that change things come back in `writes`, to be offered
 * only as proposals. A server that's down is skipped (and marked), never fatal. Call `close`
 * when the answer is done.
 */
export async function mcpTools(db: Db, viewer: Viewer, origin: string): Promise<{ tools: ToolSet; writes: WriteTool[]; servers: string[]; close: () => Promise<void> }> {
  const servers = (await listServers(db, viewer)).filter((s) => s.status === "active" && s.tools.some((t) => t.enabled));
  const clients: MCPClient[] = [];
  const tools: ToolSet = {};
  const writes: WriteTool[] = [];
  const used: string[] = [];
  for (const server of servers) {
    try {
      const { client } = await open(db, server, origin);
      if (!client) {
        await db.update(mcpServers).set({ status: "needs_auth" }).where(eq(mcpServers.id, server.id));
        continue;
      }
      clients.push(client);
      const enabled = new Set(server.tools.filter((t) => t.enabled && !changesThings(t)).map((t) => t.name));
      const writing = new Set(server.tools.filter((t) => t.enabled && changesThings(t)).map((t) => t.name));
      const listed = await client.listTools();
      for (const t of listed.tools.filter((t) => writing.has(t.name))) {
        writes.push({ name: agentName(server.name, t.name), tool: t.name, server: server.name, serverId: server.id, description: t.description, inputSchema: t.inputSchema as WriteTool["inputSchema"] });
      }
      const set = client.toolsFromDefinitions({ ...listed, tools: listed.tools.filter((t) => enabled.has(t.name)) }) as ToolSet;
      for (const [name, t] of Object.entries(set)) {
        const run = t.execute as ((input: unknown, options: unknown) => unknown) | undefined;
        const clipped = run ? ({ ...t, execute: async (input: unknown, options: unknown) => clip(await run(input, options)) } as typeof t) : t;
        tools[agentName(server.name, name)] = clipped;
      }
      used.push(server.name);
    } catch (e) {
      console.error(`live tools: ${server.name} is unreachable`, e instanceof Error ? e.message : e);
      await db.update(mcpServers).set({ lastError: (e instanceof Error ? e.message : String(e)).slice(0, 500) }).where(eq(mcpServers.id, server.id));
    }
  }
  return { tools, writes, servers: used, close: async () => void (await Promise.allSettled(clients.map((c) => c.close()))) };
}
