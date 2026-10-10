/**
 * ADR-0186 (batch 4) — the FOUNDATION, pinned on a real database through the
 * real app:
 *  - SECURE BY DEFAULT: a freshly migrated org reads every batch-4 setting
 *    strict (column defaults and stored row); each relaxation through
 *    PUT /v1/org/settings round-trips and is audited with `detail.transitions`
 *    and named under `detail.relaxed`; a stricter change is audited but not
 *    "relaxed"; out of range is a 400 and the database holds the same bounds.
 *  - `GET /v1/org/posture` reports the token-free `metrics` block (§4.9, X18).
 *  - MIGRATION 0170's rules: `approval_decisions` and `decision_receipts` are
 *    append-only (UPDATE and DELETE refused; a parent's deletion only sets the
 *    reference null), receipt keys are public-only and never deleted, the
 *    ceremony and grant windows, the SSO freshness rule, and the snapshot
 *    defaults on approvals.
 *  - `consumeWebauthnChallenge`: single use, expiry by the database clock,
 *    scoped to user + session + purpose, one winner under concurrency.
 *  - THE SEAMS: every §4.9 route answers 501 `not_built` under its auth class,
 *    the two sweeps are registered and process nothing, the anchor timestamper
 *    runs after each flush and cannot change its outcome, and the four
 *    detection monitor rules are evaluated (no breach) rather than skipped.
 *
 * Global state (M-068): every setting relaxed here is restored to strict in a
 * `finally`/`afterAll`, env vars are restored, the rows created are removed,
 * and the append-only evidence rows (which nothing may delete) are written
 * only inside transactions that are rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  and,
  approvalDecisions,
  approvals,
  auditAnchors,
  auditLog,
  authSessions,
  createDb,
  decisionReceipts,
  desc,
  eq,
  inArray,
  receiptSigningKeys,
  runMigrations,
  sql,
  users as usersTable,
  webauthnChallenges,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import {
  BATCH4_SETTING_COLUMNS,
  BATCH4_STRICT_DEFAULTS,
  DETECTION_MONITOR_RULE_IDS,
  RECEIPT_GENESIS_PREV,
  type Batch4SettingKey,
} from "@regulait/shared";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { buildApp } from "./app.js";
import { consumeWebauthnChallenge } from "./step-up.js";
import { captureAnchor, flushPendingAnchors, type AnchorTimestamper } from "./audit-chain.js";
import { relaxedSettingKeys } from "./org-settings.js";
import { schedulerJobRegistry } from "./scheduler-jobs.js";
import { runGovernanceMonitor } from "./governance-monitor.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a186-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "member", { id: string; auth: { authorization: string } }>;
const created = { users: [] as string[], sessions: [] as string[], approvals: [] as string[], anchors: [] as string[] };

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** one relaxed value per setting (each within its bounds) */
const RELAXED: { [K in Batch4SettingKey]: unknown } = {
  approvalSignatureMode: "off",
  stepUpMode: "off",
  stepUpMaxAgeSeconds: 900,
  stepUpActions: ["approval_decide"],
  toolApprovalSensitiveQuorum: 1,
  decisionReceiptsMode: "off",
  auditAnchorTimestampMode: "off",
  vendoredDetectionPacks: ["pipelock-secrets"],
  monitorMcpBaselineDays: 90,
  monitorJailbreakThreshold: 100,
  monitorJailbreakWindowHours: 1,
};

const STRICT_SQL = sql`UPDATE org_settings SET approval_signature_mode = 'passkey', step_up_mode = 'required',
  step_up_max_age_seconds = 120,
  step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage"]'::jsonb,
  tool_approval_sensitive_quorum = 2, decision_receipts_mode = 'on', audit_anchor_timestamp_mode = 'required',
  vendored_detection_packs = '["pipelock-secrets", "pipelock-normalise", "nemo-yara-injection", "agt-mcp-heuristics"]'::jsonb,
  monitor_mcp_baseline_days = 14, monitor_jailbreak_threshold = 3, monitor_jailbreak_window_hours = 24`;

function refusalText(e: unknown): string {
  return `${String((e as Error)?.message ?? e)} ${String((e as { cause?: Error })?.cause?.message ?? "")}`;
}
async function expectRefused(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const e = await Promise.resolve(p).then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, "the statement was refused").not.toBeNull();
  expect(refusalText(e)).toMatch(pattern);
}
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;

/** M-068: evidence rows cannot be deleted (that is the point), so the checks
 * that write them run inside a transaction that is always rolled back; each
 * refused statement runs in its own savepoint (a nested transaction). */
