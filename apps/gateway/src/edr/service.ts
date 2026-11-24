/**
 * ADR-0360 §6 — the EDR service: signal sync, verified webhook ingest, and the system half of the isolation lifecycle
 * (submit to the vendor, poll its action status). Routes are in `routes.ts`; adapters in `adapters.ts`.
 *
 *  - Every vendor call goes through `guardConnectionCall` (surface `edr_connection`): the base URL is egress-checked and
 *    audited, and the returned guarded fetch re-checks every request (DNS pinned, SSRF blocked, no redirects). The MDE
 *    sign-in host must be on the egress allow-list too, or the token request is refused.
 *  - The credential is opened from the sealed row (`decryptSecret`) only for the call and goes nowhere else.
 *  - An EDR device is matched to an enrolled endpoint device of the same source by the device pseudonym (the EDR host
 *    name keyed-hashed with the discovery data key, `derivePseudonym`); the host name itself is never stored.
 *  - A device whose risk rises to high or critical writes an `edr-device-risk-raised` audit row, the signal the
 *    detection engine (lane E15) and the SIEM export read from the audit stream.
 */
import { and, auditLog, desc, edrConnections, edrDeviceSignals, edrIsolationRequests, edrWebhookDeliveries, endpointDevices, eq, inArray, isNull, lt, sql, type Db, type EdrConnectionRow, type EdrIsolationRequestRow } from "@regulait/db";
import { ConnectionEgressBlockedError, guardConnectionCall, type ConnectionEgressDeps } from "../connection-egress.js";
import { derivePseudonym } from "../discovery-worker.js";
import { decryptSecret } from "../secrets.js";
import { whereFrom } from "../state-transition.js";
import { EDR_ADAPTERS, EDR_RISK_LEVELS, EdrError, deviceRisk, type EdrCredential, type EdrRisk, type EdrSeverity, type EdrWebhookEvent } from "./adapters.js";
import { ISOLATION_MACHINE, type IsolationEvent } from "./lifecycle.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** alerts are counted over this window on every sync (the vendor keeps them; we keep counts) */
export const EDR_ALERT_WINDOW_DAYS = 7;
/** the replay table keeps a delivery this long: well past the 5-minute freshness window */
export const EDR_REPLAY_RETENTION_HOURS = 24;
/** an action the vendor has not settled after this long fails (fail / fail_release), so no request waits for ever */
export const EDR_ACTION_SETTLE_MINUTES = 30;
/** a submitting or releasing request with no vendor action id after this long was stranded mid-call (a restart) */
export const EDR_STRANDED_MINUTES = 10;
/** a request or release request nobody decided within this long expires (strict compiled default, ADR-0180) */
export const EDR_DECISION_TTL_HOURS = 24;

export interface EdrDeps {
  dataKey: string;
  egress?: ConnectionEgressDeps;
  now?: () => Date;
}

async function audit(db: Db, sourceId: string, ruleId: string, reason: string, detail: Record<string, unknown>, effect: "allow" | "deny" = "allow", userId: string = NIL_UUID) {
  await db.insert(auditLog).values({ userId, objectType: "discovery_source", objectId: sourceId, detail: { subsystem: "edr", adr: "0360", ...detail }, effect, ruleId, ruleChain: [], reason });
}

/** the credential of a connection, opened from its sealed row for one call */
export function credentialOf(conn: EdrConnectionRow, dataKey: string): EdrCredential {
  return { baseUrl: conn.baseUrl, tenantId: conn.tenantId, clientId: conn.clientId, secret: decryptSecret(dataKey, conn.secretCiphertext) };
}

async function guarded(db: Db, conn: EdrConnectionRow, deps: EdrDeps): Promise<typeof fetch> {
  const { fetchImpl } = await guardConnectionCall(db, {
    surface: "edr_connection",
    baseUrl: conn.baseUrl,
    objectId: conn.id,
    label: `EDR connection '${conn.name}'`,
    detail: { vendor: conn.vendor },
    ...(deps.egress ? { deps: deps.egress } : {}),
  });
  return fetchImpl;
}

