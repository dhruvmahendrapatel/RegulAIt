/**
 * ADR-0339 — the agent risk and agent identity screens: the vocabularies, the labels and the rules the pages use.
 *
 * The SPA does not import `@regulait/shared` at runtime, so the vocabularies are mirrored here and
 * `agentRiskModel.test.ts` imports the shared source and fails on drift.
 */
import type { Tone } from "../../../ui/kit";

export const AGENT_RISK_SUBJECT_KINDS = ["agent", "builder_agent"] as const;
export type SubjectKind = (typeof AGENT_RISK_SUBJECT_KINDS)[number];
export const AGENT_RISK_BANDS = ["low", "medium", "high", "critical"] as const;
export type Band = (typeof AGENT_RISK_BANDS)[number];
export const AGENT_RISK_TRIGGERS = ["created", "modified", "published", "access_changed", "evidence_changed", "imported", "backfill", "scheduled", "manual"] as const;
export type Trigger = (typeof AGENT_RISK_TRIGGERS)[number];
export const AGENT_OWNERSHIP_FLAGS = ["owned", "inactive", "unowned", "orphaned"] as const;
export type OwnershipFlag = (typeof AGENT_OWNERSHIP_FLAGS)[number];
export const AGENT_AUTHOR_SOURCES = ["principal", "builder_owner", "vendor_record", "unknown"] as const;
export type AuthorSource = (typeof AGENT_AUTHOR_SOURCES)[number];
export const AGENT_NHI_KINDS = ["cloud_service_account", "vendor_agent_identity", "oauth_client"] as const;
export type NhiKind = (typeof AGENT_NHI_KINDS)[number];
export const AGENT_NHI_PROVIDERS = ["aws", "azure", "gcp", "entra", "okta", "other"] as const;
export type NhiProvider = (typeof AGENT_NHI_PROVIDERS)[number];
export const AGENT_NHI_LINK_STATUSES = ["staged", "confirmed", "rejected"] as const;
export type NhiLinkStatus = (typeof AGENT_NHI_LINK_STATUSES)[number];
export const AGENT_RISK_LEG_IDS = ["private_data", "untrusted_content", "external_communication", "unconfirmed_destructive"] as const;
export type LegId = (typeof AGENT_RISK_LEG_IDS)[number];

export const KIND_LABEL: Record<SubjectKind, string> = { agent: "Registry agents", builder_agent: "Builder agents" };
export const BAND_LABEL: Record<Band, string> = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };
export const BAND_TONE: Record<Band, Tone> = { low: "ok", medium: "info", high: "warn", critical: "danger" };
export const TRIGGER_LABEL: Record<Trigger, string> = {
  created: "Created",
  modified: "Changed",
  published: "Published",
  access_changed: "Access changed",
  evidence_changed: "Evidence changed",
  imported: "Imported",
  backfill: "First scoring",
  scheduled: "Daily check",
  manual: "Recomputed by an admin",
};
export const FLAG_LABEL: Record<OwnershipFlag, string> = { owned: "Owned", inactive: "Owner inactive", unowned: "No owner", orphaned: "Owner gone" };
export const FLAG_TONE: Record<OwnershipFlag, Tone> = { owned: "ok", inactive: "warn", unowned: "danger", orphaned: "danger" };
export const AUTHOR_LABEL: Record<AuthorSource, string> = {
  principal: "Created in RegulAIt",
  builder_owner: "Built by its owner",
  vendor_record: "From the vendor's record",
  unknown: "Not recorded (created before authorship was kept)",
};
export const NHI_KIND_LABEL: Record<NhiKind, string> = { cloud_service_account: "Cloud service account", vendor_agent_identity: "Vendor agent identity", oauth_client: "OAuth client" };
export const NHI_PROVIDER_LABEL: Record<NhiProvider, string> = { aws: "AWS", azure: "Azure", gcp: "Google Cloud", entra: "Microsoft Entra", okta: "Okta", other: "Other" };
export const LINK_STATUS_TONE: Record<NhiLinkStatus, Tone> = { staged: "warn", confirmed: "ok", rejected: "neutral" };
export const LINK_STATUS_LABEL: Record<NhiLinkStatus, string> = { staged: "Waiting for a second admin", confirmed: "Confirmed", rejected: "Rejected" };

