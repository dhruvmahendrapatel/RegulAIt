/** Display models are separate from the shared S1 wire contract. */
import { WORKLOAD_IDENTITY_MAX_STEWARDS, WORKLOAD_IDENTITY_MAX_ENVIRONMENTS, ENVIRONMENT_NAME_PATTERN, type WorkloadIdentityKind, type WorkloadIdentityStatus } from "../../../../../../packages/shared/src/identity/contract";
export type WorkloadKind = WorkloadIdentityKind;
export type WorkloadStatus = WorkloadIdentityStatus;
export interface IdentityPerson { id: string; name: string }
export interface WorkloadIdentity {
  id: string; kind: WorkloadKind; identifier: string; subjectId: string | null;
  stewards: IdentityPerson[]; environments: string[]; status: WorkloadStatus; createdAt: string;
}
export interface WorkloadCredential {
  id: string; identityId: string; kind: "public_key" | "x509" | "spiffe";
  fingerprint: string; notBefore: string; notAfter: string; revokedAt: string | null;
}
export interface OwnGrant {
  id: string; kind: "tool" | "server" | "connector" | "agent_invoke" | "role";
  targetId: string; targetName: string; toolName: string | null; access: "read" | "write" | "invoke" | null;
  readOnlyAll?: boolean; allowedModes?: string[]; mode?: "read" | "readwrite"; allowedObjects?: string[];
}
export interface DelegationNode {
  id: string; parentId: string | null; identityId: string; identifier: string;
  sponsor: IdentityPerson; actorChain: string[]; status: "active" | "revoked" | "expired" | "completed";
  capMicros: string | null; settledMicros: string | null; reservedMicros: string | null; expiresAt: string;
  allocation: { amountMicros: string | null; drawnMicros: string | null; releasedMicros: string | null; status: "open" | "closed" } | null;
}
export interface IdentityInventory {
  identities: WorkloadIdentity[]; people: IdentityPerson[];
  subjects: Array<{ id: string; name: string; kind: WorkloadKind }>;
  grantTargets: Array<{ id: string; name: string; kind: OwnGrant["kind"]; tools?: string[] }>;
  environments: string[];
}
export interface IdentityDetail { grantsRevision: number; credentials: WorkloadCredential[]; grants: OwnGrant[] }
export interface PublicKey { kty: "EC" | "OKP"; crv: "P-256" | "Ed25519"; x: string; y?: string }
export type IdentityWrite =
  | { operation: "create_identity"; kind: WorkloadKind; subjectId: string | null; stewardIds: string[]; environments: string[] }
  | { operation: "edit_identity"; identityId: string; stewardIds: string[]; environments: string[] }
  | { operation: "identity_status"; identityId: string; status: WorkloadStatus }
  | { operation: "add_credential" | "rotate_credential"; identityId: string; previousCredentialId?: string; publicKey: PublicKey; notAfter: string }
  | { operation: "revoke_credential"; identityId: string; credentialId: string }
  | { operation: "add_grant"; identityId: string; kind: OwnGrant["kind"]; targetId: string; toolName: string | null; access: OwnGrant["access"]; readOnlyAll?: boolean; allowedModes?: string[]; mode?: "read" | "readwrite"; allowedObjects?: string[] }
  | { operation: "remove_grant"; identityId: string; grantId: string }
  | { operation: "revoke_delegation"; grantId: string };
export interface IdentityAdminPort {
  inventory(): Promise<IdentityInventory>;
  detail(identityId: string): Promise<IdentityDetail>;
  delegationTree(runId: string): Promise<{ runId: string; nodes: DelegationNode[] }>;
  /** Capture a complete, immutable wire request before the first call or step-up. */
  prepareWrite(command: IdentityWrite): (headers: Record<string, string>) => Promise<void>;
}