const codeOf = (err: unknown): string => (err instanceof EdrError ? err.code : err instanceof ConnectionEgressBlockedError ? "egress_blocked" : "vendor_error");
const rank = (r: EdrRisk) => EDR_RISK_LEVELS.indexOf(r);

/**
 * Pull one connection's devices and open alerts, map them onto the source's enrolled devices and replace their
 * signals. Read-only at the vendor. Never throws: the outcome code is stored on the connection and audited on failure.
 */
export async function syncEdrConnection(db: Db, conn: EdrConnectionRow, deps: EdrDeps): Promise<{ code: string; devices: number; matched: number }> {
  const adapter = EDR_ADAPTERS[conn.vendor];
  const now = deps.now?.() ?? new Date();
  try {
    const f = await guarded(db, conn, deps);
    const cred = credentialOf(conn, deps.dataKey);
    const devices = await adapter.listDevices(f, cred);
    const alerts = await adapter.listAlerts(f, cred, new Date(now.getTime() - EDR_ALERT_WINDOW_DAYS * 86_400_000));
    const byVendor = new Map<string, EdrSeverity[]>();
    for (const a of alerts) byVendor.set(a.vendorDeviceId, [...(byVendor.get(a.vendorDeviceId) ?? []), a.severity]);
    // the source's live devices by pseudonym
    const pseudonyms = new Map<string, (typeof devices)[number]>();
    for (const d of devices) pseudonyms.set((await derivePseudonym(db, deps.dataKey, "device", d.hostname)).pseudonym, d);
    const enrolled = pseudonyms.size
      ? await db
          .select({ id: endpointDevices.id, pseudonym: endpointDevices.devicePseudonym })
          .from(endpointDevices)
          .where(and(eq(endpointDevices.sourceId, conn.sourceId), isNull(endpointDevices.revokedAt), inArray(endpointDevices.devicePseudonym, [...pseudonyms.keys()])))
      : [];
    let matched = 0;
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const prior = new Map(
        (await tx.select({ deviceId: edrDeviceSignals.deviceId, risk: edrDeviceSignals.risk }).from(edrDeviceSignals).where(eq(edrDeviceSignals.connectionId, conn.id))).map((r) => [r.deviceId, r.risk as EdrRisk]),
      );
      for (const e of enrolled) {
        const d = pseudonyms.get(e.pseudonym)!;
        const sev = byVendor.get(d.vendorDeviceId) ?? [];
        const risk = deviceRisk(d.risk, sev);
        const values = {
          vendorDeviceId: d.vendorDeviceId,
          risk,
          alertsLow: sev.filter((s) => s === "low").length,
          alertsMedium: sev.filter((s) => s === "medium").length,
          alertsHigh: sev.filter((s) => s === "high").length,
          alertsCritical: sev.filter((s) => s === "critical").length,
          isolatedAtVendor: d.isolated,
          observedAt: sql`now()`,
        };
        // a vendor id moved to another enrolled device (re-imaged host): the old row gives way
        await tx.delete(edrDeviceSignals).where(and(eq(edrDeviceSignals.connectionId, conn.id), eq(edrDeviceSignals.vendorDeviceId, d.vendorDeviceId), sql`${edrDeviceSignals.deviceId} <> ${e.id}`));
        await tx.insert(edrDeviceSignals).values({ connectionId: conn.id, deviceId: e.id, ...values }).onConflictDoUpdate({ target: [edrDeviceSignals.connectionId, edrDeviceSignals.deviceId], set: values });
        matched++;
        if (d.isolationKnown !== false) await reconcileWithVendor(tx, conn, e.id, d.isolated);
        const before = prior.get(e.id) ?? "none";
        if (rank(risk) >= rank("high") && rank(risk) > rank(before)) {
          await audit(tx, conn.sourceId, "edr-device-risk-raised", `EDR '${conn.name}' rates an enrolled device ${risk} (was ${before}) (ADR-0360)`, { connectionId: conn.id, vendor: conn.vendor, deviceId: e.id, risk, previous: before }, "deny");
        }
      }
      await tx.update(edrConnections).set({ lastSyncAt: sql`now()`, lastSyncCode: "ok" }).where(eq(edrConnections.id, conn.id));
    });
    return { code: "ok", devices: devices.length, matched };
  } catch (err) {
    const code = codeOf(err);
    await db.update(edrConnections).set({ lastSyncAt: sql`now()`, lastSyncCode: code }).where(eq(edrConnections.id, conn.id));
    await audit(db, conn.sourceId, "edr-sync-failed", `EDR '${conn.name}' sync failed: ${code} (ADR-0360)`, { connectionId: conn.id, vendor: conn.vendor, code }, "deny");
    return { code, devices: 0, matched: 0 };
  }
}

