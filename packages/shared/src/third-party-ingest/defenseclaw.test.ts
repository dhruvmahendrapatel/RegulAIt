// ADR-0261 (P37): the DefenseClaw HTTP JSONL parser, against SYNTHETIC fixtures written from the public docs
// (/docs/observability/, /docs/observability/end-user-identity/, /docs/acp-guard/). No DefenseClaw output is copied.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFENSECLAW_BUCKETS,
  findingEvidenceReason,
  findingFor,
  parseDefenseClawJsonl,
  recordFreshness,
  THIRD_PARTY_INGEST_MAX_RECORDS,
  ThirdPartyBatchRefused,
} from "./index.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);
const jsonl = (...rows: unknown[]) => enc(rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");

const base = { record_id: "rec-0001", bucket: "enforcement.action", timestamp: "2026-11-07T10:00:00.323651948Z" };

describe("ADR-0261 DefenseClaw JSONL parsing", () => {
  it("keeps the documented fields, drops identity and content, and digests the exact line", () => {
    const row = {
      ...base,
      schema_family: "v8",
      event_name: "hook.decision",
      severity: "HIGH",
      action: "block",
      outcome: "blocked",
      connector: "claude-code",
      source: "hook",
      "host.name": "janes-laptop",
      "user.id": "501",
      "defenseclaw.user.email": "jane@example.com",
      "client.address": "10.0.0.7",
      prompt: "please rm -rf /",
      rule_ids: ["CMD-RM-RF", "CMD-RM-RF"],
      "defenseclaw.guardrail.would_block": true,
      "defenseclaw.guardrail.reason": "destructive command with key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    const body = jsonl(row);
    const out = parseDefenseClawJsonl(body, sha);
    expect(out.rejects).toEqual([]);
    expect(out.records).toHaveLength(1);
    const r = out.records[0]!;
    expect(r).toMatchObject({ recordId: "rec-0001", bucket: "enforcement.action", eventName: "hook.decision", severity: "high", action: "block", connector: "claude-code", hostName: "janes-laptop" });
    expect(r.observedAt.toISOString()).toBe("2026-11-07T10:00:00.323Z");
    expect(r.recordSha256).toBe(sha(enc(JSON.stringify(row))));
    expect(r.attributes.ruleIds).toEqual(["CMD-RM-RF"]);
    expect(r.attributes.wouldBlock).toBe(true);
    const kept = JSON.stringify(r);
    for (const leaked of ["jane@example.com", "10.0.0.7", "rm -rf /", "sk-ant-api03-AAAA", "\"501\""]) expect(kept).not.toContain(leaked);
  });

  it("rejects bad lines one by one, so the exporter does not retry a whole batch for one line", () => {
    const out = parseDefenseClawJsonl(
      jsonl(
        base,
        "{not json",
        { ...base, record_id: "rec-2", bucket: "made.up" },
        { ...base, record_id: "rec-3", schema_family: "v9" },
        { ...base, record_id: "rec-4", timestamp: "yesterday at noon" },
        { ...base },
        { ...base, record_id: "has space" },
        { ...base, record_id: "rec-5", severity: "SEVERE" },
      ),
      sha,
    );
    expect(out.records.map((r) => r.recordId)).toEqual(["rec-0001"]);
    expect(out.rejects).toEqual([
      { line: 2, code: "invalid_json" },
      { line: 3, code: "invalid_record" },
      { line: 4, code: "unsupported_schema_family" },
      { line: 5, code: "invalid_timestamp" },
      { line: 6, code: "duplicate_in_batch" },
      { line: 7, code: "invalid_record" },
      { line: 8, code: "invalid_record" },
    ]);
  });

  it("accepts all 14 documented buckets and CRLF line endings", () => {
    const rows = DEFENSECLAW_BUCKETS.map((bucket, i) => JSON.stringify({ ...base, record_id: `r${i}`, bucket }));
    const out = parseDefenseClawJsonl(enc(rows.join("\r\n")), sha);
    expect(out.records).toHaveLength(14);
    expect(out.rejects).toEqual([]);
  });

  it("refuses an empty body, invalid UTF-8 and more than the record cap", () => {
    expect(() => parseDefenseClawJsonl(enc("\n\n"), sha)).toThrow(ThirdPartyBatchRefused);
    expect(() => parseDefenseClawJsonl(new Uint8Array([0xff, 0xfe, 0x0a]), sha)).toThrow(ThirdPartyBatchRefused);
    const many = Array.from({ length: THIRD_PARTY_INGEST_MAX_RECORDS + 1 }, (_, i) => ({ ...base, record_id: `r${i}` }));
    expect(() => parseDefenseClawJsonl(jsonl(...many), sha)).toThrow(/too_many_records/);
  });

  it("a long line is rejected without being parsed", () => {
    const out = parseDefenseClawJsonl(jsonl({ ...base, pad: "x".repeat(70_000) }), sha);
    expect(out.rejects).toEqual([{ line: 1, code: "line_too_long" }]);
  });

  it("the replay window is 15 minutes back and 5 minutes ahead", () => {
    const now = new Date("2026-11-07T10:00:00Z");
    expect(recordFreshness(new Date("2026-11-07T09:46:00Z"), now)).toBe("fresh");
    expect(recordFreshness(new Date("2026-11-07T09:44:59Z"), now)).toBe("stale");
    expect(recordFreshness(new Date("2026-11-07T10:05:00Z"), now)).toBe("fresh");
    expect(recordFreshness(new Date("2026-11-07T10:05:01Z"), now)).toBe("future");
  });

  it("maps only risky finding-bucket records with a host and connector to a finding, under a defenseclaw/ provider", () => {
    const parse = (extra: Record<string, unknown>) => parseDefenseClawJsonl(jsonl({ ...base, "host.name": "h1", connector: "codex", ...extra }), sha).records[0]!;
    expect(findingFor(parse({ severity: "CRITICAL", action: "block" }))).toEqual({ provider: "defenseclaw/codex", severity: "critical" });
    expect(findingFor(parse({ severity: "HIGH", action: "allow" }))).toBeNull();
    expect(findingFor(parse({ severity: "INFO", action: "alert" }))).toBeNull();
    expect(findingFor(parse({ bucket: "model.io", severity: "HIGH" }))).toBeNull();
    expect(findingFor(parse({ bucket: "ai.discovery", event_name: "ai_component.discovered" }))).toEqual({ provider: "defenseclaw/codex", severity: "low" });
    const noHost = parseDefenseClawJsonl(jsonl({ ...base, connector: "codex", severity: "HIGH" }), sha).records[0]!;
    expect(findingFor(noHost)).toBeNull();
    expect(findingEvidenceReason(parse({ severity: "HIGH", action: "block", rule_ids: ["CMD-RM-RF"] }))).toContain("not a RegulAIt decision");
  });
});
