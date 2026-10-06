/**
 * ADR-0182 (ADR-0175 batch D4) A12 — the incident clock catalogue and the
 * register's pure rules.
 *
 *  - EACH PERIOD IS PINNED TO ITS QUOTE: the number of days a clock counts is
 *    read back out of the clock's own verbatim quote, so changing a period
 *    without changing the quote it is read from fails here.
 *  - The catalogue is pinned by content (ids, paragraphs, periods, quotes):
 *    an edit is deliberate and shows up as a changed expectation.
 *  - Applicability under owner decisions 1 and 2: the EU clocks start for a
 *    serious incident on a high-tier or unscreened use case (or none), never
 *    on a limited/minimal one; exactly one Art. 73 report clock starts — death
 *    picks 10 days, critical infrastructure 2 days, otherwise 15 days; the
 *    role `provider` drops only the Art. 26(5) clock.
 *  - Arithmetic: whole UTC days, "immediately" at the start, contemporaneous
 *    clocks share their due time, the annual HIPAA log falls 60 days after
 *    the calendar year ends.
 */
import { describe, expect, it } from "vitest";
import type { IncidentClockFacts, SeriousIncidentCriterion } from "./accountability.js";
import {
  INCIDENT_CLOCKS,
  INCIDENT_CLOCKS_RETRIEVED_ON,
  applicableIncidentClocks,
  incidentClockById,
  incidentClockDueAt,
} from "./incident-clocks.js";
import {
  evidenceHoldBinds,
  incidentClockUrgency,
  incidentCloseBlockers,
  incidentHoldsGate,
  nextNotificationStatus,
} from "./incidents.js";
import { evaluateDeployGate } from "./deploy-gate.js";

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, five: 5, ten: 10, fifteen: 15, sixty: 60 };
/** the number of days a quote states, read the way a person reads it */
function daysInQuote(quote: string): number | null {
  const m = /(?:not|in no case) later than (\w+) (?:calendar )?days/.exec(quote);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : (WORDS[m[1]!] ?? null);
}

const facts = (
  criteria: SeriousIncidentCriterion[],
  useCase: IncidentClockFacts["useCase"] = { tier: "high", euAiActRole: "both" },
  extra: Partial<IncidentClockFacts["incident"]> = {},
): IncidentClockFacts => ({
  incident: { serious: true, seriousCriteria: criteria, phiIndividuals: null, severity: "high", ...extra },
  useCase,
});
const ids = (f: IncidentClockFacts, regimes: Array<"eu-ai-act" | "hipaa"> = ["eu-ai-act", "hipaa"]) =>
  applicableIncidentClocks(f, regimes).map((c) => c.id);

