/**
 * ADR-0076 — the roster parser, unit-tested.
 *
 * The adversarial end-to-end suite (ambiguity refused loudly, the existing
 * write paths, the PII gate) is the gateway's roster-ingest.test.ts; this file
 * covers the parsing mechanics: the SCIM dialect, CSV/JSON rows, header
 * inference that refuses ambiguity, per-row refusals with row numbers, and
 * the discard-at-parse posture for unmapped columns.
 */
import { describe, expect, it } from "vitest";
import {
  CostImportFormatError,
  ROSTER_MAX_ROWS,
  inferRosterMapping,
  parseRosterExport,
} from "./index.js";

const ENT = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

describe("the SCIM dialect", () => {
  it("reads userName, the primary email and the enterprise costCenter — and NOTHING else", () => {
    const content = JSON.stringify({
      totalResults: 2,
      Resources: [
        {
          userName: "amy.contractor@vendorbill.example",
          displayName: "Amy A.",
          phoneNumbers: [{ value: "+1 555 0100" }],
          emails: [
            { value: "amy.old@acme.example", primary: false },
            { value: "amy@acme.example", primary: true },
          ],
          [ENT]: { costCenter: "CC-R&D", manager: { displayName: "Boss" } },
        },
        { userName: "ben@acme.example", emails: [{ value: "ben@acme.example" }] },
      ],
    });
    const out = parseRosterExport({ content, format: "json" });
    expect(out.dialect).toBe("scim");
    expect(out.rowsParsed).toBe(2);
    expect(out.refusals).toHaveLength(0);
    const amy = out.entries[0]!;
    expect(amy.accountRef).toBe("amy.contractor@vendorbill.example");
    expect(amy.userEmail).toBe("amy@acme.example"); // the PRIMARY email, not the first
    expect(amy.costCenter).toBe("CC-R&D");
    // the discard-at-parse posture: unmapped attributes never survive parsing
    expect(JSON.stringify(out.entries)).not.toContain("Amy A.");
    expect(JSON.stringify(out.entries)).not.toContain("555 0100");
    expect(JSON.stringify(out.entries)).not.toContain("Boss");
    // an email identical to the account is reported as null — "the account IS
    // the directory address"
    expect(out.entries[1]!.userEmail).toBeNull();
  });

  it("refuses a resource with no userName BY ROW NUMBER, and keeps the rest", () => {
    const content = JSON.stringify({
      Resources: [{ emails: [{ value: "x@y.example" }] }, { userName: "ok@y.example" }],
    });
    const out = parseRosterExport({ content, format: "json" });
    expect(out.rowsParsed).toBe(2);
    expect(out.entries).toHaveLength(1);
    expect(out.refusals[0]!.row).toBe(1);
    expect(out.refusals[0]!.field).toBe("userName");
    expect(out.rowsParsed).toBe(out.entries.length + out.refusals.length);
  });

  it("refuses a roster over the row bound rather than truncating it", () => {
    const resources = Array.from({ length: ROSTER_MAX_ROWS + 1 }, (_, i) => ({ userName: `u${i}@y.example` }));
    expect(() => parseRosterExport({ content: JSON.stringify({ Resources: resources }), format: "json" })).toThrow(
      CostImportFormatError,
    );
  });

  it("refuses invalid JSON as a whole-file error", () => {
    expect(() => parseRosterExport({ content: "{not json", format: "json" })).toThrow(CostImportFormatError);
  });
});

describe("CSV and plain JSON rows", () => {
  it("reads a mapped CSV with per-row vendor and cost centre, refusing empty accounts by row", () => {
    const csv =
      "seat,directory,cc,vend\n" +
      "a.smith@copilot.example,alice@acme.example,CC-ENG,github-copilot\n" +
      ",bob@acme.example,CC-OPS,github-copilot\n" +
      "carol@acme.example,,,\n";
    const out = parseRosterExport({
      content: csv,
      format: "csv",
      mapping: { account: "seat", user: "directory", costCenter: "cc", vendor: "vend" },
    });
    expect(out.dialect).toBe("rows");
    expect(out.rowsParsed).toBe(3);
    expect(out.entries).toHaveLength(2);
    expect(out.refusals[0]!.row).toBe(3); // 1-based file line of the empty seat
    expect(out.entries[0]).toMatchObject({
      accountRef: "a.smith@copilot.example",
      userEmail: "alice@acme.example",
      costCenter: "CC-ENG",
      vendor: "github-copilot",
    });
    expect(out.entries[1]).toMatchObject({ accountRef: "carol@acme.example", userEmail: null, costCenter: null });
    expect(out.columnsUsed).toEqual(["seat", "directory", "cc", "vend"]);
  });

  it("a plain JSON array WITHOUT userName reads as rows through the same mapping engine", () => {
    const rows = JSON.stringify([{ email: "d@acme.example", cost_center: "CC-X" }]);
    const out = parseRosterExport({ content: rows, format: "json" });
    expect(out.dialect).toBe("rows");
    expect(out.entries[0]).toMatchObject({ accountRef: "d@acme.example", costCenter: "CC-X" });
  });
});

describe("header inference refuses to guess a join key", () => {
  it("infers the obvious roster headers", () => {
    const r = inferRosterMapping(["Email", "Cost Center", "Vendor"]);
    expect(r).toMatchObject({ ok: true, mapping: { account: "Email", costCenter: "Cost Center", vendor: "Vendor" } });
  });

  it("REFUSES when two headers could both be the account column", () => {
    const r = inferRosterMapping(["account", "email"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ambiguous/);
  });

  it("REFUSES a file with no account column at all", () => {
    const r = inferRosterMapping(["name", "department"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no account column/);
  });

  it("the whole-file refusal propagates from parseRosterExport with the stated reason", () => {
    expect(() => parseRosterExport({ content: "account,email\na,b\n", format: "csv" })).toThrow(/ambiguous/);
  });
});
