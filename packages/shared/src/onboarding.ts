/**
 * ADR-0054 — ONBOARDING & MIGRATION: the pure half.
 *
 * Everything here is a total function or a schema. No database, no HTTP, no
 * clock. The gateway's `onboarding.ts` is the only place that writes rows; this
 * file is what decides WHAT should be written, so the decision can be tested
 * without a deployment and cannot differ between the dry-run preview and the
 * apply that follows it — they call the same planner.
 *
 * THE ONE THING TO UNDERSTAND ABOUT IMPORTS
 * -----------------------------------------
 * An import payload is a FILE SOMEONE ELSE WROTE. It arrives with bulk
 * state-mutation power (it provisions users, it binds directory groups to
 * roles), and the person pasting it is frequently not the person who produced
 * it — an IdP export, a spreadsheet from a previous vendor, a config from
 * another deployment. So the posture is not "validate then trust"; it is:
 *
 *   1. The row schemas are `.strict()`. An unknown key is a REFUSAL, not a
 *      silently ignored field. A payload carrying `isAdmin` cannot be parsed
 *      into a row at all, because the row type has no such field to parse it
 *      into. This is a stronger guarantee than filtering: there is no code path
 *      that reads it.
 *   2. `screenForEscalation()` runs BEFORE parsing and looks for privilege
 *      words anywhere in the payload, at any depth. Its job is not defence —
 *      (1) is the defence — it is to make the refusal SPECIFIC and AUDITED, so
 *      an operator sees "this import tried to set isAdmin on row 3" rather than
 *      a generic schema error. A silent strip would be the worst outcome: the
 *      importer would believe the admins landed.
 *   3. Nothing an import produces can exceed what the importing admin could
 *      have done through the ordinary routes. Users land exactly as
 *      `POST /v1/users` makes them (non-admin, seat-capped); a group→role row
 *      binds to an EXISTING role and never creates one, because creating a role
 *      from a file would let the file define an entitlement bundle nobody
 *      reviewed.
 *
 * WHY THERE IS NO "ADMIN" STARTER ROLE TEMPLATE
 * ---------------------------------------------
 * ADR-0054 §1.3 lists "e.g. Admin, Builder, Reviewer, Viewer". Three of those
 * ship. `Admin` deliberately does not, because in this product platform-admin is
 * `users.is_admin` — a per-user flag — and a ROLE cannot confer it (ADR-0038
 * pins that there is no code path from a group to `isAdmin`, and asserts it
 * structurally). A starter role NAMED "Admin" that cannot make anyone an admin
 * would be a trap: an operator would assign it, believe they had delegated
 * administration, and be wrong. Admin is granted by `POST /v1/users/:id/admin`,
 * deliberately one explicit act at a time.
 */
import { z } from "zod";

// ===========================================================================
// 1. THE WIZARD'S SHAPE
// ===========================================================================

export const ONBOARDING_STEP_STATUSES = ["pending", "in_progress", "done", "skipped"] as const;
export type OnboardingStepStatus = (typeof ONBOARDING_STEP_STATUSES)[number];

export interface OnboardingStepDef {
  key: string;
  title: string;
  /** why this step exists, shown in the console rather than kept in an ADR */
  why: string;
  /** step keys that must be done-or-skipped before this one may be COMPLETED.
   * Not before it may be started — an admin mid-BYOC-install often has the
   * later pieces to hand first, and refusing to let them record progress would
   * make the checklist lie about what is configured. */
  requires: string[];
}

/**
 * The dependency order ADR-0054 §1 names. It is an ORDER, not a lock: any step
 * can be skipped (an air-gapped install with no IdP is a real deployment, not a
 * broken one), and skipping satisfies a dependant's prerequisite. What the order
 * buys is that an admin who follows it never has to back up.
 */
