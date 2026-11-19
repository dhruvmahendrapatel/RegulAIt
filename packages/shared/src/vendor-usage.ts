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
 * Endpoints verified against the vendors' own documentation on 2026-11-15 (ADR-0322 §6); GitHub's enhanced billing
 * usage report and Cursor's Admin API re-checked on 2026-11-19 for slice 3.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const VENDOR_USAGE_PULL_VENDORS = ["anthropic", "openai", "github_copilot", "cursor"] as const;
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
  github_copilot: {
    vendor: "github_copilot",
    label: "GitHub enhanced billing usage report (Copilot lines)",
    host: "api.github.com",
    endpoints: [
      "GET /organizations/{org}/settings/billing/usage?year&month&day",
      "GET /enterprises/{enterprise}/settings/billing/usage?year&month&day",
    ],
    scopePosture: "unverified",
    scopeNote:
      "GitHub documents organisation 'Administration' read (fine-grained token) for the organisation report and " +
      "enterprise billing read for the enterprise report. A fine-grained token can also carry write permissions, " +
      "and GitHub does not report a fine-grained token's permissions back, so RegulAIt cannot verify the scope. " +
      "Issue a token with read permissions only; RegulAIt calls only the usage report with it.",
    overlapMatchesOn: [],
    limits:
      "The daily usage report is billed per organisation, product, SKU and repository, not per person, so a line " +
      "resolves to a person only through an admin alias for its organisation. Only lines whose product names " +
      "Copilot are kept. GitHub does not state the currency of the amounts; they are recorded as USD, the currency " +
      "GitHub bills in. Per-user premium-request usage and cost centres are not pulled in this slice. The gateway " +
      "does not meter Copilot, so no line is excluded as already metered.",
  },
  cursor: {
    vendor: "cursor",
    label: "Cursor Admin API (usage events)",
    host: "api.cursor.com",
    endpoints: ["POST /teams/filtered-usage-events"],
    scopePosture: "write_capable",
    scopeNote:
      "Cursor's Admin API needs a team admin key with the admin:* scope, which can also change the team. RegulAIt " +
      "calls only the usage events endpoint with it.",
    overlapMatchesOn: [],
    limits:
      "Usage events are summed per day, user email (or service account), model, kind and product from each " +
      "event's charged cents, so included usage that Cursor does not charge counts as zero. A user resolves to a " +
      "person by email. A window with more than 40,000 events stops with page_limit: lower backfillDays. The " +
      "gateway does not meter Cursor, so no line is excluded as already metered.",
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
  github_copilot: z
    .object({
      /** which report to read: the organisation's or the enterprise's */
      account: z.enum(["organization", "enterprise"]),
      /** the organisation login or enterprise slug, which becomes one path segment */
      slug: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/, "a GitHub organisation login or enterprise slug"),
      backfillDays: z.number().int().min(1).max(31).default(7),
    })
    .strict(),
  cursor: z
    .object({
      /** Cursor caps its other usage endpoints at 30 days */
      backfillDays: z.number().int().min(1).max(30).default(7),
    })
    .strict(),
} as const;

export type AnthropicPublicConfig = z.infer<(typeof vendorUsagePublicConfigSchemas)["anthropic"]>;
export type OpenAiPublicConfig = z.infer<(typeof vendorUsagePublicConfigSchemas)["openai"]>;
export type GithubCopilotPublicConfig = z.infer<(typeof vendorUsagePublicConfigSchemas)["github_copilot"]>;
export type CursorPublicConfig = z.infer<(typeof vendorUsagePublicConfigSchemas)["cursor"]>;
export type VendorUsagePublicConfig =
  | AnthropicPublicConfig
  | OpenAiPublicConfig
  | GithubCopilotPublicConfig
  | CursorPublicConfig;

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

const money = z.number().finite();

/** GitHub's enhanced billing usage report (one day); money fields are plain numbers */
export const githubBillingUsageSchema = z.object({
  usageItems: z
    .array(
      z.object({
        date: z.string().min(1).max(40),
        product: z.string().min(1).max(200),
        sku: z.string().max(200).nullable().optional(),
        quantity: money.nullable().optional(),
        unitType: nullableText,
        pricePerUnit: money.nullable().optional(),
        grossAmount: money.nullable().optional(),
        discountAmount: money.nullable().optional(),
        netAmount: money,
        organizationName: nullableText,
        repositoryName: nullableText,
      }),
    )
    .max(50_000),
});
export type GithubBillingUsage = z.infer<typeof githubBillingUsageSchema>;

/** one page of Cursor's filtered usage events */
export const cursorUsageEventsSchema = z.object({
  usageEvents: z
    .array(
      z.object({
        /** epoch milliseconds, as a string */
        timestamp: z.union([z.string().regex(/^\d{1,16}$/), z.number().int().nonnegative()]),
        userEmail: nullableText,
        serviceAccountId: nullableText,
        model: nullableText,
        kind: nullableText,
        product: nullableText,
        requestsCosts: money.nullable().optional(),
        /** CENTS, possibly fractional; the docs name it as the figure that reconciles with the team's spend */
        chargedCents: money,
      }),
    )
    .max(1000),
  pagination: z.object({
    currentPage: z.number().int().min(1),
    hasNextPage: z.boolean(),
  }),
});
export type CursorUsageEvents = z.infer<typeof cursorUsageEventsSchema>;
export type CursorUsageEvent = CursorUsageEvents["usageEvents"][number];

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
  accountKind: "api_key" | "project" | "workspace" | "organisation" | "user" | "service_account";
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