describe("ADR-0182 A12 incident clocks: each period is pinned to its verbatim quote", () => {
  it.each(INCIDENT_CLOCKS.filter((c) => c.due.kind === "days" || c.due.kind === "after_calendar_year").map((c) => [c.id, c] as const))(
    "%s counts the days its quote states",
    (_id, c) => {
      const days = (c.due as { days: number }).days;
      expect(daysInQuote(c.quote), `${c.id}: the quote states no period`).not.toBeNull();
      expect(days, `${c.id}: the period must be the one its quote states`).toBe(daysInQuote(c.quote));
    },
  );

  it("an 'immediately' clock has no numeric period in its quote, and its quote says 'immediately'", () => {
    for (const c of INCIDENT_CLOCKS.filter((x) => x.due.kind === "immediately")) {
      expect(c.quote).toMatch(/immediately/);
      expect(daysInQuote(c.quote)).toBeNull();
    }
  });

  it("the periods per paragraph are the ones the contract verified", () => {
    const period = (id: string) => {
      const d = incidentClockById(id)!.due;
      return d.kind === "days" || d.kind === "after_calendar_year" ? d.days : d.kind;
    };
    expect({
      "art26-5-inform-provider": period("art26-5-inform-provider"),
      "art73-2-general": period("art73-2-general"),
      "art73-3-critical-or-widespread": period("art73-3-critical-or-widespread"),
      "art73-4-death": period("art73-4-death"),
      "164.404-individuals": period("164.404-individuals"),
      "164.406-media": period("164.406-media"),
      "164.408-secretary": period("164.408-secretary"),
      "164.408-secretary-annual": period("164.408-secretary-annual"),
      "164.410-ba-to-ce": period("164.410-ba-to-ce"),
    }).toEqual({
      "art26-5-inform-provider": "immediately",
      "art73-2-general": 15,
      "art73-3-critical-or-widespread": 2,
      "art73-4-death": 10,
      "164.404-individuals": 60,
      "164.406-media": 60,
      "164.408-secretary": "with_clock",
      "164.408-secretary-annual": 60,
      "164.410-ba-to-ce": 60,
    });
  });

  it("every clock cites its paragraph, a primary source and the retrieval date; ids are unique", () => {
    expect(new Set(INCIDENT_CLOCKS.map((c) => c.id)).size).toBe(INCIDENT_CLOCKS.length);
    for (const c of INCIDENT_CLOCKS) {
      expect(c.retrievedOn).toBe(INCIDENT_CLOCKS_RETRIEVED_ON);
      expect(INCIDENT_CLOCKS_RETRIEVED_ON).toBe("2026-10-06");
      if (c.regime === "eu-ai-act") {
        expect(c.paragraph).toMatch(/^Regulation \(EU\) 2024\/1689, Article (26|73)\(\d\)$/);
        expect(c.sourceUrl).toBe("https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202401689");
      } else {
        expect(c.paragraph).toMatch(/^45 CFR 164\.4(04|06|08|10)\([bc]\)$/);
        expect(c.sourceUrl).toMatch(/^https:\/\/www\.ecfr\.gov\/api\/versioner\/v1\/full\/2026-09-01\/title-45\.xml\?part=164&section=164\.4(04|06|08|10)$/);
      }
    }
    // Art. 73(5): only the authority reports may start with an incomplete one
    expect(INCIDENT_CLOCKS.filter((c) => c.allowsInitialReport).map((c) => c.id).sort()).toEqual([
      "art73-2-general",
      "art73-3-critical-or-widespread",
      "art73-4-death",
    ]);
  });
});

describe("ADR-0182 A12 incident clocks: which clocks start (owner decisions 1 and 2)", () => {
  it("a serious incident on a high-tier use case starts the EU clocks: 26(5) and the 15-day Art. 73(2) report", () => {
    expect(ids(facts(["health"]))).toEqual(["art26-5-inform-provider", "art73-2-general"]);
  });
  it("death picks the 10-day Art. 73(4) clock; critical infrastructure or widespread infringement the 2-day Art. 73(3)", () => {
    expect(ids(facts(["death"]))).toEqual(["art26-5-inform-provider", "art73-4-death"]);
    expect(ids(facts(["critical_infrastructure"]))).toEqual(["art26-5-inform-provider", "art73-3-critical-or-widespread"]);
    expect(ids(facts(["widespread_infringement"]))).toEqual(["art26-5-inform-provider", "art73-3-critical-or-widespread"]);
    // both: the shortest period wins (one report to the authority)
    expect(ids(facts(["death", "critical_infrastructure"]))).toEqual(["art26-5-inform-provider", "art73-3-critical-or-widespread"]);
  });
  it("unscreened (tier null), no use case, and prohibited tier start them too; limited and minimal do not", () => {
    expect(ids(facts(["health"], { tier: null, euAiActRole: "both" }))).toContain("art73-2-general");
    expect(ids(facts(["health"], null))).toContain("art73-2-general");
    expect(ids(facts(["health"], { tier: "prohibited", euAiActRole: "both" }))).toContain("art73-2-general");
    expect(ids(facts(["health"], { tier: "limited", euAiActRole: "both" }))).toEqual([]);
    expect(ids(facts(["health"], { tier: "minimal", euAiActRole: "both" }))).toEqual([]);
  });
  it("role: `provider` drops only the Art. 26(5) clock; `deployer` keeps Art. 73 (it applies mutatis mutandis)", () => {
    expect(ids(facts(["health"], { tier: "high", euAiActRole: "provider" }))).toEqual(["art73-2-general"]);
    expect(ids(facts(["health"], { tier: "high", euAiActRole: "deployer" }))).toEqual(["art26-5-inform-provider", "art73-2-general"]);
  });
  it("not serious: no EU clock; a PHI breach starts the HIPAA clocks by head count", () => {
    const notSerious = (criteria: SeriousIncidentCriterion[], n: number | null) =>
      ids({ incident: { serious: false, seriousCriteria: criteria, phiIndividuals: n, severity: "medium" }, useCase: { tier: "high", euAiActRole: "both" } });
    expect(notSerious([], null)).toEqual([]);
    expect(notSerious(["phi_breach"], null)).toEqual(["164.404-individuals", "164.406-media", "164.408-secretary", "164.410-ba-to-ce"]);
    expect(notSerious(["phi_breach"], 501)).toEqual(["164.404-individuals", "164.406-media", "164.408-secretary", "164.410-ba-to-ce"]);
    expect(notSerious(["phi_breach"], 500)).toEqual(["164.404-individuals", "164.408-secretary", "164.410-ba-to-ce"]);
    expect(notSerious(["phi_breach"], 499)).toEqual(["164.404-individuals", "164.408-secretary-annual", "164.410-ba-to-ce"]);
  });
  it("a regime the org removed starts nothing", () => {
    expect(ids(facts(["health", "phi_breach"]), ["hipaa"]).every((id) => id.startsWith("164."))).toBe(true);
    expect(ids(facts(["health", "phi_breach"]), ["eu-ai-act"]).every((id) => id.startsWith("art"))).toBe(true);
    expect(ids(facts(["health", "phi_breach"]), [])).toEqual([]);
  });
});

