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
 * usage report and Cursor's Admin API re-checked on 2026-11-19 for slice 3. ChatGPT Enterprise's Daily Usage endpoint
 * checked against the vendor's public OpenAPI document (version 2.5.43) on 2026-11-20 for slice 4b.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseCsvRecords } from "./onboarding.js";

export const VENDOR_USAGE_PULL_VENDORS = ["anthropic", "openai", "github_copilot", "cursor", "aws_cur", "openai_codex"] as const;
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
      "Storing it needs the administrator's attestation that it carries read permissions only (recorded and " +
      "audited); RegulAIt calls only the usage report with it.",
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
      "event's charged cents, so included usage that Cursor does not charge counts as zero. The user's email is " +
      "stored on each line as its account reference, as for file-imported cost lines, and resolves it to a person. " +
      "A window with more than 40,000 events stops with page_limit: lower backfillDays. The " +
      "gateway does not meter Cursor, so no line is excluded as already metered.",
  },
  aws_cur: {
    vendor: "aws_cur",
    label: "AWS Data Exports (CUR 2.0), Amazon Bedrock lines",
    host: "sts.{region}.amazonaws.com and {bucket}.s3.{region}.amazonaws.com",
    endpoints: [
      "STS AssumeRoleWithWebIdentity (federated mode)",
      "STS AssumeRoleWithWebIdentity on RegulAIt's own principal role, then AssumeRole on the customer's role with the connector's external id (principal mode)",
      "S3 ListObjectsV2 on {prefix}/{exportName}/metadata/BILLING_PERIOD=YYYY-MM/",
      "S3 GetObject on the manifest and on its data files under {prefix}/{exportName}/data/BILLING_PERIOD=YYYY-MM/",
    ],
    scopePosture: "unverified",
    scopeNote:
      "RegulAIt cannot read the role's or the key's IAM policy without asking for more access, so the scope is " +
      "unverified. Grant only s3:ListBucket on the bucket (limited to the export prefix), s3:GetObject on the " +
      "export prefix and, for a KMS-encrypted bucket, kms:Decrypt on its key (a minimal policy inferred from AWS's " +
      "documentation, not stated by AWS). Storing the credential needs the administrator's attestation that it is " +
      "limited this way; RegulAIt only lists and reads the export.",
    overlapMatchesOn: [],
    limits:
      "Reads a CUR 2.0 export delivered as gzip-compressed CSV; a Parquet export is refused (recreate it as " +
      "CSV). Use a dedicated export of Bedrock usage: a whole-estate export at a large organisation exceeds the " +
      "per-run bounds. Only lines whose product code is in the configured list are kept (AmazonBedrock by default; " +
      "the product codes of Marketplace-billed models are not verified). The amount is line_item_unblended_cost, " +
      "for every line item type, so savings plans and discounts are not amortised. A line is billed to the IAM " +
      "principal when the export carries AWS's caller identity (line_item_iam_principal, an opt-in), otherwise to " +
      "the AWS account; either resolves to a person only through an admin alias. A principal ARN of an assumed " +
      "role carries its session name, which callers often set to an email, and it is stored as the line's account " +
      "reference. AWS restates a month for about two weeks: each pull replaces the lines of every month it re-reads, " +
      "so a line AWS removes is withdrawn. The gateway does not meter Bedrock, so no line is excluded as already " +
      "metered.",
  },
  openai_codex: {
    vendor: "openai_codex",
    label: "ChatGPT Enterprise Daily Usage (ChatGPT, Codex and Work)",
    host: "api.chatgpt.com",
    endpoints: ["GET /v1/analytics/workspaces/{workspace_id}/usage?start_time&end_time&limit&page"],
    scopePosture: "unverified",
    scopeNote:
      "The endpoint needs a workspace-scoped Admin key with the enterprise.analytics.usage.read permission. An Admin " +
      "key can be created with other permissions too, including write ones, and the API does not report a key's " +
      "permissions back, so RegulAIt cannot verify the scope. Storing it needs the administrator's attestation that " +
      "it carries that read permission only (recorded and audited); RegulAIt calls only the Daily Usage endpoint.",
    overlapMatchesOn: [],
    limits:
      "One line per user, UTC day, client (such as CHAT_WEB or CODEX_CLI) and pricing basis, plus an 'unattributed' " +
      "line for the part of a user's daily total the vendor does not assign to a client. Credit-priced usage is " +
      "recorded at the vendor's estimated_cost_usd, an estimate at the workspace's current credit overage rate and not " +
      "an invoice amount, and every such line is marked as an estimate with its credit count; credit-priced usage " +
      "with no estimate is not imported and is counted in the run summary. Native USD-priced usage (cost_usd) is " +
      "recorded as reported. A line resolves to a person by the user's email, which the vendor reports as the " +
      "user's current address and may omit. Users deleted from the workspace drop out of the per-user report, so " +
      "their earlier lines are kept, not withdrawn. Recent days are corrected as usage arrives; each pull re-reads " +
      "the last two days. The gateway does not meter ChatGPT or Codex, so no line is excluded as already metered.",
  },
};

