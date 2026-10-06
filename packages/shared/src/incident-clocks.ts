/**
 * ADR-0182 (ADR-0175 batch D4) A12 — INCIDENT CLOCKS: the catalogue of
 * regulatory notification clocks an AI incident can start.
 *
 * Each clock carries where it comes from: the regime, the paragraph, the text
 * its period is read from (VERBATIM, as retrieved), the source URL and the
 * retrieval date. A test pins each clock's period to the number in its own
 * quote, so a period cannot change without its quote changing with it.
 *
 * Sources, retrieved 2026-10-06:
 *  - Regulation (EU) 2024/1689 (OJ L 2024/1689). Regulation (EU) 2026/1744
 *    (the "Digital Omnibus on AI", OJ 24.7.2026) does not amend Article 3(49),
 *    Article 26 or Article 73.
 *  - 45 CFR Part 164 Subpart D (HIPAA breach notification), eCFR point in
 *    time 2026-09-01. § 164.412 (law-enforcement delay) is the stated
 *    exception to every HIPAA period: such a clock is TOLLED with a reason.
 *
 * ARITHMETIC (the strict reading): `dueAt = start + N × 24 h` as a UTC
 * instant, the earliest reasonable reading of "N days"; "immediately" with no
 * number is due at the start and is shown as having no numeric limit.
 *
 * APPLICABILITY (owner decisions 1 and 2, 2026-10-06):
 *  - The EU AI Act clocks ALWAYS start for a serious incident on a high-tier
 *    or unscreened use case (an incident with no use case counts as
 *    unscreened). Whether Article 73 binds the organisation depends on its
 *    role and the system's classification date — the UI says "confirm with
 *    counsel"; regulAIt never marks them not required on its own.
 *  - The use case's role defaults to `both`, which starts every applicable
 *    clock. A `provider` role drops the Article 26(5) "inform the provider"
 *    clock; Article 73's clocks start for every role, because Article 26(5)
 *    applies Article 73 to a deployer who cannot reach the provider.
 *  - Article 73(2), (3) and (4) set the period of ONE report to the
 *    authority, so exactly one of the three starts: the shortest applicable
 *    ((3) two days, else (4) ten days, else (2) fifteen days).
 *  - HIPAA clocks start when the incident lists `phi_breach`. regulAIt does
 *    not know whether the organisation is a covered entity or a business
 *    associate, so both sides start (strictest); an admin sets aside the ones
 *    that do not apply, with a reason. A clock whose applicability turns on a
 *    head count (§ 164.406 media, § 164.408 Secretary) starts when the count
 *    is unknown.
 *
 * Each clock is a REMINDER computed from the recorded awareness time and the
 * cited text. It is not legal advice.
 *
 * Open source considered (ADR-0176): the OASIS STIX 2.1 `incident` object and
 * CSAF 2.0 model neither AI-harm criteria nor regulatory clocks; no library
 * encodes regulation-specific notification periods. The catalogue is data
 * and the arithmetic is native `Date` in UTC (whole-day offsets need no date
 * library).
 */
import type {
  EuAiActRole,
  IncidentClockDefinition,
  IncidentClockDue,
  IncidentClockFacts,
  IncidentClockRegime,
  SeriousIncidentCriterion,
} from "./accountability.js";

/** the date every quote below was retrieved and checked against its source */
export const INCIDENT_CLOCKS_RETRIEVED_ON = "2026-10-06";

export const EU_AI_ACT_SOURCE_URL = "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202401689";
export const EU_AI_ACT_OMNIBUS_SOURCE_URL = "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202601744";
const ecfr = (section: string) =>
  `https://www.ecfr.gov/api/versioner/v1/full/2026-09-01/title-45.xml?part=164&section=${section}`;

/** Art. 3(49), verbatim: what makes an incident "serious" under the EU AI Act */
export const ART_3_49_QUOTE =
  "'serious incident' means an incident or malfunctioning of an AI system that directly or indirectly leads to any " +
  "of the following: (a) the death of a person, or serious harm to a person's health; (b) a serious and irreversible " +
  "disruption of the management or operation of critical infrastructure; (c) the infringement of obligations under " +
  "Union law intended to protect fundamental rights; (d) serious harm to property or the environment";