describe("ADR-0182 A12 incident clocks: the arithmetic (UTC, whole days)", () => {
  const start = new Date("2026-10-06T09:30:00.000Z");
  it("N days = start + N × 24 h; immediately = the start; contemporaneous = the referenced clock's due time", () => {
    expect(incidentClockDueAt({ kind: "days", days: 15 }, start).toISOString()).toBe("2026-10-21T09:30:00.000Z");
    expect(incidentClockDueAt({ kind: "days", days: 2 }, start).toISOString()).toBe("2026-10-08T09:30:00.000Z");
    expect(incidentClockDueAt({ kind: "immediately" }, start).toISOString()).toBe(start.toISOString());
    expect(incidentClockDueAt(incidentClockById("164.408-secretary")!.due, start).toISOString()).toBe(
      incidentClockDueAt(incidentClockById("164.404-individuals")!.due, start).toISOString(),
    );
  });
  it("the annual HIPAA log is due 60 days after the calendar year of discovery ends", () => {
    expect(incidentClockDueAt({ kind: "after_calendar_year", days: 60 }, start).toISOString()).toBe("2027-03-02T00:00:00.000Z");
    expect(incidentClockDueAt({ kind: "after_calendar_year", days: 60 }, new Date("2027-12-31T23:00:00Z")).toISOString()).toBe(
      "2028-03-01T00:00:00.000Z",
    );
  });
  it("urgency: final, overdue, due within 24 h, pending", () => {
    const now = new Date("2026-10-06T00:00:00Z");
    expect(incidentClockUrgency({ status: "sent_complete", dueAt: "2026-10-01T00:00:00Z" }, now)).toBe("done");
    expect(incidentClockUrgency({ status: "pending", dueAt: "2026-10-05T23:59:59Z" }, now)).toBe("overdue");
    expect(incidentClockUrgency({ status: "sent_initial", dueAt: "2026-10-06T23:00:00Z" }, now)).toBe("due_soon");
    expect(incidentClockUrgency({ status: "pending", dueAt: "2026-10-08T00:00:00Z" }, now)).toBe("pending");
  });
});

