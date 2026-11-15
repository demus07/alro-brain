import type { ToolSet } from "ai";
import { and, eq, or } from "drizzle-orm";
import { withRetries } from "@/connectors/api";
import { providerOf } from "@/connectors/registry";
import { sessionFor } from "@/connectors/sync";
import type { Db } from "@/db/client";
import { connections } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { sourceOf } from "@/lib/sources";
import { mcpTools, type WriteTool } from "./mcp";

export interface LiveTools {
  tools: ToolSet;
  /** Switched-on server tools that change things, offered only as proposals. */
  writes: WriteTool[];
  /** Names of the systems the tools reach, for the agent's instructions. */
  systems: string[];
  close: () => Promise<void>;
}

/**
 * Everything the agent can query live for this member: connected apps that offer
 * lookups (HubSpot, Google Sheets) and live-tool servers. Team connections are shared;
 * personal ones are only used for the person who connected them.
 */
export async function liveToolsFor(db: Db, viewer: Viewer, origin: string): Promise<LiveTools> {
  const tools: ToolSet = {};
  const systems: string[] = [];
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.orgId, viewer.orgId), eq(connections.status, "active"), or(eq(connections.scope, "org"), eq(connections.ownerPersonId, viewer.personId))));
  for (const c of rows) {
    const provider = providerOf(c.provider);
    if (!provider?.tools) continue;
    try {
      const { api, credentials } = await sessionFor(db, provider, c);
      Object.assign(tools, provider.tools(withRetries(api), { accountId: c.externalAccountId ?? "", credentials }));
      systems.push(sourceOf(c.provider).label);
    } catch (e) {
      console.error(`live tools: ${c.provider} unavailable`, e instanceof Error ? e.message : e);
    }
  }
  const mcp = await mcpTools(db, viewer, origin);
  return { tools: { ...tools, ...mcp.tools }, writes: mcp.writes, systems: [...new Set([...systems, ...mcp.servers])], close: mcp.close };
}
