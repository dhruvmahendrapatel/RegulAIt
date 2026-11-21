/**
 * ADR-0333 §6 (slice 3) — device quarantine, the `quarantine_device` detection response.
 *
 * A rule whose incidents group by endpoint device (`endpoint:<deviceId>`, the hook decisions of ADR-0310's addendum)
 * may carry `response: quarantine_device`. When it fires, the response opens ONE active quarantine for that device
 * (`endpoint_device_quarantines`), for the rule's `quarantineHours` (default 72, at most 720; the database caps it at
 * 30 days). The lifecycle is the ADR-0348 machine ENDPOINT_DEVICE_QUARANTINE_MACHINE (active -> released | expired):
 *
 *   open     narrowing. Runs under any execution dial (ADR-0338 §7). A device that already has an active quarantine
 *            keeps it (the response reports `existing: true`); a revoked or unknown device fails `device_not_found`.
 *   release  widening. A human admin, with a `settings_relax` step-up bound to the quarantine, and only while the
 *            execution dial is `normal` (`killSwitchNarrowingOnly`). Audited.
 *   expire   widening. The sweep ends quarantines past `expires_at`, again only under `normal`: a halt keeps every
 *            quarantine in force until an admin sets the dial back. Audited, one row per quarantine.
 *
 * Every transition is one conditional UPDATE whose WHERE comes from the machine (`whereFrom`), so a release racing an
 * expiry moves the row once, and the loser changes nothing and audits nothing.
 *
 * ENFORCEMENT. The endpoint hook decides on the device (ADR-0298), and no gateway call is attributed to a device
 * today, so the gateway cannot refuse the device's AI tools by itself. `activeQuarantineForDevice` is the read the
 * device-side delivery uses; delivering the deny-all to the hook is a change to `agents/endpoint/` (lane E13), recorded
 * as an open owner question in ADR-0333 §6. Until it lands, every quarantine view says `deviceEnforcement:
 * "not_delivered"` (ADR-0180: an unknown is never shown as fine).
 */
import { and, auditLog, endpointDeviceQuarantines, endpointDevices, eq, isNull, lte, sql, type Db } from "@regulait/db";
import { ENDPOINT_DEVICE_QUARANTINE_MACHINE, killSwitchNarrowingOnly, type KillSwitchDial } from "@regulait/shared";
import { whereFrom } from "../state-transition.js";
import { loadExecutionMode } from "../execution-posture.js";

export const QUARANTINE_RULE_IDS = {
  released: "detection-quarantine-released",
  expired: "detection-quarantine-expired",
} as const;

/** how the device learns of its quarantine; see the module header */
export const QUARANTINE_DEVICE_ENFORCEMENT = "not_delivered" as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXPIRE_BATCH = 100;
const HOURS_DEFAULT = 72;
const HOURS_MAX = 720;

/** the device an `endpoint:` group names, or null */
export function deviceOfGroup(groupKey: string): string | null {
  if (!groupKey.startsWith("endpoint:")) return null;
  const id = groupKey.slice("endpoint:".length);
  return UUID.test(id) ? id : null;
}

/** the quarantine length a rule asks for, held to the pack's bounds even if the stored pack row was edited */
export function quarantineHoursOf(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^[0-9]{1,4}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= HOURS_MAX ? n : HOURS_DEFAULT;
}

export type OpenQuarantineOutcome =
  | { ok: true; quarantineId: string; deviceId: string; expiresAt: string; existing: boolean }
  | { ok: false; code: "not_endpoint" | "device_not_found" };

/** Open (or keep) the device's active quarantine, in the caller's transaction. Narrowing: no dial check is needed. */
export async function openQuarantine(tx: Db, args: { incidentId: string; groupKey: string; hours: number }): Promise<OpenQuarantineOutcome> {
  const deviceId = deviceOfGroup(args.groupKey);
  if (!deviceId) return { ok: false, code: "not_endpoint" };
  // opening a quarantine is narrowing, which `killSwitchNarrowingOnly` allows under every dial: no dial read here
  const [device] = await tx
    .select({ id: endpointDevices.id })
    .from(endpointDevices)
    .where(and(eq(endpointDevices.id, deviceId), isNull(endpointDevices.revokedAt)))
    .for("update")
    .limit(1);
  if (!device) return { ok: false, code: "device_not_found" };
  const inserted = await tx
    .insert(endpointDeviceQuarantines)
    .values({ deviceId, incidentId: args.incidentId, expiresAt: sql`now() + make_interval(hours => ${quarantineHoursOf(args.hours)})` })
    .onConflictDoNothing()
    .returning({ id: endpointDeviceQuarantines.id, expiresAt: endpointDeviceQuarantines.expiresAt });
  if (inserted[0]) return { ok: true, quarantineId: inserted[0].id, deviceId, expiresAt: inserted[0].expiresAt.toISOString(), existing: false };
  const active = await activeQuarantineForDevice(tx, deviceId);
  // the device row is locked, so a conflict with no active row means this incident already opened one: report it
  const [own] = active
    ? [active]
    : await tx
        .select({ id: endpointDeviceQuarantines.id, expiresAt: endpointDeviceQuarantines.expiresAt })
        .from(endpointDeviceQuarantines)
        .where(eq(endpointDeviceQuarantines.incidentId, args.incidentId))
        .limit(1);
  if (!own) throw new Error("quarantine insert conflicted with no row to report");
  return { ok: true, quarantineId: own.id, deviceId, expiresAt: own.expiresAt.toISOString(), existing: true };
}

