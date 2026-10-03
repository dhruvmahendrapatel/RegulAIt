/**
 * The review policy's editing model (ADR-0168 amendment, afternoon): reviewer
 * roles with members, the roles each EU AI Act tier requires (each role is one
 * required review) with the approval's lifetime, and who may accept risk.
 * Pure, so the page's validation and the exact PUT body are unit-tested apart
 * from the form that renders them.
 */
import type { ReviewPolicy, ReviewPolicyInput, ReviewTier, ReviewTierPolicy } from "../../../api/types";

/** the react-query key every reader of the policy shares (the settings page, the review panel) */
export const REVIEW_POLICY_KEY = ["governance", "review-policy"] as const;

/** what the review panel needs from the policy, tolerant of a gateway that does not serve it yet */
export function policyFacts(policy: Partial<ReviewPolicy> | undefined, me: string | null) {
  const roles = policy?.roles ?? [];
  return {
    isRiskAcceptor: me !== null && (policy?.riskAcceptorUserIds ?? []).includes(me),
    isRoleMember: (roleId: string | null | undefined) =>
      me !== null && Boolean(roleId) && Boolean(roles.find((r) => r.id === roleId)?.memberUserIds?.includes(me)),
  };
}

export const TIERS: ReadonlyArray<{ id: ReviewTier; label: string; hint: string }> = [
  { id: "minimal", label: "Minimal", hint: "No screening rule matched." },
  { id: "limited", label: "Limited", hint: "Transparency duties apply." },
  { id: "high", label: "High", hint: "Annex III or a safety component." },
  { id: "prohibited", label: "Prohibited", hint: "Can never be approved; the reviews record the rejection." },
  { id: "unscreened", label: "Not screened", hint: "No usable screening answers." },
];

/** the approval lifetime when a tier sets none: 12 months for minimal and limited, 6 otherwise */
export const DEFAULT_VALIDITY: Record<ReviewTier, number> = { minimal: 12, limited: 12, high: 6, prohibited: 6, unscreened: 6 };

export interface RoleDraft {
  /** stable React/draft key: the saved id, or `new-N` until saved */
  key: string;
  /** the saved id; null for a role added in this session (its id comes from its name) */
  id: string | null;
  name: string;
  memberUserIds: string[];
}

export interface PolicyDraft {
  roles: RoleDraft[];
  /** role KEYS per tier, and the validity as typed ("" = the default) */
  tiers: Record<ReviewTier, { roleKeys: string[]; validity: string }>;
  riskAcceptorUserIds: string[];
}

let seq = 0;
export const blankRole = (): RoleDraft => ({ key: `new-${++seq}`, id: null, name: "", memberUserIds: [] });

/** a role's id: lowercase letters, digits and dashes, 2..40 characters */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}
export const roleId = (role: RoleDraft) => role.id ?? slugify(role.name);

export function draftFrom(policy: Partial<ReviewPolicy> | undefined): PolicyDraft {
  const roles = (policy?.roles ?? []).map((r) => ({ key: r.id, id: r.id, name: r.name, memberUserIds: [...(r.memberUserIds ?? [])] }));
  const known = new Set(roles.map((r) => r.key));
  const tiers = Object.fromEntries(
    TIERS.map(({ id }) => {
      const t = policy?.tiers?.[id];
      return [id, { roleKeys: (t?.roleIds ?? []).filter((rid) => known.has(rid)), validity: t?.validityMonths != null ? String(t.validityMonths) : "" }];
    }),
  ) as PolicyDraft["tiers"];
  return { roles, tiers, riskAcceptorUserIds: [...(policy?.riskAcceptorUserIds ?? [])] };
}

export interface PolicyErrors {
  roles: Record<string, { name?: string; members?: string }>;
  tiers: Partial<Record<ReviewTier, string>>;
}
export const policyHasErrors = (e: PolicyErrors) => Object.values(e.roles).some((r) => r.name || r.members) || Object.values(e.tiers).some(Boolean);

export function validatePolicy(draft: PolicyDraft): PolicyErrors {
  const errors: PolicyErrors = { roles: {}, tiers: {} };
  const seen = new Map<string, string>();
  for (const role of draft.roles) {
    const row: { name?: string; members?: string } = {};
    const id = roleId(role);
    if (!role.name.trim()) row.name = "Name the role.";
    else if (id.length < 2) row.name = "Use at least two letters or digits in the name.";
    else if (seen.has(id)) row.name = "Another role already has this name.";
    else seen.set(id, role.key);
    const requiredBy = TIERS.filter((t) => draft.tiers[t.id].roleKeys.includes(role.key)).map((t) => t.label.toLowerCase());
    if (role.memberUserIds.length === 0 && requiredBy.length > 0)
      row.members = `Add at least one member: the ${listWords(requiredBy)} tier${requiredBy.length === 1 ? "" : "s"} require${requiredBy.length === 1 ? "s" : ""} this review.`;
    if (row.name || row.members) errors.roles[role.key] = row;
  }
  for (const { id } of TIERS) {
    const raw = draft.tiers[id].validity.trim();
    if (raw && !(/^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 36)) errors.tiers[id] = "Enter whole months from 1 to 36.";
  }
  return errors;
}

/** the exact body PUT /v1/governance/review-policy receives for a draft that validated */
export function policyBody(draft: PolicyDraft): ReviewPolicyInput {
  const idOf = new Map(draft.roles.map((r) => [r.key, roleId(r)]));
  const tiers: Partial<Record<ReviewTier, ReviewTierPolicy>> = {};
  for (const { id } of TIERS) {
    const t = draft.tiers[id];
    const roleIds = draft.roles.filter((r) => t.roleKeys.includes(r.key)).map((r) => idOf.get(r.key)!);
    const validity = t.validity.trim();
    // a tier with no roles and no lifetime of its own is simply not configured
    if (roleIds.length === 0 && !validity) continue;
    tiers[id] = { roleIds, validityMonths: validity ? Number(validity) : DEFAULT_VALIDITY[id] };
  }
  return {
    roles: draft.roles.map((r) => ({ id: idOf.get(r.key)!, name: r.name.trim(), memberUserIds: r.memberUserIds })),
    tiers,
    riskAcceptorUserIds: draft.riskAcceptorUserIds,
  };
}

/** removing a role also takes it off every tier that required it */
export function removeRole(draft: PolicyDraft, key: string): PolicyDraft {
  return {
    ...draft,
    roles: draft.roles.filter((r) => r.key !== key),
    tiers: Object.fromEntries(Object.entries(draft.tiers).map(([tier, t]) => [tier, { ...t, roleKeys: t.roleKeys.filter((k) => k !== key) }])) as PolicyDraft["tiers"],
  };
}

/** "a", "a and b", "a, b and c" */
export function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