/** the shape of a RegulAIt-generated AWS external id (ADR-0195 decision 3): `regulait-` and a UUID */
export const AWS_CUR_EXTERNAL_ID = /^regulait-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** true when a request's config names an external id in any spelling, which only RegulAIt may set */
export function configNamesExternalId(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  return Object.keys(raw).some((k) => k.replace(/[^a-z]/gi, "").toLowerCase() === "externalid");
}

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
  aws_cur: z
    .object({
      /**
       * federated: the customer's role trusts RegulAIt's federation issuer; principal: the customer's role trusts
       * RegulAIt's own AWS principal with a RegulAIt-generated external id (slice 4c); static: an access-key pair
       * (audited)
       */
      credentialMode: z.enum(["federated", "principal", "static"]),
      /** the customer's role RegulAIt assumes (federated and principal modes) */
      roleArn: z.string().trim().max(2048).optional(),
      /**
       * principal mode only: generated by RegulAIt when the connector is created or moved to principal mode, kept
       * across later changes, shown so the admin can put it in the role's trust policy. Never accepted from a request
       * (the routes refuse the key, ADR-0195 decision 3); the schema reads it back from storage.
       */
      externalId: z.string().regex(AWS_CUR_EXTERNAL_ID, "a RegulAIt-generated external id").optional(),
      region: z.string().trim().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d{1,2}$/, "an AWS region such as us-east-1"),
      /** no dots: a dotted bucket name cannot be reached virtual-hosted over TLS */
      bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "an S3 bucket name without dots"),
      /** the export's S3 prefix, "" for the bucket root; plain path segments only */
      prefix: z
        .string()
        .trim()
        .max(512)
        .regex(/^(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?$/, "path segments of letters, digits, '_', '.' and '-'")
        .refine((v) => !v.split("/").some((seg) => seg === "." || seg === ".."), "no '.' or '..' segments")
        .default(""),
      exportName: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/, "the Data Exports export name"),
      /** line_item_product_code values kept; Marketplace model codes are not verified (ADR-0322 slice 4a) */
      productCodes: z.array(z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1).max(20).default(["AmazonBedrock"]),
      /** billing months the first pull reads, counting the current one */
      backfillMonths: z.number().int().min(1).max(3).default(1),
    })
    .strict()
    .superRefine((c, ctx) => {
      if (c.credentialMode !== "static") {
        const parts = (c.roleArn ?? "").split(":");
        const ok = parts.length >= 6 && parts[0] === "arn" && parts[1]!.startsWith("aws") && parts[2] === "iam" && /^\d{12}$/.test(parts[4] ?? "") && parts[5]!.startsWith("role/");
        if (!ok) ctx.addIssue({ code: "custom", path: ["roleArn"], message: `${c.credentialMode} mode needs an IAM role ARN` });
      } else if (c.roleArn !== undefined) {
        ctx.addIssue({ code: "custom", path: ["roleArn"], message: "static mode takes no role ARN" });
      }
      if (c.externalId !== undefined && c.credentialMode !== "principal") {
        ctx.addIssue({ code: "custom", path: ["externalId"], message: "only principal mode has an external id" });
      }
    }),
  openai_codex: z
    .object({
      /** the ChatGPT Enterprise workspace id, which becomes one path segment */
      workspaceId: z.string().trim().uuid("the ChatGPT Enterprise workspace id (a UUID)"),
      backfillDays: z.number().int().min(1).max(30).default(7),
    })
    .strict(),
} as const;