const DAY_MS = 86_400_000;

function utcDay(ms: number): { start: string; end: string } {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString() };
}

/**
 * One day of GitHub's enhanced billing usage report to facts, keeping only Copilot lines. The report has no person
 * dimension: a line is billed to an organisation (and a repository, kept in the detail). GitHub does not state the
 * currency; it bills in USD, and the catalogue says so.
 */
export function normalizeGithubCopilotUsage(page: GithubBillingUsage, account: { kind: "organization" | "enterprise"; slug: string }): VendorUsageFact[] {
  const facts: VendorUsageFact[] = [];
  for (const item of page.usageItems) {
    if (!item.product.toLowerCase().includes("copilot")) continue;
    const at = Date.parse(item.date);
    if (Number.isNaN(at)) throw new VendorUsageResponseError("a usage item date was not a valid date");
    const { start, end } = utcDay(at);
    const org = item.organizationName ?? (account.kind === "organization" ? account.slug : null);
    const repo = item.repositoryName ?? null;
    facts.push({
      factCanonical: canonical(["github_copilot.billing_usage.v1", account.kind, account.slug, start, item.product, item.sku, org, repo]),
      accountRef: org ? `github organization ${org}` : `github enterprise ${account.slug}`,
      accountKind: "organisation",
      accountId: org,
      periodStart: start,
      periodEnd: end,
      amount: item.netAmount,
      currency: "USD",
      service: item.sku ?? item.product,
      description: item.product,
      quantity: item.quantity ?? null,
      unit: item.unitType ?? null,
      detail: {
        source: "github billing usage",
        ...(repo ? { repository: repo } : {}),
        ...(typeof item.grossAmount === "number" ? { grossAmount: item.grossAmount } : {}),
        ...(typeof item.discountAmount === "number" ? { discountAmount: item.discountAmount } : {}),
      },
    });
  }
  return facts;
}

/**
 * Cursor usage events to daily facts: one fact per UTC day, user email (or service account), model, kind and
 * product, summing each event's charged cents. Summed across every page of the run, so a fact is never split over
 * two pages. Cents are summed as integer micro-cents, so fractional cents add up without float drift.
 */
export function normalizeCursorUsageEvents(events: readonly CursorUsageEvent[]): VendorUsageFact[] {
  const groups = new Map<string, { fact: VendorUsageFact; microCents: number; events: number; requests: number }>();
  for (const e of events) {
    const ms = typeof e.timestamp === "number" ? e.timestamp : Number(e.timestamp);
    // 8.64e15 ms is the last instant a Date can hold; beyond it toISOString would throw a RangeError
    if (!Number.isSafeInteger(ms) || ms > 8.64e15) throw new VendorUsageResponseError("a usage event timestamp was not epoch milliseconds");
    const { start, end } = utcDay(ms);
    const email = e.userEmail?.trim().toLowerCase() || null;
    const serviceAccount = email ? null : (e.serviceAccountId ?? null);
    const accountKind: VendorUsageFact["accountKind"] = email ? "user" : serviceAccount ? "service_account" : "organisation";
    const accountId = email ?? serviceAccount;
    const factCanonical = canonical(["cursor.usage_events.v1", start, accountKind, accountId, e.model, e.kind, e.product]);
    let g = groups.get(factCanonical);
    if (!g) {
      g = {
        fact: {
          factCanonical,
          accountRef: email ?? (serviceAccount ? `cursor service account ${serviceAccount}` : "cursor team (no user)"),
          accountKind,
          accountId,
          periodStart: start,
          periodEnd: end,
          amount: 0,
          currency: "USD",
          service: e.model ?? null,
          description: e.product ?? e.kind ?? null,
          quantity: null,
          unit: "requests",
          detail: {},
        },
        microCents: 0,
        events: 0,
        requests: 0,
      };
      groups.set(factCanonical, g);
    }
    g.microCents += Math.round(e.chargedCents * 1e6);
    g.events += 1;
    g.requests += e.requestsCosts ?? 0;
  }
  return [...groups.values()].map(({ fact, microCents, events: count, requests }) => ({
    ...fact,
    amount: microCents / 1e8,
    quantity: Math.round(requests * 1e6) / 1e6,
    detail: { source: "cursor usage events", events: count },
  }));
}

/**
 * Whether a fact is spend the gateway already metered: the vendor billed it to a key, project or workspace the admin
 * declared as the gateway's own. Such a line is kept, excluded from the imported side and disclosed (ADR-0322 §5).
 */
export function factOverlapsMetered(
  vendor: VendorUsagePullVendor,
  fact: Pick<VendorUsageFact, "accountKind" | "accountId">,
  config: VendorUsagePublicConfig,
  detailProjectId?: string | null,
): boolean {
  // the gateway does not meter Copilot seats or Cursor usage, so none of their lines is already metered
  if (vendor === "github_copilot" || vendor === "cursor") return false;
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