/** the device's active quarantine, if any: the read device-side enforcement uses */
export async function activeQuarantineForDevice(db: Pick<Db, "select">, deviceId: string): Promise<{ id: string; expiresAt: Date } | null> {
  const [row] = await db
    .select({ id: endpointDeviceQuarantines.id, expiresAt: endpointDeviceQuarantines.expiresAt })
    .from(endpointDeviceQuarantines)
    .where(and(eq(endpointDeviceQuarantines.deviceId, deviceId), eq(endpointDeviceQuarantines.status, "active")))
    .limit(1);
  return row ?? null;
}

/**
 * End quarantines past their end time, at most EXPIRE_BATCH per pass. Widening, so nothing expires unless the dial is
 * `normal`; the caller learns how many ended and whether the dial held them.
 */
export async function expireQuarantines(db: Db, actorUserId: string): Promise<{ expired: number; heldByDial: boolean }> {
  const dial = (await loadExecutionMode(db)) as KillSwitchDial;
  if (killSwitchNarrowingOnly({ dial, direction: "widening" }) !== null) return { expired: 0, heldByDial: true };
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const due = tx
      .select({ id: endpointDeviceQuarantines.id })
      .from(endpointDeviceQuarantines)
      .where(and(eq(endpointDeviceQuarantines.status, "active"), lte(endpointDeviceQuarantines.expiresAt, sql`now()`)))
      .orderBy(endpointDeviceQuarantines.expiresAt)
      .limit(EXPIRE_BATCH)
      .for("update", { skipLocked: true });
    const ended = await tx
      .update(endpointDeviceQuarantines)
      .set({ status: "expired", endedAt: sql`now()` })
      .where(and(sql`${endpointDeviceQuarantines.id} IN (${due})`, whereFrom(endpointDeviceQuarantines.status, ENDPOINT_DEVICE_QUARANTINE_MACHINE, "expire")))
      .returning({ id: endpointDeviceQuarantines.id, deviceId: endpointDeviceQuarantines.deviceId, incidentId: endpointDeviceQuarantines.incidentId });
    if (ended.length > 0) {
      await tx.insert(auditLog).values(
        ended.map((q) => ({
          userId: actorUserId,
          objectType: "endpoint_device" as const,
          objectId: q.deviceId,
          detail: { subsystem: "agent-detection", adr: "0333", quarantineId: q.id, incidentId: q.incidentId, transition: "expire" },
          effect: "allow" as const,
          ruleId: QUARANTINE_RULE_IDS.expired,
          ruleChain: [],
          reason: "A device quarantine reached its end time and ended (ADR-0333 §6)",
        })),
      );
    }
    return { expired: ended.length, heldByDial: false };
  });
}

export type ReleaseOutcome = { ok: true; deviceId: string } | { ok: false; code: "quarantine_not_found" | "quarantine_not_active" | "execution_dial_not_normal"; detail: string };

/** Release one quarantine (the route has already checked the admin and spent the step-up). */
export async function releaseQuarantine(db: Db, args: { quarantineId: string; actorUserId: string; stepUp: string }): Promise<ReleaseOutcome> {
  const dial = (await loadExecutionMode(db)) as KillSwitchDial;
  const held = killSwitchNarrowingOnly({ dial, direction: "widening" });
  if (held !== null) return { ok: false, code: "execution_dial_not_normal", detail: held };
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const moved = await tx
      .update(endpointDeviceQuarantines)
      .set({ status: "released", endedAt: sql`now()`, releasedBy: args.actorUserId, releaseStepUp: args.stepUp })
      .where(and(eq(endpointDeviceQuarantines.id, args.quarantineId), whereFrom(endpointDeviceQuarantines.status, ENDPOINT_DEVICE_QUARANTINE_MACHINE, "release")))
      .returning({ deviceId: endpointDeviceQuarantines.deviceId, incidentId: endpointDeviceQuarantines.incidentId });
    const q = moved[0];
    if (!q) {
      const [exists] = await tx.select({ status: endpointDeviceQuarantines.status }).from(endpointDeviceQuarantines).where(eq(endpointDeviceQuarantines.id, args.quarantineId)).limit(1);
      return exists
        ? { ok: false as const, code: "quarantine_not_active" as const, detail: ENDPOINT_DEVICE_QUARANTINE_MACHINE.describe(exists.status).transitions.find((v) => v.event === "release")?.reason ?? `the quarantine is ${exists.status}` }
        : { ok: false as const, code: "quarantine_not_found" as const, detail: "no such quarantine" };
    }
    await tx.insert(auditLog).values({
      userId: args.actorUserId,
      objectType: "endpoint_device",
      objectId: q.deviceId,
      detail: { subsystem: "agent-detection", adr: "0333", quarantineId: args.quarantineId, incidentId: q.incidentId, transition: "release", stepUp: args.stepUp },
      effect: "allow",
      ruleId: QUARANTINE_RULE_IDS.released,
      ruleChain: [],
      reason: "An admin released a device quarantine after a step-up (ADR-0333 §6)",
    });
    return { ok: true as const, deviceId: q.deviceId };
  });
}
