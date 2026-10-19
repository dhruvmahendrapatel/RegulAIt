/** Small display formatters shared across views (parity with the legacy UI). */

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return "$" + Number(v).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

export function fmtDur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + "s";
  if (s < 60) return Math.round(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.round((s % 3600) / 60) + "m";
}

export function fmtBytes(n: number): string {
  return n < 1024
    ? n + " B"
    : n < 1048576
      ? Math.round(n / 1024) + " KB"
      : (n / 1048576).toFixed(1) + " MB";
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const shortId = (id: string) => id.slice(0, 8) + "…";

/** an identifier (`use_case_questionnaire`, `compliance-signoff`, `saas_export`) as words a
 * reader can scan: separators become spaces, "signoff" becomes "sign-off", first letter up.
 * Display only — never parse the result back. */
const ACRONYMS: Record<string, string> = {
  ai: "AI", api: "API", aws: "AWS", byoc: "BYOC", cli: "CLI", dlp: "DLP", eu: "EU", gcp: "GCP", github: "GitHub", hipaa: "HIPAA",
  id: "ID", ide: "IDE", iso: "ISO", llm: "LLM", mcp: "MCP", mrm: "MRM", nist: "NIST", openai: "OpenAI", pci: "PCI",
  phi: "PHI", pii: "PII", saas: "SaaS", sdk: "SDK", sla: "SLA", soc: "SOC", sso: "SSO", url: "URL", usd: "USD",
};

export function humanize(id: string | null | undefined): string {
  const words = (id ?? "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\bsignoff\b/gi, "sign-off")
    .replace(/\s+/g, " ")
    .replace(/\b[a-z]+\b/gi, (w) => ACRONYMS[w.toLowerCase()] ?? w);
  return words.replace(/^./, (c) => c.toUpperCase());
}

/** a product id (`github-copilot`) as a name (`GitHub Copilot`): every word capitalised. Display only. */
export const titleWords = (id: string) =>
  id.split(/[-_.\s]+/).filter(Boolean).map((w) => ACRONYMS[w.toLowerCase()] ?? w[0]!.toUpperCase() + w.slice(1)).join(" ");

/** `n thing` / `n things` — the UI never writes "thing(s)" */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

const FRAMEWORK_LABELS: Record<string, string> = {
  "eu-ai-act": "EU AI Act",
  // the cascade tag the EU AI Act high-risk pack recommends (compliance-packs.ts)
  "eu-ai-act-high-risk": "EU AI Act (high-risk)",
  "nist-ai-rmf": "NIST AI RMF",
  "iso-42001": "ISO/IEC 42001",
  "iso-27001": "ISO/IEC 27001",
  "soc-2": "SOC 2",
  hipaa: "HIPAA",
  "pci-dss": "PCI DSS",
  finra: "FINRA",
  gdpr: "GDPR",
};

/** a compliance tag / pack id (`eu-ai-act`) as its framework name (`EU AI Act`) */
export function frameworkLabel(tag: string): string {
  return FRAMEWORK_LABELS[tag] ?? humanize(tag);
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  mistral: "Mistral",
  cohere: "Cohere",
  meta: "Meta",
  microsoft: "Microsoft",
  aws: "AWS",
  aws_bedrock: "AWS Bedrock",
  azure_openai: "Azure OpenAI",
  google_vertex: "Google Vertex AI",
  mock: "Mock",
};

/** a provider slug (`openai`) as its name (`OpenAI`) */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider.toLowerCase()] ?? humanize(provider);
}

const EVIDENCE_LABELS: Record<string, string> = {
  egress_log: "Egress logs",
  code_scan: "Code scan",
  saas_export: "SaaS export",
  self_reported: "Self-reported",
  sdk_package: "SDK package",
  exact_host: "Exact host",
  host_suffix: "Host suffix",
};

/** an evidence / match kind (`saas_export`) as words (`SaaS export`) */
export function evidenceLabel(kind: string): string {
  return EVIDENCE_LABELS[kind] ?? humanize(kind);
}

/** the product's copy is British English, so its dates are too: en-GB formatters, never the browser's default
 * (`10/26/2026, 12:11:07 AM` next to "organisation" reads as two products) */
const enGB = (extra: Intl.DateTimeFormatOptions) => {
  const f = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", ...extra });
  return (iso: string | number | Date | null | undefined, fallback = "—"): string => {
    const d = new Date(iso ?? NaN);
    return iso === "" || Number.isNaN(d.getTime()) ? fallback : f.format(d);
  };
};

/** a timestamp as `26 Oct 2026, 00:11` (local time); `fallback` for a missing or unreadable value */
export const fmtDateTime = enGB({ hour: "2-digit", minute: "2-digit" });

/** an audit/event timestamp on one line, in the same form; an unreadable value is shown as it is */
export const fmtAt = (iso: string | Date): string => fmtDateTime(iso, String(iso));

/** "3 Oct 2026" — a date a reader scans in a column, never a timestamp (UTC, so a stored day never shifts) */
export const fmtDay = enGB({ timeZone: "UTC" });

/** the nil UUID is the gateway's own actor (monitor, scheduler, unauthenticated refusals) */
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

/** who acted: a known user's name, "System" for the gateway itself, else a short id */
export function actorLabel(userId: string | null | undefined, names: Map<string, string>): string {
  if (!userId || userId === SYSTEM_USER_ID) return "System";
  return names.get(userId) ?? shortId(userId);
}

/** Approvals Queue sentinel stages → human labels. This was originally kept in
 * step with the same mapping in the deleted ui-theme.ts (ADR-0033); it is now
 * the single definition. Returns null when the stage is not a sentinel. */
export function approvalStageLabel(a: {
  stageId?: string | null;
  contextConflict?: { key?: string } | undefined;
}): string | null {
  const s = a.stageId ?? "";
  if (s === "__project_budget__") return "Budget overage";
  if (s === "__reclassification__") return "Reclassification";
  if (s.startsWith("__context_conflict__"))
    return "Context conflict" + (a.contextConflict?.key ? " · " + a.contextConflict.key : "");
  if (s.startsWith("__budget__")) return "Run budget";
  if (s.startsWith("__infra_remediation__")) return "Infra remediation";
  // ADR-0159: a governance-monitor remediation awaiting an independent approver
  if (s.startsWith("__remediation__")) return "Governance remediation";
  if (s.startsWith("__model_card__")) return "Model card";
  if (s.startsWith("__grant_cert__")) return "Access certification";
  if (s.startsWith("__sod_override__")) return "Separation-of-duties override";
  if (s.startsWith("__infra_action__")) return "Infra action";
  if (s.startsWith("__nodebudget")) return "Worker budget";
  if (s.startsWith("__spend_anomaly__")) return "Spend anomaly";
  // any other platform sentinel: words, never the raw `__name__:<id>` an
  // approver cannot read (a new kind added server-side still renders legibly)
  const sentinel = /^__([a-z_]+?)__/.exec(s);
  if (sentinel) return sentinel[1]!.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return null;
}
