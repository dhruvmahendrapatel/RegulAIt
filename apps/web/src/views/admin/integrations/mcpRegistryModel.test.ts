import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../api/client";
import { ADMISSION_CLEAR_REFUSALS, admissionClearRefusal } from "./McpServerAdmission";
import {
  REGISTRY_REFUSAL_SENTENCES,
  createRegistryBody,
  entryImportability,
  privateRangesOf,
  privateRangesWire,
  registryRefusalText,
  registryUrlProblem,
  syncSummary,
  updateRegistryBody,
  type McpRegistry,
  type McpRegistryEntry,
  type RegistrySyncResult,
} from "./mcpRegistryModel";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const registry: McpRegistry = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "mirror",
  url: "https://registry.example.test",
  enabled: false,
  allowPrivateRanges: null,
  lastSyncAt: null,
  lastSyncOutcome: null,
  lastSyncDetail: null,
  createdAt: "2026-10-12T00:00:00.000Z",
};

const entry = (over: Partial<McpRegistryEntry> = {}): McpRegistryEntry => ({
  id: "00000000-0000-4000-8000-000000000002",
  registryId: registry.id,
  upstreamName: "io.example/records",
  upstreamVersion: "1.0.0",
  title: null,
  description: null,
  repositoryUrl: null,
  websiteUrl: null,
  kind: "remote",
  remoteUrl: "https://records.example.test/mcp",
  remoteTransport: "streamable-http",
  catalogueReason: null,
  upstreamStatus: "active",
  serverId: null,
  importedAt: null,
  conflictReason: null,
  conflictServerId: null,
  remoteUrlDrift: null,
  lastSeenAt: "2026-10-12T00:00:00.000Z",
  missingSince: null,
  ...over,
});

describe("registry forms", () => {
  it("creates disabled and inheriting by default, and sends exactly the schema's fields", () => {
    const out = createRegistryBody({ name: " mirror ", url: " https://registry.example.test ", enabled: false, privateRanges: "inherit" });
    expect(out).toEqual({ body: { name: "mirror", url: "https://registry.example.test", enabled: false, allowPrivateRanges: null } });
  });

  it("refuses a blank name, a relative URL and a non-http scheme before sending", () => {
    expect(createRegistryBody({ name: "", url: "https://x.test", enabled: false, privateRanges: "inherit" })).toHaveProperty("error");
    expect(registryUrlProblem("registry.example.test")).toMatch(/absolute URL/);
    expect(registryUrlProblem("ftp://registry.example.test")).toMatch(/https/);
    expect(registryUrlProblem("x".repeat(2001))).toMatch(/2000/);
    expect(registryUrlProblem("http://10.0.0.5:8080")).toBeNull();
  });

  it("maps the private-range tri-state both ways", () => {
    expect(privateRangesOf(null)).toBe("inherit");
    expect(privateRangesOf(true)).toBe("allow");
    expect(privateRangesOf(false)).toBe("deny");
    expect(privateRangesWire("inherit")).toBeNull();
    expect(privateRangesWire("allow")).toBe(true);
    expect(privateRangesWire("deny")).toBe(false);
  });

  it("patches only what changed, and names each relaxation", () => {
    const out = updateRegistryBody(registry, { url: registry.url, enabled: true, privateRanges: "allow" });
    expect(out).toEqual({
      body: { enabled: true, allowPrivateRanges: true },
      relaxes: [expect.stringMatching(/Enabling/), expect.stringMatching(/private ranges/)],
    });
    // tightening is not a relaxation
    expect(updateRegistryBody({ ...registry, enabled: true }, { url: registry.url, enabled: false, privateRanges: "deny" })).toEqual({
      body: { enabled: false, allowPrivateRanges: false },
      relaxes: [],
    });
    expect(updateRegistryBody(registry, { url: registry.url, enabled: false, privateRanges: "inherit" })).toEqual({ error: "Nothing has changed." });
    expect(updateRegistryBody(registry, { url: "nope", enabled: false, privateRanges: "inherit" })).toHaveProperty("error");
  });
});

describe("reading results", () => {
  const ok: RegistrySyncResult = {
    registryId: registry.id,
    registryName: "mirror",
    outcome: "ok",
    reason: "pulled",
    pages: 1,
    truncated: true,
    entriesSeen: 3,
    created: 2,
    updated: 1,
    remote: 2,
    catalogueOnly: 1,
    malformed: 0,
    markedMissing: 0,
    driftDetected: 1,
    conflicts: 0,
    serversCreated: 0,
    grantsCreated: 0,
  };

  it("says what a sync wrote, and that it created no server or grant", () => {
    const text = syncSummary(ok);
    expect(text).toContain("3 entries seen");
    expect(text).toContain("1 with a moved endpoint");
    expect(text).toContain("No server and no grant was created.");
    expect(text).toContain("page limit");
    expect(syncSummary({ ...ok, outcome: "refused", reason: "air-gapped: federation is refused" })).toBe("air-gapped: federation is refused");
  });

  it("explains every entry that cannot be imported", () => {
    expect(entryImportability(entry())).toEqual({ importable: true });
    expect(entryImportability(entry({ serverId: registry.id }))).toMatchObject({ importable: false });
    expect(entryImportability(entry({ kind: "catalogue_only", remoteUrl: null, catalogueReason: "package_only" }))).toMatchObject({
      importable: false,
      reason: expect.stringContaining("package_only"),
    });
    expect(entryImportability(entry({ conflictReason: "url_taken" }))).toMatchObject({ reason: expect.stringContaining("URL") });
    expect(entryImportability(entry({ missingSince: "2026-10-12T00:00:00.000Z" }))).toMatchObject({ importable: false });
    expect(entryImportability(entry({ upstreamStatus: "deleted" }))).toMatchObject({ importable: false });
  });

  it("reads a refusal as the page's sentence plus the gateway's detail", () => {
    expect(registryRefusalText({ error: "egress_blocked", detail: "metadata address" })).toBe(`${REGISTRY_REFUSAL_SENTENCES.egress_blocked} metadata address`);
    expect(registryRefusalText({ error: "something_else" })).toBeNull();
    expect(registryRefusalText(null)).toBeNull();
  });
});

describe("pinned to the gateway source", () => {
  it("every registry refusal code is one mcp-registry.ts sends", () => {
    const gateway = src("../../../../../gateway/src/mcp-registry.ts");
    expect(Object.keys(REGISTRY_REFUSAL_SENTENCES).filter((code) => !gateway.includes(`"${code}"`))).toEqual([]);
  });

  it("every admission-clear refusal code is one mcp-admission.ts sends", () => {
    const gateway = src("../../../../../gateway/src/mcp-admission.ts");
    expect(Object.keys(ADMISSION_CLEAR_REFUSALS).filter((code) => !gateway.includes(`error: "${code}"`))).toEqual([]);
    expect(admissionClearRefusal(new ApiError(409, { error: "reserved_tool_name" }))).toMatch(/rename/);
    expect(admissionClearRefusal(new ApiError(500, { error: "internal" }))).toBeNull();
  });
});
