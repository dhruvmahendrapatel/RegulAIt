/**
 * ADR-0361 — monitoring sanctioned AI SaaS through the vendors' compliance APIs: the shared, side-effect-free half.
 *
 * Everything here is pure: the vendor catalogue, each connector's public configuration schema, the schema of each
 * vendor's documented response, the normaliser that turns a vendor record into a vendor-neutral interaction, the text
 * extraction bounds, and the run lifecycle as a declared transition table. The gateway (`ai-saas-monitor.ts`,
 * `ai-saas-connectors.ts`) does the I/O.
 */
import { z } from "zod";

export const AI_SAAS_MONITOR_VENDORS = ["m365_copilot", "chatgpt_enterprise", "claude_enterprise"] as const;
export type AiSaasMonitorVendor = (typeof AI_SAAS_MONITOR_VENDORS)[number];

/** the vendors whose connector is built (slice 1: Microsoft 365 Copilot only); the others are refused at create */
export const AI_SAAS_MONITOR_BUILT_VENDORS: readonly AiSaasMonitorVendor[] = ["m365_copilot"];

export interface AiSaasMonitorCatalogueEntry {
  vendor: AiSaasMonitorVendor;
  label: string;
  /** every host a run calls, which the admin must also put on the egress allow-list (ADR-0034) */
  hosts: readonly string[];
  /** the least-privileged permission(s) the vendor documents for the read */
  permissions: readonly string[];
  /** how the credential's read-only scope is checked */
  scopeCheck: string;
  /** whether the vendor's API offers a conversation delete or quarantine (slice 3) */
  remediation: "none" | "planned";
  docs: string;
  built: boolean;
}

export const AI_SAAS_MONITOR_CATALOGUE: Readonly<Record<AiSaasMonitorVendor, AiSaasMonitorCatalogueEntry>> = {
  m365_copilot: {
    vendor: "m365_copilot",
    label: "Microsoft 365 Copilot (Graph interaction export)",
    hosts: ["graph.microsoft.com", "login.microsoftonline.com"],
    permissions: ["AiEnterpriseInteraction.Read.All (application)", "User.Read.All (application, only when every user is in scope)"],
    scopeCheck:
      "the issued token's roles must include AiEnterpriseInteraction.Read.All and every role must be a .Read.All permission; any other role refuses the credential",
    remediation: "none",
    docs: "https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/ai-services/interaction-export/aiinteractionhistory-getallenterpriseinteractions",
    built: true,
  },
  chatgpt_enterprise: {
    vendor: "chatgpt_enterprise",
    label: "ChatGPT Enterprise (Compliance API)",
    hosts: ["api.chatgpt.com"],
    permissions: ["an Enterprise Compliance API key for the workspace"],
    scopeCheck: "verified against OpenAI's Admin API reference when the connector is built (ADR-0361 slice 2)",
    remediation: "planned",
    docs: "https://learn.chatgpt.com/docs/enterprise/compliance-api",
    built: false,
  },
  claude_enterprise: {
    vendor: "claude_enterprise",
    label: "Claude Enterprise (compliance API)",
    hosts: ["api.anthropic.com"],
    permissions: ["an organization-scoped compliance API key"],
    scopeCheck: "verified against Anthropic's documentation when the connector is built (ADR-0361 slice 2)",
    remediation: "planned",
    docs: "https://docs.anthropic.com",
    built: false,
  },
};

/** the statement every posture read and run response carries */
export const AI_SAAS_MONITOR_STATEMENT =
  "Read-only monitoring of conversations in your own AI SaaS tenants through each vendor's documented compliance export. " +
  "Requests go only to your vendor tenant; nothing is pooled or sent anywhere else. Conversation text is scanned in memory " +
  "and not stored unless an admin turns on redacted capture.";

// --------------------------------------------------------------------------------------------------------------------
// Bounds
// --------------------------------------------------------------------------------------------------------------------