/**
 * A verified webhook event: recorded once (the replay table), then folded into the device's signal when the device is
 * already known for this connection. Returns `duplicate` for a replay.
 */
export async function ingestEdrWebhook(db: Db, conn: EdrConnectionRow, ev: EdrWebhookEvent): Promise<"accepted" | "duplicate"> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const fresh = await tx.insert(edrWebhookDeliveries).values({ connectionId: conn.id, eventId: ev.eventId }).onConflictDoNothing().returning({ id: edrWebhookDeliveries.id });
    if (fresh.length === 0) return "duplicate";
    if (ev.vendorDeviceId && ev.severity) {
      const [sig] = await tx.select().from(edrDeviceSignals).where(and(eq(edrDeviceSignals.connectionId, conn.id), eq(edrDeviceSignals.vendorDeviceId, ev.vendorDeviceId)));
      if (sig) {
        const col = { low: "alertsLow", medium: "alertsMedium", high: "alertsHigh", critical: "alertsCritical" } as const;
        const risk = deviceRisk(sig.risk as EdrRisk, [ev.severity]);
        await tx
          .update(edrDeviceSignals)
          .set({ [col[ev.severity]]: sig[col[ev.severity]] + 1, risk, observedAt: sql`now()` })
          .where(and(eq(edrDeviceSignals.connectionId, conn.id), eq(edrDeviceSignals.deviceId, sig.deviceId)));
        if (rank(risk) >= rank("high") && rank(risk) > rank(sig.risk as EdrRisk)) {
          await audit(tx, conn.sourceId, "edr-device-risk-raised", `EDR '${conn.name}' alert raised an enrolled device to ${risk} (ADR-0360)`, { connectionId: conn.id, vendor: conn.vendor, deviceId: sig.deviceId, risk, previous: sig.risk, via: "webhook" }, "deny");
        }
      }
    }
    return "accepted";
  });
}

/** a guarded lifecycle write: only from the event's declared source states; false when the row moved underneath */
export async function moveIsolation(db: Db, id: string, event: IsolationEvent, set: Partial<typeof edrIsolationRequests.$inferInsert> = {}): Promise<EdrIsolationRequestRow | null> {
  const [row] = await db
    .update(edrIsolationRequests)
    .set({ ...set, state: ISOLATION_MACHINE.def.transitions[event].to, updatedAt: sql`now()` })
    .where(and(eq(edrIsolationRequests.id, id), whereFrom(edrIsolationRequests.state, ISOLATION_MACHINE, event)))
    .returning();
  return row ?? null;
}

/** a guarded lifecycle write and its audit row, in one transaction; null when the row moved underneath */
export async function moveIsolationAudited(
  db: Db,
  conn: EdrConnectionRow,
  req: EdrIsolationRequestRow,
  event: IsolationEvent,
  set: Partial<typeof edrIsolationRequests.$inferInsert>,
  entry: { ruleId: string; reason: string; detail?: Record<string, unknown>; effect?: "allow" | "deny"; userId?: string },
): Promise<EdrIsolationRequestRow | null> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const moved = await moveIsolation(tx, req.id, event, set);
    if (!moved) return null;
    await audit(tx, conn.sourceId, entry.ruleId, entry.reason, { connectionId: conn.id, requestId: req.id, deviceId: req.deviceId, event, from: req.state, to: moved.state, ...entry.detail }, entry.effect ?? "allow", entry.userId);
    return moved;
  });
}

