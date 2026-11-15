import { afterEach, describe, expect, it, vi } from "vitest";
import { changesThings, checkServerUrl, defaultEnabled, mergeTools } from "./mcp";

describe("live tools", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("switches on only tools that read", () => {
    expect(defaultEnabled({ name: "anything", annotations: { readOnlyHint: true } })).toBe(true);
    expect(defaultEnabled({ name: "search_deals" })).toBe(true);
    expect(defaultEnabled({ name: "listInvoices" })).toBe(true);
    expect(defaultEnabled({ name: "create_deal" })).toBe(false);
    expect(defaultEnabled({ name: "getter" })).toBe(false);
    expect(defaultEnabled({ name: "get_and_delete", annotations: { destructiveHint: true } })).toBe(false);
    expect(defaultEnabled({ name: "search_deals", annotations: { readOnlyHint: false } })).toBe(false);
  });

  it("keeps a person's on/off choices, including tools that change things (those ask first)", () => {
    const listed = [
      { name: "search_deals", description: "Find deals", inputSchema: { type: "object" as const } },
      { name: "export_report", inputSchema: { type: "object" as const } },
      { name: "update_deal", annotations: { readOnlyHint: false }, inputSchema: { type: "object" as const } },
    ];
    const stored = [
      { name: "search_deals", readOnly: null, enabled: false },
      { name: "export_report", readOnly: null, enabled: true },
      { name: "update_deal", readOnly: null, enabled: true },
    ];
    expect(mergeTools(listed, stored).map((t) => [t.name, t.readOnly, t.enabled])).toEqual([
      ["search_deals", null, false],
      ["export_report", null, true],
      ["update_deal", false, true],
    ]);
  });

  it("treats tools that say they change things, or might, as needing approval", () => {
    expect(changesThings({ name: "update_deal", readOnly: false, enabled: true })).toBe(true);
    expect(changesThings({ name: "export_report", readOnly: null, enabled: true })).toBe(true);
    expect(changesThings({ name: "search_deals", readOnly: null, enabled: true })).toBe(false);
    expect(changesThings({ name: "delete_everything", readOnly: true, enabled: true })).toBe(false);
  });

  it("only accepts public https servers in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(checkServerUrl("https://mcp.example.com/mcp").host).toBe("mcp.example.com");
    for (const bad of ["http://mcp.example.com/mcp", "https://localhost/mcp", "https://10.0.0.4/mcp", "https://192.168.1.9/mcp", "https://169.254.169.254/latest", "https://[::1]/mcp", "ftp://x.com", "not a url"]) {
      expect(() => checkServerUrl(bad), bad).toThrow();
    }
  });
});
