/**
 * ADR-0296 (P18 B2, B3) — GDPR, NIS2, DORA and CRA incident clocks.
 *
 *  - Each period is read back out of its own verbatim quote (hours, or "one month"), so a period cannot change
 *    without its quote.
 *  - Each regime starts only on its own criterion, never on another regime's, and none of the new criteria makes an
 *    incident serious under the EU AI Act.
 *  - Arithmetic: hours are exact; months are UTC calendar months, clamped to the target month's last day.
 *  - Every clock has a recipient and a caveat; a fresh org enables every regime (secure by default).
 */
import { describe, expect, it } from "vitest";
import {
  ACCOUNTABILITY_STRICT_DEFAULTS,
  INCIDENT_CLOCK_REGIMES,
  type IncidentClockFacts,
  type IncidentClockRegime,
  type SeriousIncidentCriterion,
} from "./accountability.js";
import {
  CYBER_PRIVACY_CLOCK_CAVEAT,
  INCIDENT_CLOCKS,
  INCIDENT_CLOCKS_ADR0296_RETRIEVED_ON,
  INCIDENT_CLOCK_RECIPIENT,
  INCIDENT_CLOCK_REGIME_CAVEAT,
  applicableIncidentClocks,
  incidentClockDueAt,
  incidentClockDueLabel,
} from "./incident-clocks.js";
import { hasEuSeriousCriterion } from "./incidents.js";

const NEW: IncidentClockRegime[] = ["gdpr", "nis2", "dora", "cra"];
const NEW_CRITERIA: SeriousIncidentCriterion[] = [
  "personal_data_breach",
  "significant_cyber_incident",
  "major_ict_incident",
  "exploited_vulnerability",
  "severe_product_incident",
];
const clocks = INCIDENT_CLOCKS.filter((c) => NEW.includes(c.regime));
const facts = (criteria: SeriousIncidentCriterion[]): IncidentClockFacts => ({
  incident: { serious: false, seriousCriteria: criteria, phiIndividuals: null, severity: "high" },
  useCase: null,
});
const ids = (criteria: SeriousIncidentCriterion[], regimes: readonly IncidentClockRegime[] = INCIDENT_CLOCK_REGIMES) =>
  applicableIncidentClocks(facts(criteria), regimes).map((c) => c.id);

const WORDS: Record<string, number> = { four: 4, one: 1 };
/** the period a quote states, read the way a person reads it */
function periodInQuote(quote: string): { hours: number } | { months: number } | null {
  const h = /(?:within|not later than) (\w+) hours/.exec(quote);
  if (h) return { hours: Number.isFinite(Number(h[1])) ? Number(h[1]) : WORDS[h[1]!]! };
  const m = /(?:not later than|no later than|within) (\w+) months? after/.exec(quote);
  if (m) return { months: WORDS[m[1]!]! };
  return null;
}

describe("each period is pinned to its verbatim quote", () => {
  it.each(clocks.filter((c) => c.due.kind !== "immediately").map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const stated = periodInQuote(c.quote);
    expect(stated, `${c.id}: the quote states no period`).not.toBeNull();
    if (c.due.kind === "hours") expect(stated).toEqual({ hours: c.due.hours });
    else if (c.due.kind === "months") expect(stated).toEqual({ months: c.due.months });
    else throw new Error(`${c.id}: unexpected kind ${c.due.kind}`);
  });

  it("the catalogue of the four regimes, as verified against the acts", () => {
    expect(Object.fromEntries(clocks.map((c) => [c.id, incidentClockDueLabel(c.due)]))).toEqual({
      "gdpr-33-1-supervisory-authority": "72 hours",
      "gdpr-33-2-processor-to-controller": "immediately — no numeric limit in the text",
      "gdpr-34-1-data-subjects": "immediately — no numeric limit in the text",
      "nis2-23-4a-early-warning": "24 hours",
      "nis2-23-4b-incident-notification": "72 hours",
      "nis2-23-4d-final-report": "1 month",
      "dora-rts5-1a-initial-notification": "4 hours",
      "dora-rts5-1b-intermediate-report": "72 hours",
      "dora-rts5-1c-final-report": "1 month",
      "cra-14-2a-vulnerability-early-warning": "24 hours",
      "cra-14-2b-vulnerability-notification": "72 hours",
      "cra-14-4a-incident-early-warning": "24 hours",
      "cra-14-4b-incident-notification": "72 hours",
      "cra-14-4c-incident-final-report": "1 month",
    });
  });

  it("every clock cites its act and paragraph, the retrieval date, a recipient and the applicability caveat", () => {
    const acts: Record<string, RegExp> = {
      gdpr: /^Regulation \(EU\) 2016\/679, Article 3[34]\(\d\)$/,
      nis2: /^Directive \(EU\) 2022\/2555, Article 23\(4\)\([abd]\)$/,
      dora: /^Delegated Regulation \(EU\) 2025\/301, Article 5\(1\)\([abc]\)$/,
      cra: /^Regulation \(EU\) 2024\/2847, Article 14\([24]\)\([abc]\)$/,
    };
    for (const c of clocks) {
      expect(c.paragraph, c.id).toMatch(acts[c.regime]!);
      expect(c.sourceUrl, c.id).toMatch(/^https:\/\/eur-lex\.europa\.eu\/legal-content\/EN\/TXT\/HTML\/\?uri=CELEX:3(2016R0679|2022L2555|2025R0301|2024R2847)$/);
      expect(c.retrievedOn).toBe(INCIDENT_CLOCKS_ADR0296_RETRIEVED_ON);
      expect(INCIDENT_CLOCK_RECIPIENT[c.id], c.id).toBeTruthy();
      expect(INCIDENT_CLOCK_REGIME_CAVEAT[c.regime]).toBe(CYBER_PRIVACY_CLOCK_CAVEAT);
    }
  });
});