/** ask the vendor to isolate or release, after the approval moved the request to submitting or releasing */
export async function submitIsolation(db: Db, conn: EdrConnectionRow, req: EdrIsolationRequestRow, kind: "isolate" | "release", deps: EdrDeps): Promise<EdrIsolationRequestRow> {
  const adapter = EDR_ADAPTERS[conn.vendor];
  const comment = `RegulAIt ${kind} request ${req.id}`;
  try {
    const f = await guarded(db, conn, deps);
    const cred = credentialOf(conn, deps.dataKey);
    const action = kind === "isolate" ? await adapter.requestIsolation(f, cred, req.vendorDeviceId, comment) : await adapter.releaseIsolation(f, cred, req.vendorDeviceId, comment);
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [r] = await tx.update(edrIsolationRequests).set({ vendorActionId: action.actionId, updatedAt: sql`now()` }).where(eq(edrIsolationRequests.id, req.id)).returning();
      await audit(tx, conn.sourceId, `edr-${kind}-submitted`, `EDR '${conn.name}' asked to ${kind} a device (ADR-0360)`, { connectionId: conn.id, requestId: req.id, deviceId: req.deviceId, vendor: conn.vendor }, kind === "isolate" ? "deny" : "allow");
      return r!;
    });
    return action.status === "succeeded" ? ((await settleIsolation(db, conn, row, kind, "succeeded")) ?? row) : row;
  } catch (err) {
    const code = codeOf(err);
    const moved = await moveIsolationAudited(db, conn, req, kind === "isolate" ? "fail" : "fail_release", { errorCode: code }, { ruleId: `edr-${kind}-failed`, reason: `EDR '${conn.name}' could not ${kind} a device: ${code} (ADR-0360)`, detail: { code }, effect: "deny" });
    return moved ?? req;
  }
}

async function settleIsolation(db: Db, conn: EdrConnectionRow, req: EdrIsolationRequestRow, kind: "isolate" | "release", status: "succeeded" | "failed", errorCode = "vendor_failed") {
  const event: IsolationEvent = kind === "isolate" ? (status === "succeeded" ? "confirm" : "fail") : status === "succeeded" ? "confirm_release" : "fail_release";
  return moveIsolationAudited(db, conn, req, event, status === "failed" ? { errorCode } : {}, {
    ruleId: `edr-${kind}-${status}`,
    reason: `EDR '${conn.name}': ${kind} ${status}${status === "failed" ? ` (${errorCode})` : ""} (ADR-0360)`,
    ...(status === "failed" ? { detail: { code: errorCode } } : {}),
    effect: kind === "isolate" && status === "succeeded" ? "deny" : "allow",
  });
}

/**
 * The vendor's real isolation state, from a sync, against ours (R2 #3). A failed request whose device the vendor did
 * isolate (a timeout, a restart, MDE's "already in progress") moves to isolated, so its release is governed again; an
 * isolated request whose device the vendor no longer isolates (released in the vendor console) moves to released and is
 * audited as outside governance. Requests in flight (submitting, releasing) are left to the action poller.
 */
export async function reconcileWithVendor(db: Db, conn: EdrConnectionRow, deviceId: string, isolatedAtVendor: boolean): Promise<void> {
  const fromState = isolatedAtVendor ? "failed" : "isolated";
  const [r] = await db
    .select()
    .from(edrIsolationRequests)
    .where(and(eq(edrIsolationRequests.connectionId, conn.id), eq(edrIsolationRequests.deviceId, deviceId), eq(edrIsolationRequests.state, fromState)))
    .orderBy(desc(edrIsolationRequests.updatedAt))
    .limit(1);
  if (!r) return;
  if (isolatedAtVendor) {
    try {
      await db.transaction(async (rawSp) => {
        const sp = rawSp as unknown as Db;
        await moveIsolationAudited(sp, conn, r, "vendor_isolated", {}, { ruleId: "edr-isolate-reconciled", reason: `EDR '${conn.name}' reports a device isolated after its request failed; the request is isolated again and its release is governed (ADR-0360)`, effect: "deny" });
      });
    } catch (e) {
      // a newer open request for the device already holds its slot and governs it
      if ((e as { code?: string }).code !== "23505") throw e;
    }
    return;
  }
  await moveIsolationAudited(db, conn, r, "vendor_released", {}, { ruleId: "edr-release-outside-governance", reason: `EDR '${conn.name}' reports an isolated device released outside RegulAIt (ADR-0360)`, effect: "deny" });
}