export const AI_SAAS_MONITOR_MAX_BACKFILL_DAYS = 30;
/** the window never reaches closer to now than this: the vendor's export settles behind real time */
export const AI_SAAS_MONITOR_SETTLE_MS = 5 * 60 * 1000;
export const AI_SAAS_MONITOR_MAX_USERS = 1000;
export const AI_SAAS_MONITOR_MAX_PAGES_PER_USER = 50;
/**
 * One run reads at most one day of a tenant's history, so a large tenant (or a long backfill, or a connector that was
 * off for weeks) catches up over successive hourly runs instead of failing one oversized window over and over.
 */
export const AI_SAAS_MONITOR_MAX_WINDOW_MS = 24 * 3600 * 1000;
/** the narrowest window a run halves down to after runs that hit a per-run bound (review R7 [1]); a window this narrow
 * that still overflows fails with that bound's code and a sentence saying the floor was reached */
export const AI_SAAS_MONITOR_MIN_WINDOW_MS = 15 * 60 * 1000;
/** the run error codes that mean "the window held too much": the next run asks for half as long */
export const AI_SAAS_MONITOR_WINDOW_LIMIT_CODES = ["interaction_limit", "page_limit"] as const;
export const AI_SAAS_MONITOR_MAX_INTERACTIONS_PER_RUN = 50_000;
/** text scanned per interaction; longer text is truncated and the evidence row says so */
export const AI_SAAS_MONITOR_MAX_TEXT_CHARS = 64 * 1024;
/** each vendor response */
export const AI_SAAS_MONITOR_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

// --------------------------------------------------------------------------------------------------------------------
// Public configuration (schema-validated configuration documents, the ADR-0200 exception)
// --------------------------------------------------------------------------------------------------------------------

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const guid = z.string().regex(GUID, "must be a GUID").transform((s) => s.toLowerCase());

/** the Copilot app classes Microsoft documents as filters (export-teams-content-copilot) */
export const M365_COPILOT_APP_CLASSES = [
  "IPM.SkypeTeams.Message.Copilot.Word",
  "IPM.SkypeTeams.Message.Copilot.Excel",
  "IPM.SkypeTeams.Message.Copilot.Teams",
  "IPM.SkypeTeams.Message.Copilot.BizChat",
  "IPM.SkypeTeams.Message.Copilot.WebChat",
  "IPM.SkypeTeams.Message.Copilot.CoworkChat",
] as const;

export const m365CopilotConfigSchema = z
  .object({
    tenantId: guid,
    clientId: guid,
    /** `listed` (default and least privilege): only these Entra user object ids. `all`: every user, through /users. */
    users: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("listed"), ids: z.array(guid).min(1).max(AI_SAAS_MONITOR_MAX_USERS) }).strict(),
      z.object({ mode: z.literal("all") }).strict(),
    ]),
    /** optional narrowing to documented app classes; empty = every class the export returns */
    appClasses: z.array(z.enum(M365_COPILOT_APP_CLASSES)).max(M365_COPILOT_APP_CLASSES.length).default([]),
    backfillDays: z.number().int().min(1).max(AI_SAAS_MONITOR_MAX_BACKFILL_DAYS).default(7),
  })
  .strict();
export type M365CopilotConfig = z.output<typeof m365CopilotConfigSchema>;

/** per vendor; a vendor not built yet has no schema and is refused at create */
export const aiSaasMonitorConfigSchemas: Partial<Record<AiSaasMonitorVendor, z.ZodType<Record<string, unknown>>>> = {
  m365_copilot: m365CopilotConfigSchema as unknown as z.ZodType<Record<string, unknown>>,
};

/** the backfill a connector's configuration asks for (every schema carries `backfillDays`) */
export function configuredBackfillDays(config: unknown): number {
  const raw = config && typeof config === "object" ? (config as Record<string, unknown>).backfillDays : undefined;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= AI_SAAS_MONITOR_MAX_BACKFILL_DAYS ? raw : 7;
}