/** Art. 73(6), verbatim: the evidence hold */
export const ART_73_6_QUOTE =
  "…shall not perform any investigation which involves altering the AI system concerned in a way which may affect " +
  "any subsequent evaluation of the causes of the incident, prior to informing the competent authorities of such action.";
export const ART_73_6_PARAGRAPH = "Regulation (EU) 2024/1689, Article 73(6)";

/** Art. 73(5), verbatim: an incomplete initial report may come first */
export const ART_73_5_QUOTE = "…may submit an initial report that is incomplete, followed by a complete report.";

/** what every clock says about itself in the UI and the export */
export const INCIDENT_CLOCK_DISCLAIMER =
  "Each clock is a reminder computed from the recorded awareness time and the cited text. It is not legal advice.";
/** what every EU AI Act clock adds (owner decision 1) */
export const EU_AI_ACT_CLOCK_CAVEAT =
  "Statutory applicability depends on your role and the system's classification date — confirm with counsel.";

/** the criteria that make an incident serious under Art. 3(49) and Art. 73(3) (everything but `phi_breach`) */
export const EU_SERIOUS_CRITERIA: readonly SeriousIncidentCriterion[] = [
  "death",
  "health",
  "critical_infrastructure",
  "fundamental_rights",
  "property_environment",
  "widespread_infringement",
];

/** the EU AI Act tiers on which the clocks start (owner decision 1); an unscreened use case (tier null) too */
export const EU_CLOCK_TIERS: readonly string[] = ["high", "prohibited"];

const has = (facts: IncidentClockFacts, c: SeriousIncidentCriterion) => facts.incident.seriousCriteria.includes(c);
const role = (facts: IncidentClockFacts): EuAiActRole => facts.useCase?.euAiActRole ?? "both";

/** an EU serious incident on a high-tier or unscreened use case (or on none) */
function euEligible(facts: IncidentClockFacts): boolean {
  if (!facts.incident.serious) return false;
  const tier = facts.useCase?.tier ?? null;
  return tier === null || EU_CLOCK_TIERS.includes(tier);
}
const art73_3 = (f: IncidentClockFacts) => has(f, "critical_infrastructure") || has(f, "widespread_infringement");
const art73_4 = (f: IncidentClockFacts) => has(f, "death");
const phi = (f: IncidentClockFacts) => has(f, "phi_breach");