class RolledBack extends Error {}
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await body(tx);
      throw new RolledBack();
    })
    .catch((e: unknown) => {
      if (!(e instanceof RolledBack)) throw e;
    });
}
const inSavepoint = (tx: Tx, stmt: ReturnType<typeof sql>) => tx.transaction((sp) => sp.execute(stmt));

async function lastSettingsAudit(userId: string = users.admin.id) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, "org-settings-updated"), eq(auditLog.userId, userId)))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return row!;
}

async function mkSession(userId: string): Promise<string> {
  const [row] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
      userId,
      origin: "password",
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  created.sessions.push(row!.id);
  return row!.id;
}

async function mkApproval(userId: string, approverUserId: string): Promise<string> {
  const [row] = await db
    .insert(approvals)
    .values({ userId, approverUserId, objectType: "mcp_tool", toolName: `a186_${RUN}` })
    .returning({ id: approvals.id });
  created.approvals.push(row!.id);
  return row!.id;
}

const b64u = () => randomBytes(32).toString("base64url");

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // this suite drives users through API keys and is not about MFA (M-068: restored below)
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["member", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, {
      email: `a186-${k}-${RUN}@example.com`,
      displayName: `a186 ${k} ${RUN}`,
      isAdmin,
    });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    created.users.push(id);
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a186" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  await db.execute(STRICT_SQL);
  await restoreAdminKeyMfa?.();
  if (created.anchors.length) await db.delete(auditAnchors).where(inArray(auditAnchors.id, created.anchors));
  // deleting an approval sets its append-only decisions' reference NULL (allowed)
  if (created.approvals.length) await db.delete(approvals).where(inArray(approvals.id, created.approvals));
  if (created.sessions.length) await db.delete(authSessions).where(inArray(authSessions.id, created.sessions));
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------