export const ONBOARDING_STEPS: readonly OnboardingStepDef[] = [
  {
    key: "connect_idp",
    title: "Connect an identity provider",
    why: "Establishes how humans authenticate before any user exists to authenticate. Any OIDC or SAML provider — the wizard names no vendor.",
    requires: [],
  },
  {
    key: "import_users",
    title: "Import your user directory",
    why: "SCIM where the IdP supports it, CSV where it does not. Users land as ordinary entitled seats, subject to the licensed seat cap.",
    requires: ["connect_idp"],
  },
  {
    key: "seed_roles",
    title: "Seed starter roles and group mappings",
    why: "Starter role templates you can accept or edit, plus IdP group -> role mapping so directory groups drive assignment at scale instead of per-user clicks.",
    requires: ["import_users"],
  },
  {
    key: "connect_model_provider",
    title: "Connect your first model provider",
    why: "Any vendor, or a self-hosted endpoint. This is the step that makes a governed dispatch possible at all.",
    requires: [],
  },
  {
    key: "compliance_pack",
    title: "Choose a compliance pack",
    why: "One classification seeds workflow stages, connector data-scope defaults, audit retention, PII mode and guardrail floors through the existing cascade. A starting point you can tighten — never a ceiling that overrides governance.",
    requires: ["seed_roles"],
  },
  {
    key: "first_governed_call",
    title: "Make a first governed call",
    why: "The day-one proof: a real dispatch that appears in the audit log and the cost dashboard. Until this happens, governance is configured but not demonstrated.",
    requires: ["connect_model_provider"],
  },
] as const;

export const ONBOARDING_STEP_KEYS: readonly string[] = ONBOARDING_STEPS.map((s) => s.key);

export const onboardingStepKeySchema = z.enum(
  ONBOARDING_STEP_KEYS as [string, ...string[]],
);

