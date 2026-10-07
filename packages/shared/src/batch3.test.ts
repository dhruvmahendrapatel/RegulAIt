/**
 * ADR-0185 (batch 3) — the shared contract: strict defaults, what counts as a
 * relaxation, the settings bounds, the server bodies (today's body unchanged),
 * the owner body and the Outlook allow-list check.
 */
import { describe, expect, it } from "vitest";
import {
  BATCH3_SETTING_KEYS,
  BATCH3_SETTING_COPY,
  BATCH3_STRICT_DEFAULTS,
  INCIDENT_LINK_OBJECT_TYPES,
  MCP_PROTOCOL_GRANT_NAMES,
  MCP_PROTOCOL_METHODS,
  MCP_PROTOCOL_METHOD_GRANTS,
  batch3SettingRelaxed,
  createServerSchema,
  mcpStdioSentinelUrl,
  outlookRecipientAllowListProblem,
  relaxedBatch3Keys,
  setOwnerSchema,
  updateOrgSettingsSchema,
  updateServerSchema,
} from "./index.js";

describe("ADR-0185 strict defaults and relaxations", () => {
  it("the strict defaults are the owner's and ADR-0180's", () => {
    expect(BATCH3_STRICT_DEFAULTS).toEqual({
      semanticCacheTtlSeconds: 3600,
      conversationRetentionDays: 30,
      mcpProtocolMethods: [],
      mcpUpstreamTransports: ["streamable_http"],
    });
    for (const k of BATCH3_SETTING_KEYS) {
      expect(BATCH3_SETTING_COPY[k].label.length, k).toBeGreaterThan(0);
      expect(batch3SettingRelaxed(k, BATCH3_STRICT_DEFAULTS[k] as never), `${k} strict is not relaxed`).toBe(false);
    }
  });

  it("longer lifetimes, any method and any extra transport are relaxations; stricter values are not", () => {
    expect(batch3SettingRelaxed("conversationRetentionDays", 31)).toBe(true);
    expect(batch3SettingRelaxed("conversationRetentionDays", 7)).toBe(false);
    expect(batch3SettingRelaxed("semanticCacheTtlSeconds", 3601)).toBe(true);
    expect(batch3SettingRelaxed("semanticCacheTtlSeconds", 60)).toBe(false);
    expect(batch3SettingRelaxed("mcpProtocolMethods", ["prompts/list"])).toBe(true);
    expect(batch3SettingRelaxed("mcpUpstreamTransports", ["streamable_http", "sse"])).toBe(true);
    expect(batch3SettingRelaxed("mcpUpstreamTransports", ["stdio"])).toBe(true);
    expect(batch3SettingRelaxed("mcpUpstreamTransports", [])).toBe(false);
    expect(
      relaxedBatch3Keys({ conversationRetentionDays: 90, semanticCacheTtlSeconds: 10, mcpProtocolMethods: [], other: 1 }),
    ).toEqual(["conversationRetentionDays"]);
  });
});

describe("ADR-0185 settings fields of PUT /v1/org/settings", () => {
  const ok = (b: unknown) => updateOrgSettingsSchema.safeParse(b).success;
  it("accepts the bounds and refuses outside them", () => {
    expect(ok({ semanticCacheTtlSeconds: 1 })).toBe(true);
    expect(ok({ semanticCacheTtlSeconds: 2_592_000 })).toBe(true);
    expect(ok({ semanticCacheTtlSeconds: 0 })).toBe(false);
    expect(ok({ semanticCacheTtlSeconds: 2_592_001 })).toBe(false);
    expect(ok({ conversationRetentionDays: 1 })).toBe(true);
    expect(ok({ conversationRetentionDays: 2555 })).toBe(true);
    expect(ok({ conversationRetentionDays: 0 })).toBe(false);
    expect(ok({ conversationRetentionDays: 2556 })).toBe(false);
    expect(ok({ conversationRetentionDays: 30.5 })).toBe(false);
    expect(ok({ mcpProtocolMethods: [...MCP_PROTOCOL_METHODS] })).toBe(true);
    expect(ok({ mcpProtocolMethods: ["sampling/createMessage"] })).toBe(false);
    expect(ok({ mcpProtocolMethods: ["prompts/list", "prompts/list"] })).toBe(false);
    expect(ok({ mcpUpstreamTransports: ["streamable_http", "sse", "stdio"] })).toBe(true);
    expect(ok({ mcpUpstreamTransports: ["websocket"] })).toBe(false);
  });

  it("stores a set in vocabulary order, so the same set always reads and audits the same", () => {
    const p = updateOrgSettingsSchema.parse({
      mcpUpstreamTransports: ["stdio", "streamable_http"],
      mcpProtocolMethods: ["logging/setLevel", "resources/list"],
    });
    expect(p.mcpUpstreamTransports).toEqual(["streamable_http", "stdio"]);
    expect(p.mcpProtocolMethods).toEqual(["resources/list", "logging/setLevel"]);
  });
});