/** what an identifier from each provider looks like, as the gateway checks it (mirrored; the test holds them equal) */
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const AGENT_NHI_ID_PATTERNS: Readonly<Record<NhiProvider, readonly RegExp[]>> = {
  aws: [/^arn:aws(-[a-z]+)*:[a-z0-9-]{1,64}:[a-z0-9-]{0,32}:\d{12}:[A-Za-z0-9+=,.@_/:-]{1,512}$/],
  azure: [GUID, /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/[A-Za-z0-9./_-]{1,400}$/],
  gcp: [/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/, /^projects\/[a-z0-9-]{1,63}\/[A-Za-z0-9._/-]{1,400}$/],
  entra: [GUID],
  okta: [/^0o[A-Za-z0-9]{18}$/],
  other: [/^[\x21-\x7e]{1,256}$/],
};
export const NHI_ID_HINT: Record<NhiProvider, string> = {
  aws: "An ARN, such as arn:aws:iam::123456789012:role/agent-runner.",
  azure: "A managed identity or service principal object id, or a full resource id.",
  gcp: "A service account email (name@project.iam.gserviceaccount.com) or a projects/… resource name.",
  entra: "The object id of the agent identity, service principal or app.",
  okta: "The client or service app id (starts 0o, 20 characters).",
  other: "Any identifier without spaces, up to 256 characters.",
};

export function validNhiExternalId(provider: NhiProvider, externalId: string): boolean {
  return externalId.length <= 1024 && AGENT_NHI_ID_PATTERNS[provider].some((re) => re.test(externalId));
}

export interface LinkDraft {
  kind: NhiKind;
  provider: NhiProvider;
  externalId: string;
  note: string;
}
export const EMPTY_LINK: LinkDraft = { kind: "cloud_service_account", provider: "aws", externalId: "", note: "" };

export function linkProblems(d: LinkDraft): { externalId?: string; note?: string } {
  const out: { externalId?: string; note?: string } = {};
  const id = d.externalId.trim();
  if (!id) out.externalId = "Enter the identifier the provider issued.";
  else if (!validNhiExternalId(d.provider, id)) out.externalId = `That is not an identifier ${NHI_PROVIDER_LABEL[d.provider]} issues. ${NHI_ID_HINT[d.provider]}`;
  if (d.note.length > 500) out.note = "Keep the note to 500 characters.";
  return out;
}

export function linkBody(d: LinkDraft): { kind: NhiKind; provider: NhiProvider; externalId: string; note?: string } {
  const note = d.note.trim();
  return { kind: d.kind, provider: d.provider, externalId: d.externalId.trim(), ...(note ? { note } : {}) };
}

export const LINK_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  conflict: "That identity is already linked to this agent.",
  already_decided: "Another admin decided this link first. The list now shows their decision.",
  four_eyes: "You staged this link, so a different admin has to confirm or reject it.",
  named_admin_required: "Sign in as a named admin to decide a link; the bootstrap credential cannot.",
});

// ---- the responses the pages read ---------------------------------------------------------------------------------

