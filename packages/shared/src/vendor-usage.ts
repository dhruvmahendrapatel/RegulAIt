/**
 * ADR-0322 — opt-in, per-tenant read-only pull of vendor usage and cost data: the pure half.
 *
 * What lives here: the vendor catalogue (documented host, credential posture, limits stated honestly), the
 * per-vendor configuration schema, the response schemas and the normalisers that turn one validated vendor page into
 * restated cost facts. No I/O. The gateway (`apps/gateway/src/vendor-usage-pull.ts`) owns the fetch, the credential,
 * the ledger and the writes.
 *
 * Every normalised fact is IMPORTED spend (ADR-0069): a restatement of what the vendor says it billed, never a
 * metered figure. A fact carries the vendor's own identity (`factCanonical`), from which the gateway derives the
 * upsert key, so a re-pull of the same window replaces its own rows instead of adding a second copy.
 *
 * Endpoints verified against the vendors' own documentation on 2026-11-15 (ADR-0322 §6).
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const VENDOR_USAGE_PULL_VENDORS = ["anthropic", "openai"] as const;
export type VendorUsagePullVendor = (typeof VENDOR_USAGE_PULL_VENDORS)[number];

export interface VendorUsageCatalogueEntry {
  vendor: VendorUsagePullVendor;
  label: string;
  /** the only host a connector for this vendor may call (ADR-0322 §3) */
  host: string;
  endpoints: readonly string[];
  /** how the vendor scopes the key; `write_capable` needs a recorded acknowledgement (owner answer, 2026-11-15) */
  scopePosture: "read_only" | "write_capable" | "unverified";
  scopeNote: string;
  /** what the key identifies in the vendor's report, and so what `overlaps_metered` can match on */
  overlapMatchesOn: readonly ("api_key" | "project" | "workspace")[];
  /** an honest limit: a capability list that only says yes is marketing (ADR-0069 §2) */
  limits: string;
}

export const VENDOR_USAGE_CATALOGUE: Readonly<Record<VendorUsagePullVendor, VendorUsageCatalogueEntry>> = {
  anthropic: {
    vendor: "anthropic",
    label: "Anthropic Admin API (cost report)",
    host: "api.anthropic.com",
    endpoints: ["GET /v1/organizations/cost_report"],
    scopePosture: "write_capable",
    scopeNote:
      "Anthropic documents no read-only scope for Admin keys: the key can also manage keys, members and workspaces. " +
      "RegulAIt calls only the cost report endpoint with it.",
    overlapMatchesOn: ["workspace"],
    limits:
      "The cost report is grouped by workspace and line description, not by person or API key, so lines resolve to " +
      "a person only through an admin alias for the workspace. It excludes Priority Tier costs, and Claude Code " +
      "per-user cost is not pulled in this slice.",
  },
  openai: {
    vendor: "openai",
    label: "OpenAI Administration API (costs)",
    host: "api.openai.com",
    endpoints: ["GET /v1/organization/costs"],
    scopePosture: "write_capable",
    scopeNote:
      "OpenAI's admin API guide documents no read-only restriction for Admin keys. RegulAIt treats the key as able " +
      "to write and calls only the costs endpoint with it.",
    overlapMatchesOn: ["api_key", "project"],
    limits:
      "Costs come in daily buckets per API key, project and line item, not per person: an API key or project " +
      "resolves to a person only through an admin alias. Usage that is not billed to an API key is reported per " +
      "project.",
  },
};

const idList = z.array(z.string().trim().min(1).max(200)).max(200);

/**
 * The non-secret configuration of one connector. Schema-validated on every write (the 3NF exception on
 * `vendor_usage_connectors.public_config`). The `gateway*` lists name the vendor's ids for the keys, projects and
 * workspaces the gateway itself uses, so their spend, already metered, is excluded from the imported side.
 */
export const vendorUsagePublicConfigSchemas = {
  anthropic: z
    .object({
      gatewayWorkspaceIds: idList.default([]),
      backfillDays: z.number().int().min(1).max(31).default(7),
    })
    .strict(),
  openai: z
    .object({
      gatewayApiKeyIds: idList.default([]),
      gatewayProjectIds: idList.default([]),
      backfillDays: z.number().int().min(1).max(31).default(7),
    })
    .strict(),
} as const;

export type AnthropicPublicConfig = z.infer<(typeof vendorUsagePublicConfigSchemas)["anthropic"]>;
export type OpenAiPublicConfig = z.infer<(typeof vendorUsagePublicConfigSchemas)["openai"]>;

