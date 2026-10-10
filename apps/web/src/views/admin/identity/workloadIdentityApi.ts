/** Frozen S1 write contract. Read envelopes and picker APIs remain owner-defined. */
import {
  IDENTITY_ROUTES, createWorkloadIdentitySchema, updateWorkloadIdentitySchema,
  revokeWorkloadIdentitySchema, addWorkloadCredentialSchema, putAgentGrantsSchema,
  type PutAgentGrants,
} from "../../../../../../packages/shared/src/identity/contract";
import { api } from "../../../api/client";
import { readPublicKey, type IdentityWrite, type OwnGrant } from "./workloadIdentityModel";

type Method = "POST" | "PATCH" | "PUT" | "DELETE";
export interface IdentityWriteRequest { method: Method; path: string; body?: unknown }
interface GrantFields { readOnlyAll?: boolean; allowedModes?: string[]; mode?: "read" | "readwrite"; allowedObjects?: string[] }
function validate<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Check the identity fields against the accepted contract and refresh before retrying.");
  return parsed.data;
}
function id(value: string): string {
  // Same UUID shape used by the accepted shared schemas; no extra web dependency.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Choose a valid identity identifier and refresh before retrying.");
  }
  return value;
}
function route(method: Method | "GET", template: string, params: object = {}): string {
  if (!IDENTITY_ROUTES.some(r => r.method === method && r.path === template && r.cls === "admin")) {
    throw new Error("The identity route is unavailable in the accepted contract.");
  }
  return template.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
    if (!(key in params)) throw new Error("The identity route needs an identifier.");
    const value = (params as Record<string, unknown>)[key];
    if (typeof value !== "string") throw new Error("The identity route needs an identifier.");
    return encodeURIComponent(id(value));
  });
}
/** A full validated snapshot is required: PUT replaces all direct grants and roles.
 * It must be captured with the action, never re-read inside a step-up retry.
 * Capture the published grant-set revision too; stale replacements are refused.
 */