// --------------------------------------------------------------------------------------------------------------------
// Policy
// --------------------------------------------------------------------------------------------------------------------

/** `none` (default): text is scanned in memory and never stored. `redacted`: an ADR-0140-redacted copy, sealed. */
export const AI_SAAS_CONTENT_CAPTURE_MODES = ["none", "redacted"] as const;
export type AiSaasContentCapture = (typeof AI_SAAS_CONTENT_CAPTURE_MODES)[number];

// --------------------------------------------------------------------------------------------------------------------
// The vendor-neutral interaction
// --------------------------------------------------------------------------------------------------------------------

export const AI_SAAS_INTERACTION_KINDS = ["prompt", "response", "other"] as const;
export type AiSaasInteractionKind = (typeof AI_SAAS_INTERACTION_KINDS)[number];

/** one interaction as every connector hands it over; `text` exists only in memory, for the scan */
export interface MonitoredInteraction {
  vendorInteractionId: string;
  conversationRef: string | null;
  kind: AiSaasInteractionKind;
  occurredAt: Date;
  /** the vendor's own id for the person or app that produced it (an Entra object id, a workspace user id) */
  actorRef: string | null;
  appRef: string | null;
  text: string;
  truncated: boolean;
}

// --------------------------------------------------------------------------------------------------------------------
// Microsoft Graph: aiInteraction (v1.0), as documented. Unknown fields are ignored; a wrong type fails the page.
// --------------------------------------------------------------------------------------------------------------------

const str = (max: number) => z.string().max(max);
const nullableStr = (max: number) => z.string().max(max).nullish();

export const graphAiInteractionSchema = z
  .object({
    id: str(200).min(1),
    sessionId: nullableStr(500),
    requestId: nullableStr(200),
    appClass: nullableStr(200),
    interactionType: nullableStr(50),
    conversationType: nullableStr(100),
    createdDateTime: z.string().datetime({ offset: true }),
    from: z
      .object({
        user: z.object({ id: nullableStr(100) }).passthrough().nullish(),
        application: z.object({ id: nullableStr(100), displayName: nullableStr(300) }).passthrough().nullish(),
      })
      .passthrough()
      .nullish(),
    body: z.object({ contentType: nullableStr(20), content: z.string().nullish() }).passthrough().nullish(),
    attachments: z
      .array(z.object({ contentType: nullableStr(200), content: z.string().nullish(), name: nullableStr(500) }).passthrough())
      .max(200)
      .nullish(),
  })
  .passthrough();
export type GraphAiInteraction = z.infer<typeof graphAiInteractionSchema>;

export const graphAiInteractionPageSchema = z
  .object({ value: z.array(graphAiInteractionSchema).max(1000), "@odata.nextLink": z.string().max(4096).nullish() })
  .passthrough();

export const graphUserPageSchema = z
  .object({ value: z.array(z.object({ id: guid }).passthrough()).max(1000), "@odata.nextLink": z.string().max(4096).nullish() })
  .passthrough();