describe("which clocks start", () => {
  it("each criterion starts its own regime's clocks and no other's", () => {
    expect(ids(["personal_data_breach"])).toEqual([
      "gdpr-33-1-supervisory-authority",
      "gdpr-33-2-processor-to-controller",
      "gdpr-34-1-data-subjects",
    ]);
    expect(ids(["significant_cyber_incident"])).toEqual([
      "nis2-23-4a-early-warning",
      "nis2-23-4b-incident-notification",
      "nis2-23-4d-final-report",
    ]);
    expect(ids(["major_ict_incident"])).toEqual([
      "dora-rts5-1a-initial-notification",
      "dora-rts5-1b-intermediate-report",
      "dora-rts5-1c-final-report",
    ]);
    expect(ids(["exploited_vulnerability"])).toEqual(["cra-14-2a-vulnerability-early-warning", "cra-14-2b-vulnerability-notification"]);
    expect(ids(["severe_product_incident"])).toEqual([
      "cra-14-4a-incident-early-warning",
      "cra-14-4b-incident-notification",
      "cra-14-4c-incident-final-report",
    ]);
  });

  it("none of the new criteria is serious under the EU AI Act, so no EU or HIPAA clock starts", () => {
    expect(hasEuSeriousCriterion(NEW_CRITERIA)).toBe(false);
    const started = applicableIncidentClocks(facts(NEW_CRITERIA), INCIDENT_CLOCK_REGIMES);
    expect(started.every((c) => NEW.includes(c.regime))).toBe(true);
    expect(started).toHaveLength(14);
  });

  it("a regime the org turned off starts nothing", () => {
    expect(ids(["personal_data_breach", "major_ict_incident"], ["dora"])).toEqual([
      "dora-rts5-1a-initial-notification",
      "dora-rts5-1b-intermediate-report",
      "dora-rts5-1c-final-report",
    ]);
  });

  it("a fresh org enables every regime (secure by default)", () => {
    expect(ACCOUNTABILITY_STRICT_DEFAULTS.incidentClockRegimes).toEqual([...INCIDENT_CLOCK_REGIMES]);
    for (const r of NEW) expect(INCIDENT_CLOCK_REGIMES).toContain(r);
  });
});

describe("arithmetic", () => {
  const start = new Date("2026-11-14T09:30:00.000Z");
  it("hours are exact", () => {
    expect(incidentClockDueAt({ kind: "hours", hours: 72 }, start).toISOString()).toBe("2026-11-17T09:30:00.000Z");
    expect(incidentClockDueAt({ kind: "hours", hours: 4 }, start).toISOString()).toBe("2026-11-14T13:30:00.000Z");
  });
  it("months are UTC calendar months, clamped to the last day of a shorter month", () => {
    expect(incidentClockDueAt({ kind: "months", months: 1 }, start).toISOString()).toBe("2026-12-14T09:30:00.000Z");
    expect(incidentClockDueAt({ kind: "months", months: 1 }, new Date("2027-01-31T08:00:00Z")).toISOString()).toBe("2027-02-28T08:00:00.000Z");
    expect(incidentClockDueAt({ kind: "months", months: 1 }, new Date("2026-12-31T23:59:00Z")).toISOString()).toBe("2027-01-31T23:59:00.000Z");
  });
});