function grantSet(grants: readonly (OwnGrant & GrantFields)[], revision: number | undefined): PutAgentGrants {
  if (!Number.isSafeInteger(revision) || revision! < 0) throw new Error("Refresh the complete grant set and its revision before editing.");
  if (new Set(grants.map(g => g.id)).size !== grants.length) throw new Error("Refresh the complete grants before editing.");
  const body: PutAgentGrants = { revision: revision!, tools: [], servers: [], agents: [], connectors: [], roleIds: [] };
  for (const g of grants) {
    switch (g.kind) {
      case "tool": body.tools.push({ serverId: g.targetId, toolName: g.toolName! }); break;
      case "server": body.servers.push({ serverId: g.targetId, readOnlyAll: g.readOnlyAll! }); break;
      case "agent_invoke": body.agents.push({ agentId: g.targetId, allowedModes: g.allowedModes! }); break;
      case "connector": body.connectors.push({ connectorId: g.targetId, mode: g.mode!, allowedObjects: g.allowedObjects! }); break;
      case "role": body.roleIds.push(g.targetId); break;
      default: throw new Error("Refresh the complete grants before editing.");
    }
  }
  return validate(putAgentGrantsSchema, body);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function encodeIdentityWrite(command: IdentityWrite, currentGrantSet?: readonly OwnGrant[], currentGrantRevision?: number): IdentityWriteRequest {
  let request: IdentityWriteRequest;
  switch (command.operation) {
    case "create_identity": {
      const subject = command.kind === "agent" ? "agentId" : command.kind === "builder_agent" ? "builderAgentId" : command.kind === "engine_runner" ? "engineRunnerId" : null;
      if (subject === null && command.subjectId !== null) throw new Error("An external identity has no internal subject.");
      request = { method: "POST", path: route("POST", "/v1/workload-identities"), body: validate(createWorkloadIdentitySchema, {
        kind: command.kind, ...(subject ? { [subject]: command.subjectId } : {}), sponsorUserIds: command.stewardIds, environments: command.environments,
      }) }; break;
    }
    case "edit_identity": request = { method: "PATCH", path: route("PATCH", "/v1/workload-identities/:identityId", command), body: validate(updateWorkloadIdentitySchema, { sponsorUserIds: command.stewardIds, environments: command.environments }) }; break;
    case "identity_status": request = command.status === "revoked"
      ? { method: "POST", path: route("POST", "/v1/workload-identities/:identityId/revoke", command), body: validate(revokeWorkloadIdentitySchema, {}) }
      : { method: "PATCH", path: route("PATCH", "/v1/workload-identities/:identityId", command), body: validate(updateWorkloadIdentitySchema, { status: command.status }) }; break;
    case "add_credential": case "rotate_credential": request = {
      method: "POST", path: route("POST", "/v1/workload-identities/:identityId/credentials", command),
      // Refuse private members before whitelisting public coordinates. Rotation adds a key;
      // previousCredentialId is UI context, never an invented wire field or implicit revoke.
      body: validate(addWorkloadCredentialSchema, { kind: "jwk", publicJwk: readPublicKey(JSON.stringify(command.publicKey)), notAfter: command.notAfter }),
    }; break;
    case "revoke_credential": request = { method: "DELETE", path: route("DELETE", "/v1/workload-identities/:identityId/credentials/:credentialId", command) }; break;
    case "add_grant": case "remove_grant": {
      if (currentGrantSet === undefined) throw new Error("Load the complete grants before editing.");
      // Validate the existing snapshot even when removing a malformed entry: never
      // silently drop unknown grants and replace the server's full set with a partial list.
      grantSet(currentGrantSet, currentGrantRevision);
      let next: readonly (OwnGrant & GrantFields)[];
      if (command.operation === "remove_grant") {
        if (!currentGrantSet.some(g => g.id === command.grantId)) throw new Error("The grant changed. Refresh before editing.");
        next = currentGrantSet.filter(g => g.id !== command.grantId);
      } else {
        const fields = command as typeof command & GrantFields;
        next = [...currentGrantSet, { id: "new-grant", kind: command.kind, targetId: command.targetId, targetName: "", toolName: command.toolName,
          readOnlyAll: fields.readOnlyAll, allowedModes: fields.allowedModes, mode: fields.mode, allowedObjects: fields.allowedObjects } as OwnGrant & GrantFields];
      }
      request = { method: "PUT", path: route("PUT", "/v1/workload-identities/:identityId/grants", command), body: grantSet(next, currentGrantRevision) }; break;
    }
    case "revoke_delegation": request = { method: "POST", path: route("POST", "/v1/delegation-grants/:grantId/revoke", command), body: {} }; break;
  }
  return freeze(request);
}
/** Sends one captured request using the shared cookie/CSRF/refusal client.
 * Call within the page's withStepUp callback; pass its grant headers unchanged.
 */
export async function sendIdentityWrite(request: IdentityWriteRequest, headers: Record<string, string>): Promise<void> {
  switch (request.method) {
    case "POST": await api.postWithHeaders(request.path, request.body, headers); break;
    case "PATCH": await api.patchWithHeaders(request.path, request.body, headers); break;
    case "PUT": await api.putWithHeaders(request.path, request.body, headers); break;
    case "DELETE": await api.delWithHeaders(request.path, headers, request.body); break;
  }
}
/** Endpoint descriptors only: no unaccepted response envelope or run-id filter. */
export function identityReadRequests(identityId?: string) {
  return {
    inventory: { method: "GET" as const, path: route("GET", "/v1/workload-identities") },
    delegationGrants: { method: "GET" as const, path: route("GET", "/v1/delegation-grants") },
    ...(identityId === undefined ? {} : {
      identity: { method: "GET" as const, path: route("GET", "/v1/workload-identities/:identityId", { identityId }) },
      credentials: { method: "GET" as const, path: route("GET", "/v1/workload-identities/:identityId/credentials", { identityId }) },
      grants: { method: "GET" as const, path: route("GET", "/v1/workload-identities/:identityId/grants", { identityId }) },
    }),
  };
}
