/**
 * ADR-0206 — the wire contract for G1 (project archive) and G10 (rename roles and teams).
 *
 * G1: `POST /v1/projects/:projectId/archive` and `/unarchive` (admin-only; unarchive needs a `settings_relax`
 * step-up), and `GET /v1/projects/:projectId/archive-impact` (what the archive dialog lists before the admin
 * confirms). G10: `PATCH /v1/roles/:roleId` and `PATCH /v1/teams/:teamId` (admin-only; a rename whose OLD name is
 * matched by an access policy or a routing rule is refused until the admin gives a reason and a step-up).
 *
 * The refusal codes below are the ones the UI branches on. Every list in a refusal is bounded by
 * `ARCHIVE_BLOCKER_LIST_MAX` / `RENAME_REFERENCE_LIST_MAX`, with the full count beside it.
 */
import { z } from "zod";

/** a recorded reason: long enough to say why, short enough to bound the audit row */
export const LIFECYCLE_REASON_MIN = 10;
export const LIFECYCLE_REASON_MAX = 500;
const reason = z.string().trim().min(LIFECYCLE_REASON_MIN).max(LIFECYCLE_REASON_MAX);

/** the most ids any one refusal or impact list carries; the count beside it is always the full count */
export const ARCHIVE_BLOCKER_LIST_MAX = 50;
export const RENAME_REFERENCE_LIST_MAX = 50;

// ------------------------------------------------------------------ G1

export const archiveProjectSchema = z.object({ reason }).strict();
export type ArchiveProjectBody = z.infer<typeof archiveProjectSchema>;

/** unarchive takes no fields; an optional note is recorded with the step-up */
export const unarchiveProjectSchema = z.object({ reason: reason.optional() }).strict();

/** `GET /v1/projects?archived=` — archived projects are left out unless asked for (ADR-0206: hidden by default) */
export const projectListQuerySchema = z.object({
  archived: z.enum(["exclude", "include", "only"]).default("exclude"),
});

export const PROJECT_ARCHIVE_REFUSALS = [
  "unknown_project",
  "project_already_archived",
  "project_not_archived",
  "project_has_open_approvals",
  "project_has_running_work",
  "project_has_open_delegations",
  /** any write to an archived project (members, context, settings) and any call attributed to one */
  "project_archived",
] as const;
export type ProjectArchiveRefusal = (typeof PROJECT_ARCHIVE_REFUSALS)[number];

export interface PinnedEngineKey {
  id: string;
  name: string;
  engineRunId: string | null;
  expiresAt: string | null;
}

export interface RunningWork {
  id: string;
  kind: "workflow" | "orchestration" | "engine_run";
  status: string;
}

export interface ArchiveImpact {
  projectId: string;
  archived: boolean;
  /** live engine keys pinned to the project: they stop working once it is archived */
  pinnedEngineKeys: PinnedEngineKey[];
  pinnedEngineKeyCount: number;
  /** what would refuse the archive right now */
  openApprovals: Array<{ id: string }>;
  openApprovalCount: number;
  runningWork: RunningWork[];
  runningWorkCount: number;
  openDelegations: Array<{ id: string }>;
  openDelegationCount: number;
}

// ------------------------------------------------------------------ G10

const name = z.string().trim().min(1).max(200);

export const renameRoleSchema = z
  .object({
    name,
    description: z.string().trim().max(1000).nullable().optional(),
    /** required (with `acknowledgeReferences`) only when the old name is referenced */
    reason: reason.optional(),
    acknowledgeReferences: z.boolean().optional(),
  })
  .strict();

export const renameTeamSchema = z
  .object({
    name,
    reason: reason.optional(),
    acknowledgeReferences: z.boolean().optional(),
  })
  .strict();

export const RENAME_REFUSALS = [
  "unknown_role",
  "unknown_team",
  "name_taken",
  "role_name_referenced",
  "team_name_referenced",
  "rename_reason_required",
] as const;
export type RenameRefusal = (typeof RENAME_REFUSALS)[number];

export interface NameReference {
  id: string;
  name: string;
}

/** the 409 body of `role_name_referenced` / `team_name_referenced` */
export interface NameReferencedRefusal {
  error: "role_name_referenced" | "team_name_referenced";
  policies: NameReference[];
  rules: NameReference[];
  policyCount: number;
  ruleCount: number;
  detail: string;
}
