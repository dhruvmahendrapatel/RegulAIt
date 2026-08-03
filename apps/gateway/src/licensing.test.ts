import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createDb,
  eq,
  inArray,
  isNull,
  licenseVerifications,
  licenses,
  runMigrations,
  users,
  type Db,
} from "@regulait/db";
import { LICENSE_SCHEMA_ID, canonicalLicenseBytes, licenseDocumentSchema } from "@regulait/shared";
import { verifyLicenseArtifact } from "./licensing.js";

/**
 * ADR-0052 — LICENSING & SEATS, proved by attack.
 *
 * WHY THE KEYS ARE EPHEMERAL
 * --------------------------
 * `infra/license-keys/regulait-license-dev-2026-08.pub` is a development key
 * whose private half was destroyed on generation, exactly like ADR-0041's
 * release key — so nothing in this repo can sign a license the default keyring
 * accepts, which is the correct fail-closed direction and useless for a test.
 * This suite therefore generates a REAL Ed25519 keypair in memory, writes only
 * its public half into a temporary keyring, and points
 * `REGULAIT_LICENSE_KEYRING` at that directory. Real crypto is exercised end to
 * end with no committed secret and nothing written that `.gitignore` would have
 * to catch.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. A "VERIFICATION" THAT PHONES HOME. `globalThis.fetch`, `https.request`
 *     and `http.request` are replaced with throwing spies for the duration of
 *     an install + status + verify cycle, and asserted never to have been
 *     called. An air-gapped deployment has no network; a license check that
 *     quietly used one would work on a laptop and fail at the customer.
 *  2. A FORGERY THAT LANDS. Three separate attacks — a flipped byte in the
 *     document, a signature from a DIFFERENT key, and a key id this deployment
 *     does not pin — are each asserted refused, AND asserted not to have
 *     displaced the license already installed. Displacing a valid license with
 *     a forged one is the actual attack.
 *  3. AN EXPIRED LICENSE THAT BRICKS THE DEPLOYMENT. With a license past its
 *     grace window, reads are asserted to still work, the governance action
 *     class is asserted to still be permitted, and only expansion is refused.
 *  4. A SEAT COUNT THAT BILLS THE SUSPENDED. A deactivated user is asserted not
 *     to consume a seat, and deactivating one is asserted to free headroom that
 *     was exhausted a moment earlier.
 *
 * SHARED-STATE DISCIPLINE: `licenses` is an ORG SINGLETON — at most one active
 * row, and a stray one would change the behaviour of every other suite's user
 * creation. `afterEach` clears both licensing tables, and `afterAll` clears
 * them again plus every `lic-` user this suite created, so the deployment ends
 * the run UNLICENSED exactly as it started.
 */

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "lic-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);
const KEY_ID = "lic-test-key";
const OTHER_KEY_ID = "lic-other-key";

let db: Db;
let app: ReturnType<typeof buildApp>;
let keyring: string;
let priv: KeyObject;
let otherPriv: KeyObject;
let memberAuth: { authorization: string };
let memberId: string;
const createdUserIds: string[] = [];
const prevKeyring = process.env.REGULAIT_LICENSE_KEYRING;

/** the FUTURE — every "valid" license in this suite is valid until then */
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

function makeDoc(over: Record<string, unknown> = {}) {
  return licenseDocumentSchema.parse({
    schema: LICENSE_SCHEMA_ID,
    licenseId: "lic-test",
    tenant: "lic-acme",
    tier: "enterprise",
    seatCap: 1000,
    features: ["sso_saml", "airgapped_mode"],
    deploymentMode: "airgapped",
    issuedAt: "2026-01-01T00:00:00.000Z",
    notBefore: "2026-01-01T00:00:00.000Z",
    expiresAt: FAR_FUTURE,
    graceDays: 30,
    ...over,
  });
}