/** the largest window one run asks for: both vendors cap a request at 31 daily buckets */
export const VENDOR_USAGE_MAX_WINDOW_DAYS = 31;
/** pages one run may follow before it stops with `page_limit` */
export const VENDOR_USAGE_MAX_PAGES = 40;
/** bytes one response may carry (the guarded fetch enforces it) */
export const VENDOR_USAGE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// --------------------------------------------------------------------------------------------------------------------
// Response schemas. Unknown fields are allowed (vendors add fields) but every field used is checked.
// --------------------------------------------------------------------------------------------------------------------

const nullableText = z.string().max(500).nullable().optional();

export const anthropicCostReportSchema = z.object({
  data: z
    .array(
      z.object({
        starting_at: z.string().max(40),
        ending_at: z.string().max(40),
        results: z
          .array(
            z.object({
              /** a DECIMAL STRING IN CENTS ("123.45" = $1.2345) */
              amount: z.string().max(40),
              currency: z.string().min(1).max(10),
              workspace_id: nullableText,
              description: nullableText,
              cost_type: nullableText,
              context_window: nullableText,
              model: nullableText,
              service_tier: nullableText,
              token_type: nullableText,
              inference_geo: nullableText,
              speed: nullableText,
            }),
          )
          .max(10_000),
      }),
    )
    .max(100),
  has_more: z.boolean(),
  next_page: z.string().max(2000).nullable().optional(),
});
export type AnthropicCostReport = z.infer<typeof anthropicCostReportSchema>;

export const openAiCostsSchema = z.object({
  data: z
    .array(
      z.object({
        start_time: z.number().int(),
        end_time: z.number().int(),
        results: z
          .array(
            z.object({
              /** DOLLARS, as a float, with a lower-case currency */
              amount: z.object({ value: z.number().finite(), currency: z.string().min(1).max(10) }),
              line_item: nullableText,
              project_id: nullableText,
              api_key_id: nullableText,
              quantity: z.number().finite().nullable().optional(),
              quantity_unit: nullableText,
            }),
          )
          .max(10_000),
      }),
    )
    .max(200),
  has_more: z.boolean(),
  next_page: z.string().max(2000).nullable().optional(),
});
export type OpenAiCosts = z.infer<typeof openAiCostsSchema>;

// --------------------------------------------------------------------------------------------------------------------
// Normalisation
// --------------------------------------------------------------------------------------------------------------------

export class VendorUsageResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendorUsageResponseError";
  }
}

/** one restated cost fact, ready for identity resolution and an upsert */
export interface VendorUsageFact {
  /** the vendor's own identity of the fact; the gateway stores its sha-256 as the upsert key */
  factCanonical: string;
  accountRef: string;
  /** which kind of vendor id `accountRef` names, for the metered-overlap match */
  accountKind: "api_key" | "project" | "workspace" | "organisation";
  /** the bare vendor id, or null for the organisation-level remainder */
  accountId: string | null;
  periodStart: string;
  periodEnd: string;
  amount: number;
  currency: string;
  service: string | null;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  detail: Record<string, unknown>;
}

/** sha-256 of the canonical fact identity, hex: the `fact_key` column */
export function vendorUsageFactKey(fact: Pick<VendorUsageFact, "factCanonical">): string {
  return createHash("sha256").update(fact.factCanonical).digest("hex");
}

/**
 * Cents as a decimal string to dollars, by moving the decimal point in the string rather than dividing a float, so
 * "0.1" cents becomes 0.001 exactly as written. Refuses anything that is not a plain non-negative or negative decimal.
 */
export function centsDecimalToDollars(raw: string): number {
  const m = /^(-?)(\d{1,15})(?:\.(\d{1,12}))?$/.exec(raw.trim());
  if (!m) throw new VendorUsageResponseError("an amount was not a plain decimal number");
  const [, sign, int, frac = ""] = m;
  const padded = int!.padStart(3, "0");
  return Number(`${sign}${padded.slice(0, -2)}.${padded.slice(-2)}${frac}`);
}

function isoOrThrow(raw: string, what: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new VendorUsageResponseError(`a bucket ${what} was not a valid instant`);
  return d.toISOString();
}

function canonical(parts: ReadonlyArray<string | number | null | undefined>): string {
  return parts.map((p) => (p === null || p === undefined ? "" : String(p).replace(/\|/g, "%7C"))).join("|");
}