const ENTITIES: Readonly<Record<string, string>> = { nbsp: " ", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", amp: "&" };

/**
 * The text of an HTML fragment, for SCANNING ONLY (it is never rendered or returned as HTML): markup between `<` and
 * `>` becomes a space, the common entities are decoded, whitespace is collapsed. One linear pass with no regex
 * (M-074), so a hostile body cannot make it backtrack.
 */
export function htmlToScanText(html: string): string {
  let out = "";
  let inTag = false;
  let space = true;
  const push = (s: string) => {
    for (const ch of s) {
      const ws = ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f";
      if (ws) {
        if (!space) out += " ";
        space = true;
      } else {
        out += ch;
        space = false;
      }
    }
  };
  for (let i = 0; i < html.length; i++) {
    const ch = html[i]!;
    if (inTag) {
      if (ch === ">") {
        inTag = false;
        push(" ");
      }
      continue;
    }
    if (ch === "<") {
      inTag = true;
      continue;
    }
    if (ch === "&") {
      const end = html.indexOf(";", i + 1);
      const name = end > i && end - i <= 6 ? html.slice(i + 1, end) : null;
      const decoded = name !== null ? ENTITIES[name] : undefined;
      if (decoded !== undefined) {
        push(decoded);
        i = end;
        continue;
      }
    }
    push(ch);
  }
  return out.trim();
}

/** a plain-text body with Graph's empty `<attachment id="…"></attachment>` placeholders removed (linear, no regex) */
function stripAttachmentMarkers(text: string): string {
  if (!text.includes("<attachment")) return text.trim();
  return htmlToScanText(text);
}

/** the `text` of every TextBlock (and similar) in an Adaptive Card, depth- and count-bounded */
export function adaptiveCardText(json: string): string {
  let card: unknown;
  try {
    card = JSON.parse(json);
  } catch {
    return "";
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 12 || out.length >= 500 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    for (const key of ["text", "title", "value"] as const) {
      const v = rec[key];
      // a card often repeats one text block twice (display and plain); scan it once
      if (typeof v === "string" && v.trim() && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    for (const v of Object.values(rec)) if (v && typeof v === "object") walk(v, depth + 1);
  };
  walk(card, 0);
  return out.join("\n");
}

function bound(text: string): { text: string; truncated: boolean } {
  return text.length > AI_SAAS_MONITOR_MAX_TEXT_CHARS
    ? { text: text.slice(0, AI_SAAS_MONITOR_MAX_TEXT_CHARS), truncated: true }
    : { text, truncated: false };
}

/** one Graph aiInteraction → the vendor-neutral interaction */
export function normalizeGraphInteraction(r: GraphAiInteraction): MonitoredInteraction {
  const parts: string[] = [];
  const body = r.body?.content ?? "";
  if (body) parts.push((r.body?.contentType ?? "").toLowerCase() === "html" ? htmlToScanText(body) : stripAttachmentMarkers(body));
  for (const a of r.attachments ?? []) {
    if (!a.content) continue;
    if ((a.contentType ?? "").toLowerCase() === "application/vnd.microsoft.card.adaptive") parts.push(adaptiveCardText(a.content));
    else if ((a.contentType ?? "").toLowerCase().startsWith("text/")) parts.push(a.content);
  }
  const { text, truncated } = bound(parts.filter(Boolean).join("\n"));
  const type = (r.interactionType ?? "").toLowerCase();
  return {
    vendorInteractionId: r.id,
    conversationRef: r.sessionId ?? null,
    kind: type === "userprompt" ? "prompt" : type === "airesponse" ? "response" : "other",
    occurredAt: new Date(r.createdDateTime),
    actorRef: r.from?.user?.id ?? r.from?.application?.id ?? null,
    appRef: r.appClass ?? null,
    text,
    truncated,
  };
}

// --------------------------------------------------------------------------------------------------------------------
// Runs: the lifecycle is AI_SAAS_MONITOR_RUN_MACHINE in state-machines.ts (ADR-0348, in the STATE_MACHINES registry)
// --------------------------------------------------------------------------------------------------------------------

/** every error code a run may record; the text beside it is always a sentence RegulAIt wrote */
export const AI_SAAS_MONITOR_ERROR_CODES = [
  "disabled",
  "air_gapped",
  "no_credential",
  "credential_refused",
  "data_key_unavailable",
  "egress_refused",
  "token_failed",
  "missing_permission",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "http_error",
  "bad_response",
  "response_too_large",
  "network_error",
  "page_limit",
  "interaction_limit",
  "in_progress",
  "internal",
] as const;
export type AiSaasMonitorErrorCode = (typeof AI_SAAS_MONITOR_ERROR_CODES)[number];

export const AI_SAAS_FINDING_ACTIONS = ["block", "warn", "log"] as const;
export type AiSaasFindingAction = (typeof AI_SAAS_FINDING_ACTIONS)[number];
