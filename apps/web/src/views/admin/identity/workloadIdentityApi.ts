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
 * Live on the gateway: the identity list and detail (S4), PATCH for
 * stewards, environments and suspend/restore (S4), the own-grant set read
 * and replace (S4), the delegation-grant list and cascade revoke (S5), and
 * (S6) create and revoke an identity, its public credentials (list, bind,
 * revoke), the grant proposals from observed use, and the picker sources.
 */
import { api } from "../../../api/client";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import {
  DELEGATION_TREE_MAX_NODES,
  UUID_PATTERN,
  type AddWorkloadCredentialBody,
  type AgentGrantsView,
  type CreateWorkloadIdentityBody,
  type DelegationAllocationView,
  type IdentityGrantProposalsView,
  type IdentityPickerSourcesView,
  type WorkloadCredentialListView,
  type WorkloadCredentialView,
  type DelegationGrantListView,
  type DelegationGrantView,
  type PutAgentGrants,
  type WorkloadIdentityDetailView,
  type WorkloadIdentityListView,
  type WorkloadIdentityView,
} from "./workloadIdentityModel";
import { kidOk, type DelegationGrantDetailView, type IdentitySigningKeyListView } from "./signingKeyModel";
import {
  bundleDraftError,
  type PutSpiffeTrustBundleBody,
  type SpiffeTrustBundleListView,
  type SpiffeTrustBundleRevokeResult,
  type SpiffeTrustBundleView,
} from "./spiffeBundleModel";