/** THE CATALOGUE. Order is display order. */
export const INCIDENT_CLOCKS: readonly IncidentClockDefinition[] = Object.freeze([
  {
    regime: "eu-ai-act",
    id: "art26-5-inform-provider",
    paragraph: "Regulation (EU) 2024/1689, Article 26(5)",
    quote:
      "Where deployers have identified a serious incident, they shall also immediately inform first the provider, and " +
      "then the importer or distributor and the relevant market surveillance authorities of that incident. If the " +
      "deployer is not able to reach the provider, Article 73 shall apply mutatis mutandis.",
    sourceUrl: EU_AI_ACT_SOURCE_URL,
    retrievedOn: INCIDENT_CLOCKS_RETRIEVED_ON,
    start: "aware_at",
    due: { kind: "immediately" },
    allowsInitialReport: false,
    applies: (f) => euEligible(f) && role(f) !== "provider",
  },
  {
    regime: "eu-ai-act",
    id: "art73-3-critical-or-widespread",
    paragraph: "Regulation (EU) 2024/1689, Article 73(3)",
    quote:
      "…in the event of a widespread infringement or a serious incident as defined in Article 3, point (49)(b), the " +
      "report … shall be provided immediately, and not later than two days after the provider or, where applicable, " +
      "the deployer becomes aware of that incident.",
    sourceUrl: EU_AI_ACT_SOURCE_URL,
    retrievedOn: INCIDENT_CLOCKS_RETRIEVED_ON,
    start: "aware_at",
    due: { kind: "days", days: 2 },
    allowsInitialReport: true,
    applies: (f) => euEligible(f) && art73_3(f),
  },
  {
    regime: "eu-ai-act",
    id: "art73-4-death",
    paragraph: "Regulation (EU) 2024/1689, Article 73(4)",
    quote:
      "…in the event of the death of a person, the report shall be provided immediately after the provider or the " +
      "deployer has established, or as soon as it suspects, a causal relationship …, but not later than 10 days after " +
      "the date on which the provider or, where applicable, the deployer becomes aware of the serious incident.",
    sourceUrl: EU_AI_ACT_SOURCE_URL,
    retrievedOn: INCIDENT_CLOCKS_RETRIEVED_ON,
    start: "aware_at",
    due: { kind: "days", days: 10 },
    allowsInitialReport: true,
    applies: (f) => euEligible(f) && !art73_3(f) && art73_4(f),
  },
  {
    regime: "eu-ai-act",
    id: "art73-2-general",
    paragraph: "Regulation (EU) 2024/1689, Article 73(2)",
    quote:
      "…immediately after the provider has established a causal link between the AI system and the serious incident " +
      "or the reasonable likelihood of such a link, and, in any event, not later than 15 days after the provider or, " +
      "where applicable, the deployer, becomes aware of the serious incident. The period … shall take account of the " +
      "severity of the serious incident.",
    sourceUrl: EU_AI_ACT_SOURCE_URL,
    retrievedOn: INCIDENT_CLOCKS_RETRIEVED_ON,
    start: "aware_at",
    due: { kind: "days", days: 15 },
    allowsInitialReport: true,
    applies: (f) => euEligible(f) && !art73_3(f) && !art73_4(f),
  },
  {
    regime: "hipaa",
    id: "164.404-individuals",
    paragraph: "45 CFR 164.404(b)",
    quote:
      "Except as provided in § 164.412, a covered entity shall provide the notification required by paragraph (a) of " +
      "this section without unreasonable delay and in no case later than 60 calendar days after discovery of a breach.",
    sourceUrl: ecfr("164.404"),
    retrievedOn: INCIDENT_CLOCKS_RETRIEVED_ON,
    start: "aware_at",
    due: { kind: "days", days: 60 },
    allowsInitialReport: false,
    applies: phi,
  },
  {
    regime: "hipaa",
    id: "164.406-media",
    paragraph: "45 CFR 164.406(b)",
    quote:
      "Except as provided in § 164.412, a covered entity shall provide the notification required by paragraph (a) of " +
      "this section without unreasonable delay and in no case later than 60 calendar days after discovery of a breach.",
    sourceUrl: ecfr("164.406"),
    retrievedOn: INCIDENT_CLOCKS_RETRIEVED_ON,
    start: "aware_at",
    due: { kind: "days", days: 60 },
    allowsInitialReport: false,
    // § 164.406(a): "more than 500 residents of a State or jurisdiction". The
    // register records a total head count, not residence, so it starts unless
    // the count is known to be 500 or fewer; an admin confirms the residence
    // test and sets it aside with a reason when it is not met.
    applies: (f) => phi(f) && (f.incident.phiIndividuals === null || f.incident.phiIndividuals > 500),
  },
  {
    regime: "hipaa",
    id: "164.408-secretary",
    paragraph: "45 CFR 164.408(b)",
    quote:
      "For breaches of unsecured protected health information involving 500 or more individuals, a covered entity " +
      "shall, except as provided in § 164.412, provide the notification required by paragraph (a) of this section " +
      "contemporaneously with the notice required by § 164.404(a) and in the manner specified on the HHS Web site.",
    sourceUrl: ecfr("164.408"),
    retrievedOn: INCIDENT_CLOCKS_RETRIEVED_ON,
    start: "aware_at",
    due: { kind: "with_clock", clockId: "164.404-individuals" },
    allowsInitialReport: false,
    applies: (f) => phi(f) && (f.incident.phiIndividuals === null || f.incident.phiIndividuals >= 500),
  },
  {
    regime: "hipaa",
    id: "164.408-secretary-annual",
    paragraph: "45 CFR 164.408(c)",
    quote:
      "For breaches of unsecured protected health information involving less than 500 individuals, a covered entity " +
      "shall maintain a log or other documentation of such breaches and, not later than 60 days after the end of each " +
      "calendar year, provide the notification required by paragraph (a) of this section for breaches discovered " +
      "during the preceding calendar year, in the manner specified on the HHS web site.",
    sourceUrl: ecfr("164.408"),
    retrievedOn: INCIDENT_CLOCKS_RETRIEVED_ON,
    start: "aware_at",
    due: { kind: "after_calendar_year", days: 60 },
    allowsInitialReport: false,
    applies: (f) => phi(f) && f.incident.phiIndividuals !== null && f.incident.phiIndividuals < 500,
  },
  {
    regime: "hipaa",
    id: "164.410-ba-to-ce",
    paragraph: "45 CFR 164.410(b)",
    quote:
      "Except as provided in § 164.412, a business associate shall provide the notification required by paragraph (a) " +
      "of this section without unreasonable delay and in no case later than 60 calendar days after discovery of a breach.",
    sourceUrl: ecfr("164.410"),
    retrievedOn: INCIDENT_CLOCKS_RETRIEVED_ON,
    start: "aware_at",
    due: { kind: "days", days: 60 },
    allowsInitialReport: false,
    applies: phi,
  },
]);