describe("ADR-0182 A12 the register's pure rules", () => {
  it("notification moves: initial only where Art. 73(5) allows it and only once; a final clock never moves", () => {
    expect(nextNotificationStatus("pending", { kind: "sent", stage: "initial" }, "art73-2-general")).toEqual({ ok: true, status: "sent_initial" });
    expect(nextNotificationStatus("sent_initial", { kind: "sent", stage: "complete" }, "art73-2-general")).toEqual({ ok: true, status: "sent_complete" });
    expect(nextNotificationStatus("sent_initial", { kind: "sent", stage: "initial" }, "art73-2-general")).toMatchObject({ ok: false, code: "initial_report_already_sent" });
    expect(nextNotificationStatus("pending", { kind: "sent", stage: "initial" }, "164.404-individuals")).toMatchObject({ ok: false, code: "initial_report_not_allowed" });
    for (const final of ["sent_complete", "not_required", "tolled"] as const) {
      for (const move of [{ kind: "sent", stage: "complete" }, { kind: "not_required" }, { kind: "toll" }] as const) {
        expect(nextNotificationStatus(final, move, "art73-2-general")).toMatchObject({ ok: false, code: "notification_final" });
      }
    }
  });
  it("closing needs both texts and every clock final", () => {
    expect(incidentCloseBlockers({ status: "resolved", rootCause: "x", lessonsLearned: " ", notifications: [] }).missing).toEqual(["lessonsLearned"]);
    expect(
      incidentCloseBlockers({
        status: "resolved",
        rootCause: "x",
        lessonsLearned: "y",
        notifications: [
          { id: "1", clockId: "art73-2-general", status: "sent_initial" },
          { id: "2", clockId: "art26-5-inform-provider", status: "sent_complete" },
          { id: "3", clockId: "164.404-individuals", status: "tolled" },
        ],
      }).openClocks,
    ).toEqual(["art73-2-general"]);
  });
  it("closing needs every corrective action done or cancelled", () => {
    const base = { status: "resolved" as const, rootCause: "x", lessonsLearned: "y", notifications: [] };
    expect(
      incidentCloseBlockers({ ...base, actions: [{ id: "a", status: "open" }, { id: "b", status: "done" }, { id: "c", status: "cancelled" }] }).openActions,
    ).toEqual(["a"]);
    expect(incidentCloseBlockers(base).openActions).toEqual([]);
  });
  it("the evidence hold binds an open serious incident until an authority report is sent or set aside", () => {
    const open = { status: "open" as const, serious: true };
    expect(evidenceHoldBinds(open, [{ clockId: "art73-2-general", status: "pending" }])).toBe(true);
    expect(evidenceHoldBinds(open, [{ clockId: "art73-2-general", status: "tolled" }])).toBe(true);
    expect(evidenceHoldBinds(open, [{ clockId: "art73-2-general", status: "sent_initial" }])).toBe(false);
    expect(evidenceHoldBinds(open, [{ clockId: "art73-2-general", status: "not_required" }])).toBe(false);
    // informing the provider (26(5)) is not informing the authority
    expect(evidenceHoldBinds(open, [{ clockId: "art26-5-inform-provider", status: "pending" }])).toBe(false);
    expect(evidenceHoldBinds({ status: "closed", serious: true }, [{ clockId: "art73-2-general", status: "pending" }])).toBe(false);
    expect(evidenceHoldBinds({ status: "open", serious: false }, [{ clockId: "art73-2-general", status: "pending" }])).toBe(false);
  });
  it("the gate: open or contained serious / high / critical holds; resolved, closed and low/medium do not", () => {
    expect(incidentHoldsGate({ status: "open", severity: "low", serious: true })).toBe("open_serious_incident");
    expect(incidentHoldsGate({ status: "contained", severity: "critical", serious: false })).toBe("open_high_incident");
    expect(incidentHoldsGate({ status: "open", severity: "medium", serious: false })).toBeNull();
    expect(incidentHoldsGate({ status: "resolved", severity: "critical", serious: true })).toBeNull();
    expect(incidentHoldsGate({ status: "closed", severity: "critical", serious: true })).toBeNull();
  });
  it("evaluateDeployGate: enforce blocks, warn warns, off skips and says so", () => {
    const base = {
      useCase: { id: "uc", name: "UC", status: "approved", intendedAgentIds: [] },
      requestedAgentIds: null,
      agents: new Map(),
      alerts: [],
      incidents: [{ id: "i1", ref: "INC-00001", status: "open" as const, severity: "high" as const, serious: false }],
    };
    const enforce = evaluateDeployGate({ ...base, incidentMode: "enforce" });
    expect(enforce.decision).toBe("deny");
    expect(enforce.reasons).toContainEqual(expect.objectContaining({ code: "open_high_incident", severity: "block", ref: { type: "incident", id: "i1" } }));
    const warn = evaluateDeployGate({ ...base, incidentMode: "warn" });
    expect(warn.decision).toBe("allow");
    expect(warn.reasons).toContainEqual(expect.objectContaining({ code: "open_high_incident", severity: "warn" }));
    const off = evaluateDeployGate({ ...base, incidentMode: "off" });
    expect(off.decision).toBe("allow");
    expect(off.incidentGate).toEqual({ mode: "off", status: "skipped", label: "skipped (mode off)" });
    expect(off.reasons.filter((r) => r.code.endsWith("_incident"))).toEqual([]);
  });
});