export const updateOnboardingStepSchema = z
  .object({
    status: z.enum(ONBOARDING_STEP_STATUSES),
    /** free-form evidence the console shows next to the step (which provider,
     * which file). Never a secret — the routes reject anything that smells of
     * one before it is stored. */
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Which steps block `key` from being marked done, given what is recorded so far.
 * `skipped` satisfies a prerequisite: an admin who genuinely has no IdP has not
 * left the wizard half-done, they have made a decision, and the checklist has to
 * be able to represent that without lying.
 */
export function blockedBy(
  key: string,
  statuses: Readonly<Record<string, OnboardingStepStatus>>,
): string[] {
  const def = ONBOARDING_STEPS.find((s) => s.key === key);
  if (!def) return [];
  return def.requires.filter((r) => {
    const s = statuses[r];
    return s !== "done" && s !== "skipped";
  });
}

/**
 * Is a transition allowed? Only `done` is gated, and only on prerequisites.
 * Everything else — including moving a `done` step back to `in_progress` because
 * the thing it recorded got torn down — is permitted, because a checklist that
 * cannot record a regression is a checklist that becomes wrong and stays wrong.
 */
export function transitionRefusal(
  key: string,
  next: OnboardingStepStatus,
  statuses: Readonly<Record<string, OnboardingStepStatus>>,
): { blockedBy: string[] } | null {
  if (next !== "done") return null;
  const blockers = blockedBy(key, statuses);
  return blockers.length > 0 ? { blockedBy: blockers } : null;
}

// ===========================================================================
// 2. STARTER ROLE TEMPLATES
// ===========================================================================

export interface StarterRoleTemplate {
  name: string;
  description: string;
  /** MCP servers this role may use wholesale, by NAME. Resolved against the
   * servers that actually exist at seed time; a name that matches nothing is
   * REPORTED, never invented. */
  serverGrants: Array<{ serverName: string; readOnlyAll: boolean }>;
  /** agents by name, with the modes the role may dispatch in */
  agentGrants: Array<{ agentName: string; allowedModes: string[] | null }>;
  /** connectors by name */
  connectorGrants: Array<{ connectorName: string; mode: "read" | "readwrite" }>;
}

/**
 * Deliberately EMPTY grant lists on every template.
 *
 * This is the honest shape, and it took some thought. A starter template that
 * arrives pre-wired to "all servers, read-write" would demo beautifully and
 * would be a governance product shipping a default-allow — the exact posture
 * pillar 1 exists to refuse. And a template cannot reference a specific server
 * or agent by name, because on a fresh install none exist yet and their names
 * are the customer's.
 *
 * So what a template ships is the SHAPE — the four roles an org actually needs,
 * named, described, and created as ordinary reviewable rows — and the admin
 * attaches grants through the existing role-builder. The value is that the
 * role structure is there and consistent, not that access was pre-granted.
 * `serverGrants`/`agentGrants`/`connectorGrants` exist on the type because an
 * operator replaying a reference configuration into a second BYOC deployment
 * (ADR-0054 §4) fills them in from their own export.
 */
export const STARTER_ROLE_TEMPLATES: readonly StarterRoleTemplate[] = [
  {
    name: "Builder",
    description:
      "Builds with agents and connectors. The default seat for an engineer: dispatch, invoke, and drive workflows — no authority over who else may.",
    serverGrants: [],
    agentGrants: [],
    connectorGrants: [],
  },
  {
    name: "Reviewer",
    description:
      "Decides approvals and reviews governed changes. Deliberately separate from Builder so 'who built it' and 'who approved it' can be different people.",
    serverGrants: [],
    agentGrants: [],
    connectorGrants: [],
  },
  {
    name: "Viewer",
    description:
      "Read-only. Sees cost, audit and workflow state for what they are a member of, and can change nothing.",
    serverGrants: [],
    agentGrants: [],
    connectorGrants: [],
  },
  {
    name: "Operator",
    description:
      "Runs the deployment: infrastructure posture, backups, certificates and deploy targets. Not a platform administrator — that is a per-user flag, not a role.",
    serverGrants: [],
    agentGrants: [],
    connectorGrants: [],
  },
] as const;

// ===========================================================================
// 3. COMPLIANCE PACKS — cascade seeds, not a new mechanism
// ===========================================================================

export interface CompliancePack {
  /** the classification tag the cascade keys on — an ORDINARY tag */
  tag: string;
  label: string;
  summary: string;
  /** exactly the shape `POST /v1/compliance/profiles` already accepts, because
   * a pack IS a profile upsert. There is no parallel configuration path. */
  profile: {
    mcpDefaultMode: "read_only" | "read_write";
    auditRetentionDays: number;
    piiMode: "block" | "warn" | "log";
    backupRetentionDays: number | null;
    patchCadenceDays: number | null;
    guardrailModes: Record<string, string> | null;
  };
}

/**
 * Four first-party packs. Each is a STARTING POINT an admin tightens, never a
 * certification and never a ceiling: the cascade composes these by
 * strictest-wins with the org and project settings, so a pack can only ever
 * RAISE a floor. The retention numbers are the ones each framework's own text
 * makes defensible, and they are the part most likely to need review as
 * frameworks move — which is why ADR-0054 names pack ownership as a real cost.
 */
export const COMPLIANCE_PACKS: readonly CompliancePack[] = [
  {
    tag: "hipaa",
    label: "HIPAA",
    summary:
      "PHI must not leave the boundary in a prompt. Blocks PII outright, defaults connectors to read-only, and holds the audit trail for six years (45 CFR 164.316(b)(2)).",
    profile: {
      mcpDefaultMode: "read_only",
      auditRetentionDays: 2192,
      piiMode: "block",
      backupRetentionDays: 2192,
      patchCadenceDays: 30,
      guardrailModes: { prompt_injection: "block", secret_leak: "block" },
    },
  },
  {
    tag: "pci-dss",
    label: "PCI-DSS",
    summary:
      "Cardholder data never reaches a model. Blocks PII, read-only connectors by default, one year of audit retention (PCI-DSS v4 req. 10.5.1) and a 30-day patch cadence (req. 6.3.3).",
    profile: {
      mcpDefaultMode: "read_only",
      auditRetentionDays: 365,
      piiMode: "block",
      backupRetentionDays: 365,
      patchCadenceDays: 30,
      guardrailModes: { prompt_injection: "block", secret_leak: "block" },
    },
  },
  {
    tag: "soc2",
    label: "SOC 2",
    summary:
      "Evidence-first: a complete audit trail for a full annual observation window plus a review period, PII warned rather than blocked so the control is visible without stopping work.",
    profile: {
      mcpDefaultMode: "read_write",
      auditRetentionDays: 456,
      piiMode: "warn",
      backupRetentionDays: 365,
      patchCadenceDays: 60,
      guardrailModes: { prompt_injection: "warn", secret_leak: "block" },
    },
  },
  {
    tag: "gdpr",
    label: "GDPR",
    summary:
      "Data minimisation cuts both ways: personal data is blocked from prompts, and the audit trail is held for two years rather than forever, because indefinite retention of a log about people is itself a GDPR problem.",
    profile: {
      mcpDefaultMode: "read_only",
      auditRetentionDays: 730,
      piiMode: "block",
      backupRetentionDays: 730,
      patchCadenceDays: 60,
      guardrailModes: { prompt_injection: "block", secret_leak: "block" },
    },
  },
] as const;

export const COMPLIANCE_PACK_TAGS: readonly string[] = COMPLIANCE_PACKS.map((p) => p.tag);

export const applyCompliancePackSchema = z
  .object({
    pack: z.enum(COMPLIANCE_PACK_TAGS as [string, ...string[]]),
    /** classify this project with the pack's tag, which is what actually starts
     * the cascade. Omitted = seed the profile only (the cascade exists but
     * nothing carries the tag yet). */
    projectId: z.string().uuid().optional(),
    mode: z.enum(["dry_run", "apply"]).default("apply"),
  })
  .strict();

// ===========================================================================
// 4. IMPORTS — the untrusted path
// ===========================================================================

/**
 * Keys that would, if honoured, hand an import more authority than the routes
 * would. Matched case-insensitively and ignoring separators, so `is_admin`,
 * `isAdmin`, `IS-ADMIN` and `platformadmin` are one rule rather than four
 * near-misses.
 */
const PRIVILEGE_KEYS = [
  "isadmin",
  "admin",
  "platformadmin",
  "superuser",
  "superadmin",
  "root",
  "sysadmin",
  "isstaff",
  "issuperuser",
  "grants",
  "entitlements",
  "permissions",
  "scopes",
] as const;

export interface EscalationFinding {
  /** JSON path to the offending key, e.g. `rows[2].isAdmin` */
  path: string;
  key: string;
  value: unknown;
}

const normalizeKey = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "");

/**
 * Walk an arbitrary payload for privilege-bearing keys, at any depth.
 *
 * This is NOT the defence — the `.strict()` row schemas are, because a field
 * with nowhere to be parsed into cannot be honoured by any code path. This is
 * the DISCLOSURE: it turns a generic "unrecognized key" into a named,
 * auditable refusal that says exactly which row tried to escalate. An import
 * that silently dropped `isAdmin: true` would leave the importer believing they
 * had provisioned administrators, which is worse than refusing.
 */
export function screenForEscalation(payload: unknown, basePath = ""): EscalationFinding[] {
  const found: EscalationFinding[] = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const child = path ? `${path}.${k}` : k;
      if (PRIVILEGE_KEYS.includes(normalizeKey(k) as (typeof PRIVILEGE_KEYS)[number])) {
        found.push({ path: child, key: k, value: v });
      }
      walk(v, child, depth + 1);
    }
  };
  walk(payload, basePath, 0);
  return found;
}