export interface Fix {
  title: string;
  link: { to: string; label: string };
}
export interface Factor {
  id: string;
  title: string;
  owasp: string[];
  present: boolean;
  points: number;
  max: number;
  evidence: string;
  fix: Fix;
}
export interface Leg {
  id: LegId;
  label: string;
  members: Array<{ kind: string; id: string; name: string; why: string }>;
}
export interface FixOption {
  rank: number;
  action: "ask_first" | "remove";
  leg: LegId;
  targets: Array<{ kind: string; id: string; name: string }>;
  cost: number;
  sharedWith: number;
  title: string;
}
export interface ToxicCombination {
  id: string;
  title: string;
  owasp: string[];
  present: boolean;
  points: number;
  evidence: string;
  fix: Fix;
  legs?: Leg[];
  fixOptions?: FixOption[];
}
export interface RankedFix {
  rank: number;
  source: string;
  title: string;
  points: number;
  owasp: string[];
  link: { to: string; label: string };
}
export interface StoredSummary {
  id: string;
  score: number;
  band: Band;
  computedAt: string;
  triggers: Trigger[];
  methodVersion: string;
}
export interface Assessment {
  subject: { kind: SubjectKind; id: string; name: string };
  score: number;
  band: Band;
  exposure: number;
  reach: { people: number; dependents: number; multiplier: number; label: string; detail: string };
  factors: Factor[];
  toxicCombinations: ToxicCombination[];
  fixes: RankedFix[];
  owaspExposure: string[];
  method: string;
  disclaimer: string;
  methodVersion: string;
  latestAssessment: StoredSummary | null;
  recomputePending: boolean;
}
export interface RankedAgent {
  id: string;
  name: string;
  score: number;
  band: Band;
  computedAt: string;
  assessmentId: string;
}
export interface RankedPage {
  kind: SubjectKind;
  items: RankedAgent[];
  unscored: number;
  nextCursor: string | null;
}
export interface HistoryPage {
  items: Array<StoredSummary & { assessment: { score: number; fixes?: RankedFix[] } }>;
  nextCursor: string | null;
}
export interface SweepResult {
  scored: number;
  dropped: number;
  failed: number;
  changed: number;
}
export interface NhiLink {
  id: string;
  kind: NhiKind;
  provider: NhiProvider;
  externalId: string;
  status: NhiLinkStatus;
  source: string;
  note: string | null;
  stagedByUserId: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  stagedAt: string;
  decisionNote: string | null;
}
export interface IdentityView {
  subject: { kind: SubjectKind; id: string; name: string };
  author: { source: AuthorSource; userId: string | null; displayName: string | null; vendorCreatorPseudonym: string | null; recordedAt: string | null };
  ownership: { flag: OwnershipFlag; ownerUserId: string | null; ownerLastActiveAt: string | null; inactiveAfterDays: number };
  runner: {
    workloadIdentity: { id: string; identifier: string; status: string } | null;
    invokers: Array<{ userId: string | null; displayName: string | null; calls: number }>;
    moreInvokers: boolean;
    windowDays: number;
    connections?: string;
    unattendedRunsAs?: string;
  };
  nonHumanIdentities: NhiLink[];
}
export interface OwnershipFinding {
  kind: SubjectKind;
  id: string;
  name: string;
  ownerUserId: string | null;
  flag: OwnershipFlag;
  ownerLastActiveAt: string | null;
}

// ---- paths and sentences -------------------------------------------------------------------------------------------

export const detailPath = (kind: SubjectKind, id: string) => `/admin/agent-risk/${kind}/${id}`;
export const isSubjectKind = (k: string | undefined): k is SubjectKind => (AGENT_RISK_SUBJECT_KINDS as readonly string[]).includes(k ?? "");

export function rankedUrl(kind: SubjectKind, cursor: string | null): string {
  const q = new URLSearchParams({ kind, limit: "50" });
  if (cursor) q.set("cursor", cursor);
  return `/v1/agent-risk?${q.toString()}`;
}

export function historyUrl(kind: SubjectKind, id: string, cursor: string | null): string {
  const q = new URLSearchParams({ limit: "20" });
  if (cursor) q.set("cursor", cursor);
  return `/v1/agent-risk/${kind}/${id}/history?${q.toString()}`;
}

/** what the sweep did, in words, for the toast */
export function sweepSentence(r: SweepResult): string {
  const parts = [`${r.scored} scored`];
  if (r.changed) parts.push(`${r.changed} changed band or score`);
  if (r.failed) parts.push(`${r.failed} could not be scored and will be retried`);
  return `Recompute finished: ${parts.join(", ")}.`;
}

/** how many other agents a combination's fix would touch, in words ("" when none) */
export function sharedText(o: FixOption): string {
  if (o.sharedWith <= 0) return "";
  return o.sharedWith === 1 ? "1 other agent also holds this" : `${o.sharedWith} holdings by other agents`;
}