/** who each clock's notification goes to (a default the person sending it may replace) */
export const INCIDENT_CLOCK_RECIPIENT: Readonly<Record<string, string>> = {
  "art26-5-inform-provider": "the provider of the AI system (then the importer or distributor and the market surveillance authorities)",
  "art73-2-general": "the market surveillance authorities of the Member States where the incident occurred",
  "art73-3-critical-or-widespread": "the market surveillance authorities of the Member States where the incident occurred",
  "art73-4-death": "the market surveillance authorities of the Member States where the incident occurred",
  "164.404-individuals": "each affected individual",
  "164.406-media": "prominent media outlets serving the State or jurisdiction",
  "164.408-secretary": "the Secretary of HHS",
  "164.408-secretary-annual": "the Secretary of HHS (annual log)",
  "164.410-ba-to-ce": "the covered entity",
};

/** the EU clocks whose notification goes to the AUTHORITY (Art. 73): until one
 * is sent, Art. 73(6)'s evidence hold applies */
export const EU_AUTHORITY_CLOCK_IDS: readonly string[] = [
  "art73-2-general",
  "art73-3-critical-or-widespread",
  "art73-4-death",
];

export function incidentClockById(id: string): IncidentClockDefinition | undefined {
  return INCIDENT_CLOCKS.find((c) => c.id === id);
}

/**
 * The clocks that apply to these facts under the enabled regimes, in
 * catalogue order. Pure: the caller decides what to do with them (the
 * register creates the missing ones and never deletes one).
 */
export function applicableIncidentClocks(
  facts: IncidentClockFacts,
  regimes: readonly IncidentClockRegime[],
): IncidentClockDefinition[] {
  return INCIDENT_CLOCKS.filter((c) => regimes.includes(c.regime) && c.applies(facts));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a clock falls due, from its start: `start + N × 24 h` (UTC), the start
 * itself for "immediately", the referenced clock's due time for
 * "contemporaneously with", and N days after the end of the start's calendar
 * year (UTC) for the § 164.408(c) annual notice.
 */
export function incidentClockDueAt(due: IncidentClockDue, start: Date, seen: ReadonlySet<string> = new Set()): Date {
  switch (due.kind) {
    case "days":
      return new Date(start.getTime() + due.days * DAY_MS);
    case "immediately":
      return new Date(start.getTime());
    case "with_clock": {
      const other = incidentClockById(due.clockId);
      if (!other || seen.has(due.clockId)) throw new Error(`incident clock: unresolvable reference '${due.clockId}'`);
      return incidentClockDueAt(other.due, start, new Set([...seen, due.clockId]));
    }
    case "after_calendar_year": {
      const endOfYear = Date.UTC(start.getUTCFullYear() + 1, 0, 1);
      return new Date(endOfYear + due.days * DAY_MS);
    }
  }
}

/** the period in words, for the UI and the export */
export function incidentClockDueLabel(due: IncidentClockDue): string {
  switch (due.kind) {
    case "days":
      return `${due.days} days`;
    case "immediately":
      return "immediately — no numeric limit in the text";
    case "with_clock":
      return `at the same time as ${due.clockId}`;
    case "after_calendar_year":
      return `${due.days} days after the end of the calendar year`;
  }
}
