/**
 * The object types the console opens one object's audit trail for (`/admin/audit?objectType=…&objectId=…`). The
 * page sends `objectType` only when it is listed here, so it never sends a type the gateway refuses (400
 * `unknown_object_type`, owner decision of 2026-10-21). This is not a copy of the audit object types: it lists only
 * the types a console link opens, and the gateway's `zz-audit-object-type-0210.test.ts` checks each one is an
 * `audit_log.object_type` the schema declares.
 */
export const AUDIT_OBJECT_LINK_TYPES: ReadonlySet<string> = new Set(["ai_use_case"]);