/**
 * One imported user. `.strict()` is load-bearing: there is deliberately no
 * `isAdmin`, no `roles`, and no `grants` field, so an import can produce exactly
 * what `POST /v1/users` produces and not one privilege more. Role membership
 * arrives through GROUPS, which resolve through mappings an admin authored — an
 * indirection that exists precisely so a file cannot name a role directly.
 */
export const userImportRowSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    displayName: z.string().trim().min(1).max(200),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9._-]+$/, "username may contain only a-z, 0-9, dot, underscore and hyphen")
      .refine((v) => !v.includes("@"), "a username may never contain '@' (that namespace is email's)")
      .optional(),
    /** directory groups this user belongs to. Recorded as ASSERTED groups; what
     * they confer is decided by the admin-authored mappings, or nothing. */
    groups: z.array(z.string().trim().min(1).max(512)).max(200).optional(),
  })
  .strict();

export type UserImportRow = z.infer<typeof userImportRowSchema>;

export const userImportSchema = z
  .object({
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    /** which directory the `groups` on each row came from. It is a payload-level
     * field, not a per-row one, because one import is one directory export —
     * letting a row name its own source would let a file claim a group came
     * from an IdP it did not, and group→role mappings are keyed on source. */
    groupSource: z.enum(["oidc", "saml", "scim"]).default("scim"),
    rows: z.array(userImportRowSchema).min(1).max(5000),
  })
  .strict();

