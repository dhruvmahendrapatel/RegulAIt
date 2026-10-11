/**
 * ADR-0188 S6 — the workload identity calls, over the shared client.
 *
 * Reads use the shared client (`api`). Every write goes through `withStepUp`
 * with the step-up client (`stepUpApi`): the gateway refuses it 403
 * `step_up_required` (`identity_manage`), the global "Confirm it's you"
 * dialog asks once, and the SAME captured body is resent with the grant. The
 * body is built and frozen before the first attempt, so a retry can never
 * send something other than what the person confirmed.
 *
 * Live on the gateway today: the identity list and detail (S4), PATCH for
 * stewards, environments and suspend/restore (S4), the own-grant set read
 * and replace (S4), and the delegation-grant list and cascade revoke (S5).
 * `createWorkloadIdentity` is written to the frozen contract but its route
 * still answers 501 (`IDENTITY_ROUTES_NOT_BUILT`); the page keeps its
 * control disabled and never calls it until the model test says the route
 * is live.
 */
import { api } from "../../../api/client";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import {
  DELEGATION_TREE_MAX_NODES,
  UUID_PATTERN,
  type AgentGrantsView,
  type DelegationAllocationView,
  type DelegationGrantListView,
  type DelegationGrantView,
  type PutAgentGrants,
  type WorkloadIdentityDetailView,
  type WorkloadIdentityKind,
  type WorkloadIdentityListView,
  type WorkloadIdentityView,
} from "./workloadIdentityModel";

export const workloadIdentityKeys = {
  root: ["admin", "workload-identities"] as const,
  list: ["admin", "workload-identities", "list"] as const,
  detail: (id: string) => ["admin", "workload-identities", "detail", id] as const,
  grants: (id: string) => ["admin", "workload-identities", "grants", id] as const,
  tree: (runId: string) => ["admin", "workload-identities", "tree", runId] as const,
};

/** one path segment that must be a UUID; anything else is refused before a request is made */
function seg(id: string): string {
  if (!UUID_PATTERN.test(id)) throw new Error("That identifier could not be read. Refresh the page and try again.");
  return encodeURIComponent(id);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const IDENTITY_LIST_PAGE = 100;

// ---- reads -----------------------------------------------------------------

export function listWorkloadIdentities(cursor: string | null): Promise<WorkloadIdentityListView> {
  const q = new URLSearchParams({ limit: String(IDENTITY_LIST_PAGE) });
  if (cursor) q.set("cursor", cursor);
  return api.get<WorkloadIdentityListView>(`/v1/workload-identities?${q.toString()}`);
}

export function getWorkloadIdentity(identityId: string): Promise<WorkloadIdentityDetailView> {
  return api.get<WorkloadIdentityDetailView>(`/v1/workload-identities/${seg(identityId)}`);
}

export function getIdentityGrants(identityId: string): Promise<AgentGrantsView> {
  return api.get<AgentGrantsView>(`/v1/workload-identities/${seg(identityId)}/grants`);
}

const TREE_PAGE = 200;

/**
 * One run's delegation tree, every page of it up to `DELEGATION_TREE_MAX_NODES`.
 * `truncated` says the bound was reached; the page then draws nothing rather
 * than a tree with missing branches.
 */
export async function listRunDelegationTree(runId: string): Promise<DelegationGrantListView & { truncated: boolean }> {
  const run = seg(runId);
  const items: DelegationGrantView[] = [];
  const edges: DelegationAllocationView[] = [];
  let cursor: string | null = null;
  for (;;) {
    const q = new URLSearchParams({ runId: run, limit: String(TREE_PAGE) });
    if (cursor) q.set("cursor", cursor);
    const page: DelegationGrantListView = await api.get<DelegationGrantListView>(`/v1/delegation-grants?${q.toString()}`);
    items.push(...page.items);
    edges.push(...page.edges);
    cursor = page.nextCursor;
    if (!cursor) return { items, edges, nextCursor: null, truncated: false };
    if (items.length >= DELEGATION_TREE_MAX_NODES) return { items, edges, nextCursor: cursor, truncated: true };
  }
}

// ---- writes (each under the identity_manage step-up) ------------------------

/** stewards, environments, or suspend (`suspended`) / restore (`active`) */
export function updateWorkloadIdentity(
  identityId: string,
  change: { sponsorUserIds?: string[]; environments?: string[]; status?: "active" | "suspended" },
): Promise<WorkloadIdentityView> {
  const path = `/v1/workload-identities/${seg(identityId)}`;
  const body = deepFreeze({ ...change });
  return withStepUp((h) => stepUpApi.patch<WorkloadIdentityView>(path, body, h));
}

/**
 * Replace the identity's direct grants and role assignments, as one set, at
 * the revision that was read. A stale revision is refused 409
 * `grants_revision_conflict`; `If-Match` carries the same revision.
 */
export function replaceIdentityGrants(identityId: string, set: PutAgentGrants): Promise<AgentGrantsView> {
  if (!Number.isSafeInteger(set.revision) || set.revision < 0) {
    return Promise.reject(new Error("Reload the grant set before changing it."));
  }
  const path = `/v1/workload-identities/${seg(identityId)}/grants`;
  const body = deepFreeze({ ...set });
  return withStepUp((h) => stepUpApi.put<AgentGrantsView>(path, body, { ...h, "if-match": `"${body.revision}"` }));
}

/** cascade revoke: this grant and every descendant are refused at the next use */
export function revokeDelegationGrant(grantId: string): Promise<unknown> {
  const path = `/v1/delegation-grants/${seg(grantId)}/revoke`;
  return withStepUp((h) => stepUpApi.post(path, {}, h));
}

/** the subject column each kind names (`WORKLOAD_IDENTITY_SUBJECT_COLUMN`) */
const SUBJECT_COLUMN: Record<WorkloadIdentityKind, "agentId" | "builderAgentId" | "engineRunnerId" | null> = {
  agent: "agentId",
  builder_agent: "builderAgentId",
  engine_runner: "engineRunnerId",
  worker_runtime: null,
  pdp: null,
};

/**
 * `POST /v1/workload-identities` (createWorkloadIdentitySchema). NOT BUILT on
 * the gateway yet: the page's "Add identity" control is disabled with the
 * reason, and this is not called. It is here so the request is written to
 * the contract, and checked by its unit test, before the backend lands.
 */
export function createWorkloadIdentity(input: {
  kind: WorkloadIdentityKind;
  subjectId: string | null;
  stewardIds: string[];
  environments: string[];
}): Promise<WorkloadIdentityView> {
  const column = SUBJECT_COLUMN[input.kind];
  if (column === null && input.subjectId !== null) return Promise.reject(new Error("An external worker or policy client has no internal subject."));
  if (column !== null && (input.subjectId === null || !UUID_PATTERN.test(input.subjectId))) {
    return Promise.reject(new Error("Choose the subject this identity belongs to."));
  }
  const body = deepFreeze({
    kind: input.kind,
    ...(column ? { [column]: input.subjectId } : {}),
    sponsorUserIds: [...input.stewardIds],
    environments: [...input.environments],
  });
  return withStepUp((h) => stepUpApi.post<WorkloadIdentityView>("/v1/workload-identities", body, h));
}