/**
 * The secret of a connector whose credential is structured. Only `aws_cur` has one: a federated connector stores a
 * marker (nothing secret exists, but the live credential row still makes store, attest and revoke the switch), and a
 * static one stores the access-key pair.
 */
export const vendorUsageSecretSchemas = {
  aws_cur: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("federated") }).strict(),
    z.object({ mode: z.literal("principal") }).strict(),
    z
      .object({
        mode: z.literal("static"),
        accessKeyId: z.string().regex(/^[A-Z0-9]{16,128}$/, "an AWS access key id"),
        secretAccessKey: z.string().min(16).max(256),
      })
      .strict(),
  ]),
} as const;
export type AwsCurSecret = z.infer<(typeof vendorUsageSecretSchemas)["aws_cur"]>;

export type AnthropicPublicConfig = z.infer<(typeof vendorUsagePublicConfigSchemas)["anthropic"]>;
export type OpenAiPublicConfig = z.infer<(typeof vendorUsagePublicConfigSchemas)["openai"]>;
export type GithubCopilotPublicConfig = z.infer<(typeof vendorUsagePublicConfigSchemas)["github_copilot"]>;
export type CursorPublicConfig = z.infer<(typeof vendorUsagePublicConfigSchemas)["cursor"]>;
export type AwsCurPublicConfig = z.infer<(typeof vendorUsagePublicConfigSchemas)["aws_cur"]>;
export type OpenAiCodexPublicConfig = z.infer<(typeof vendorUsagePublicConfigSchemas)["openai_codex"]>;
export type VendorUsagePublicConfig =
  | AnthropicPublicConfig
  | OpenAiPublicConfig
  | GithubCopilotPublicConfig
  | CursorPublicConfig
  | AwsCurPublicConfig
  | OpenAiCodexPublicConfig;

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

/** an amount as the vendor sends it: a JSON number, bounded so micro-units stay exact integers */
const usageAmount = z.number().finite().gt(-1e9).lt(1e9);

