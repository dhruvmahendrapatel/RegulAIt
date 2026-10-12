/**
 * ADR-0054 — the group→role mapping import and the import history, as the
 * browser models them. The gateway is the authority on every rule; this only
 * shapes the request (`groupRoleImportSchema`: 1 to 5000 rows of source,
 * externalGroup, roleName) and reads the plan and the refusals as unknown input.
 */

export const GROUP_SOURCES = ["oidc", "saml", "scim"] as const;
export type GroupSource = (typeof GROUP_SOURCES)[number];

export interface GroupRoleDraftRow {
  source: GroupSource;
  externalGroup: string;
  roleName: string;
}

export interface GroupRolePlanEntry {
  source: string;
  externalGroup: string;
  roleName: string;
  action: string;
}
export interface GroupRolePlan {
  entries: GroupRolePlanEntry[];
  counts: { create: number; unchanged: number; unknown_role: number };
  unknownRoles: string[];
}

export interface OnboardingImport {
  id: string;
  kind: string;
  mode: string;
  status: string;
  payloadSha256: string;
  rowCount: number;
  reason: string;
  ruleId: string;
  createdAt: string;
  appliedAt: string | null;
}

/** the rows the gateway would accept (trimmed, blank rows dropped), or the reason it would refuse them */
export function importRows(rows: readonly GroupRoleDraftRow[]): { ok: true; rows: GroupRoleDraftRow[] } | { ok: false; problem: string } {
  const out: GroupRoleDraftRow[] = [];
  for (const [i, r] of rows.entries()) {
    const group = r.externalGroup.trim();
    const role = r.roleName.trim();
    if (group === "" && role === "") continue;
    if (group === "" || role === "") return { ok: false, problem: `Row ${i + 1}: enter both the group and the role.` };
    if (group.length > 512) return { ok: false, problem: `Row ${i + 1}: a group name is at most 512 characters.` };
    if (role.length > 200) return { ok: false, problem: `Row ${i + 1}: a role name is at most 200 characters.` };
    out.push({ source: r.source, externalGroup: group, roleName: role });
  }
  if (out.length === 0) return { ok: false, problem: "Add at least one group and role." };
  if (out.length > 5000) return { ok: false, problem: "One import holds at most 5000 rows." };
  return { ok: true, rows: out };
}

/** a plan read defensively: a missing or malformed plan is null, never an empty "nothing to do" */
export function readPlan(value: unknown): GroupRolePlan | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<GroupRolePlan>;
  if (!Array.isArray(p.entries) || !p.counts || typeof p.counts !== "object") return null;
  return { entries: p.entries, counts: p.counts, unknownRoles: Array.isArray(p.unknownRoles) ? p.unknownRoles : [] };
}

export const ACTION_TEXT: Record<string, string> = {
  create: "will be created",
  unchanged: "already mapped",
  unknown_role: "no such role",
};

/** the lines that explain a refused import, from its payload (the gateway's own fields) */
export function refusalLines(code: string | null, payload: Record<string, unknown> | null): string[] {
  if (!payload) return [];
  if (code === "unknown_role" && Array.isArray(payload.unknownRoles)) {
    return [
      `These roles do not exist: ${(payload.unknownRoles as string[]).join(", ")}.`,
      "An import never creates a role. Create the role in the role builder first, then import again. Nothing was mapped.",
    ];
  }
  if (code === "import_privilege_escalation_refused" && Array.isArray(payload.findings)) {
    return (payload.findings as Array<{ path?: string }>).map((f) => `Refused field: ${f.path ?? "unknown"}`);
  }
  if (code === "import_validation_failed" && Array.isArray(payload.issues)) {
    return (payload.issues as Array<{ path?: unknown; message?: string }>).slice(0, 20).map((i) => {
      const path = Array.isArray(i.path) ? i.path.join(".") : String(i.path ?? "");
      return `${path ? `${path}: ` : ""}${i.message ?? "invalid"}`;
    });
  }
  return [];
}
