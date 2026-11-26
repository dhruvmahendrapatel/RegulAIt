import { describe, expect, it } from "vitest";
import { ATLASSIAN_AUDIT_DEFAULT_FILTERS, AtlassianAuditPageError, parseAtlassianAuditPage } from "./atlassian-audit.js";

const ev = (id: string, action: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "events",
  attributes: {
    time: "2026-11-17T09:00:00.000Z",
    action,
    actor: { id: "557058:alice", name: "Alice Example", links: {} },
    context: [{ id: "agent-1", type: "rovo-agent", attributes: { name: "x" } }],
    container: [{ id: "site-1", type: "site" }],
    location: { ip: "203.0.113.7", geo: "Somewhere" },
    ...extra,
  },
});

describe("ADR-0356 PR 3 Atlassian audit page", () => {
  it("keeps Rovo and MCP events only, as allow-listed evidence without ip, geo or names", () => {
    const page = parseAtlassianAuditPage(
      { data: [ev("e1", "rovo_agent_invoked"), ev("e2", "user_login"), ev("e3", "Remote MCP server tool called")], meta: { next: "c2" } },
      ATLASSIAN_AUDIT_DEFAULT_FILTERS,
    );
    expect(page.seen).toBe(3);
    expect(page.nextCursor).toBe("c2");
    expect(page.events.map((e) => e.eventId)).toEqual(["e1", "e3"]);
    const json = JSON.stringify(page.events);
    expect(json).not.toMatch(/203\.0\.113\.7|Somewhere|Alice Example/);
    expect(page.events[0]!.attributes).toEqual({
      action: "rovo_agent_invoked",
      actorAccountId: "557058:alice",
      context: [{ id: "agent-1", type: "rovo-agent" }],
      container: [{ id: "site-1", type: "site" }],
    });
    expect(page.events[0]!.recordSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("reads the cursor from links.next when meta has none; the last page has none", () => {
    expect(parseAtlassianAuditPage({ data: [], links: { next: "https://api.atlassian.com/admin/v1/orgs/o/events-stream?cursor=abc&limit=200" } }, ["rovo"]).nextCursor).toBe("abc");
    expect(parseAtlassianAuditPage({ data: [] }, ["rovo"]).nextCursor).toBeNull();
  });
  it("refuses a malformed page whole", () => {
    expect(() => parseAtlassianAuditPage({ nope: 1 }, ["rovo"])).toThrow(AtlassianAuditPageError);
    expect(() => parseAtlassianAuditPage({ data: [{ id: "x", attributes: { action: "rovo", time: "not a time" } }] }, ["rovo"])).toThrow(/valid time/);
    expect(() => parseAtlassianAuditPage({ data: [{ attributes: { action: "rovo", time: "2026-01-01T00:00:00Z" } }] }, ["rovo"])).toThrow(AtlassianAuditPageError);
  });
});