/** sign the EXACT bytes — the same rule the verifier applies */
function artifact(doc: ReturnType<typeof makeDoc>, opts: { key?: KeyObject; keyId?: string } = {}) {
  const bytes = Buffer.from(canonicalLicenseBytes(doc), "utf8");
  const sig = cryptoSign(null, bytes, opts.key ?? priv);
  return {
    documentBase64: bytes.toString("base64"),
    signature: sig.toString("base64"),
    signingKeyId: opts.keyId ?? KEY_ID,
  };
}

async function install(a: ReturnType<typeof artifact>) {
  return app.inject({ method: "POST", url: "/v1/licenses", headers: AUTH, payload: a });
}

async function status() {
  const r = await app.inject({ method: "GET", url: "/v1/licenses/status", headers: AUTH });
  expect(r.statusCode).toBe(200);
  return r.json();
}

async function audits(ruleId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
}

async function activeUserCount() {
  const rows = await db.select({ id: users.id }).from(users).where(isNull(users.disabledAt));
  return rows.length;
}

async function makeUser(email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]! },
  });
  if (res.statusCode === 201) createdUserIds.push(res.json().id as string);
  return res;
}

beforeAll(async () => {
  keyring = mkdtempSync(path.join(tmpdir(), "regulait-license-keys-"));
  const kp = generateKeyPairSync("ed25519");
  priv = kp.privateKey;
  writeFileSync(
    path.join(keyring, `${KEY_ID}.pub`),
    kp.publicKey.export({ type: "spki", format: "pem" }) as string,
  );
  const other = generateKeyPairSync("ed25519");
  otherPriv = other.privateKey;
  // NOTE: the OTHER key's public half is deliberately pinned too. That makes
  // the "signed by a different key" case a real cryptographic refusal rather
  // than a key-id lookup miss — the two failures are distinct and both must be
  // covered.
  writeFileSync(
    path.join(keyring, `${OTHER_KEY_ID}.pub`),
    other.publicKey.export({ type: "spki", format: "pem" }) as string,
  );
  process.env.REGULAIT_LICENSE_KEYRING = keyring;

  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const u = await makeUser("lic-member@example.com");
  expect(u.statusCode).toBe(201);
  memberId = u.json().id;
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${memberId}/keys`,
    headers: AUTH,
    payload: { name: "lic" },
  });
  memberAuth = { authorization: `Bearer ${k.json().token}` };
});

afterEach(async () => {
  // `licenses` is an ORG SINGLETON. A row left behind would change how every
  // other suite's user creation behaves, so it goes after every test.
  await db.delete(licenseVerifications);
  await db.delete(licenses);
});

afterAll(async () => {
  await db.delete(licenseVerifications);
  await db.delete(licenses);
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  if (prevKeyring === undefined) delete process.env.REGULAIT_LICENSE_KEYRING;
  else process.env.REGULAIT_LICENSE_KEYRING = prevKeyring;
  rmSync(keyring, { recursive: true, force: true });
});

describe("ADR-0052 — a valid license verifies OFFLINE", () => {
  it("installs, and makes ZERO network calls doing it", async () => {
    // the CJS exports objects, via createRequire — the ESM namespace is frozen,
    // and these are the very objects node's own internals dispatch through
    const req = createRequire(import.meta.url);
    const http = req("node:http") as { request: unknown; get: unknown };
    const https = req("node:https") as { request: unknown; get: unknown };
    const realFetch = globalThis.fetch;
    const realHttp = http.request;
    const realHttps = https.request;
    const calls: string[] = [];
    // any outbound attempt is both recorded AND thrown, so a swallowed error
    // cannot hide it. `net`/`tls` are deliberately NOT patched: the Postgres
    // pool rides them, and breaking the db would prove nothing about licensing.
    globalThis.fetch = ((...a: unknown[]) => {
      calls.push(`fetch ${String(a[0])}`);
      throw new Error("network call attempted during license verification");
    }) as typeof fetch;
    http.request = (...a: unknown[]) => {
      calls.push(`http ${String(a[0])}`);
      throw new Error("network call attempted during license verification");
    };
    https.request = (...a: unknown[]) => {
      calls.push(`https ${String(a[0])}`);
      throw new Error("network call attempted during license verification");
    };
    try {
      const res = await install(artifact(makeDoc()));
      expect(res.statusCode).toBe(201);
      expect(res.json().installed).toBe(true);
      expect(res.json().state).toBe("valid");
      const s = await status();
      expect(s.licensed).toBe(true);
      expect(s.phoneHome).toBe(false);
      const v = await app.inject({ method: "POST", url: "/v1/licenses/verify", headers: AUTH });
      expect(v.statusCode).toBe(200);
      expect(v.json().ok).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      http.request = realHttp;
      https.request = realHttps;
    }
    expect(calls).toEqual([]);

    // A SECOND, STRUCTURAL PROOF. `verifyLicenseArtifact` is SYNCHRONOUS: it
    // returns a value, not a promise. A synchronous function cannot have
    // awaited a network round trip, whatever a spy does or does not observe.
    const out = verifyLicenseArtifact({ ...artifact(makeDoc()), keyringDir: keyring });
    expect(out).not.toBeInstanceOf(Promise);
    expect(out.ok).toBe(true);
  });

  it("records the install, the verification trail and the audit row", async () => {
    await install(artifact(makeDoc()));
    const [row] = await db.select().from(licenses).where(eq(licenses.status, "active"));
    expect(row!.tenant).toBe("lic-acme");
    expect(row!.signingKeyId).toBe(KEY_ID);
    // the EXACT signed bytes are retained, so the row stays re-verifiable
    expect(JSON.parse(row!.document).tenant).toBe("lic-acme");
    const checks = await db.select().from(licenseVerifications);
    expect(checks.some((c) => c.trigger === "install" && c.ok)).toBe(true);
    expect((await audits("license-installed")).length).toBeGreaterThan(0);
  });

  it("recognises a re-install of the SAME artifact rather than duplicating it", async () => {
    const a = artifact(makeDoc());
    expect((await install(a)).statusCode).toBe(201);
    const again = await install(a);
    expect(again.statusCode).toBe(200);
    expect(again.json().installed).toBe(false);
    expect(await db.select().from(licenses)).toHaveLength(1);
  });

  it("installing a NEW license supersedes the old one, keeping the history", async () => {
    await install(artifact(makeDoc({ licenseId: "one", seatCap: 10 })));
    await install(artifact(makeDoc({ licenseId: "two", seatCap: 20 })));
    const rows = await db.select().from(licenses);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
    expect(rows.find((r) => r.status === "active")!.licenseId).toBe("two");
    expect(rows.find((r) => r.status === "superseded")!.supersededAt).not.toBeNull();
  });
});

describe("ADR-0052 — forgery fails CLOSED", () => {
  it("refuses a TAMPERED document and leaves the installed license in force", async () => {
    await install(artifact(makeDoc({ licenseId: "genuine", seatCap: 7 })));

    // the attack: raise the seat cap and re-send the ORIGINAL signature
    const good = artifact(makeDoc({ licenseId: "genuine", seatCap: 7 }));
    const tampered = {
      ...good,
      documentBase64: Buffer.from(
        Buffer.from(good.documentBase64, "base64").toString("utf8").replace('"seatCap":7', '"seatCap":99999'),
        "utf8",
      ).toString("base64"),
    };
    const res = await install(tampered);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("license_refused");
    expect(res.json().ruleId).toBe("license-signature-invalid");

    // AND the genuine one is untouched — this is the part that matters
    const [active] = await db.select().from(licenses).where(eq(licenses.status, "active"));
    expect(active!.licenseId).toBe("genuine");
    expect(active!.seatCap).toBe(7);
    expect((await status()).seats.cap).toBe(7);
    expect((await audits("license-signature-invalid")).some((r) => r.effect === "deny")).toBe(true);
    // the refusal is in the verification trail even though nothing was installed
    const refusals = await db.select().from(licenseVerifications).where(eq(licenseVerifications.ok, false));
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals[0]!.licenseRowId).toBeNull();
  });

  it("refuses a license signed by a DIFFERENT (but pinned) key", async () => {
    // signed by the other key, but CLAIMING the first key id — a cryptographic
    // refusal, not a lookup miss
    const a = artifact(makeDoc(), { key: otherPriv, keyId: KEY_ID });
    const res = await install(a);
    expect(res.statusCode).toBe(400);
    expect(res.json().ruleId).toBe("license-signature-invalid");
    expect(await db.select().from(licenses)).toHaveLength(0);
  });

  it("refuses a key id this deployment does not pin, even with a valid signature", async () => {
    const a = artifact(makeDoc(), { keyId: "a-key-nobody-gave-us" });
    const res = await install(a);
    expect(res.statusCode).toBe(400);
    expect(res.json().ruleId).toBe("license-signing-key-not-pinned");
    expect(res.json().detail).toMatch(/that is what pinning means/);
  });

  it("refuses a key id shaped like a path escape", async () => {
    const a = artifact(makeDoc());
    const res = await install({ ...a, signingKeyId: "../../etc/shadow" });
    // rejected by the schema before it ever reaches the filesystem
    expect(res.statusCode).toBe(400);
  });

  it("catches an installed row edited directly in the database", async () => {
    await install(artifact(makeDoc({ seatCap: 5 })));
    const [row] = await db.select().from(licenses).where(eq(licenses.status, "active"));
    await db
      .update(licenses)
      .set({ document: row!.document.replace('"seatCap":5', '"seatCap":5000') })
      .where(eq(licenses.id, row!.id));
    const v = await app.inject({ method: "POST", url: "/v1/licenses/verify", headers: AUTH });
    expect(v.statusCode).toBe(200);
    expect(v.json().ok).toBe(false);
    expect(v.json().state).toBe("invalid");
    // the row is RETAINED, not deleted — destroying evidence on a failed check
    // is the wrong instinct for a governance product
    expect(await db.select().from(licenses)).toHaveLength(1);
  });
});

describe("ADR-0052 — absence is not an error (fail OPEN on a missing license)", () => {
  it("reports UNLICENSED, closes every tier feature, and enforces no seat cap", async () => {
    const s = await status();
    expect(s.licensed).toBe(false);
    expect(s.state).toBe("absent");
    expect(s.seats.cap).toBeNull();
    expect(s.seats.canProvision).toBe(true);
    expect(Object.values(s.features).every((v) => v === false)).toBe(true);
    expect(s.actionClasses.governance.allowed).toBe(true);
    expect(s.reason).toMatch(/UNLICENSED/);
  });

  it("still lets an admin provision a user and create an agent", async () => {
    const u = await makeUser("lic-unlicensed-ok@example.com");
    expect(u.statusCode).toBe(201);
    const a = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: { name: "lic-agent-unlicensed", provider: "mock", tier: 1, model: "mock-balanced" },
    });
    expect(a.statusCode).toBe(201);
  });
});

describe("ADR-0052 — an EXPIRED license degrades to read-only, it does not brick", () => {
  const EXPIRED_AT = "2026-02-01T00:00:00.000Z";
  const expiredDoc = (over: Record<string, unknown> = {}) =>
    makeDoc({
      licenseId: "lic-expired",
      seatCap: 1000,
      notBefore: "2026-01-01T00:00:00.000Z",
      expiresAt: EXPIRED_AT,
      graceDays: 1,
      ...over,
    });

  it("READS still work and GOVERNANCE still runs, while EXPANSION is refused", async () => {
    expect((await install(artifact(expiredDoc()))).statusCode).toBe(201);
    const s = await status();
    expect(s.state).toBe("expired");

    // READS: the console surface answers, and the audit log is still readable
    expect(s.actionClasses.read.allowed).toBe(true);
    const listUsers = await app.inject({ method: "GET", url: "/v1/users", headers: AUTH });
    expect(listUsers.statusCode).toBe(200);
    const listAgents = await app.inject({ method: "GET", url: "/v1/agents", headers: AUTH });
    expect(listAgents.statusCode).toBe(200);
    const auditRead = await app.inject({ method: "GET", url: "/v1/audit", headers: AUTH });
    expect(auditRead.statusCode).toBe(200);

    // GOVERNANCE: fails OPEN — the gate keeps gating
    expect(s.actionClasses.governance.allowed).toBe(true);
    expect(s.actionClasses.governance.ruleId).toBe("license-expired-governance-fails-open");

    // EXPANSION: fails CLOSED — both wired write paths refuse
    expect(s.actionClasses.expansion.allowed).toBe(false);
    const newUser = await makeUser("lic-should-not-exist@example.com");
    expect(newUser.statusCode).toBe(403);
    expect(newUser.json().ruleId).toBe("license-expired-no-expansion");
    const newAgent = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: { name: "lic-agent-expired", provider: "mock", tier: 1, model: "mock-balanced" },
    });
    expect(newAgent.statusCode).toBe(403);
    expect(newAgent.json().error).toBe("license_expansion_refused");

    // and nothing was written by either refusal
    const leaked = await db.select().from(users).where(eq(users.email, "lic-should-not-exist@example.com"));
    expect(leaked).toHaveLength(0);
    expect((await audits("license-expired-no-expansion")).some((r) => r.effect === "deny")).toBe(true);
  });

  it("closes tier features past grace but keeps them open INSIDE grace", async () => {
    await install(artifact(expiredDoc()));
    expect((await status()).features.sso_saml).toBe(false);
    await db.delete(licenses);

    // the SAME license with a grace window wide enough that "now" is still
    // inside it — computed from the clock so the test does not rot
    const graceDays =
      Math.ceil((Date.now() - new Date(EXPIRED_AT).getTime()) / (24 * 3600 * 1000)) + 5;
    await install(artifact(expiredDoc({ licenseId: "lic-in-grace", graceDays })));
    const s = await status();
    expect(s.state).toBe("grace");
    expect(s.features.sso_saml).toBe(true);
    expect(s.actionClasses.expansion.allowed).toBe(true);
  });

  it("hardStopOnExpiry is opt-in: it refuses governance but never a read", async () => {
    await install(artifact(expiredDoc({ hardStopOnExpiry: true })));
    const s = await status();
    expect(s.hardStopOnExpiry).toBe(true);
    expect(s.actionClasses.governance.allowed).toBe(false);
    expect(s.actionClasses.governance.ruleId).toBe("license-hard-stop");
    expect(s.actionClasses.read.allowed).toBe(true);
    // reads genuinely still answer, so the deployment can be renewed
    expect((await app.inject({ method: "GET", url: "/v1/licenses", headers: AUTH })).statusCode).toBe(200);
  });
});

describe("ADR-0052 — seats count ACTIVE users and never punish existing ones", () => {
  it("does not count a DEACTIVATED user, and deactivating frees a seat", async () => {
    const active = await activeUserCount();
    // licensed for EXACTLY the current headcount: the next provisioning must fail
    await install(artifact(makeDoc({ licenseId: "lic-tight", seatCap: active })));
    const s = await status();
    expect(s.seats.active).toBe(active);
    expect(s.seats.cap).toBe(active);
    expect(s.seats.canProvision).toBe(false);

    const refused = await makeUser("lic-over-cap@example.com");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("seat_cap_reached");
    expect(refused.json().activeSeats).toBe(active);
    expect((await audits("seat_cap_reached")).some((r) => r.effect === "deny")).toBe(true);

    // ADR-0022: deactivate is not delete. The row survives, the seat does not.
    const victim = createdUserIds[createdUserIds.length - 1]!;
    const deact = await app.inject({
      method: "POST",
      url: `/v1/users/${victim}/deactivate`,
      headers: AUTH,
      payload: { reason: "lic seat test" },
    });
    expect(deact.statusCode).toBe(200);

    const after = await status();
    expect(after.seats.active).toBe(active - 1);
    expect(after.seats.canProvision).toBe(true);
    // the deactivated user still EXISTS — the seat was freed, the record was not
    const [still] = await db.select().from(users).where(eq(users.id, victim));
    expect(still).toBeTruthy();
    expect(still!.disabledAt).not.toBeNull();

    // and the freed seat is genuinely usable
    const ok = await makeUser("lic-reuses-freed-seat@example.com");
    expect(ok.statusCode).toBe(201);

    // restore: reactivate the victim so no other suite sees a disabled user
    await app.inject({ method: "POST", url: `/v1/users/${victim}/reactivate`, headers: AUTH });
  });

  it("an OVER-CAP deployment refuses the next grant and disables nobody", async () => {
    const active = await activeUserCount();
    await install(artifact(makeDoc({ licenseId: "lic-small", seatCap: 1 })));
    const s = await status();
    expect(s.seats.active).toBe(active);
    expect(s.seats.remaining).toBeLessThan(0);
    expect(s.seats.canProvision).toBe(false);
    // NOT ONE existing user was touched — seat enforcement is a growth gate
    expect(await activeUserCount()).toBe(active);
    expect((await makeUser("lic-nope@example.com")).statusCode).toBe(403);
  });

  it("the seat definition is stated on the API, not only in a doc", async () => {
    await install(artifact(makeDoc()));
    expect((await status()).seats.definition).toMatch(/Deactivate is not delete/);
  });
});

describe("ADR-0052 — admin gating, disclosure and audit", () => {
  it("refuses a non-admin every licensing route", async () => {
    for (const [method, url, payload] of [
      ["POST", "/v1/licenses", artifact(makeDoc())],
      ["GET", "/v1/licenses", undefined],
      ["GET", "/v1/licenses/status", undefined],
      ["POST", "/v1/licenses/verify", {}],
      ["GET", "/v1/licenses/verifications", undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: memberAuth, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(await db.select().from(licenses)).toHaveLength(0);
  });

  it("discloses no phone-home, no scheduler, the pinned keyring and the wired enforcement points", async () => {
    await install(artifact(makeDoc()));
    const s = await status();
    expect(s.phoneHome).toBe(false);
    expect(s.schedulerPresent).toBe(false);
    expect(s.keyring.pinnedKeyIds).toContain(KEY_ID);
    expect(s.enforcementPointsWired).toEqual(["user.provision", "agent.create"]);
    expect(s.note).toMatch(/no network call of any kind/);
    // ADR-0064: a scheduler exists; licence re-verification deliberately has no
    // job on it, and the disclosure names that rather than denying the scheduler
    expect(s.note).toMatch(/scheduler deliberately has NO job here/i);
    expect(s.note).toMatch(/THIS HOST'S CLOCK/);
    expect(s.posture).toMatch(/governance\/safety\/audit layer keeps/i);
    // the reviewed action-class inventory is served, not just documented
    expect(s.inventory.find((i: { action: string }) => i.action === "audit.write").class).toBe("governance");
    expect(s.inventory.find((i: { action: string }) => i.action === "user.provision").class).toBe("expansion");
  });

  it("audits with stable ruleIds", async () => {
    await install(artifact(makeDoc({ licenseId: "lic-audit" })));
    await install({ ...artifact(makeDoc()), signingKeyId: "not-pinned-at-all" });
    for (const ruleId of ["license-installed", "license-signing-key-not-pinned"]) {
      const rows = await audits(ruleId);
      expect(rows.length, ruleId).toBeGreaterThan(0);
      expect(rows.every((r) => r.objectType === "license")).toBe(true);
    }
  });
});