/** one Anthropic cost report page to facts. Every line is billed to a workspace (null = the default workspace). */
export function normalizeAnthropicCostReport(page: AnthropicCostReport): VendorUsageFact[] {
  const facts: VendorUsageFact[] = [];
  for (const bucket of page.data) {
    const periodStart = isoOrThrow(bucket.starting_at, "start");
    const periodEnd = isoOrThrow(bucket.ending_at, "end");
    if (periodEnd <= periodStart) throw new VendorUsageResponseError("a bucket ended before it started");
    for (const r of bucket.results) {
      const workspace = r.workspace_id ?? null;
      facts.push({
        factCanonical: canonical([
          "anthropic.cost_report.v1",
          periodStart,
          periodEnd,
          workspace ?? "default",
          r.description,
          r.cost_type,
          r.model,
          r.token_type,
          r.service_tier,
          r.context_window,
          r.inference_geo,
          r.speed,
        ]),
        accountRef: workspace ? `anthropic workspace ${workspace}` : "anthropic workspace default",
        accountKind: "workspace",
        accountId: workspace,
        periodStart,
        periodEnd,
        amount: centsDecimalToDollars(r.amount),
        currency: r.currency.toUpperCase(),
        service: r.model ?? r.cost_type ?? null,
        description: r.description ?? null,
        quantity: null,
        unit: null,
        detail: {
          source: "anthropic cost_report",
          ...(r.cost_type ? { costType: r.cost_type } : {}),
          ...(r.token_type ? { tokenType: r.token_type } : {}),
          ...(r.service_tier ? { serviceTier: r.service_tier } : {}),
        },
      });
    }
  }
  return facts;
}

/** one OpenAI costs page to facts. A line names its API key when the vendor gives one, else its project. */
export function normalizeOpenAiCosts(page: OpenAiCosts): VendorUsageFact[] {
  const facts: VendorUsageFact[] = [];
  for (const bucket of page.data) {
    if (bucket.end_time <= bucket.start_time) throw new VendorUsageResponseError("a bucket ended before it started");
    const periodStart = new Date(bucket.start_time * 1000).toISOString();
    const periodEnd = new Date(bucket.end_time * 1000).toISOString();
    for (const r of bucket.results) {
      const apiKey = r.api_key_id ?? null;
      const project = r.project_id ?? null;
      const accountKind = apiKey ? "api_key" : project ? "project" : "organisation";
      const accountId = apiKey ?? project ?? null;
      facts.push({
        factCanonical: canonical(["openai.costs.v1", periodStart, periodEnd, apiKey, project, r.line_item]),
        accountRef: apiKey
          ? `openai api key ${apiKey}`
          : project
            ? `openai project ${project}`
            : "openai organisation (no project)",
        accountKind,
        accountId,
        periodStart,
        periodEnd,
        amount: r.amount.value,
        currency: r.amount.currency.toUpperCase(),
        service: r.line_item ?? null,
        description: r.line_item ?? null,
        quantity: r.quantity ?? null,
        unit: r.quantity_unit ?? null,
        detail: { source: "openai costs", ...(project ? { projectId: project } : {}) },
      });
    }
  }
  return facts;
}

/**
 * Whether a fact is spend the gateway already metered: the vendor billed it to a key, project or workspace the admin
 * declared as the gateway's own. Such a line is kept, excluded from the imported side and disclosed (ADR-0322 §5).
 */
export function factOverlapsMetered(
  vendor: VendorUsagePullVendor,
  fact: Pick<VendorUsageFact, "accountKind" | "accountId">,
  config: AnthropicPublicConfig | OpenAiPublicConfig,
  detailProjectId?: string | null,
): boolean {
  if (vendor === "anthropic") {
    const c = config as AnthropicPublicConfig;
    return fact.accountKind === "workspace" && fact.accountId !== null && c.gatewayWorkspaceIds.includes(fact.accountId);
  }
  const c = config as OpenAiPublicConfig;
  if (fact.accountKind === "api_key" && fact.accountId !== null && c.gatewayApiKeyIds.includes(fact.accountId)) return true;
  const project = fact.accountKind === "project" ? fact.accountId : (detailProjectId ?? null);
  return project !== null && c.gatewayProjectIds.includes(project);
}

/** the plain statement every pull response and the posture read carry */
export const VENDOR_USAGE_PULL_STATEMENT =
  "Pulled vendor figures are IMPORTED spend: a restatement of what the vendor says it billed, never metered by " +
  "RegulAIt and never added to metered spend. Lines billed to a key, project or workspace the gateway itself uses " +
  "are excluded from the imported side because that spend is already metered, and the exclusion is disclosed.";
