/**
 * ADR-0069 — AN INDEPENDENT CHECK THAT THE metered/imported SPLIT IS REAL.
 *
 * Written the way `groundedness-is-real.test.ts` and `asr-is-real.test.ts` are:
 * not "does the function run", but "is the claim in the ADR actually true, and
 * would this file fail if somebody quietly made it untrue".
 *
 * The four claims under attack:
 *
 *  1. THE BLENDED TOTAL DOES NOT EXIST. Not "is not displayed" — does not
 *     exist. Every number reachable anywhere in a consolidation output is
 *     enumerated and asserted not to be the sum. A future `total` field, or a
 *     helper that returns one, fails here.
 *  2. A MALFORMED ROW PRODUCES A REFUSAL NAMING IT, NOT A SMALLER TOTAL. The
 *     same file is parsed twice — once clean, once with one row corrupted — and
 *     the corrupted parse must NOT simply return less money.
 *  3. AN UNMATCHED ACCOUNT SURVIVES. Its money appears, attributed to nobody,
 *     and is not redistributed across the people who did match.
 *  4. AN IMPORTED FIGURE IS NEVER LABELLED metered. The basis travels with the
 *     number through every shape this module produces.
 */
import { describe, expect, it } from "vitest";
import {
  COST_BASES,
  consolidate,
  genericMappedAdapter,
  renderConsolidatedCsv,
  resolveVendorAccount,
  type ConsolidatedSubject,
} from "./index.js";

/** every finite number reachable in a value, at any depth — including numbers
 * spelled inside strings, because a "total" rendered into a sentence would be
 * just as much of a blended figure as one in a field. */
function everyNumber(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (typeof value === "string") {
    let cur = "";
    for (const ch of value + " ") {
      if ((ch >= "0" && ch <= "9") || ch === ".") cur += ch;
      else {
        if (cur.length > 0) {
          const n = Number(cur);
          if (Number.isFinite(n)) out.push(n);
        }
        cur = "";
      }
    }
  } else if (Array.isArray(value)) for (const v of value) everyNumber(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) everyNumber(v, out);
  return out;
}

// Chosen so the sum cannot collide with anything else: 137.11 + 402.89 = 540.00
const METERED_USD = 137.11;
const IMPORTED_USD = 402.89;
const BLENDED = 540;

describe("claim 1 — the blended total does not exist", () => {
  const { subjects, basisStatement } = consolidate({
    by: "user",
    metered: [{ userId: "u1", costCenter: "CC", costUsd: METERED_USD }],
    imported: [{ userId: "u1", costCenter: "CC", vendor: "copilot", amount: IMPORTED_USD, currency: "USD", billingKind: "seat" }],
  });

  it("reports both sides, separately, with the split stated", () => {
    expect(subjects).toHaveLength(1);
    expect(subjects[0]!.metered.usd).toBe(METERED_USD);
    expect(subjects[0]!.imported.usd).toBe(IMPORTED_USD);
    expect(subjects[0]!.coverage).toContain("not added together");
    expect(basisStatement).toMatch(/never added to `metered` spend/);
  });

  it("NO number anywhere in the output equals metered + imported", () => {
    const numbers = everyNumber({ subjects, basisStatement });
    expect(numbers).toContain(METERED_USD);
    expect(numbers).toContain(IMPORTED_USD);
    expect(numbers).not.toContain(BLENDED);
  });

  it("no FIELD NAME anywhere invites a consumer to read one number as the answer", () => {
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          keys.add(k.toLowerCase());
          walk(val);
        }
      }
    };
    walk(subjects);
    for (const forbidden of ["total", "combined", "grandtotal", "allusd", "sum", "spend"]) {
      expect([...keys]).not.toContain(forbidden);
    }
  });

  it("the CSV rendering cannot be summed back into one column either", () => {
    const csv = renderConsolidatedCsv(subjects);
    expect(everyNumber(csv)).not.toContain(BLENDED);
    expect(csv.split("\n")[0]).not.toMatch(/total|combined/i);
  });

  it("the two bases are the only two, and both are named on every row", () => {
    expect([...COST_BASES].sort()).toEqual(["imported", "metered"]);
    expect(subjects[0]!.metered.basis).toBe("metered");
    expect(subjects[0]!.imported.basis).toBe("imported");
  });
});