export const groupRoleImportRowSchema = z
  .object({
    source: z.enum(["oidc", "saml", "scim"]),
    externalGroup: z.string().trim().min(1).max(512),
    /** by NAME, resolved against roles that already exist. An import can never
     * create a role: a file defining a new entitlement bundle is a file
     * defining policy, and policy is authored, not imported. */
    roleName: z.string().trim().min(1).max(200),
  })
  .strict();

export const groupRoleImportSchema = z
  .object({
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    rows: z.array(groupRoleImportRowSchema).min(1).max(5000),
  })
  .strict();

// --- the planner (shared by dry-run and apply) ------------------------------

export interface UserImportPlanEntry {
  email: string;
  action: "create" | "update" | "unchanged" | "reactivate_required";
  /** what would change, field by field — the diff a dry-run shows */
  changes: Record<string, { from: unknown; to: unknown }>;
  groups: string[];
}

export interface UserImportPlan {
  entries: UserImportPlanEntry[];
  counts: { create: number; update: number; unchanged: number; reactivate_required: number };
  /** rows whose email appeared more than once — the LAST wins, and the
   * duplication is reported rather than resolved silently */
  duplicateEmails: string[];
}

export interface ExistingUser {
  email: string;
  displayName: string;
  username: string | null;
  disabledAt: Date | string | null;
}

/**
 * Decide what an import WOULD do. Pure, and called by both the dry-run and the
 * apply — a preview that is computed differently from the thing it previews is
 * not a preview.
 *
 * IDEMPOTENCE IS A PROPERTY OF THIS FUNCTION, not of the caller: applying a plan
 * and re-planning the same rows against the resulting state yields all
 * `unchanged`, because the comparison is on the post-apply values.
 */
