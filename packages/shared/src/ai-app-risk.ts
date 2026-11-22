/**
 * ADR-0363 slice 3 — RISK ATTRIBUTES FOR AI APPS, as a curated dataset (data, not code).
 *
 * One row per catalogue `provider` (the key `SHADOW_AI_CATALOG_V3` and `shadow_ai_findings.provider` use). Each row
 * names the `offering` its values describe (a vendor's business or API plan; a consumer plan of the same vendor can
 * differ, and the row says which it is). EVERY attribute value carries the vendor page it was read from and the date it
 * was checked (the ADR-0158 rule). A value nobody verified is `unknown`, and `unknown` scores as risk: the secure
 * default (ADR-0180) is that an unverified claim is not credit.
 *
 * Integrity: the dataset is deep-frozen and pinned by version, row count and content hash in `ai-app-risk.test.ts`
 * (the catalogue v2/v3 rule), so "scored against risk dataset v1" always means the same thing. `aiAppRiskDatasetDigest`
 * is the canonical (RFC 8785) SHA-256 of the dataset: the value a signed out-of-band update (Codex lane C2's signed
 * feed) binds to. This module builds no second signing path.
 *
 * The score is a sum of named factors, each shown with the points it added, so a score is never a bare number. It
 * ranks the shadow-AI inventory and SUGGESTS a site rule; it never applies one.
 */
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { AI_APP_RISK_ROWS } from "./ai-app-risk-data.js";

export const AI_APP_RISK_DATASET_VERSION = 1;

export const AI_APP_TRAINING_VALUES = ["no", "opt_in", "opt_out", "yes", "unknown"] as const;
export type AiAppTraining = (typeof AI_APP_TRAINING_VALUES)[number];

export type AiAppRetention = "none" | { days: number } | "until_deleted" | "configurable" | "unknown";

export const AI_APP_CERTIFICATIONS = [
  "soc2_type2",
  "iso27001",
  "iso27017",
  "iso27018",
  "iso27701",
  "iso42001",
  "hipaa_baa",
  "fedramp_moderate",
  "fedramp_high",
  "pci_dss",
  "csa_star",
] as const;
export type AiAppCertification = (typeof AI_APP_CERTIFICATIONS)[number];

export const AI_APP_SSO_VALUES = ["saml_and_oidc", "saml", "oidc", "none", "unknown"] as const;
export type AiAppSso = (typeof AI_APP_SSO_VALUES)[number];

export type AiAppSubProcessors = { url: string } | "not_published" | "unknown";

/** where a value came from: the vendor page and the day it was read; null only for `unknown` */
export interface AiAppSource {
  url: string;
  checkedOn: string;
}

export interface Sourced<T> {
  value: T;
  source: AiAppSource | null;
}

export interface AiAppRiskAttributes {
  trainsOnCustomerData: Sourced<AiAppTraining>;
  retention: Sourced<AiAppRetention>;
  hostingRegions: Sourced<readonly string[] | "unknown">;
  certifications: Sourced<readonly AiAppCertification[] | "unknown">;
  ssoSupport: Sourced<AiAppSso>;
  subProcessors: Sourced<AiAppSubProcessors>;
}

export interface AiAppRiskRow {
  provider: string;
  /** the plan these values describe, e.g. "OpenAI API platform" */
  offering: string;
  attributes: AiAppRiskAttributes;
}

const deepFreeze = <T extends object>(o: T): T => {
  for (const v of Object.values(o)) if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v as object);
  return Object.freeze(o);
};

/** the curated rows live in `ai-app-risk-data.ts` (data only) */
export const AI_APP_RISK_DATASET: ReadonlyArray<AiAppRiskRow> = deepFreeze(AI_APP_RISK_ROWS.map((r) => r));