/** ChatGPT Enterprise Daily Usage, one page (`GET /v1/analytics/workspaces/{id}/usage`, OpenAPI 2.5.43) */
export const chatGptDailyUsagePageSchema = z.object({
  object: z.literal("page"),
  data: z
    .array(
      z.object({
        object: z.literal("workspace.usage.result"),
        start_time: z.number().int(),
        end_time: z.number().int(),
        user_id: z.string().min(1).max(200).nullable(),
        actor: z
          .object({
            type: z.literal("ACCOUNT_USER"),
            user_id: z.string().min(1).max(200),
            email: z.string().max(320).nullable().optional(),
          })
          .nullable(),
        totals: z.object({
          chats: z.number().int().nonnegative(),
          messages: z.number().int().nonnegative(),
          credits: usageAmount.nullable(),
          cost_usd: usageAmount.nullable().optional(),
          estimated_cost_usd: usageAmount.optional(),
        }),
        clients: z
          .array(
            z.object({
              client_id: z.string().min(1).max(100),
              chats: z.number().int().nonnegative(),
              messages: z.number().int().nonnegative(),
              credits: usageAmount.nullable(),
              cost_usd: usageAmount.nullable().optional(),
              estimated_cost_usd: usageAmount.optional(),
            }),
          )
          .max(200),
      }),
    )
    .max(30_000),
  has_more: z.boolean(),
  next_page: z.string().min(1).max(4096).nullable(),
});
export type ChatGptDailyUsagePage = z.infer<typeof chatGptDailyUsagePageSchema>;
export type ChatGptDailyUsageRow = ChatGptDailyUsagePage["data"][number];

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
  accountKind: "api_key" | "project" | "workspace" | "organisation" | "user" | "service_account" | "iam_principal" | "aws_account";
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
  // items with the same identity on the same day (for example around a price change) are summed, never collapsed:
  // the gateway keeps one fact per key, so an unsummed duplicate would silently drop spend (#1069 R4)
  const groups = new Map<string, { fact: VendorUsageFact; net: number; qty: number | null; gross: number | null; discount: number | null }>();
  const micro = (n: number) => Math.round(n * 1e6);
  for (const item of page.usageItems) {
    if (!item.product.toLowerCase().includes("copilot")) continue;
    const at = Date.parse(item.date);
    if (Number.isNaN(at)) throw new VendorUsageResponseError("a usage item date was not a valid date");
    const { start, end } = utcDay(at);
    const org = item.organizationName ?? (account.kind === "organization" ? account.slug : null);
    const repo = item.repositoryName ?? null;
    const factCanonical = canonical(["github_copilot.billing_usage.v1", account.kind, account.slug, start, item.product, item.sku, org, repo]);
    let g = groups.get(factCanonical);
    if (!g) {
      g = {
        fact: {
          factCanonical,
          accountRef: org ? `github organization ${org}` : `github enterprise ${account.slug}`,
          accountKind: "organisation",
          accountId: org,
          periodStart: start,
          periodEnd: end,
          amount: 0,
          currency: "USD",
          service: item.sku ?? item.product,
          description: item.product,
          quantity: null,
          unit: item.unitType ?? null,
          detail: { source: "github billing usage", ...(repo ? { repository: repo } : {}) },
        },
        net: 0,
        qty: null,
        gross: null,
        discount: null,
      };
      groups.set(factCanonical, g);
    }
    g.net += micro(item.netAmount);
    if (typeof item.quantity === "number") g.qty = (g.qty ?? 0) + micro(item.quantity);
    if (typeof item.grossAmount === "number") g.gross = (g.gross ?? 0) + micro(item.grossAmount);
    if (typeof item.discountAmount === "number") g.discount = (g.discount ?? 0) + micro(item.discountAmount);
    // a unit that differs between summed items is not one unit any more
    if (g.fact.unit !== (item.unitType ?? null)) g.fact.unit = null;
  }
  return [...groups.values()].map(({ fact, net, qty, gross, discount }) => ({
    ...fact,
    amount: net / 1e6,
    quantity: qty === null ? null : qty / 1e6,
    detail: {
      ...fact.detail,
      ...(gross !== null ? { grossAmount: gross / 1e6 } : {}),
      ...(discount !== null ? { discountAmount: discount / 1e6 } : {}),
    },
  }));
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

const toMicro = (x: number): number => Math.round(x * 1e6);

/**
 * ChatGPT Enterprise Daily Usage rows (every page of a run) to facts (ADR-0322 slice 4b, owner decisions 1 and 2).
 *
 * Each per-user, per-day row yields, for each of its clients, a `credit_estimate` fact when the vendor gives
 * `estimated_cost_usd` (the amount, marked as an estimate, with the credit count beside it) and a `usd` fact when it
 * gives native `cost_usd`. The part of a row's total the vendor does not assign to a client becomes an `unattributed`
 * fact of the same basis, when it is positive. A row with credit-priced usage and no estimate imports no credit line
 * and is counted in `creditRowsWithoutEstimate`. A row that is not a per-user UTC day inside the window, or a second
 * row for the same user and day, fails the run rather than being moved or summed.
 */