describe("ADR-0185 G3 vocabulary", () => {
  it("every governed method maps to one of the four grant names", () => {
    for (const m of MCP_PROTOCOL_METHODS) expect(MCP_PROTOCOL_GRANT_NAMES).toContain(MCP_PROTOCOL_METHOD_GRANTS[m].grant);
    expect(MCP_PROTOCOL_METHOD_GRANTS["logging/setLevel"].kind).toBe("write");
    expect(MCP_PROTOCOL_METHOD_GRANTS["resources/read"].kind).toBe("read");
  });
  it("an incident can link a conversation (I3)", () => {
    expect(INCIDENT_LINK_OBJECT_TYPES).toContain("conversation");
  });
});

describe("ADR-0185 server bodies", () => {
  it("today's create and update bodies are unchanged", () => {
    expect(createServerSchema.safeParse({ name: "a", url: "https://mcp.example.com/mcp" }).success).toBe(true);
    expect(
      createServerSchema.safeParse({ name: "a", url: "https://mcp.example.com/mcp", allowPrivateRanges: null }).success,
    ).toBe(true);
    expect(updateServerSchema.safeParse({ name: "b" }).success).toBe(true);
    expect(updateServerSchema.safeParse({ url: "https://x.example.com/", allowPrivateRanges: true }).success).toBe(true);
    expect(updateServerSchema.safeParse({ nonsense: 1 }).success).toBe(false);
  });

  it("a URL upstream may name sse and an owner; it never carries a stdio block", () => {
    const owner = "00000000-0000-4000-8000-000000000001";
    expect(
      createServerSchema.safeParse({ name: "a", url: "https://mcp.example.com/sse", transport: "sse", ownerUserId: owner })
        .success,
    ).toBe(true);
    expect(createServerSchema.safeParse({ name: "a", url: "https://x.example.com/", ownerUserId: null }).success).toBe(true);
    expect(
      createServerSchema.safeParse({ name: "a", url: "https://x.example.com/", stdio: { command: "/bin/x" } }).success,
    ).toBe(false);
    expect(createServerSchema.safeParse({ name: "a", url: "https://x.example.com/", ownerUserId: "nope" }).success).toBe(
      false,
    );
  });

  it("a stdio upstream has a command and an argv list, and no url", () => {
    const p = createServerSchema.parse({ name: "fs", transport: "stdio", stdio: { command: "/opt/mcp/bin/fs" } });
    expect(p).toMatchObject({ transport: "stdio", stdio: { command: "/opt/mcp/bin/fs", args: [] } });
    expect(
      createServerSchema.safeParse({ name: "fs", transport: "stdio", stdio: { command: "/opt/x", args: ["--root", "/srv"] } })
        .success,
    ).toBe(true);
    // a shell line is not an argv list
    expect(
      createServerSchema.safeParse({ name: "fs", transport: "stdio", stdio: { command: "/opt/x", args: "--root /srv" } })
        .success,
    ).toBe(false);
    expect(
      createServerSchema.safeParse({
        name: "fs",
        transport: "stdio",
        url: "https://x.example.com/",
        stdio: { command: "/opt/x" },
      }).success,
    ).toBe(false);
    expect(createServerSchema.safeParse({ name: "fs", transport: "stdio" }).success).toBe(false);
    expect(mcpStdioSentinelUrl("fs")).toBe("stdio:fs");
  });

  it("the owner body is one uuid or null", () => {
    expect(setOwnerSchema.safeParse({ ownerUserId: null }).success).toBe(true);
    expect(setOwnerSchema.safeParse({ ownerUserId: "00000000-0000-4000-8000-000000000001" }).success).toBe(true);
    expect(setOwnerSchema.safeParse({}).success).toBe(false);
    expect(setOwnerSchema.safeParse({ ownerUserId: null, extra: 1 }).success).toBe(false);
  });
});

describe("ADR-0185 Outlook recipient allow-list", () => {
  it("normalises exact mailboxes and refuses the rest with the contract's codes", () => {
    expect(outlookRecipientAllowListProblem("outlook", [" CAB@Acme.com ", "cab@acme.com", "ops@acme.com"])).toEqual({
      ok: true,
      value: ["cab@acme.com", "ops@acme.com"],
    });
    expect(outlookRecipientAllowListProblem("outlook", [])).toEqual({ ok: true, value: [] });
    expect(outlookRecipientAllowListProblem("slack", ["a@acme.com"])).toMatchObject({ ok: false, error: "outlook_only" });
    expect(outlookRecipientAllowListProblem("slack", [])).toEqual({ ok: true, value: [] });
    expect(outlookRecipientAllowListProblem("outlook", ["@acme.com"])).toMatchObject({
      ok: false,
      error: "invalid_recipient",
      invalid: ["@acme.com"],
    });
    expect(outlookRecipientAllowListProblem("outlook", ["Name <a@acme.com>"])).toMatchObject({ error: "invalid_recipient" });
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@acme.com`);
    expect(outlookRecipientAllowListProblem("outlook", many)).toMatchObject({ ok: false, error: "allow_list_too_long" });
    expect(outlookRecipientAllowListProblem("outlook", many.slice(0, 50))).toMatchObject({ ok: true });
  });
});