describe("claim 2 — a malformed row refuses by name; it does not shrink the total", () => {
  const CLEAN =
    "email,cost,month\n" +
    "a@x.com,100.00,2026-07\n" +
    "b@x.com,200.00,2026-07\n" +
    "c@x.com,300.00,2026-07\n";
  const CORRUPT =
    "email,cost,month\n" +
    "a@x.com,100.00,2026-07\n" +
    "b@x.com,20O.00,2026-07\n" + // capital O, not a zero
    "c@x.com,300.00,2026-07\n";

  const cfg = {
    mapping: { account: "email", amount: "cost", period: "month" },
    defaults: { vendor: "v", currency: "USD" },
  };

  it("the clean file parses three rows and refuses none", () => {
    const r = genericMappedAdapter.parse({ content: CLEAN, format: "csv", config: cfg });
    expect(r.rowsParsed).toBe(3);
    expect(r.lines).toHaveLength(3);
    expect(r.refusals).toHaveLength(0);
  });

  it("the corrupt file does NOT quietly return 400 instead of 600 — it names row 3", () => {
    const r = genericMappedAdapter.parse({ content: CORRUPT, format: "csv", config: cfg });
    expect(r.rowsParsed).toBe(3);
    expect(r.lines).toHaveLength(2);
    expect(r.refusals).toHaveLength(1);
    // THE ASSERTION THAT MATTERS: the loss is reported, not absorbed
    expect(r.lines.length + r.refusals.length).toBe(r.rowsParsed);
    expect(r.refusals[0]!.row).toBe(3);
    expect(r.refusals[0]!.field).toBe("cost");
    expect(r.refusals[0]!.reason).toContain("20O.00");
  });

  it("every refusal carries a row number — a refusal with no locus is an apology", () => {
    const r = genericMappedAdapter.parse({
      content: "email,cost,month\nx@x.com,,2026-07\n,5.00,2026-07\ny@x.com,5.00,07/08/2026\n",
      format: "csv",
      config: cfg,
    });
    expect(r.refusals).toHaveLength(3);
    expect(r.refusals.map((f) => f.row)).toEqual([2, 3, 4]);
    for (const f of r.refusals) {
      expect(Number.isInteger(f.row)).toBe(true);
      expect(f.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("claim 3 — an unmatched account stays visible as unattributed", () => {
  const users = new Map([["known@x.com", "u-known"]]);

  it("resolves to nobody rather than to somebody plausible", () => {
    const r = resolveVendorAccount("unknown@x.com", "v", { userIdByEmail: users, aliases: [], domainRules: [] });
    expect(r.userId).toBeNull();
    expect(r.method).toBe("unresolved");
  });

  it("its money appears in the rollup and is NOT redistributed", () => {
    const { subjects } = consolidate({
      by: "user",
      metered: [],
      imported: [
        { userId: "u-known", costCenter: null, vendor: "v", amount: 10, currency: "USD", billingKind: "usage" },
        { userId: null, costCenter: null, vendor: "v", amount: 90, currency: "USD", billingKind: "usage" },
      ],
    });
    const known = subjects.find((s) => s.subjectId === "u-known")!;
    const unattributed = subjects.find((s) => s.subjectId === null)!;
    expect(known.imported.usd).toBe(10); // NOT 100, NOT 55
    expect(unattributed.imported.usd).toBe(90);
    expect(unattributed.attributed).toBe(false);
    expect(unattributed.coverage).toMatch(/NOT observed by RegulAIt/);
  });

  it("the unattributed row survives the CSV rendering with its money intact", () => {
    const subjects: ConsolidatedSubject[] = consolidate({
      by: "user",
      metered: [],
      imported: [{ userId: null, costCenter: null, vendor: "v", amount: 90, currency: "USD", billingKind: "usage" }],
    }).subjects;
    const csv = renderConsolidatedCsv(subjects);
    expect(csv).toContain("90.00");
    expect(csv).toContain("unattributed");
  });
});

describe("claim 4 — an imported figure is never labelled metered", () => {
  it("an imported-only subject reports zero metered spend rather than borrowing the label", () => {
    const { subjects } = consolidate({
      by: "user",
      metered: [],
      imported: [{ userId: "u1", costCenter: null, vendor: "v", amount: 77, currency: "USD", billingKind: "seat" }],
    });
    const s = subjects[0]!;
    expect(s.metered.usd).toBe(0);
    expect(s.metered.events).toBe(0);
    expect(s.imported.usd).toBe(77);
    expect(s.coverage).toMatch(/was NOT observed by RegulAIt/);
  });

  it("a metered-only subject says so, and does not imply an imported figure of zero is a measurement", () => {
    const { subjects } = consolidate({
      by: "user",
      metered: [{ userId: "u1", costCenter: null, costUsd: 5 }],
      imported: [],
    });
    expect(subjects[0]!.imported.lines).toBe(0);
    expect(subjects[0]!.coverage).toMatch(/observed by RegulAIt/);
  });
});