export function normalizeChatGptDailyUsage(
  rows: readonly ChatGptDailyUsageRow[],
  ctx: { workspaceId: string; window: { start: Date; end: Date } },
): { facts: VendorUsageFact[]; creditRowsWithoutEstimate: number } {
  const facts: VendorUsageFact[] = [];
  const seen = new Set<string>();
  let creditRowsWithoutEstimate = 0;
  for (const row of rows) {
    if (row.user_id === null || row.actor === null || row.actor.user_id !== row.user_id) {
      throw new VendorUsageResponseError("a daily usage row was not a per-user row");
    }
    const startMs = row.start_time * 1000;
    if (startMs % DAY_MS !== 0 || row.end_time - row.start_time !== DAY_MS / 1000) {
      throw new VendorUsageResponseError("a daily usage row did not cover one UTC day");
    }
    if (startMs < ctx.window.start.getTime() || startMs >= ctx.window.end.getTime()) {
      throw new VendorUsageResponseError("a daily usage row fell outside the requested window");
    }
    const dayKey = `${row.user_id}|${startMs}`;
    if (seen.has(dayKey)) throw new VendorUsageResponseError("the vendor returned two rows for the same user and day");
    seen.add(dayKey);

    const { start, end } = utcDay(startMs);
    const email = row.actor.email?.trim().toLowerCase() || null;
    const accountRef = email ?? `chatgpt user ${row.user_id}`;
    const accountId = email ?? row.user_id;
    const push = (
      service: string,
      basis: "credit_estimate" | "usd",
      micro: number,
      extra: { credits: number | null; chats: number | null; messages: number | null },
    ) => {
      facts.push({
        factCanonical: canonical(["openai_codex.daily_usage.v1", ctx.workspaceId, start, row.user_id, service, basis]),
        accountRef,
        accountKind: "user",
        accountId,
        periodStart: start,
        periodEnd: end,
        amount: micro / 1e6,
        currency: "USD",
        service,
        description: basis === "credit_estimate" ? "credit-priced usage, estimated in USD" : "USD-priced usage",
        quantity: basis === "credit_estimate" ? extra.credits : extra.messages,
        unit: basis === "credit_estimate" ? "credits" : "messages",
        detail: {
          source: "chatgpt daily usage",
          basis,
          estimate: basis === "credit_estimate",
          userId: row.user_id,
          ...extra,
        },
      });
    };

    let estSum = 0;
    let usdSum = 0;
    let creditSum = 0;
    for (const c of row.clients) {
      const counts = { chats: c.chats, messages: c.messages };
      if (c.estimated_cost_usd !== undefined) {
        const micro = toMicro(c.estimated_cost_usd);
        estSum += micro;
        creditSum += toMicro(c.credits ?? 0);
        push(c.client_id, "credit_estimate", micro, { credits: c.credits, ...counts });
      }
      if (c.cost_usd !== null && c.cost_usd !== undefined) {
        const micro = toMicro(c.cost_usd);
        usdSum += micro;
        push(c.client_id, "usd", micro, { credits: null, ...counts });
      }
    }
    const t = row.totals;
    if (t.estimated_cost_usd !== undefined) {
      const rest = toMicro(t.estimated_cost_usd) - estSum;
      const credits = Math.max(0, toMicro(t.credits ?? 0) - creditSum) / 1e6;
      if (rest > 0) push("unattributed", "credit_estimate", rest, { credits, chats: null, messages: null });
    } else if (t.credits !== null && t.credits !== 0) {
      creditRowsWithoutEstimate += 1;
    }
    if (t.cost_usd !== null && t.cost_usd !== undefined) {
      const rest = toMicro(t.cost_usd) - usdSum;
      if (rest > 0) push("unattributed", "usd", rest, { credits: null, chats: null, messages: null });
    }
  }
  return { facts, creditRowsWithoutEstimate };
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
  if (vendor === "github_copilot" || vendor === "cursor" || vendor === "aws_cur" || vendor === "openai_codex") return false;
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


// --------------------------------------------------------------------------------------------------------------------
// AWS CUR 2.0 (Data Exports), slice 4a. Pure: the reader in @regulait/cloud-discovery hands over the decompressed
// CSV text of each data file; this turns it into daily Bedrock facts. Owner decisions 2026-11-20 (ADR-0322).
// --------------------------------------------------------------------------------------------------------------------

/** months one pull may read at most (backfill plus the restated previous month) */
export const AWS_CUR_MAX_PERIODS = 4;
/** AWS restates a closed month for about two weeks; it is re-read while today's day of month is at most this */
export const AWS_CUR_RESTATE_DAYS = 15;

/** the CUR 2.0 manifest (metadata/BILLING_PERIOD=YYYY-MM/...Manifest.json); unknown fields are allowed */
export const awsCurManifestSchema = z.object({
  executionId: z.string().min(1).max(200).optional(),
  columns: z.array(z.object({ name: z.string().min(1).max(200), type: z.string().max(100).optional() })).max(2000).optional(),
  dataFiles: z.array(z.string().min(1).max(2048)).min(0).max(500),
});
export type AwsCurManifest = z.infer<typeof awsCurManifestSchema>;

/** "YYYY-MM" for a UTC instant */
export function awsCurPeriodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function periodShift(period: string, months: number): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return awsCurPeriodOf(new Date(Date.UTC(y, m - 1 + months, 1)));
}