export function planUserImport(
  rows: readonly UserImportRow[],
  existing: readonly ExistingUser[],
): UserImportPlan {
  const byEmail = new Map<string, ExistingUser>();
  for (const u of existing) byEmail.set(u.email.toLowerCase(), u);

  const seen = new Map<string, UserImportRow>();
  const duplicateEmails: string[] = [];
  for (const r of rows) {
    if (seen.has(r.email)) duplicateEmails.push(r.email);
    seen.set(r.email, r);
  }

  const entries: UserImportPlanEntry[] = [];
  for (const [email, row] of seen) {
    const current = byEmail.get(email);
    const groups = [...new Set(row.groups ?? [])];
    if (!current) {
      entries.push({ email, action: "create", changes: {}, groups });
      continue;
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (current.displayName !== row.displayName) {
      changes.displayName = { from: current.displayName, to: row.displayName };
    }
    if (row.username !== undefined && current.username !== row.username) {
      changes.username = { from: current.username, to: row.username };
    }
    if (current.disabledAt !== null) {
      // An import must not silently un-deactivate an account somebody
      // deliberately disabled (ADR-0022 makes deactivation a governed act).
      // It is reported so the admin can reactivate explicitly, and skipped.
      entries.push({ email, action: "reactivate_required", changes, groups });
      continue;
    }
    entries.push({
      email,
      action: Object.keys(changes).length === 0 ? "unchanged" : "update",
      changes,
      groups,
    });
  }

  const counts = { create: 0, update: 0, unchanged: 0, reactivate_required: 0 };
  for (const e of entries) counts[e.action] += 1;
  return { entries, counts, duplicateEmails };
}

export interface GroupRolePlanEntry {
  source: string;
  externalGroup: string;
  roleName: string;
  action: "create" | "unchanged" | "unknown_role";
}

export interface GroupRolePlan {
  entries: GroupRolePlanEntry[];
  counts: { create: number; unchanged: number; unknown_role: number };
  unknownRoles: string[];
}

export function planGroupRoleImport(
  rows: readonly z.infer<typeof groupRoleImportRowSchema>[],
  knownRoles: readonly { id: string; name: string }[],
  existingMappings: readonly { source: string; externalGroup: string; roleId: string }[],
): GroupRolePlan {
  const roleByName = new Map(knownRoles.map((r) => [r.name.toLowerCase(), r]));
  const have = new Set(
    existingMappings.map((m) => `${m.source} ${m.externalGroup} ${m.roleId}`),
  );
  const entries: GroupRolePlanEntry[] = [];
  const unknownRoles = new Set<string>();
  const seen = new Set<string>();
  for (const r of rows) {
    const dedupe = `${r.source} ${r.externalGroup} ${r.roleName.toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const role = roleByName.get(r.roleName.toLowerCase());
    if (!role) {
      unknownRoles.add(r.roleName);
      entries.push({ ...r, action: "unknown_role" });
      continue;
    }
    const key = `${r.source} ${r.externalGroup} ${role.id}`;
    entries.push({ ...r, action: have.has(key) ? "unchanged" : "create" });
  }
  const counts = { create: 0, unchanged: 0, unknown_role: 0 };
  for (const e of entries) counts[e.action] += 1;
  return { entries, counts, unknownRoles: [...unknownRoles] };
}

// --- CSV, for the environments with no SCIM --------------------------------

/**
 * A deliberately small RFC-4180 reader: quoted fields, doubled quotes, embedded
 * newlines and commas. It does NOT guess delimiters or types — a CSV importer
 * that infers is a CSV importer that turns `0123` into a number and drops a
 * leading zero from someone's employee id.
 */
export function parseCsv(text: string): string[][] {
  return parseCsvRecords(text)
    .map((r) => r.cells)
    .filter((r) => r.some((cell) => cell.trim().length > 0));
}

/**
 * The same reader, but every record keeps the 1-based LINE NUMBER of the
 * physical line it started on, and blank records are NOT dropped.
 *
 * ADR-0069 needs this: an importer that refuses a malformed row has to name the
 * row, and "row 14" has to mean line 14 of the file the operator is looking at.
 * Filtering blanks first \u2014 which `parseCsv` does, correctly, for its own
 * caller \u2014 renumbers everything after the first blank line and turns a precise
 * refusal into a wrong one. `parseCsv` is now defined in terms of this so there
 * is still exactly ONE CSV parser in the codebase.
 *
 * Character-scanned, never regex-driven: the input is an untrusted file.
 */
export function parseCsvRecords(text: string): Array<{ line: number; cells: string[] }> {
  const rows: Array<{ line: number; cells: string[] }> = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  let line = 1;
  let recordLine = 1;
  const src = text.replace(/^\uFEFF/, "");
  const pushRow = () => {
    row.push(field);
    rows.push({ line: recordLine, cells: row });
    row = [];
    field = "";
  };
  while (i < src.length) {
    const c = src[i]!;
    // a newline INSIDE a quoted field still advances the physical line counter,
    // so the next record's reported line number stays true to the file
    if (c === "\n" && inQuotes) line += 1;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      pushRow();
      line += 1;
      recordLine = line;
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

/**
 * CSV -> the SAME row objects the JSON path produces, so both go through the
 * same `.strict()` schema and the same planner. A header column this does not
 * recognise is KEPT in the object, which means the strict schema refuses it —
 * that is deliberate. A CSV with an `is_admin` column must be a loud refusal,
 * not a quietly dropped column.
 */
export function csvToUserRows(text: string): Array<Record<string, unknown>> {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim());
  const canonical = (h: string) => {
    const n = normalizeKey(h);
    if (n === "email" || n === "emailaddress" || n === "mail") return "email";
    if (n === "displayname" || n === "name" || n === "fullname") return "displayName";
    if (n === "username" || n === "login" || n === "userid") return "username";
    if (n === "groups" || n === "group" || n === "memberof") return "groups";
    return h.trim();
  };
  const keys = header.map(canonical);
  return rows.slice(1).map((cells) => {
    const obj: Record<string, unknown> = {};
    keys.forEach((k, idx) => {
      const raw = (cells[idx] ?? "").trim();
      if (raw === "") return;
      obj[k] = k === "groups" ? raw.split(/[;|]/).map((g) => g.trim()).filter(Boolean) : raw;
    });
    return obj;
  });
}