/** canonical JSON SHA-256 of the dataset (RFC 8785 via `canonicalize`), the value a signed update binds to */
export function aiAppRiskDatasetDigest(rows: ReadonlyArray<AiAppRiskRow> = AI_APP_RISK_DATASET): string {
  return createHash("sha256").update(canonicalize({ version: AI_APP_RISK_DATASET_VERSION, rows }) ?? "").digest("hex");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REGION = /^[a-z]{2,8}$/;

/** problems with one row (empty = valid): every known value is sourced, every unknown is not */
export function aiAppRiskRowProblems(r: AiAppRiskRow): string[] {
  const out: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(r.provider)) out.push(`${r.provider}: provider key`);
  if (r.offering.trim().length < 3) out.push(`${r.provider}: offering`);
  for (const [name, a] of Object.entries(r.attributes) as Array<[string, Sourced<unknown>]>) {
    const unknown = a.value === "unknown";
    if (unknown && a.source !== null) out.push(`${r.provider}.${name}: an unknown value carries no source`);
    if (!unknown) {
      if (!a.source) out.push(`${r.provider}.${name}: a known value needs its source`);
      else {
        let ok = false;
        try {
          ok = new URL(a.source.url).protocol === "https:";
        } catch {
          ok = false;
        }
        if (!ok) out.push(`${r.provider}.${name}: source must be an https URL`);
        if (!ISO_DATE.test(a.source.checkedOn)) out.push(`${r.provider}.${name}: checkedOn must be YYYY-MM-DD`);
      }
    }
  }
  const at = r.attributes;
  if (!AI_APP_TRAINING_VALUES.includes(at.trainsOnCustomerData.value)) out.push(`${r.provider}: training value`);
  if (!AI_APP_SSO_VALUES.includes(at.ssoSupport.value)) out.push(`${r.provider}: sso value`);
  const ret = at.retention.value;
  if (typeof ret === "object" && !(Number.isInteger(ret.days) && ret.days > 0 && ret.days <= 3650)) out.push(`${r.provider}: retention days`);
  if (Array.isArray(at.hostingRegions.value) && (at.hostingRegions.value.length === 0 || at.hostingRegions.value.some((x) => !REGION.test(x))))
    out.push(`${r.provider}: hosting regions`);
  if (Array.isArray(at.certifications.value) && at.certifications.value.some((c) => !AI_APP_CERTIFICATIONS.includes(c)))
    out.push(`${r.provider}: certification`);
  const sp = at.subProcessors.value;
  if (typeof sp === "object") {
    try {
      if (new URL(sp.url).protocol !== "https:") out.push(`${r.provider}: sub-processor URL`);
    } catch {
      out.push(`${r.provider}: sub-processor URL`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The score, with its factors
// ---------------------------------------------------------------------------------------------------------------

export const AI_APP_RISK_BANDS = ["low", "medium", "high"] as const;
export type AiAppRiskBand = (typeof AI_APP_RISK_BANDS)[number];

export interface AiAppRiskFactor {
  attribute: keyof AiAppRiskAttributes | "dataset";
  /** what was observed, in words an admin reads */
  observed: string;
  points: number;
  source: AiAppSource | null;
}

export interface AiAppRiskScore {
  provider: string;
  offering: string | null;
  datasetVersion: number;
  /** 0 (least) – 100 (most) */
  score: number;
  band: AiAppRiskBand;
  factors: AiAppRiskFactor[];
  /** a SUGGESTION for the site rule; never applied by this code */
  suggestedSiteRule: "allow" | "review" | "block";
}

/** the points, in one table, so the weighting is reviewable in one place (sum of maxima = 100) */
export const AI_APP_RISK_WEIGHTS = Object.freeze({
  training: { no: 0, opt_in: 5, opt_out: 20, yes: 30, unknown: 25 } satisfies Record<AiAppTraining, number>,
  retention: { none: 0, shortDays: 5, longDays: 10, configurable: 5, until_deleted: 15, unknown: 15, shortDaysMax: 30 },
  regions: { known: 0, unknown: 10 },
  certifications: { core: 0, partial: 10, none: 15, unknown: 15 },
  sso: { saml_and_oidc: 0, saml: 0, oidc: 0, none: 15, unknown: 15 },
  subProcessors: { published: 0, not_published: 15, unknown: 15 },
});

const CORE_CERTS: readonly AiAppCertification[] = ["soc2_type2", "iso27001"];

function band(score: number): AiAppRiskBand {
  return score >= 50 ? "high" : score >= 25 ? "medium" : "low";
}

/** score one provider; a provider not in the dataset is scored as every attribute unknown, and says so */
export function scoreAiApp(provider: string, rows: ReadonlyArray<AiAppRiskRow> = AI_APP_RISK_DATASET): AiAppRiskScore {
  const row = rows.find((r) => r.provider === provider);
  const W = AI_APP_RISK_WEIGHTS;
  const factors: AiAppRiskFactor[] = [];
  if (!row) {
    factors.push({ attribute: "dataset", observed: "not in the risk dataset: every attribute is unknown", points: 0, source: null });
  }
  const a = row?.attributes;
  const src = <T>(s: Sourced<T> | undefined) => s?.source ?? null;

  const training = a?.trainsOnCustomerData.value ?? "unknown";
  factors.push({
    attribute: "trainsOnCustomerData",
    observed: { no: "does not train on customer data", opt_in: "trains only if the customer opts in", opt_out: "trains unless the customer opts out", yes: "trains on customer data", unknown: "training on customer data not verified" }[training],
    points: W.training[training],
    source: src(a?.trainsOnCustomerData),
  });

  const ret = a?.retention.value ?? "unknown";
  const retPoints =
    ret === "none" ? W.retention.none
    : ret === "configurable" ? W.retention.configurable
    : ret === "until_deleted" ? W.retention.until_deleted
    : ret === "unknown" ? W.retention.unknown
    : ret.days <= W.retention.shortDaysMax ? W.retention.shortDays
    : W.retention.longDays;
  factors.push({
    attribute: "retention",
    observed:
      ret === "none" ? "no retention of prompts and outputs by default"
      : ret === "configurable" ? "retention is configurable by the customer"
      : ret === "until_deleted" ? "kept until the customer deletes it"
      : ret === "unknown" ? "retention not verified"
      : `kept ${ret.days} days by default`,
    points: retPoints,
    source: src(a?.retention),
  });

  const regions = a?.hostingRegions.value ?? "unknown";
  factors.push({
    attribute: "hostingRegions",
    observed: regions === "unknown" ? "hosting regions not verified" : `hosted in: ${regions.join(", ")}`,
    points: regions === "unknown" ? W.regions.unknown : W.regions.known,
    source: src(a?.hostingRegions),
  });

  const certs = a?.certifications.value ?? "unknown";
  const coreHeld = certs === "unknown" ? 0 : CORE_CERTS.filter((c) => certs.includes(c)).length;
  factors.push({
    attribute: "certifications",
    observed: certs === "unknown" ? "certifications not verified" : certs.length ? `holds: ${certs.join(", ")}` : "no certification stated",
    points: certs === "unknown" ? W.certifications.unknown : coreHeld === CORE_CERTS.length ? W.certifications.core : coreHeld > 0 ? W.certifications.partial : W.certifications.none,
    source: src(a?.certifications),
  });

  const sso = a?.ssoSupport.value ?? "unknown";
  factors.push({
    attribute: "ssoSupport",
    observed: { saml_and_oidc: "SAML and OIDC single sign-on", saml: "SAML single sign-on", oidc: "OIDC single sign-on", none: "no single sign-on", unknown: "single sign-on not verified" }[sso],
    points: W.sso[sso],
    source: src(a?.ssoSupport),
  });

  const sp = a?.subProcessors.value ?? "unknown";
  factors.push({
    attribute: "subProcessors",
    observed: sp === "unknown" ? "sub-processor list not verified" : sp === "not_published" ? "no published sub-processor list" : "publishes its sub-processor list",
    points: sp === "unknown" ? W.subProcessors.unknown : sp === "not_published" ? W.subProcessors.not_published : W.subProcessors.published,
    source: src(a?.subProcessors),
  });

  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0));
  const b = band(score);
  return {
    provider,
    offering: row?.offering ?? null,
    datasetVersion: AI_APP_RISK_DATASET_VERSION,
    score,
    band: b,
    factors,
    suggestedSiteRule: b === "high" ? "block" : b === "medium" ? "review" : "allow",
  };
}