/** the UTC bounds of a billing period */
export function awsCurPeriodBounds(period: string): { start: Date; end: Date } {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

/**
 * The billing periods the next pull reads, oldest first. The first pull reads the current month and `backfillMonths
 * - 1` before it; a later pull resumes at the month of `pulledThrough`. The previous month is always included while
 * AWS may still restate it, and the list never exceeds AWS_CUR_MAX_PERIODS (the most recent ones are kept).
 */
export function awsCurBillingPeriods(pulledThrough: Date | null, backfillMonths: number, now: Date): string[] {
  const current = awsCurPeriodOf(now);
  let start = pulledThrough ? awsCurPeriodOf(pulledThrough) : periodShift(current, -(backfillMonths - 1));
  if (now.getUTCDate() <= AWS_CUR_RESTATE_DAYS) {
    const previous = periodShift(current, -1);
    if (previous < start) start = previous;
  }
  if (start > current) start = current;
  const out: string[] = [];
  for (let p = start; p <= current; p = periodShift(p, 1)) out.push(p);
  return out.slice(-AWS_CUR_MAX_PERIODS);
}

/** a decimal string to integer micro-units without float arithmetic on plain decimals; refuses anything else */
export function decimalToMicro(raw: string): number {
  const t = raw.trim();
  // at most nine integer digits (a billion), so micro-units stay exact integers; a larger line is a units error
  const m = /^(-?)(\d{1,9})(?:\.(\d{1,20}))?$/.exec(t);
  if (m) {
    const [, sign, int, frac = ""] = m;
    const six = (frac + "000000").slice(0, 6);
    // round half away from zero on the seventh digit
    const up = Number(frac[6] ?? "0") >= 5 ? 1 : 0;
    const v = Number(int) * 1e6 + Number(six) + up;
    return sign ? -v : v;
  }
  // AWS writes very small amounts in exponent form (1.0E-7); those are rounded through a float, once
  if (/^-?\d{1,15}(?:\.\d{1,20})?[eE][-+]?\d{1,3}$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n) && Math.abs(n) < 1e9) return Math.round(n * 1e6);
  }
  throw new VendorUsageResponseError("a cost was not a plain decimal number");
}

const AWS_CUR_REQUIRED_COLUMNS = [
  "line_item_usage_start_date",
  "line_item_usage_account_id",
  "line_item_product_code",
  "line_item_usage_type",
  "line_item_line_item_type",
  "line_item_unblended_cost",
  "line_item_currency_code",
] as const;
const AWS_CUR_OPTIONAL_COLUMNS = ["line_item_usage_amount", "line_item_iam_principal"] as const;

/** rows one pull may read across all data files */
export const AWS_CUR_MAX_ROWS = 1_000_000;

/**
 * One CUR 2.0 data file (decompressed CSV text) to daily facts for one billing period, keeping only the configured
 * product codes. Only the columns named here are read; every other column (tags, resource ids, the free-text line
 * description) is discarded at parse. Lines are summed per UTC day, account, IAM principal, product code, usage type,
 * line item type and currency, in integer micro-units. `into` lets several files of one period sum into one map.
 */