/**
 * The scheduler's half, every minute:
 *  - a request or release request nobody decided within EDR_DECISION_TTL_HOURS expires (R2 #4);
 *  - a submitting or releasing request with no vendor action id after EDR_STRANDED_MINUTES was stranded mid-call and
 *    fails (`stranded`), so it never holds the device's slot for good (R2 #2);
 *  - every other submitting or releasing request's vendor action is polled and settled; one still pending after
 *    EDR_ACTION_SETTLE_MINUTES fails (`vendor_timeout`) (R2 #3). A failed isolation the vendor did carry out is
 *    reconciled by the next sync (`vendor_isolated`).
 */
export async function pollEdrIsolations(db: Db, deps: EdrDeps): Promise<number> {
  let settled = 0;
  const expiring = await db
    .select({ r: edrIsolationRequests, c: edrConnections })
    .from(edrIsolationRequests)
    .innerJoin(edrConnections, eq(edrConnections.id, edrIsolationRequests.connectionId))
    .where(and(inArray(edrIsolationRequests.state, ["requested", "release_requested"]), lt(edrIsolationRequests.updatedAt, sql`now() - make_interval(hours => ${EDR_DECISION_TTL_HOURS})`)))
    .limit(100);
  for (const { r, c } of expiring) {
    const event: IsolationEvent = r.state === "requested" ? "expire" : "expire_release";
    if (await moveIsolationAudited(db, c, r, event, { errorCode: "expired" }, { ruleId: `edr-isolation-${event.replace("_", "-")}`, reason: `EDR isolation ${r.state === "requested" ? "request" : "release request"} expired undecided after ${EDR_DECISION_TTL_HOURS} hours (ADR-0360)` })) settled++;
  }
  const open = await db
    .select({
      r: edrIsolationRequests,
      c: edrConnections,
      stranded: sql<boolean>`${edrIsolationRequests.updatedAt} < now() - make_interval(mins => ${EDR_STRANDED_MINUTES})`,
      overdue: sql<boolean>`${edrIsolationRequests.updatedAt} < now() - make_interval(mins => ${EDR_ACTION_SETTLE_MINUTES})`,
    })
    .from(edrIsolationRequests)
    .innerJoin(edrConnections, eq(edrConnections.id, edrIsolationRequests.connectionId))
    .where(inArray(edrIsolationRequests.state, ["submitting", "releasing"]))
    .limit(100);
  for (const { r, c, stranded, overdue } of open) {
    const kind = r.state === "submitting" ? "isolate" : "release";
    if (!r.vendorActionId) {
      if (stranded && (await settleIsolation(db, c, r, kind, "failed", "stranded"))) settled++;
      continue;
    }
    try {
      const f = await guarded(db, c, deps);
      const st = await EDR_ADAPTERS[c.vendor].actionStatus(f, credentialOf(c, deps.dataKey), { actionId: r.vendorActionId, vendorDeviceId: r.vendorDeviceId, kind });
      if (st.status === "pending" ? overdue && (await settleIsolation(db, c, r, kind, "failed", "vendor_timeout")) : await settleIsolation(db, c, r, kind, st.status)) settled++;
    } catch {
      // a failed poll changes nothing until the action is overdue; then it fails, so an unreachable vendor holds no slot
      if (overdue && (await settleIsolation(db, c, r, kind, "failed", "vendor_timeout"))) settled++;
    }
  }
  return settled;
}

export async function pruneEdrDeliveries(db: Db): Promise<number> {
  const gone = await db.delete(edrWebhookDeliveries).where(lt(edrWebhookDeliveries.receivedAt, sql`now() - make_interval(hours => ${EDR_REPLAY_RETENTION_HOURS})`)).returning({ id: edrWebhookDeliveries.id });
  return gone.length;
}