describe("ADR-0186 secure by default: the batch-4 org settings", () => {
  it("a freshly migrated org reads every batch-4 setting strict — the column defaults and the stored row", async () => {
    const res = await db.execute(sql`
      select column_name, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'org_settings'`);
    const defaults = new Map(
      rows<{ column_name: string; column_default: string | null }>(res).map((r) => [r.column_name, r.column_default ?? ""]),
    );
    const g = await inject("GET", "/v1/org/settings", users.admin.auth);
    expect(g.statusCode, g.body).toBe(200);
    const settings = g.json().settings as Record<string, unknown>;
    for (const [key, strict] of Object.entries(BATCH4_STRICT_DEFAULTS)) {
      expect(settings[key], key).toEqual(strict);
      const def = defaults.get(BATCH4_SETTING_COLUMNS[key as Batch4SettingKey]);
      expect(def, key).toBeDefined();
      if (typeof strict === "number") expect(def, key).toBe(String(strict));
      else if (typeof strict === "string") expect(def, key).toBe(`'${strict}'::text`);
      else expect(JSON.parse(def!.replace(/^'/, "").replace(/'::jsonb$/, "")), key).toEqual(strict);
    }
  });

  it("each relaxation round-trips, is audited with detail.transitions and named as relaxed; strict comes back", async () => {
    // slice A: a relaxation needs a `settings_relax` step-up, which an API key can never give; the deploy-time
    // bootstrap credential is no person and is not asked (zz-b4a-step-up.test.ts proves the step-up itself)
    const BOOT_USER = "00000000-0000-0000-0000-000000000000";
    try {
      for (const [key, value] of Object.entries(RELAXED)) {
        const put = await inject("PUT", "/v1/org/settings", AUTH, { [key]: value });
        expect(put.statusCode, `${key}: ${put.body}`).toBe(200);
        expect(put.json().settings[key], key).toEqual(value);
        const read = await inject("GET", "/v1/org/settings", users.admin.auth);
        expect(read.json().settings[key], `${key} read back`).toEqual(value);
        const row = await lastSettingsAudit(BOOT_USER);
        const detail = row.detail as { transitions: Record<string, { from: unknown; to: unknown }>; relaxed?: string[] };
        expect(detail.transitions[key], key).toEqual({ from: BATCH4_STRICT_DEFAULTS[key as Batch4SettingKey], to: value });
        expect(detail.relaxed, key).toEqual([key]);
        expect(row.reason, key).toContain("RELAXED from the strict default");
      }
    } finally {
      const back = await inject("PUT", "/v1/org/settings", AUTH, { ...BATCH4_STRICT_DEFAULTS });
      expect(back.statusCode, back.body).toBe(200);
    }
    const detail = (await lastSettingsAudit(BOOT_USER)).detail as { transitions: Record<string, unknown>; relaxed?: string[] };
    expect(Object.keys(detail.transitions).sort()).toEqual(Object.keys(BATCH4_STRICT_DEFAULTS).sort());
    expect(detail.relaxed).toBeUndefined();
  });

  it("a stricter value is audited as a transition but not as a relaxation; the relaxation facts name only looser keys", async () => {
    try {
      const put = await inject("PUT", "/v1/org/settings", users.admin.auth, {
        stepUpMaxAgeSeconds: 60,
        toolApprovalSensitiveQuorum: 3,
        monitorJailbreakWindowHours: 48,
      });
      expect(put.statusCode, put.body).toBe(200);
      const row = await lastSettingsAudit();
      const detail = row.detail as { transitions: Record<string, unknown>; relaxed?: string[] };
      expect(detail.transitions).toEqual({
        stepUpMaxAgeSeconds: { from: 120, to: 60 },
        toolApprovalSensitiveQuorum: { from: 2, to: 3 },
        monitorJailbreakWindowHours: { from: 24, to: 48 },
      });
      expect(detail.relaxed).toBeUndefined();
      expect(row.reason).not.toContain("RELAXED");
      // the step-up hook's facts: batch-3, accountability and batch-4 keys alike
      expect(relaxedSettingKeys({ stepUpMode: "off", conversationRetentionDays: 31, stepUpMaxAgeSeconds: 60 })).toEqual([
        "conversationRetentionDays",
        "stepUpMode",
      ]);
    } finally {
      await inject("PUT", "/v1/org/settings", users.admin.auth, { ...BATCH4_STRICT_DEFAULTS });
    }
  });

  it("refuses a value outside its bounds (400) and saves nothing; the database holds the same bounds", async () => {
    const before = (await inject("GET", "/v1/org/settings", users.admin.auth)).json().settings;
    for (const body of [
      { approvalSignatureMode: "none" },
      { stepUpMode: "optional" },
      { stepUpMaxAgeSeconds: 29 },
      { stepUpMaxAgeSeconds: 901 },
      { stepUpActions: ["approval_decide", "approval_decide"] },
      { stepUpActions: ["sudo"] },
      { toolApprovalSensitiveQuorum: 0 },
      { toolApprovalSensitiveQuorum: 6 },
      { decisionReceiptsMode: "sometimes" },
      { auditAnchorTimestampMode: "best_effort" },
      { vendoredDetectionPacks: ["yara-rules"] },
      { monitorMcpBaselineDays: 0 },
      { monitorJailbreakThreshold: 101 },
      { monitorJailbreakWindowHours: 169 },
    ]) {
      const r = await inject("PUT", "/v1/org/settings", users.admin.auth, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    const after = (await inject("GET", "/v1/org/settings", users.admin.auth)).json().settings;
    for (const k of Object.keys(BATCH4_STRICT_DEFAULTS)) expect(after[k], k).toEqual(before[k]);
    for (const [stmt, constraint] of [
      [sql`UPDATE org_settings SET approval_signature_mode = 'none'`, "org_settings_approval_signature_mode_check"],
      [sql`UPDATE org_settings SET step_up_max_age_seconds = 901`, "org_settings_step_up_max_age_seconds_check"],
      [sql`UPDATE org_settings SET step_up_actions = '["sudo"]'::jsonb`, "org_settings_step_up_actions_check"],
      [sql`UPDATE org_settings SET tool_approval_sensitive_quorum = 0`, "org_settings_tool_approval_sensitive_quorum_check"],
      [sql`UPDATE org_settings SET vendored_detection_packs = '"pipelock-secrets"'::jsonb`, "org_settings_vendored_detection_packs_check"],
      [sql`UPDATE org_settings SET monitor_jailbreak_window_hours = 0`, "org_settings_monitor_jailbreak_window_hours_check"],
    ] as const) {
      await expectRefused(db.execute(stmt), new RegExp(constraint));
    }
  });
});

describe("ADR-0186 §4.9: GET /v1/org/posture reports where /metrics is served, token-free", () => {
  const KEYS = ["REGULAIT_METRICS_LISTEN", "REGULAIT_METRICS_ON_MAIN_LISTENER", "REGULAIT_METRICS_TOKEN"] as const;
  const TOKEN = `m186-${"x".repeat(40)}-${RUN}`;
  async function postureWith(env: Partial<Record<(typeof KEYS)[number], string>>) {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    try {
      for (const k of KEYS) {
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
      }
      const r = await inject("GET", "/v1/org/posture", users.admin.auth);
      expect(r.statusCode, r.body).toBe(200);
      return { metrics: r.json().metrics, body: r.body };
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it("off by default: no listener, no main route, no token", async () => {
    expect((await postureWith({})).metrics).toEqual({ separateListener: "off", mainListener: false, tokenConfigured: false });
  });

  it("a loopback listener, a non-loopback listener, the main route — and never the token, host or port", async () => {
    const loop = await postureWith({ REGULAIT_METRICS_LISTEN: "127.0.0.1:19464", REGULAIT_METRICS_TOKEN: TOKEN });
    expect(loop.metrics).toEqual({ separateListener: "loopback", mainListener: false, tokenConfigured: true });
    expect((await postureWith({ REGULAIT_METRICS_LISTEN: "19464", REGULAIT_METRICS_TOKEN: TOKEN })).metrics.separateListener).toBe(
      "loopback",
    );
    expect(
      (await postureWith({ REGULAIT_METRICS_LISTEN: "[::1]:19464", REGULAIT_METRICS_TOKEN: TOKEN })).metrics.separateListener,
    ).toBe("loopback");
    const wide = await postureWith({
      REGULAIT_METRICS_LISTEN: "0.0.0.0:19464",
      REGULAIT_METRICS_ON_MAIN_LISTENER: "on",
      REGULAIT_METRICS_TOKEN: TOKEN,
    });
    expect(wide.metrics).toEqual({ separateListener: "non_loopback", mainListener: true, tokenConfigured: true });
    expect(
      (await postureWith({ REGULAIT_METRICS_LISTEN: "metrics.internal:19464", REGULAIT_METRICS_TOKEN: TOKEN })).metrics
        .separateListener,
    ).toBe("non_loopback");
    for (const r of [loop, wide]) {
      expect(r.body).not.toContain(TOKEN);
      expect(r.body).not.toContain("19464");
      expect(r.body).not.toContain("0.0.0.0");
      expect(JSON.stringify(r.metrics)).not.toMatch(/127\.0\.0\.1|metrics\.internal/);
    }
  });

  it("a configuration the boot would refuse reads as the safer answer (a short token serves nothing)", async () => {
    expect(
      (await postureWith({ REGULAIT_METRICS_LISTEN: "0.0.0.0:19464", REGULAIT_METRICS_ON_MAIN_LISTENER: "on", REGULAIT_METRICS_TOKEN: "short" }))
        .metrics,
    ).toEqual({ separateListener: "off", mainListener: false, tokenConfigured: false });
  });
});

describe("ADR-0186 migration 0170: append-only evidence", () => {
  it("approval_decisions refuses UPDATE and DELETE; deleting the approval only sets the reference NULL", async () => {
    await inRolledBackTx(async (tx) => {
      const [a] = await tx
        .insert(approvals)
        .values({ userId: users.member.id, approverUserId: users.admin.id, objectType: "mcp_tool", toolName: `a186_${RUN}` })
        .returning({ id: approvals.id });
      const approvalId = a!.id;
      const [d] = await tx
        .insert(approvalDecisions)
        .values({
          approvalId,
          deciderUserId: users.admin.id,
          principalUserId: users.admin.id,
          decision: "approved",
          stepUpMethod: "totp",
        })
        .returning();
      await expectRefused(
        inSavepoint(tx, sql`UPDATE approval_decisions SET decision = 'denied' WHERE id = ${d!.id}`),
        /approval_decisions is append-only: UPDATE refused/,
      );
      await expectRefused(
        inSavepoint(tx, sql`DELETE FROM approval_decisions WHERE id = ${d!.id}`),
        /approval_decisions is append-only: DELETE refused/,
      );
      // one decision per principal per approval
      await expectRefused(
        tx.transaction((sp) =>
          sp.insert(approvalDecisions).values({
            approvalId,
            deciderUserId: users.member.id,
            principalUserId: users.admin.id,
            decision: "denied",
            stepUpMethod: "totp",
          }),
        ),
        /approval_decisions_approval_principal_uq/,
      );
      // a signed decision is all-or-nothing, and only a passkey signs
      await expectRefused(
        tx.transaction((sp) =>
          sp.insert(approvalDecisions).values({
            approvalId,
            principalUserId: users.member.id,
            decision: "approved",
            stepUpMethod: "totp",
            signedPayload: { v: "x" },
            signedDigest: "a".repeat(64),
            assertion: {},
            counterBefore: 0,
          }),
        ),
        /approval_decisions_signature_shape_check/,
      );
      await tx.delete(approvals).where(eq(approvals.id, approvalId));
      const [kept] = await tx.select().from(approvalDecisions).where(eq(approvalDecisions.id, d!.id));
      expect(kept).toMatchObject({ approvalId: null, decision: "approved", principalUserId: users.admin.id });
    });
  });

  it("decision_receipts refuse UPDATE and DELETE; keys are public-only and never deleted; the payload states its own seq, key and prev", async () => {
    const keyId = `a186-${RUN}`;
    await inRolledBackTx(async (tx) => {
      await expectRefused(
        tx.transaction((sp) =>
          sp.insert(receiptSigningKeys).values({
            keyId: `${keyId}-priv`,
            publicJwk: { kty: "OKP", crv: "Ed25519", x: "AAAA", d: "secret" } as never,
          }),
        ),
        /receipt_signing_keys_public_only_check/,
      );
      await expectRefused(
        tx.transaction((sp) =>
          sp.insert(receiptSigningKeys).values({ keyId: `${keyId}-nox`, publicJwk: { kty: "OKP", crv: "Ed25519" } as never }),
        ),
        /receipt_signing_keys_public_only_check/,
      );
      await tx.insert(receiptSigningKeys).values({ keyId, publicJwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" } });
      const [{ next }] = rows<{ next: string }>(
        await tx.execute(sql`SELECT (COALESCE(MAX(receipt_seq), 0) + 1)::text AS next FROM decision_receipts`),
      ) as [{ next: string }];
      const seq = Number(next);
      const payload = {
        v: "regulait.receipt.v1",
        receiptSeq: seq,
        audit: { id: "x", seq: 1, rowHash: "r", contentHash: "c" },
        decision: {},
        prev: RECEIPT_GENESIS_PREV,
        keyId,
      };
      const values = {
        receiptSeq: seq,
        auditId: randomUUID(),
        auditSeq: 9_000_000_000 + seq,
        payload,
        payloadHash: "b".repeat(64),
        prevHash: RECEIPT_GENESIS_PREV,
        signature: "A".repeat(86),
        keyId,
      };
      await expectRefused(
        tx.transaction((sp) => sp.insert(decisionReceipts).values({ ...values, payload: { ...payload, receiptSeq: seq + 1 } })),
        /decision_receipts_payload_check/,
      );
      await expectRefused(
        tx.transaction((sp) => sp.insert(decisionReceipts).values({ ...values, payload: { ...payload, keyId: undefined } })),
        /decision_receipts_payload_check/,
      );
      await tx.insert(decisionReceipts).values(values);
      await expectRefused(
        inSavepoint(tx, sql`UPDATE decision_receipts SET signature = ${"B".repeat(86)} WHERE receipt_seq = ${seq}`),
        /decision_receipts is append-only: UPDATE refused/,
      );
      await expectRefused(
        inSavepoint(tx, sql`DELETE FROM decision_receipts WHERE receipt_seq = ${seq}`),
        /decision_receipts is append-only: DELETE refused/,
      );
      await expectRefused(
        inSavepoint(tx, sql`DELETE FROM receipt_signing_keys WHERE key_id = ${keyId}`),
        /receipt_signing_keys is append-only: DELETE refused/,
      );
      // a key may still be retired
      await tx.update(receiptSigningKeys).set({ retiredAt: new Date() }).where(eq(receiptSigningKeys.keyId, keyId));
    });
    // rolled back: nothing of it is left for a later file (M-068)
    const left = await db.select().from(receiptSigningKeys).where(eq(receiptSigningKeys.keyId, keyId));
    expect(left).toEqual([]);
  });

  it("approvals snapshot quorum 1 and the strict passkey mode; rules take a quorum of 1–5", async () => {
    const id = await mkApproval(users.member.id, users.admin.id);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row).toMatchObject({ quorum: 1, signatureMode: "passkey" });
    await expectRefused(db.execute(sql`UPDATE approvals SET quorum = 6 WHERE id = ${id}`), /approvals_quorum_check/);
    await expectRefused(
      db.execute(sql`UPDATE approvals SET signature_mode = 'none' WHERE id = ${id}`),
      /approvals_signature_mode_check/,
    );
    const [def] = rows<{ def: string }>(
      await db.execute(sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'approval_rules_quorum_check'`),
    );
    expect(def?.def).toMatch(/quorum >= 1.*quorum <= 5/);
    const [cols] = rows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'approval_rules' AND column_name IN ('quorum', 'approver_role_id')`),
    );
    expect(cols!.n).toBe(2);
  });
});

describe("ADR-0186 migration 0170: ceremonies, grants and fresh SSO logins", () => {
  it("stores a real-sized passkey (Postgres caps regex repetition at 255, so the length bounds are separate predicates)", async () => {
    // a 64-byte credential id and a ~77-byte COSE key, base64url — both longer than 255 characters would be
    // refused by a `{16,1366}` regex bound at insert time with "invalid repetition count(s)"
    const longId = "A".repeat(400);
    const longKey = "B".repeat(600);
    const [row] = await db
      .insert(webauthnCredentials)
      .values({ userId: users.member.id, credentialId: longId, publicKey: longKey, label: `a186 ${RUN}` })
      .returning({ id: webauthnCredentials.id });
    try {
      expect(row!.id).toBeTruthy();
      await expectRefused(
        db.insert(webauthnCredentials).values({ userId: users.member.id, credentialId: "A".repeat(1367), publicKey: longKey, label: "x" }),
        /webauthn_credentials_credential_id_check/,
      );
      await expectRefused(
        db.insert(webauthnCredentials).values({ userId: users.member.id, credentialId: "C".repeat(32), publicKey: "B".repeat(4097), label: "x" }),
        /webauthn_credentials_public_key_check/,
      );
      await expectRefused(
        db.insert(webauthnCredentials).values({ userId: users.member.id, credentialId: "not base64url!!!!!", publicKey: longKey, label: "x" }),
        /webauthn_credentials_credential_id_check/,
      );
    } finally {
      await db.delete(webauthnCredentials).where(eq(webauthnCredentials.id, row!.id));
    }
  });

  it("a challenge lives at most 5 minutes and carries exactly the binding its purpose needs", async () => {
    const sessionId = await mkSession(users.member.id);
    const now = new Date();
    await expectRefused(
      db.insert(webauthnChallenges).values({
        userId: users.member.id,
        sessionId,
        purpose: "register",
        challenge: b64u(),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 5 * 60_000 + 1000),
      }),
      /webauthn_challenges_expiry_check/,
    );
    await expectRefused(
      db.insert(webauthnChallenges).values({
        userId: users.member.id,
        sessionId,
        purpose: "step_up",
        challenge: b64u(),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      }),
      /webauthn_challenges_shape_check/,
    );
    await expectRefused(
      db.insert(webauthnChallenges).values({
        userId: users.member.id,
        sessionId,
        purpose: "approval_sign",
        challenge: b64u(),
        actionDigest: "a".repeat(64),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      }),
      /webauthn_challenges_shape_check/,
    );
  });

  it("a step-up grant may be proven by passkey, TOTP or a fresh SSO login, for at most 900 s", async () => {
    const sessionId = await mkSession(users.member.id);
    const now = new Date();
    const grant = (method: string, seconds: number) =>
      db.execute(sql`INSERT INTO step_up_grants (token_hash, user_id, session_id, method, action_kind, action_digest, created_at, expires_at)
        VALUES (${createHash("sha256").update(randomBytes(16)).digest("hex")}, ${users.member.id}, ${sessionId}, ${method},
                'approval_decide', ${"c".repeat(64)}, ${now.toISOString()}::timestamptz, ${new Date(now.getTime() + seconds * 1000).toISOString()}::timestamptz)`);
    for (const m of ["passkey", "totp", "sso"]) await grant(m, 120);
    await expectRefused(grant("password", 120), /step_up_grants_method_check/);
    await expectRefused(grant("sso", 901), /step_up_grants_expiry_check/);
  });

  it("a fresh SSO login verifies only with auth_time after the request, and is used only once verified", async () => {
    const sessionId = await mkSession(users.member.id);
    const now = new Date();
    const [ch] = await db
      .insert(webauthnChallenges)
      .values({
        userId: users.member.id,
        sessionId,
        purpose: "step_up",
        challenge: b64u(),
        actionKind: "approval_decide",
        actionDigest: "d".repeat(64),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      })
      .returning({ id: webauthnChallenges.id });
    const [provider] = rows<{ id: string }>(
      await db.execute(sql`INSERT INTO oidc_providers (name, issuer_url, client_id, client_secret_ciphertext, enabled)
        VALUES (${`a186-${RUN}`}, 'https://idp.example.com', 'c', 'x', false) RETURNING id`),
    );
    const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
    const reauth = (over: { codeVerifier?: string | null; authTime?: string | null; verifiedAt?: string | null; usedAt?: string | null } = {}) =>
      db.execute(sql`INSERT INTO sso_reauth_requests (step_up_id, user_id, session_id, provider_kind, oidc_provider_id,
           state, nonce, code_verifier, redirect_uri, action_digest, requested_at, expires_at, auth_time, verified_at, used_at)
         VALUES (${ch!.id}, ${users.member.id}, ${sessionId}, 'oidc', ${provider!.id}, ${b64u()}, 'n',
           ${over.codeVerifier === undefined ? "v" : over.codeVerifier}, 'https://gw.example.com/auth/oidc/callback',
           ${"d".repeat(64)}, ${at(0)}::timestamptz, ${at(120_000)}::timestamptz,
           ${over.authTime ?? null}::timestamptz, ${over.verifiedAt ?? null}::timestamptz, ${over.usedAt ?? null}::timestamptz)`);
    try {
      await reauth();
      await reauth({ authTime: at(1000), verifiedAt: at(2000), usedAt: at(3000) });
      // verified with an auth_time BEFORE the request: a stale login
      await expectRefused(reauth({ authTime: at(-1000), verifiedAt: at(2000) }), /sso_reauth_requests_verified_check/);
      // used before it was verified
      await expectRefused(reauth({ usedAt: at(1000) }), /sso_reauth_requests_used_check/);
      // an OIDC request without PKCE
      await expectRefused(reauth({ codeVerifier: null }), /sso_reauth_requests_provider_check/);
    } finally {
      await db.execute(sql`DELETE FROM oidc_providers WHERE id = ${provider!.id}`);
    }
  });
});

describe("ADR-0186 consumeWebauthnChallenge — single use, by the database clock", () => {
  async function mkChallenge(userId: string, sessionId: string, expiresInMs: number, createdAgoMs = 0) {
    const created = new Date(Date.now() - createdAgoMs);
    const [row] = await db
      .insert(webauthnChallenges)
      .values({
        userId,
        sessionId,
        purpose: "register",
        challenge: b64u(),
        createdAt: created,
        expiresAt: new Date(created.getTime() + expiresInMs),
      })
      .returning({ id: webauthnChallenges.id });
    return row!.id;
  }

  it("succeeds once; the second claim is `used`; an expired one is `expired`; another session or purpose is `unknown`", async () => {
    const s1 = await mkSession(users.member.id);
    const s2 = await mkSession(users.member.id);
    const id = await mkChallenge(users.member.id, s1, 60_000);
    const key = { id, userId: users.member.id, sessionId: s1, purpose: "register" as const };
    expect(await consumeWebauthnChallenge(db, { ...key, sessionId: s2 })).toEqual({ ok: false, reason: "unknown" });
    expect(await consumeWebauthnChallenge(db, { ...key, purpose: "step_up" })).toEqual({ ok: false, reason: "unknown" });
    expect(await consumeWebauthnChallenge(db, { ...key, userId: users.admin.id })).toEqual({ ok: false, reason: "unknown" });
    const first = await consumeWebauthnChallenge(db, key);
    expect(first.ok).toBe(true);
    expect(first.ok && first.row.usedAt).toBeInstanceOf(Date);
    expect(await consumeWebauthnChallenge(db, key)).toEqual({ ok: false, reason: "used" });
    const old = await mkChallenge(users.member.id, s1, 60_000, 120_000);
    expect(await consumeWebauthnChallenge(db, { ...key, id: old })).toEqual({ ok: false, reason: "expired" });
    const [stillUnused] = await db.select().from(webauthnChallenges).where(eq(webauthnChallenges.id, old));
    expect(stillUnused!.usedAt).toBeNull();
  });

  it("ten concurrent claims: exactly one wins", async () => {
    const s = await mkSession(users.member.id);
    const id = await mkChallenge(users.member.id, s, 60_000);
    const key = { id, userId: users.member.id, sessionId: s, purpose: "register" as const };
    const results = await Promise.all(Array.from({ length: 10 }, () => consumeWebauthnChallenge(db, key)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "used")).toHaveLength(9);
  });
});

describe("ADR-0186 seams: §4.9 routes, sweeps, the anchor timestamper, the monitor", () => {
  // slice A (passkeys and step-up) has landed: its self routes are built
  // (zz-b4a-step-up.test.ts proves them); what stays here is that they are
  // NOT admin-gated, and that an API key — admin or not — can never use them
  const SELF_BUILT_A: Array<[Method, string]> = [
    ["POST", "/v1/auth/passkeys/registration-options"],
    ["POST", "/v1/auth/passkeys"],
    ["GET", "/v1/auth/passkeys"],
    ["PATCH", "/v1/auth/passkeys/00000000-0000-4000-a000-000000000001"],
    ["DELETE", "/v1/auth/passkeys/00000000-0000-4000-a000-000000000001"],
    ["POST", "/v1/auth/step-up/options"],
    ["POST", "/v1/auth/step-up/verify"],
    ["GET", "/v1/auth/step-up/00000000-0000-4000-a000-000000000001"],
  ];
  // slice B (signed approvals) has landed too: its signing options are proved
  // in zz-b4ab-dual-control-signed-approvals.test.ts; what stays here is that
  // the route is NOT admin-gated and an API key can never sign
  const SELF_BUILT_B: Array<[Method, string]> = [
    ["POST", "/v1/approvals/00000000-0000-4000-a000-000000000001/signing-options"],
  ];
  const ADMIN: Array<[Method, string]> = [
    ["GET", "/v1/receipts?fromSeq=1&limit=10"],
    ["GET", "/v1/receipts/status"],
    ["GET", "/v1/receipts/keys"],
    ["GET", "/v1/receipts/export?fromSeq=1&toSeq=2"],
    ["POST", "/v1/receipts/verify"],
    ["GET", "/v1/receipts/00000000-0000-4000-a000-000000000001"],
    ["POST", "/v1/audit/anchors/00000000-0000-4000-a000-000000000001/timestamp"],
    ["GET", "/v1/audit/anchors/00000000-0000-4000-a000-000000000001/timestamp.tsr"],
    ["GET", "/v1/detection-content"],
  ];

  it("slice B's signing options are not admin-gated and refuse any API key (only a browser session can sign)", async () => {
    for (const [m, url] of SELF_BUILT_B) {
      for (const who of [users.member, users.admin]) {
        const r = await inject(m, url, who.auth, { decision: "approved" });
        expect(r.statusCode, `${m} ${url}: ${r.body}`).toBe(403);
        expect(r.json().error).toBe("passkey_signature_required");
      }
    }
  });

  it("slice A's self routes are not admin-gated and refuse any API key (a browser session is required)", async () => {
    for (const [m, url] of SELF_BUILT_A) {
      for (const who of [users.member, users.admin]) {
        const r = await inject(m, url, who.auth, m === "GET" || m === "DELETE" ? undefined : {});
        expect(r.statusCode, `${m} ${url}: ${r.body}`).toBe(403);
        expect(r.json().error).toBe("browser_session_required");
      }
    }
    // slice A's admin passkey routes stay admin-only
    const member = await inject("GET", "/v1/users/00000000-0000-4000-a000-000000000001/passkeys", users.member.auth);
    expect(member.statusCode).toBe(403);
    const admin = await inject("GET", "/v1/users/00000000-0000-4000-a000-000000000001/passkeys", users.admin.auth);
    expect(admin.statusCode, admin.body).toBe(200);
  });

  it("every admin route refuses a non-admin (403) and answers 501 not_built to an admin", async () => {
    for (const [m, url] of ADMIN) {
      const payload = m === "POST" ? {} : undefined;
      const member = await inject(m, url, users.member.auth, payload);
      expect(member.statusCode, `${m} ${url} (member): ${member.body}`).toBe(403);
      const admin = await inject(m, url, users.admin.auth, payload);
      expect(admin.statusCode, `${m} ${url} (admin): ${admin.body}`).toBe(501);
      expect(admin.json()).toEqual({ error: "not_built" });
    }
  });

  it("the two batch-4 sweeps are registered and process nothing", async () => {
    const registry = schedulerJobRegistry();
    for (const name of ["decision-receipt-sign-sweep", "anchor-timestamp-sweep"]) {
      const def = registry.get(name);
      expect(def, name).toBeDefined();
      expect(def!.adr).toBe("ADR-0186");
      const out = await def!.run({ db, actorUserId: null, now: new Date(), runId: `a186-${RUN}` });
      expect(out.itemsProcessed, name).toBe(0);
      expect(out.detail, name).toMatchObject({ state: "not_built" });
    }
  });

  it("the anchor timestamper runs after every flush attempt and cannot change the outcome", async () => {
    const calls: Array<{ id: string; flushStatus: string; seq: number }> = [];
    const recording: AnchorTimestamper = {
      async afterFlush(_db, a) {
        calls.push({ id: a.id, flushStatus: a.flushStatus, seq: a.record.seq });
      },
    };
    const captured = await captureAnchor(db, null, users.admin.id, recording);
    expect(captured).not.toBeNull();
    created.anchors.push(captured!.anchorId);
    expect(calls).toEqual([{ id: captured!.anchorId, flushStatus: "pending", seq: captured!.seq }]);
    const [row] = await db.select().from(auditAnchors).where(eq(auditAnchors.id, captured!.anchorId));
    expect(row!.tsaStatus).toBe("not_configured");

    const throwing: AnchorTimestamper = {
      async afterFlush() {
        throw new Error("tsa unreachable (test)");
      },
    };
    const again = await captureAnchor(db, null, users.admin.id, throwing);
    created.anchors.push(again!.anchorId);
    expect(again!.status).toBe("pending");
    const [failed] = await db.select().from(auditAnchors).where(eq(auditAnchors.id, again!.anchorId));
    expect(failed!.tsaLastError).toBe("tsa unreachable (test)");
    expect(failed!.tsaStatus).toBe("not_configured");

    calls.length = 0;
    const flushed = await flushPendingAnchors(db, null, recording);
    expect(calls.length).toBe(flushed.attempted);
    expect(calls.map((c) => c.id)).toEqual(expect.arrayContaining([captured!.anchorId, again!.anchorId]));
  });

  it("the four detection monitor rules are evaluated (no breach) — not skipped", async () => {
    const out = await runGovernanceMonitor(db, { actorUserId: users.admin.id });
    for (const id of DETECTION_MONITOR_RULE_IDS) expect(out.notEvaluated).not.toContain(id);
  });
});
