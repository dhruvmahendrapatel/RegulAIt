import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectLockConfigurationCommand } from "@aws-sdk/client-s3";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { snapshotOrgSettingsForTest } from "./testing/strict-data-posture.js";
import { S3ObjectLockSink, type S3SendClient } from "./audit-chain.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the preset is measured from a relaxed (pre-hardening) posture; the strict defaults are restored after
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * AER-012 — THE POSTURE READ ASKS THE BUCKET, THROUGH THE LONG-LIVED SINK.
 *
 * `GET /v1/org/posture` built a fresh `S3ObjectLockSink` per request and read
 * its synchronous `tamperResistant` getter, which reports `false` until
 * `observe()` has run — and nothing ever ran it. So the anchor control graded
 * `false` whatever the bucket enforced, and a COMPLIANCE-mode deployment could
 * never read as hardened. The read is now async on the sink `buildApp` holds
 * for the audit-chain routes, and awaits `observe()`.
 *
 * Four buckets, same fake transport the audit-chain tests use (real SDK
 * command objects, only `send` faked): COMPLIANCE is the one that grades true;
 * GOVERNANCE, no Object Lock, and an endpoint that errors all grade false and
 * each says WHY in `lockMode`. The probe counter proves the sink is the
 * long-lived one — a cached observation is reused across requests — and the
 * `null` sink is the negative control.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `aer012-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

class FakeS3 implements S3SendClient {
  probes = 0;
  constructor(private readonly opts: { lock?: Record<string, unknown>; lockError?: Error }) {}
  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetObjectLockConfigurationCommand) {
      this.probes++;
      if (this.opts.lockError) throw this.opts.lockError;
      return { ObjectLockConfiguration: this.opts.lock };
    }
    throw new Error(`posture must never send ${(command as { constructor?: { name?: string } })?.constructor?.name}`);
  }
}
const S3_CONFIG = {
  bucket: "anchors", prefix: "audit-anchors", region: "us-east-1", endpoint: "http://minio:9000",
  forcePathStyle: true, retentionDays: 365, credentials: { accessKeyId: "k", secretAccessKey: "s" },
};
const lockConfig = (mode?: "COMPLIANCE" | "GOVERNANCE") => ({
  ObjectLockEnabled: "Enabled",
  ...(mode ? { Rule: { DefaultRetention: { Mode: mode, Days: 365 } } } : {}),
});

type Mode = "compliance" | "governance" | "absent" | "error" | "off";
const MODES: ReadonlyArray<{ mode: Mode; tamperResistant: boolean; lockMode: string; destination: string }> = [
  { mode: "compliance", tamperResistant: true, lockMode: "compliance", destination: "s3_object_lock" },
  { mode: "governance", tamperResistant: false, lockMode: "governance", destination: "s3_object_lock" },
  { mode: "absent", tamperResistant: false, lockMode: "object_lock_absent", destination: "s3_object_lock" },
  { mode: "error", tamperResistant: false, lockMode: "unobserved", destination: "s3_object_lock" },
  { mode: "off", tamperResistant: false, lockMode: "off", destination: "off" },
];

let db: Db;
const apps = new Map<Mode, { app: ReturnType<typeof buildApp>; fake: FakeS3 | null }>();

function fakeFor(mode: Mode): FakeS3 | null {
  switch (mode) {
    case "compliance": return new FakeS3({ lock: lockConfig("COMPLIANCE") });
    case "governance": return new FakeS3({ lock: lockConfig("GOVERNANCE") });
    case "absent": return new FakeS3({ lock: undefined });
    case "error": return new FakeS3({ lockError: new Error("AccessDenied") });
    case "off": return null;
  }
}

const anchorOf = (body: { controls: Array<{ key: string; current: Record<string, unknown>; satisfied: boolean; settable: boolean }> }) =>
  body.controls.find((c) => c.key === "auditAnchorTamperResistant")!;

async function restoreShippedDefaults(app: ReturnType<typeof buildApp>) {
  const r = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: {
    defaultPiiMode: "none", mcpAdmissionMode: "enforce", useCaseGateMode: "off",
    dispatchAttributionRequired: false, semanticCachePolicy: "opt_in",
  } });
  expect(r.statusCode).toBe(200);
  const m = await app.inject({ method: "POST", url: "/v1/mrm/enforcement", headers: AUTH, payload: { enforced: false } });
  expect(m.statusCode).toBe(200);
}

let restoreSb1Posture: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { useCaseGateMode: "off", dispatchAttributionRequired: false, mrmEnforced: false });
  // ADR-0181: this file hardens FROM a fixed lax starting posture, which its
  // helper writes; the strict values SB1 owns are recorded here and put back
  // LAST in afterAll, so the shared database is handed on as it was found.
  restoreSb1Posture = await snapshotOrgSettingsForTest(db, ["defaultPiiMode", "semanticCachePolicy"]);
  for (const { mode } of MODES) {
    const fake = fakeFor(mode);
    const sink = fake ? new S3ObjectLockSink(S3_CONFIG, fake) : null;
    apps.set(mode, { app: buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64), auditAnchorSink: sink }), fake });
  }
});

afterAll(async () => {
  await restoreSb2Gates();
  await restoreSb1Posture?.();
  for (const { app } of apps.values()) await app.close();
});

describe("GET /v1/org/posture grades the anchor from what the bucket answered", () => {
  it.each(MODES)("$mode bucket: tamperResistant=$tamperResistant, lockMode=$lockMode", async ({ mode, tamperResistant, lockMode, destination }) => {
    const { app } = apps.get(mode)!;
    const res = await app.inject({ method: "GET", url: "/v1/org/posture", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const anchor = anchorOf(res.json());
    expect(anchor.settable).toBe(false);
    expect(anchor.current.destination).toBe(destination);
    expect(anchor.current.tamperResistant).toBe(tamperResistant);
    expect(anchor.current.lockMode).toBe(lockMode);
    expect(anchor.satisfied).toBe(tamperResistant);
    const blocked = res.json().summary.blockedByEnvironment as string[];
    if (tamperResistant) expect(blocked).not.toContain("auditAnchorTamperResistant");
    else expect(blocked).toContain("auditAnchorTamperResistant");
    // the medium's own words ride along for anything that was observed
    if (mode !== "off") expect(typeof anchor.current.disclosure).toBe("string");
  });

  it("the sink is LONG-LIVED: a second read reuses the cached observation instead of probing again", async () => {
    const { app, fake } = apps.get("compliance")!;
    const before = fake!.probes;
    await app.inject({ method: "GET", url: "/v1/org/posture", headers: AUTH });
    await app.inject({ method: "GET", url: "/v1/org/posture", headers: AUTH });
    // at most ONE probe for both reads (zero if an earlier case already filled
    // the cache) — a fresh sink per request would have probed twice
    expect(fake!.probes - before).toBeLessThanOrEqual(1);
  });

  it("a FAILED probe is never cached: every read asks again, so a boot-time race cannot freeze a false", async () => {
    const { app, fake } = apps.get("error")!;
    const before = fake!.probes;
    await app.inject({ method: "GET", url: "/v1/org/posture", headers: AUTH });
    await app.inject({ method: "GET", url: "/v1/org/posture", headers: AUTH });
    expect(fake!.probes - before).toBe(2);
  });
});

describe("POST /v1/org/posture/harden reports the posture AFTER the write from the same observed sink", () => {
  it("COMPLIANCE: the anchor is satisfied and absent from blockedByEnvironment / notSettable", async () => {
    const { app } = apps.get("compliance")!;
    await restoreShippedDefaults(app);
    try {
      const res = await app.inject({ method: "POST", url: "/v1/org/posture/harden", headers: AUTH, payload: {} });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body.applied).length).toBeGreaterThan(0);
      expect(anchorOf(body.posture).current.tamperResistant).toBe(true);
      expect(body.posture.summary.blockedByEnvironment).not.toContain("auditAnchorTamperResistant");
      expect(body.notSettable.map((n: { key: string }) => n.key)).not.toContain("auditAnchorTamperResistant");
    } finally { await restoreShippedDefaults(app); }
  });

  it("GOVERNANCE: the anchor stays unsatisfied, named as not settable, with the governance reason", async () => {
    const { app } = apps.get("governance")!;
    await restoreShippedDefaults(app);
    try {
      const res = await app.inject({ method: "POST", url: "/v1/org/posture/harden", headers: AUTH, payload: {} });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const anchor = anchorOf(body.posture);
      expect(anchor.current.tamperResistant).toBe(false);
      expect(anchor.current.lockMode).toBe("governance");
      expect(body.posture.summary.blockedByEnvironment).toContain("auditAnchorTamperResistant");
      expect(body.notSettable.map((n: { key: string }) => n.key)).toContain("auditAnchorTamperResistant");
    } finally { await restoreShippedDefaults(app); }
  });
});

describe("NEGATIVE CONTROL", () => {
  it("anchoring OFF (null sink) reads as off and never hardened, and no bucket was asked", async () => {
    const { app, fake } = apps.get("off")!;
    expect(fake).toBeNull();
    const res = await app.inject({ method: "GET", url: "/v1/org/posture", headers: AUTH });
    const anchor = anchorOf(res.json());
    expect(anchor.current).toMatchObject({ destination: "off", tamperResistant: false, lockMode: "off" });
    expect(anchor.satisfied).toBe(false);
    expect(res.json().hardened).toBe(false);
  });
});