export const workloadKindLabels: Record<WorkloadKind, string> = {
  agent: "Agent", builder_agent: "Builder agent", engine_runner: "Engine runner", worker_runtime: "External worker", pdp: "Policy client",
};
export function formatMicros(value: string | null): string {
  if (value === null || !/^-?\d{1,64}$/.test(value)) return "Unmeasured";
  const n = BigInt(value), sign = n < 0n ? "−" : "", absolute = n < 0n ? -n : n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${sign}$${absolute / 1_000_000n}.${fraction}`;
}
export function remainingMicros(node: Pick<DelegationNode, "capMicros" | "settledMicros" | "reservedMicros">): string | null {
  const values = [node.capMicros, node.settledMicros, node.reservedMicros];
  if (values.some(v => v === null || !/^\d{1,64}$/.test(v))) return null;
  return (BigInt(values[0]!) - BigInt(values[1]!) - BigInt(values[2]!)).toString();
}
export function credentialStatus(c: WorkloadCredential, at = Date.now()): string {
  if (c.revokedAt !== null) return "Revoked";
  const from = Date.parse(c.notBefore), until = Date.parse(c.notAfter);
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) return "Validity unmeasured";
  if (until <= at) return "Expired";
  return from > at ? "Not yet valid" : "Active";
}
export function readPublicKey(text: string): PublicKey {
  if (text.length > 16384) throw new Error("Choose a public JWK file under 16 KiB.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Choose a JSON file containing one public JWK."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose one public JWK, rather than a key set.");
  const key = value as Record<string, unknown>;
  if (["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(name => Object.hasOwn(key, name))) throw new Error("Private or shared key material is refused. Choose only the public JWK.");
  const coordinate = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v) &&
    (() => { try {
      const decoded = atob(v.replace(/-/g, "+").replace(/_/g, "/") + "=");
      return decoded.length === 32 && btoa(decoded).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") === v;
    } catch { return false; } })();
  if (key.kty === "EC" && key.crv === "P-256" && coordinate(key.x) && coordinate(key.y)) return { kty: "EC", crv: "P-256", x: key.x as string, y: key.y as string };
  if (key.kty === "OKP" && key.crv === "Ed25519" && coordinate(key.x)) return { kty: "OKP", crv: "Ed25519", x: key.x as string };
  throw new Error("Choose an ES256 (P-256) or Ed25519 public JWK. The server also validates the key.");
}
export async function publicKeyFingerprint(key: PublicKey): Promise<string> {
  const canonical = key.kty === "EC" ? { crv: key.crv, kty: key.kty, x: key.x, y: key.y } : { crv: key.crv, kty: key.kty, x: key.x };
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
export function validateIdentity(kind: WorkloadKind, subjectId: string | null, stewardIds: string[], environments: string[]): string | null {
  if (["agent", "builder_agent", "engine_runner"].includes(kind) && !subjectId) return "Choose the subject this identity belongs to.";
  if (["worker_runtime", "pdp"].includes(kind) && subjectId !== null) return "An external worker or policy client has no internal subject.";
  if (!stewardIds.length) return "Choose at least one steward.";
  if (stewardIds.length > WORKLOAD_IDENTITY_MAX_STEWARDS || new Set(stewardIds).size !== stewardIds.length) return "Choose up to 10 distinct stewards.";
  if (environments.length > WORKLOAD_IDENTITY_MAX_ENVIRONMENTS || new Set(environments).size !== environments.length || environments.some(env => !ENVIRONMENT_NAME_PATTERN.test(env))) return "Choose up to 20 distinct valid environments.";
  return null;
}
export function orderedDelegations(nodes: DelegationNode[]): { nodes: Array<DelegationNode & { level: number }>; problem: string | null } {
  if (nodes.length > 1000) return { nodes: [], problem: "The delegation tree is too large to display. Narrow the run selection." };
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (byId.size !== nodes.length || nodes.some(n => n.parentId !== null && !byId.has(n.parentId))) return { nodes: [], problem: "The delegation chain is incomplete. Refresh before acting." };
  const result: Array<DelegationNode & { level: number }> = [];
  const visited = new Set<string>();
  const visit = (node: DelegationNode, level: number) => {
    if (visited.has(node.id) || level > 64) return;
    visited.add(node.id); result.push({ ...node, level });
    for (const child of nodes.filter(n => n.parentId === node.id)) visit(child, level + 1);
  };
  for (const root of nodes.filter(n => n.parentId === null)) visit(root, 0);
  if (visited.size !== nodes.length) return { nodes: [], problem: "The delegation chain has a cycle or exceeds the display depth. Refresh before acting." };
  return { nodes: result, problem: null };
}

export function ownGrantSummary(grant: OwnGrant): string {
  switch (grant.kind) {
    case "tool": return "This named tool";
    case "server": return grant.readOnlyAll === undefined ? "Permission unmeasured" : grant.readOnlyAll ? "All read-only tools" : "All tools";
    case "agent_invoke": return grant.allowedModes === undefined ? "Modes unmeasured" : grant.allowedModes.length ? `Modes: ${grant.allowedModes.join(", ")}` : "No modes allowed";
    case "connector": return grant.mode === undefined || grant.allowedObjects === undefined ? "Permission unmeasured" : `${grant.mode === "read" ? "Read" : "Read and write"}; ${grant.allowedObjects.length ? `objects: ${grant.allowedObjects.join(", ")}` : "no objects allowed"}`;
    case "role": return "Defined by role";
  }
}

/** Mock display facts only; not an HTTP response or delegation-proof wire body. */
export interface DelegationPreviewContext {
  viewerId: string | null;
  projectId: string | null;
  projectAccess: boolean | null;
  uncappedRootAllowed: boolean | null;
  maxLifetimeSeconds: number;
}
export function canPreviewDelegation(identity: WorkloadIdentity, context?: DelegationPreviewContext): boolean {
  return identity.status === "active" && !!context?.viewerId && !!context.projectId && context.projectAccess === true &&
    identity.stewards.some(steward => steward.id === context?.viewerId);
}
export function validateRootDelegationPreview(capMicros: string, lifetimeSeconds: number, context: DelegationPreviewContext): string | null {
  if (!capMicros.trim() && context.uncappedRootAllowed !== true) return "Name a root-grant cap. Uncapped roots require an audited admin relaxation.";
  if (capMicros.trim() && !/^\d{1,64}$/.test(capMicros.trim())) return "Enter a cap as a whole number of micro-dollars.";
  if (!Number.isSafeInteger(context.maxLifetimeSeconds) || context.maxLifetimeSeconds < 1 ||
    !Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > context.maxLifetimeSeconds) {
    return "Choose a positive lifetime within the current root-grant limit. The strict limit is 15 minutes.";
  }
  return null;
}
export const delegationRefusalMessages = {
  delegation_depth_unenforced: "External child delegation is unavailable until the parent's signed depth limit is enforced. Retry only after the deployment enables that enforcement.",
  invalid_target: "The child's resource must exactly equal its parent's audience. Choose that same resource; a different audience cannot narrow this delegation.",
} as const;