export const workloadIdentityKeys = {
  root: ["admin", "workload-identities"] as const,
  list: ["admin", "workload-identities", "list"] as const,
  detail: (id: string) => ["admin", "workload-identities", "detail", id] as const,
  grants: (id: string) => ["admin", "workload-identities", "grants", id] as const,
  tree: (runId: string) => ["admin", "workload-identities", "tree", runId] as const,
  credentials: (id: string) => ["admin", "workload-identities", "credentials", id] as const,
  proposals: (id: string) => ["admin", "workload-identities", "proposals", id] as const,
  pickers: ["admin", "workload-identities", "pickers"] as const,
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

/** public halves only; the gateway stores no private member */
export function listIdentityCredentials(identityId: string): Promise<WorkloadCredentialListView> {
  return api.get<WorkloadCredentialListView>(`/v1/workload-identities/${seg(identityId)}/credentials`);
}

/** proposals from the identity's last 30 days of observed use; reading them changes nothing */
export function getGrantProposals(identityId: string): Promise<IdentityGrantProposalsView> {
  return api.get<IdentityGrantProposalsView>(`/v1/workload-identities/${seg(identityId)}/grant-proposals`);
}

/** what the identity forms may offer (only objects that exist) */
export function getIdentityPickerSources(): Promise<IdentityPickerSourcesView> {
  return api.get<IdentityPickerSourcesView>("/v1/identity/picker-sources");
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

/** a new identity: active, with no grants of its own */
export function createWorkloadIdentity(body: CreateWorkloadIdentityBody): Promise<WorkloadIdentityView> {
  const frozen = deepFreeze({ ...body });
  return withStepUp((h) => stepUpApi.post<WorkloadIdentityView>("/v1/workload-identities", frozen, h));
}

/** terminal: the identity, its credentials, its tokens and every grant naming it end */
export async function revokeWorkloadIdentity(identityId: string): Promise<unknown> {
  const path = `/v1/workload-identities/${seg(identityId)}/revoke`;
  return withStepUp((h) => stepUpApi.post(path, {}, h));
}

/** bind a PUBLIC credential (the body is built by `credentialBody`, which refuses private material) */
export async function addIdentityCredential(identityId: string, body: AddWorkloadCredentialBody): Promise<WorkloadCredentialView> {
  const path = `/v1/workload-identities/${seg(identityId)}/credentials`;
  const frozen = deepFreeze({ ...body });
  return withStepUp((h) => stepUpApi.post<WorkloadCredentialView>(path, frozen, h));
}

/** revoke (never delete) a credential, and every token and grant it authenticated */
export async function revokeIdentityCredential(identityId: string, credentialId: string): Promise<unknown> {
  // both ids are checked before any request; the path is written at the call so the affordance census sees it
  const identity = seg(identityId);
  const credential = seg(credentialId);
  return withStepUp((h) => stepUpApi.del(`/v1/workload-identities/${identity}/credentials/${credential}`, undefined, h));
}

/** cascade revoke: this grant and every descendant are refused at the next use */
export function revokeDelegationGrant(grantId: string): Promise<unknown> {
  const path = `/v1/delegation-grants/${seg(grantId)}/revoke`;
  return withStepUp((h) => stepUpApi.post(path, {}, h));
}

// ---- ADR-0188: the issuer's signing keys, and one delegation grant -----------

export const signingKeyKeys = { list: ["admin", "workload-identities", "signing-keys"] as const };

/** `GET /v1/identity/signing-keys`: every issuer key ever recorded, public halves only */
export function listSigningKeys(): Promise<IdentitySigningKeyListView> {
  return api.get<IdentitySigningKeyListView>("/v1/identity/signing-keys");
}

/** activate a configured key and retire the current signer; `kid` may be omitted when exactly one configured key is unrecorded */
export function rotateSigningKey(kid: string | null): Promise<{ kid: string; previousKid: string | null }> {
  if (kid !== null && !kidOk(kid)) return Promise.reject(new Error("That key id could not be read. Copy it exactly, or leave it blank."));
  const body = deepFreeze(kid ? { kid } : {});
  return withStepUp((h) => stepUpApi.post<{ kid: string; previousKid: string | null }>("/v1/identity/signing-keys/rotate", body, h));
}

/** compromise: every token the key signed is refused from now on; never undone */
export function revokeSigningKey(kid: string): Promise<{ kid: string; tokensRevoked: number }> {
  if (!kidOk(kid)) return Promise.reject(new Error("That key id could not be read. Refresh the list."));
  const path = `/v1/identity/signing-keys/${encodeURIComponent(kid)}/revoke`;
  return withStepUp((h) => stepUpApi.post<{ kid: string; tokensRevoked: number }>(path, {}, h));
}

// ---- ADR-0188 S9: SPIFFE trust bundles (identity_manage step-up on every write) --

export const spiffeBundleKeys = { list: ["admin", "workload-identities", "spiffe-trust-bundles"] as const };

/** `GET /v1/identity/spiffe-trust-bundles`: every bundle ever recorded, public facts only */
export function listSpiffeTrustBundles(): Promise<SpiffeTrustBundleListView> {
  return api.get<SpiffeTrustBundleListView>("/v1/identity/spiffe-trust-bundles");
}

/** upload a trust domain's bundle; `replacesBundleId` names the active bundle it replaces (null for the first) */
export function uploadSpiffeTrustBundle(input: PutSpiffeTrustBundleBody): Promise<SpiffeTrustBundleView> {
  const problem = bundleDraftError(input);
  if (problem) return Promise.reject(new Error(problem));
  if (input.replacesBundleId !== null) seg(input.replacesBundleId);
  const body = deepFreeze({ trustDomain: input.trustDomain, bundle: input.bundle, replacesBundleId: input.replacesBundleId });
  return withStepUp((h) => stepUpApi.post<SpiffeTrustBundleView>("/v1/identity/spiffe-trust-bundles", body, h));
}

/** end a domain's SPIFFE trust: its tokens and grants are revoked; never undone */
export function revokeSpiffeTrustBundle(bundleId: string): Promise<SpiffeTrustBundleRevokeResult> {
  const id = seg(bundleId);
  return withStepUp((h) => stepUpApi.post<SpiffeTrustBundleRevokeResult>(`/v1/identity/spiffe-trust-bundles/${id}/revoke`, {}, h));
}

/** `GET /v1/delegation-grants/:grantId`: one grant with its incoming and outgoing allocations */
export function getDelegationGrant(grantId: string): Promise<DelegationGrantDetailView> {
  return api.get<DelegationGrantDetailView>(`/v1/delegation-grants/${seg(grantId)}`);
}