export function normalizeAwsCurCsv(
  text: string,
  period: string,
  config: Pick<AwsCurPublicConfig, "productCodes">,
  into: Map<string, { fact: VendorUsageFact; micro: number; qty: number }> = new Map(),
): { groups: Map<string, { fact: VendorUsageFact; micro: number; qty: number }>; rows: number; kept: number } {
  const records = parseCsvRecords(text);
  if (records.length === 0) return { groups: into, rows: 0, kept: 0 };
  const header = records[0]!.cells.map((c) => c.trim());
  const index = new Map(header.map((h, i) => [h, i] as const));
  for (const col of AWS_CUR_REQUIRED_COLUMNS) {
    if (!index.has(col)) throw new VendorUsageResponseError(`the export has no ${col} column`);
  }
  const at = (cells: string[], col: (typeof AWS_CUR_REQUIRED_COLUMNS)[number] | (typeof AWS_CUR_OPTIONAL_COLUMNS)[number]) => {
    const i = index.get(col);
    return i === undefined ? "" : (cells[i] ?? "").trim();
  };
  const codes = new Set(config.productCodes);
  const bounds = awsCurPeriodBounds(period);
  let rows = 0;
  let kept = 0;
  for (const rec of records.slice(1)) {
    if (rec.cells.length === 1 && rec.cells[0] === "") continue;
    rows += 1;
    const product = at(rec.cells, "line_item_product_code");
    if (!codes.has(product)) continue;
    const startMs = Date.parse(at(rec.cells, "line_item_usage_start_date"));
    if (Number.isNaN(startMs)) throw new VendorUsageResponseError(`a usage start date on line ${rec.line} was not a valid instant`);
    // a line dated outside its billing period is AWS's to explain, not ours to move: refuse it
    if (startMs < bounds.start.getTime() || startMs >= bounds.end.getTime()) {
      throw new VendorUsageResponseError(`line ${rec.line} is dated outside billing period ${period}`);
    }
    const day = utcDay(startMs);
    const accountId = at(rec.cells, "line_item_usage_account_id");
    if (!/^\d{12}$/.test(accountId)) throw new VendorUsageResponseError(`line ${rec.line} has no valid AWS account id`);
    const principal = at(rec.cells, "line_item_iam_principal") || null;
    if (principal !== null && (principal.length > 2048 || !principal.startsWith("arn:aws"))) {
      throw new VendorUsageResponseError(`line ${rec.line} has an IAM principal that is not an ARN`);
    }
    const usageType = at(rec.cells, "line_item_usage_type");
    const lineItemType = at(rec.cells, "line_item_line_item_type");
    const currency = at(rec.cells, "line_item_currency_code").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new VendorUsageResponseError(`line ${rec.line} has no valid currency`);
    const micro = decimalToMicro(at(rec.cells, "line_item_unblended_cost"));
    // a quantity (tokens, requests) can exceed the money bound, so it is summed as a plain number
    const qtyRaw = at(rec.cells, "line_item_usage_amount");
    const qty = qtyRaw === "" ? 0 : Number(qtyRaw);
    if (!Number.isFinite(qty) || !/^-?[\d.]+(?:[eE][-+]?\d+)?$/.test(qtyRaw || "0")) {
      throw new VendorUsageResponseError(`line ${rec.line} has a usage amount that is not a number`);
    }
    const factCanonical = canonical(["aws_cur.v1", period, day.start, accountId, principal, product, usageType, lineItemType, currency]);
    let g = into.get(factCanonical);
    if (!g) {
      g = {
        fact: {
          factCanonical,
          accountRef: principal ?? `aws account ${accountId}`,
          accountKind: principal ? "iam_principal" : "aws_account",
          accountId: principal ?? accountId,
          periodStart: day.start,
          periodEnd: day.end,
          amount: 0,
          currency,
          service: usageType || product,
          description: product,
          quantity: null,
          unit: null,
          detail: { source: "aws cur 2.0", billingPeriod: period, awsAccountId: accountId, productCode: product, usageType, lineItemType },
        },
        micro: 0,
        qty: 0,
      };
      into.set(factCanonical, g);
    }
    g.micro += micro;
    g.qty += qty;
    kept += 1;
  }
  return { groups: into, rows, kept };
}

/** the summed groups of a period to facts */
export function awsCurFacts(groups: Map<string, { fact: VendorUsageFact; micro: number; qty: number }>): VendorUsageFact[] {
  return [...groups.values()].map(({ fact, micro, qty }) => ({ ...fact, amount: micro / 1e6, quantity: Math.round(qty * 1e6) / 1e6 }));
}
