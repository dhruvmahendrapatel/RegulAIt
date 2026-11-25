/**
 * Shared Salesforce read-adapter pieces (ADR-0336 decision 5, ADR-0337 §4a): the org's My Domain origin, validated from
 * configuration (never from a vendor response), and the read-only check of the integration user every Salesforce read
 * adapter runs before anything else. One copy, used by the Agentforce registry adapter and the entitlement reader
 * (#890 R4 [1]).
 */
import { ReadFailure, WiderSourceConfigError, atPath, str } from "./discovery-wider-scanners.js";
import type { SalesforceEnvironment } from "./salesforce-jwt.js";

const PRODUCTION_HOST = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?\.my\.salesforce\.com$/;
const SANDBOX_HOST = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?--[a-z0-9]{1,40}\.sandbox\.my\.salesforce\.com$/;
/** a Salesforce record id: 15 characters (case-sensitive) or 18 (with the case-safe suffix) */
export const SALESFORCE_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/** the org's validated My Domain origin and environment, or null when the target does not name a valid one */
export function salesforceMyDomain(target: Readonly<Record<string, string>>): { origin: string; environment: SalesforceEnvironment } | null {
  const origin = (target.myDomain ?? "").trim().toLowerCase().replace(/\/+$/, "");
  const environment = target.environment;
  if (environment !== "production" && environment !== "sandbox") return null;
  if (!(environment === "production" ? PRODUCTION_HOST : SANDBOX_HOST).test(origin)) return null;
  return { origin, environment };
}

/** the reason a target names no valid My Domain, for a source's config error */
export function salesforceMyDomainProblem(target: Readonly<Record<string, string>>): string | null {
  if (target.environment !== "production" && target.environment !== "sandbox") return "'environment' must be production or sandbox";
  if (salesforceMyDomain(target)) return null;
  return target.environment === "production"
    ? "'myDomain' must be the org's My Domain URL, https://<name>.my.salesforce.com"
    : "'myDomain' must be the sandbox's My Domain URL, https://<name>--<sandbox>.sandbox.my.salesforce.com";
}

/**
 * A system permission on the integration user's session that writes, or lets the user grant itself more: any one of
 * these refuses the credential. The first group changes data, setup, code or metadata; the second group are the
 * escalation and user-management permissions (#1111 R4 [1]).
 */
export const WRITE_SYSTEM_PERMISSIONS = Object.freeze([
  "PermissionsModifyAllData",
  "PermissionsModifyMetadata",
  "PermissionsCustomizeApplication",
  "PermissionsAuthorApex",
  "PermissionsManageUsers",
  "PermissionsAssignPermissionSets",
  "PermissionsManageProfilesPermissionsets",
  "PermissionsManageInternalUsers",
  "PermissionsManageRoles",
  "PermissionsManageSharing",
  "PermissionsResetPasswords",
] as const);
export type WriteSystemPermission = (typeof WRITE_SYSTEM_PERMISSIONS)[number];

/** the session's effective system permissions (one row); no free-text column is selected */
export const SALESFORCE_PERMISSIONS_QUERY = `SELECT ${WRITE_SYSTEM_PERMISSIONS.join(", ")} FROM UserPermissionAccess`;

/**
 * Object-level write on any object, across every permission set assigned to the user (#1111 S4 [1]): one row is
 * enough to refuse. The user id is validated (a 15- or 18-character Salesforce id) before it is placed in the query.
 */
export function objectWriteQuery(userId: string, kind = "agent_registry_agentforce"): string {
  if (!SALESFORCE_ID.test(userId)) throw new WiderSourceConfigError(`${kind}: the session's user id is not a Salesforce id`);
  return `SELECT Id, SobjectType FROM ObjectPermissions WHERE (PermissionsCreate = true OR PermissionsEdit = true OR PermissionsDelete = true OR PermissionsModifyAllRecords = true) AND ParentId IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}') LIMIT 5`;
}

/**
 * What the integration user may write: the system permissions it holds, else the objects it may change. Empty means
 * read-only by both checks. A check that cannot be read throws a ReadFailure (the caller then records `unverified`).
 */
export async function salesforceWritePermissions(get: (url: string) => Promise<unknown>, queryUrl: (soql: string) => string, userId: string, kind: string): Promise<string[]> {
  return (await salesforceWriteCheck(get, queryUrl, userId, kind)).refused;
}

/**
 * The same check, with system permissions an admin's audited opt-in TOLERATES (ADR-0337 §4a, owner decision
 * 2026-11-22: only `PermissionsCustomizeApplication`, for the org-wide OAuth token read). A tolerated permission the
 * user holds is reported apart and never refuses; every other write permission, and any object-level write, still
 * refuses. A caller that tolerates a held permission must not record the credential as `read_only`.
 */
export async function salesforceWriteCheck(
  get: (url: string) => Promise<unknown>,
  queryUrl: (soql: string) => string,
  userId: string,
  kind: string,
  tolerate: readonly WriteSystemPermission[] = [],
): Promise<{ refused: string[]; tolerated: WriteSystemPermission[] }> {
  const rows = atPath(await get(queryUrl(SALESFORCE_PERMISSIONS_QUERY)), "records");
  if (!Array.isArray(rows) || rows.length !== 1) throw new ReadFailure("error", "the permission check returned no single row");
  const unknown = WRITE_SYSTEM_PERMISSIONS.filter((p) => typeof atPath(rows[0], p) !== "boolean");
  if (unknown.length) throw new ReadFailure("error", `the permission check did not report ${unknown.join(", ")}`);
  const heldAll = WRITE_SYSTEM_PERMISSIONS.filter((p) => atPath(rows[0], p) === true);
  const tolerated = heldAll.filter((p) => tolerate.includes(p));
  const held: string[] = heldAll.filter((p) => !tolerate.includes(p));
  if (held.length) return { refused: held, tolerated };
  const objects = atPath(await get(queryUrl(objectWriteQuery(userId, kind))), "records");
  if (!Array.isArray(objects)) throw new ReadFailure("error", "the object permission check was not readable");
  return { refused: objects.map((o) => `write on ${str(atPath(o, "SobjectType"), 80) ?? "an object"}`), tolerated };
}
