/**
 * ADR-0063 — DATA-KEY CUSTODY, PROVED BY ATTACK.
 *
 * The claim this file has to prove is not "there is a fingerprint column". It
 * is the scenario ADR-0035 left open and named as the sharpest edge in the
 * stack:
 *
 *   > Restoring that backup onto a NEW machine WITHOUT this key recovers every
 *   > user, every audit row, every project — and leaves every connector token,
 *   > model API key and TOTP secret PERMANENTLY undecryptable.
 *
 * So the central test performs that restore. It boots a real gateway under key
 * A against a real Postgres, stores a real encrypted credential through the
 * real route, shuts down, and boots again under key B against the same
 * database — the exact shape of a restore onto a box that does not hold the
 * original key. The assertion is **that the gateway did not start**: the
 * promise rejects, and a TCP connect to the port it would have bound is
 * REFUSED. A test that only checked for a log line would pass against a gateway
 * that logged a warning and served traffic anyway, which is precisely the
 * behaviour this ADR rejects.
 *
 * Everything else follows from taking that seriously:
 *
 *  - the fingerprint must be STABLE (or the gate flaps), DIFFERENT per key (or
 *    it gates nothing), and must NOT LEAK THE KEY — asserted by searching the
 *    fingerprint for every 8-character substring of the key rather than by
 *    trusting the word "HMAC" in a comment;
 *  - the legitimate mismatch (a declared rotation) must be able to get through,
 *    and a STALE declaration must not;
 *  - a first boot that finds ciphertext its key cannot open must refuse too —
 *    otherwise the very first boot after the upgrade would launder the wrong
 *    key into the permanent record;
 *  - and the whole thing must be invisible to `buildApp`, because a boot gate
 *    that breaks app construction is a boot gate that gets disabled. That is
 *    asserted directly, with a deliberately mismatched key.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createDb,
  dataKeyAttestations,
  dataKeyState,
  desc,
  eq,
  modelCredentials,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { startGateway } from "./boot.js";
import {
  CIPHERTEXT_COLUMNS,
  DATA_KEY_ROTATION_ENV,
  DATA_KEY_RULE_IDS,
  DataKeyBootError,
  FINGERPRINT_DOMAIN,
  FINGERPRINT_PREFIX,
  dataKeyFingerprint,
  decideDataKeyBoot,
  fingerprintsMatch,
  probeCiphertext,
  verifyDataKeyOnBoot,
} from "./data-key.js";
import { dataKeyFormatError, encryptSecret } from "./secrets.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

// Per-RUN unique (pid + timestamp): a fixed name plus beforeAll's
// DROP ... WITH (FORCE) lets two concurrent runs on one host destroy each
// other's database (PENDING §5); afterAll drops this one, so nothing persists.
const SCRATCH_DB = `regulait_dk_custody_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "data-key-custody-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

/** three DISTINCT, well-formed AES-256 keys */
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
/** differs from KEY_A in a single nibble — the avalanche check */
const KEY_A_PRIME = "a".repeat(63) + "b";

const FP_A = dataKeyFingerprint(KEY_A);
const FP_B = dataKeyFingerprint(KEY_B);

let admin: Db;
let db: Db;

/** a port nothing else holds, discovered once and reused so "is anything
 * listening here?" is a meaningful question across the whole file */
let port: number;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/** true when something answers on `port`. This is the assertion behind
 * "the gateway refused to start" — not a log line, a closed socket. */
async function somethingIsListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(2000, () => done(false));
  });
}

interface BootAttempt {
  app?: Awaited<ReturnType<typeof startGateway>>["app"];
  code?: string;
  log: string[];
  error?: unknown;
}

/** drive the REAL boot sequence main.ts runs */
async function boot(dataKey: string | undefined, extraEnv: Record<string, string> = {}): Promise<BootAttempt> {
  const log: string[] = [];
  try {
    const started = await startGateway({
      db,
      migrationsFolder,
      port,
      host: "127.0.0.1",
      bootstrapToken: BOOT,
      dataKey,
      log: (line) => log.push(line),
      env: { ...process.env, ...extraEnv },
    });
    return { app: started.app, code: started.dataKey.code, log };
  } catch (error) {
    return { log, error };
  }
}

async function lastAudit(ruleId: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ruleId, ruleId))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row;
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(scratchUrl);
  await runMigrations(db, migrationsFolder);
  port = await freePort();
}, 60_000);

afterAll(async () => {
  await closeAll([
    async () => {
      await dropScratchDatabase(admin, SCRATCH_DB);
    },
  ]);
});

// ===========================================================================
// 1. THE FINGERPRINT — stable, discriminating, and not the key
// ===========================================================================

describe("the fingerprint", () => {
  it("is stable for the same key and different for a different key", () => {
    expect(dataKeyFingerprint(KEY_A)).toBe(FP_A);
    expect(dataKeyFingerprint(KEY_A)).toBe(dataKeyFingerprint(KEY_A));
    expect(FP_A).not.toBe(FP_B);
    // uppercase hex is the same key, and must not look like a different one
    expect(dataKeyFingerprint(KEY_A.toUpperCase())).toBe(FP_A);
  });

  it("has the documented shape: dk1: + 32 hex characters", () => {
    expect(FP_A.startsWith(FINGERPRINT_PREFIX)).toBe(true);
    expect(FP_A.slice(FINGERPRINT_PREFIX.length)).toMatch(/^[0-9a-f]{32}$/);
    // length is a constant of the scheme, never a function of the key
    expect(dataKeyFingerprint(KEY_A_PRIME).length).toBe(FP_A.length);
  });

  it("DOES NOT LEAK THE KEY — no 8-character run of the key appears in it, in either direction", () => {
    for (const key of [KEY_A, KEY_B, "0123456789abcdef".repeat(4)]) {
      const fp = dataKeyFingerprint(key);
      const body = fp.slice(FINGERPRINT_PREFIX.length);
      expect(fp).not.toBe(key);
      expect(body).not.toBe(key);
      expect(key.startsWith(body)).toBe(false);
      expect(body.startsWith(key.slice(0, body.length))).toBe(false);
      for (let i = 0; i + 8 <= key.length; i++) {
        expect(fp.includes(key.slice(i, i + 8))).toBe(false);
      }
      for (let i = 0; i + 8 <= body.length; i++) {
        expect(key.includes(body.slice(i, i + 8))).toBe(false);
      }
    }
  });

  it("avalanches: a one-nibble key change rewrites the whole fingerprint", () => {
    const a = FP_A.slice(FINGERPRINT_PREFIX.length);
    const b = dataKeyFingerprint(KEY_A_PRIME).slice(FINGERPRINT_PREFIX.length);
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same += 1;
    // 32 hex chars; ~2 collisions expected by chance. 12 is a wide margin that
    // still fails hard for any scheme that copied part of the key through.
    expect(same).toBeLessThan(12);
  });

  it("is domain-separated — the same key under a different message gives a different value", () => {
    const other = createHmac("sha256", Buffer.from(KEY_A, "hex"))
      .update("regulait/some-other-purpose", "utf8")
      .digest()
      .subarray(0, 16)
      .toString("hex");
    expect(FP_A.slice(FINGERPRINT_PREFIX.length)).not.toBe(other);
    // and it really is the documented derivation, not something adjacent
    const expected = createHmac("sha256", Buffer.from(KEY_A, "hex"))
      .update(FINGERPRINT_DOMAIN, "utf8")
      .digest()
      .subarray(0, 16)
      .toString("hex");
    expect(FP_A).toBe(FINGERPRINT_PREFIX + expected);
  });

  it("refuses a key the envelope itself would refuse, and says which way it is wrong", () => {
    // D01 sharpened these messages: both still refuse, and each now names its
    // OWN problem rather than both reporting a length. Asserting the specific
    // wording is the point — a fingerprint that cannot be derived is the last
    // moment before an operator is handed something unactionable.
    expect(() => dataKeyFingerprint("deadbeef")).toThrow(/8 hex characters.*exactly 64/);
    expect(() => dataKeyFingerprint("")).toThrow(/it is empty/);
    expect(() => dataKeyFingerprint("zzzz")).toThrow(/not hex digits/);
  });

  it("fingerprintsMatch is total — a null on either side is never a match", () => {
    expect(fingerprintsMatch(FP_A, FP_A)).toBe(true);
    expect(fingerprintsMatch(FP_A, FP_B)).toBe(false);
    expect(fingerprintsMatch(null, null)).toBe(false);
    expect(fingerprintsMatch(FP_A, null)).toBe(false);
    expect(fingerprintsMatch(null, FP_A)).toBe(false);
  });
});

// ===========================================================================
// 2. THE BOOT MATRIX, as a pure function — every row, including the refusals
// ===========================================================================

describe("the boot decision", () => {
  const decide = (over: Partial<Parameters<typeof decideDataKeyBoot>[0]>) =>
    decideDataKeyBoot({
      malformed: null,
      current: null,
      recorded: null,
      rotatedFrom: null,
      probe: null,
      ...over,
    });

  it("no key + nothing recorded = nothing to check", () => {
    const d = decide({});
    expect(d.code).toBe("no_key_configured");
    expect(d.ok).toBe(true);
  });

  it("key + nothing recorded + no ciphertext = record it", () => {
    const d = decide({ current: FP_A, probe: { sampled: 0, decrypted: 0, columns: [] } });
    expect(d.code).toBe("recorded");
    expect(d.ok).toBe(true);
    expect(d.message).toContain("nothing to verify against");
  });

  it("key + nothing recorded + ciphertext it CAN open = record it, with the proof named", () => {
    const d = decide({ current: FP_A, probe: { sampled: 4, decrypted: 4, columns: ["users.totp_secret_ciphertext"] } });
    expect(d.code).toBe("recorded");
    expect(d.ok).toBe(true);
    expect(d.message).toContain("4/4");
  });

  it("key + nothing recorded + ciphertext it CANNOT open = REFUSE", () => {
    const d = decide({ current: FP_B, probe: { sampled: 3, decrypted: 0, columns: ["model_credentials.key_ciphertext"] } });
    expect(d.code).toBe("undecryptable");
    expect(d.ok).toBe(false);
    expect(d.message).toContain("REFUSING TO START");
  });

  it("a PARTIAL decrypt is not a refusal — it is the middle of an out-of-band re-encryption", () => {
    const d = decide({ current: FP_A, probe: { sampled: 4, decrypted: 1, columns: ["x.y"] } });
    expect(d.code).toBe("recorded");
    expect(d.message).toContain("1/4");
  });

  it("matching fingerprint = ordinary boot", () => {
    const d = decide({ current: FP_A, recorded: FP_A });
    expect(d.code).toBe("verified");
    expect(d.ok).toBe(true);
  });

  it("MISMATCH = REFUSE, naming both fingerprints and what it means", () => {
    const d = decide({ current: FP_B, recorded: FP_A });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("mismatch");
    expect(d.message).toContain(FP_A);
    expect(d.message).toContain(FP_B);
    expect(d.message).toContain("RESTORE ONTO A NEW BOX");
    expect(d.message).toContain(DATA_KEY_ROTATION_ENV);
  });

  it("recorded but NO key in the process = REFUSE", () => {
    const d = decide({ current: null, recorded: FP_A });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("key_missing");
    expect(d.message).toContain(FP_A);
  });

  it("a rotation declaration naming the recorded key is accepted, and says what it did NOT do", () => {
    const d = decide({ current: FP_B, recorded: FP_A, rotatedFrom: FP_A });
    expect(d.ok).toBe(true);
    expect(d.code).toBe("rotation_accepted");
    expect(d.message).toContain("Nothing has been re-encrypted");
  });

  it("a STALE rotation declaration does NOT bless a later mismatch", () => {
    const stale = dataKeyFingerprint("c".repeat(64));
    const d = decide({ current: FP_B, recorded: FP_A, rotatedFrom: stale });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("mismatch");
    expect(d.message).toContain("was ignored");
  });
});

// ===========================================================================
// 3. THE RESTORE, END TO END — the scenario ADR-0035 left open
// ===========================================================================

// ===========================================================================
// 2b. A MALFORMED KEY — the shape check that runs BEFORE any of the above
// ===========================================================================
//
// D01. Before this existed the refusal was correct and the MESSAGE was not:
// `fingerprintOrNull` hashed `Buffer.from(x, "hex")`, `keyBytes` threw three
// frames down, and `main.ts` — whose whole job is to print an operator
// sentence rather than a stack trace — re-raised it as a stack trace, because
// it only special-cases DataKeyBootError.
//
// The regression these tests really guard is subtler than the message. The
// switch in `verifyDataKeyOnBoot` is what stops a boot; `decision.ok === false`
// stops nothing. A new code with no case would fall through and the deployment
// would COME UP on a key it had just refused.

describe("a malformed data key", () => {
  it("names what is wrong, and names base64 specifically because that is the mistake people make", () => {
    // 32 random bytes in base64 — the exact thing `openssl rand -base64 32` prints
    const asBase64 = Buffer.from("a".repeat(32), "utf8").toString("base64");
    const problem = dataKeyFormatError(asBase64);
    expect(problem).toMatch(/not hex digits/);
    expect(problem).toMatch(/BASE64/);
    expect(problem).toMatch(/openssl rand -hex 32/);
  });

  it("distinguishes 'not hex' from 'wrong length', because they need different fixes", () => {
    expect(dataKeyFormatError("a".repeat(63))).toMatch(/63 hex characters/);
    expect(dataKeyFormatError("a".repeat(65))).toMatch(/65 hex characters/);
    // 64 characters, one of them not hex: the length is right and the message
    // must NOT say the length is wrong
    const typo = "a".repeat(63) + "z";
    expect(dataKeyFormatError(typo)).toMatch(/not hex digits/);
    expect(dataKeyFormatError(typo)).not.toMatch(/hex characters, and exactly/);
  });

  it("accepts the real thing, in either case, with whitespace around it", () => {
    expect(dataKeyFormatError(KEY_A)).toBeNull();
    expect(dataKeyFormatError(KEY_A.toUpperCase())).toBeNull();
    expect(dataKeyFormatError(`  ${KEY_A}\n`)).toBeNull();
    expect(dataKeyFormatError("")).toBe("it is empty");
  });

  it("is the SAME authority the cipher uses — anything it accepts, encryptSecret accepts", () => {
    // the drift this prevents: a validator that is more lenient than the
    // parser would let a key past the gate and fail at the first write, which
    // is precisely the failure D01 is about.
    expect(dataKeyFormatError(KEY_A)).toBeNull();
    expect(() => encryptSecret(KEY_A, "x")).not.toThrow();
    expect(dataKeyFormatError("zz")).not.toBeNull();
    expect(() => encryptSecret("zz", "x")).toThrow(/unusable/);
  });

  it("is decided FIRST — ahead of every custody question, and never reports as a mismatch", () => {
    const d = decideDataKeyBoot({
      malformed: "it is 10 hex characters, and exactly 64 are required (32 bytes, AES-256).",
      current: null,
      // a recorded key is present: without the first-branch ordering this
      // would come back `key_missing`, which would send an operator hunting a
      // lost key rather than fixing a typo
      recorded: FP_A,
      rotatedFrom: null,
      probe: null,
    });
    expect(d.code).toBe("malformed_key");
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/REFUSING TO START/);
    expect(d.message).toMatch(/configuration error, not a key-custody problem/);
  });
});

describe("restore onto a new box", () => {
  it("first boot with key A records the fingerprint and comes up normally", async () => {
    const attempt = await boot(KEY_A);
    expect(attempt.error).toBeUndefined();
    expect(attempt.code).toBe("recorded");
    expect(await somethingIsListening()).toBe(true);

    const [row] = await db.select().from(dataKeyState);
    expect(row?.fingerprint).toBe(FP_A);
    expect(row?.rotatedFrom).toBeNull();

    // the posture block says which key this box is running, and that nobody
    // has claimed to hold it
    const line = attempt.log.find((l) => l.includes("data key:"));
    expect(line).toContain(FP_A);
    expect(line).toContain("NO CUSTODY ATTESTATION");

    const audited = await lastAudit(DATA_KEY_RULE_IDS.recorded);
    expect(audited?.effect).toBe("allow");
    expect((audited?.detail as { fingerprint?: string }).fingerprint).toBe(FP_A);

    // ... and a REAL encrypted credential is written through the real route,
    // so the next boot has genuine ciphertext to be wrong about
    const res = await attempt.app!.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "anthropic", apiKey: "sk-ant-custody-fixture" },
    });
    expect(res.statusCode).toBe(201);
    const [cred] = await db.select().from(modelCredentials).where(eq(modelCredentials.provider, "anthropic"));
    expect(cred?.keyCiphertext).toBeTruthy();
    expect(cred!.keyCiphertext).not.toContain("sk-ant-custody-fixture");

    await attempt.app!.close();
    expect(await somethingIsListening()).toBe(false);
  });

  it("restarting with the SAME key boots silently — no complaint, and last_verified_at moves", async () => {
    const [before] = await db.select().from(dataKeyState);
    const attempt = await boot(KEY_A);
    expect(attempt.error).toBeUndefined();
    expect(attempt.code).toBe("verified");
    expect(await somethingIsListening()).toBe(true);

    const line = attempt.log.find((l) => l.includes("data key:"))!;
    expect(line).toContain("verified");
    expect(line).not.toContain("REFUS");

    const [after] = await db.select().from(dataKeyState);
    expect(after!.lastVerifiedAt.getTime()).toBeGreaterThanOrEqual(before!.lastVerifiedAt.getTime());
    expect(after!.fingerprint).toBe(FP_A);

    await attempt.app!.close();
  });

  it("THE RESTORE: restarting with key B against key A's database REFUSES TO START", async () => {
    expect(await somethingIsListening()).toBe(false);

    const attempt = await boot(KEY_B);

    // 1. the boot rejected
    expect(attempt.error).toBeInstanceOf(DataKeyBootError);
    const err = attempt.error as DataKeyBootError;
    expect(err.decision.code).toBe("mismatch");

    // 2. it named BOTH fingerprints and what the mismatch means
    expect(err.message).toContain(FP_A);
    expect(err.message).toContain(FP_B);
    expect(err.message).toContain("DATA KEY MISMATCH");
    expect(err.message).toContain("RESTORE ONTO A NEW BOX");
    expect(err.recorded).toBe(FP_A);
    expect(err.current).toBe(FP_B);

    // 3. THE ASSERTION THAT MATTERS: nothing is serving. Not "a warning was
    //    logged" — the socket was never bound.
    expect(await somethingIsListening()).toBe(false);
    expect(attempt.log.some((l) => l.includes("listening on"))).toBe(false);

    // 4. and the refusal is IN THE AUDIT TRAIL, written before the throw, so
    //    the reason a deployment would not come up survives the console
    const audited = await lastAudit(DATA_KEY_RULE_IDS.mismatch);
    expect(audited?.effect).toBe("deny");
    expect(audited?.objectType).toBe("data_key");
    expect((audited?.detail as { recorded?: string; running?: string })).toMatchObject({
      recorded: FP_A,
      running: FP_B,
    });

    // 5. the recorded fingerprint was NOT overwritten by the failed attempt
    const [row] = await db.select().from(dataKeyState);
    expect(row?.fingerprint).toBe(FP_A);
  });

  it("a STALE rotation declaration does not get a restore through", async () => {
    const attempt = await boot(KEY_B, { [DATA_KEY_ROTATION_ENV]: dataKeyFingerprint("f".repeat(64)) });
    expect(attempt.error).toBeInstanceOf(DataKeyBootError);
    expect((attempt.error as DataKeyBootError).decision.code).toBe("mismatch");
    expect(await somethingIsListening()).toBe(false);
  });

  it("removing the key entirely from a deployment that HAS one also refuses", async () => {
    const attempt = await boot(undefined);
    expect(attempt.error).toBeInstanceOf(DataKeyBootError);
    expect((attempt.error as DataKeyBootError).decision.code).toBe("key_missing");
    expect(await somethingIsListening()).toBe(false);
    expect((await lastAudit(DATA_KEY_RULE_IDS.keyMissing))?.effect).toBe("deny");
  });

  it("the DECLARED rotation is the documented way through, and is audited with both keys", async () => {
    const attempt = await boot(KEY_B, { [DATA_KEY_ROTATION_ENV]: FP_A });
    expect(attempt.error).toBeUndefined();
    expect(attempt.code).toBe("rotation_accepted");
    expect(await somethingIsListening()).toBe(true);

    const [row] = await db.select().from(dataKeyState);
    expect(row?.fingerprint).toBe(FP_B);
    expect(row?.rotatedFrom).toBe(FP_A);
    expect(row?.rotatedAt).not.toBeNull();

    const audited = await lastAudit(DATA_KEY_RULE_IDS.rotated);
    expect((audited?.detail as { from?: string; to?: string })).toMatchObject({ from: FP_A, to: FP_B });

    await attempt.app!.close();
  });

  it("after the rotation, key A is now the intruder — the gate is symmetric", async () => {
    const attempt = await boot(KEY_A);
    expect(attempt.error).toBeInstanceOf(DataKeyBootError);
    expect((attempt.error as DataKeyBootError).recorded).toBe(FP_B);
    expect(await somethingIsListening()).toBe(false);

    // put the deployment back under key A for the remaining suites
    const back = await boot(KEY_A, { [DATA_KEY_ROTATION_ENV]: FP_B });
    expect(back.code).toBe("rotation_accepted");
    await back.app!.close();
  });
});

// ===========================================================================
// 4. THE FIRST BOOT AFTER UPGRADE — the window where the wrong key could have
//    been laundered into the record
// ===========================================================================

describe("first boot after upgrade", () => {
  // per-run unique for the same concurrency reason as SCRATCH_DB above
  const UPGRADE_DB = `regulait_dk_upgrade_${process.pid}_${Date.now()}`;
  const upgradeUrl = (() => {
    const u = new URL(DATABASE_URL!);
    u.pathname = "/" + UPGRADE_DB;
    return u.toString();
  })();
  let legacy: Db;

  beforeAll(async () => {
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${UPGRADE_DB} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${UPGRADE_DB}`));
    legacy = createDb(upgradeUrl);
    await runMigrations(legacy, migrationsFolder);
    // a pre-existing deployment: ciphertext written under key A, and no
    // fingerprint recorded because the column did not exist when it was written
    await legacy
      .insert(modelCredentials)
      .values({ provider: "anthropic", keyCiphertext: encryptSecret(KEY_A, "legacy-secret") });
    await legacy.delete(dataKeyState);
  }, 60_000);

  afterAll(async () => {
    await closeAll([
      async () => {
        await dropScratchDatabase(admin, UPGRADE_DB);
      },
    ]);
  });

  it("the probe reads real stored ciphertext and tells the two keys apart", async () => {
    const right = await probeCiphertext(legacy, KEY_A);
    expect(right.sampled).toBeGreaterThan(0);
    expect(right.decrypted).toBe(right.sampled);
    expect(right.columns).toContain("model_credentials.key_ciphertext");

    const wrong = await probeCiphertext(legacy, KEY_B);
    expect(wrong.sampled).toBe(right.sampled);
    expect(wrong.decrypted).toBe(0);
  });

  it("REFUSES to record a key that cannot open the ciphertext already in the database", async () => {
    await expect(verifyDataKeyOnBoot(legacy, KEY_B, {})).rejects.toBeInstanceOf(DataKeyBootError);
    // nothing was written — the wrong key did not become the record
    expect(await legacy.select().from(dataKeyState)).toEqual([]);
    const [audited] = await legacy
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, DATA_KEY_RULE_IDS.undecryptable))
      .limit(1);
    expect(audited?.effect).toBe("deny");
  });

  it("records the RIGHT key, and says it proved it against real ciphertext", async () => {
    const res = await verifyDataKeyOnBoot(legacy, KEY_A, {});
    expect(res.code).toBe("recorded");
    expect(res.probe!.decrypted).toBeGreaterThan(0);
    const [row] = await legacy.select().from(dataKeyState);
    expect(row?.fingerprint).toBe(FP_A);
  });

  it("a deployment with NO ciphertext at all still records on first boot", async () => {
    await legacy.delete(dataKeyState);
    await legacy.delete(modelCredentials);
    const res = await verifyDataKeyOnBoot(legacy, KEY_B, {});
    expect(res.code).toBe("recorded");
    expect(res.probe!.sampled).toBe(0);
    expect(res.message).toContain("nothing to verify against");
  });

  it("no key and no record is a disclosed state, not a failure", async () => {
    await legacy.delete(dataKeyState);
    const res = await verifyDataKeyOnBoot(legacy, undefined, {});
    expect(res.code).toBe("no_key_configured");
    expect(res.ok).toBe(true);
  });

  it("D01: a base64 key REFUSES THE BOOT as a DataKeyBootError, not a raw throw", async () => {
    await legacy.delete(dataKeyState);
    await legacy.delete(auditLog);
    const asBase64 = Buffer.from("a".repeat(32), "utf8").toString("base64");

    // the type is the whole point: main.ts only prints the operator sentence
    // for DataKeyBootError and re-raises anything else as a stack trace, which
    // is exactly what a bare Error out of keyBytes used to produce.
    const err = await verifyDataKeyOnBoot(legacy, asBase64, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataKeyBootError);
    expect((err as DataKeyBootError).decision.code).toBe("malformed_key");
    expect((err as DataKeyBootError).message).toMatch(/openssl rand -hex 32/);

    // and it REFUSED — a code whose case is missing from the switch would
    // return here instead of throwing, and the deployment would come up
    expect((err as DataKeyBootError).decision.ok).toBe(false);

    // nothing was recorded: no fingerprint was derived, so the recorded key
    // was never compared against anything
    expect(await legacy.select().from(dataKeyState)).toEqual([]);

    // but the refusal IS in the trail, and the key is NOT
    const [filed] = await legacy
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, DATA_KEY_RULE_IDS.malformed))
      .limit(1);
    expect(filed?.effect).toBe("deny");
    expect(JSON.stringify(filed?.detail ?? {})).not.toContain(asBase64);
  });
});

// ===========================================================================
// 5. CUSTODY ATTESTATION — a record, not a checkbox
// ===========================================================================

describe("custody attestation", () => {
  let app: ReturnType<typeof buildApp>;
  let adminUserId: string;
  let adminAuth: { authorization: string };

  beforeAll(async () => {
    app = buildApp(db, { bootstrapToken: BOOT, dataKey: KEY_A });
    const u = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "custodian@example.com", displayName: "Ops Custodian", isAdmin: true },
    });
    adminUserId = u.json().id;
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${adminUserId}/admin`, payload: { isAdmin: true } });
    const key = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${adminUserId}/keys`,
      payload: { name: "cli" },
    });
    adminAuth = { authorization: `Bearer ${key.json().token}` };
  });

  afterAll(async () => {
    await app?.close();
  });

  it("reports the UNATTESTED state prominently, and says why it matters", async () => {
    await db.delete(dataKeyAttestations);
    const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/security/data-key" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fingerprint).toBe(FP_A);
    expect(body.recordedFingerprint).toBe(FP_A);
    expect(body.matches).toBe(true);
    expect(body.attested).toBe(false);
    expect(body.attestationCount).toBe(0);
    expect(body.warnings.join(" ")).toContain("NO CUSTODY ATTESTATION");
    expect(body.warnings.join(" ")).toContain("may not be restorable");
    // it publishes the derivation rather than asking anyone to trust it
    expect(body.derivation).toContain(FINGERPRINT_DOMAIN);
    // and never the key
    expect(JSON.stringify(body)).not.toContain(KEY_A);
  });

  it("records an attestation with the ACTOR and the fingerprint, and audits it", async () => {
    const res = await app.inject({
      method: "POST",
      headers: adminAuth,
      url: "/v1/security/data-key/attestations",
      payload: {
        method: "password_manager",
        locationHint: "1Password vault: Platform Ops",
        note: "restore rehearsal 2026-08",
        confirmRecordedOutOfBand: true,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().fingerprint).toBe(FP_A);
    expect(res.json().limits).toContain("does not verify custody");

    const [row] = await db.select().from(dataKeyAttestations).where(eq(dataKeyAttestations.fingerprint, FP_A));
    expect(row?.attestedByUserId).toBe(adminUserId);
    expect(row?.attestedByLabel).toContain("custodian@example.com");
    expect(row?.method).toBe("password_manager");

    const audited = await lastAudit(DATA_KEY_RULE_IDS.attested);
    expect(audited?.userId).toBe(adminUserId);
    expect((audited?.detail as { fingerprint?: string }).fingerprint).toBe(FP_A);
    expect(audited?.reason).toContain("cannot verify custody");
  });

  it("flips the posture and the boot line once attested", async () => {
    const body = (await app.inject({ method: "GET", headers: AUTH, url: "/v1/security/data-key" })).json();
    expect(body.attested).toBe(true);
    expect(body.attestationCount).toBe(1);
    expect(body.latestAttestation.attestedByLabel).toContain("Ops Custodian");
    expect(body.warnings.join(" ")).not.toContain("NO CUSTODY ATTESTATION");

    const res = await verifyDataKeyOnBoot(db, KEY_A, {});
    expect(res.attested).toBe(true);
  });

  it("an explicit confirmation is required — an implied one is not an attestation", async () => {
    const res = await app.inject({
      method: "POST",
      headers: adminAuth,
      url: "/v1/security/data-key/attestations",
      payload: { method: "kms" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("REFUSES to let anyone paste the key into the field that says where the key is", async () => {
    const res = await app.inject({
      method: "POST",
      headers: adminAuth,
      url: "/v1/security/data-key/attestations",
      payload: { method: "other", locationHint: `the key is ${KEY_B}`, confirmRecordedOutOfBand: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("looks_like_key_material");
    const rows = await db.select().from(dataKeyAttestations);
    expect(rows.every((r) => !(r.locationHint ?? "").includes(KEY_B))).toBe(true);
  });

  it("an attestation of the OLD key does not silently cover a rotated-to key", async () => {
    const rotated = await verifyDataKeyOnBoot(db, KEY_B, { [DATA_KEY_ROTATION_ENV]: FP_A });
    expect(rotated.code).toBe("rotation_accepted");
    expect(rotated.attested).toBe(false);

    // restore the singleton for anything that runs after this file
    await verifyDataKeyOnBoot(db, KEY_A, { [DATA_KEY_ROTATION_ENV]: FP_B });
  });

  it("is admin-only", async () => {
    const member = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "not-custodian@example.com", displayName: "Member" },
    });
    const key = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${member.json().id}/keys`,
      payload: { name: "cli" },
    });
    const memberAuth = { authorization: `Bearer ${key.json().token}` };
    expect((await app.inject({ method: "GET", headers: memberAuth, url: "/v1/security/data-key" })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          headers: memberAuth,
          url: "/v1/security/data-key/attestations",
          payload: { method: "kms", confirmRecordedOutOfBand: true },
        })
      ).statusCode,
    ).toBe(403);
  });
});

// ===========================================================================
// 6. THE GATE MUST NOT LEAK INTO APP CONSTRUCTION
//
// A boot-refusal feature that breaks `buildApp` is a boot-refusal feature that
// gets deleted. ~100 test files construct apps against databases whose recorded
// fingerprint they know nothing about; every one of them must be unaffected.
// ===========================================================================

describe("app construction is untouched by the gate", () => {
  it("buildApp with a key that would REFUSE at boot still constructs and serves", async () => {
    const [row] = await db.select().from(dataKeyState);
    expect(row?.fingerprint).toBe(FP_A);

    // deliberately the wrong key for this database
    const app = buildApp(db, { bootstrapToken: BOOT, dataKey: KEY_B });
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    // and the posture endpoint reports the disagreement rather than throwing
    const body = (await app.inject({ method: "GET", headers: AUTH, url: "/v1/security/data-key" })).json();
    expect(body.matches).toBe(false);
    expect(body.warnings.join(" ")).toContain("A gateway boot would refuse");
    await app.close();
  });

  it("buildApp with NO key at all still constructs against a database that has a fingerprint", async () => {
    const app = buildApp(db, { bootstrapToken: BOOT });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const body = (await app.inject({ method: "GET", headers: AUTH, url: "/v1/security/data-key" })).json();
    expect(body.fingerprint).toBeNull();
    expect(body.recordedFingerprint).toBe(FP_A);
    await app.close();
  });
});

// ===========================================================================
// 7. THE CIPHERTEXT INVENTORY MUST NOT DRIFT
// ===========================================================================

describe("the ciphertext inventory", () => {
  it("names every *_ciphertext column in the schema — a new one cannot escape the probe", () => {
    const schemaPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../packages/db/src/schema.ts",
    );
    const lines = readFileSync(schemaPath, "utf8").split("\n");
    const found = new Set<string>();
    let table: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.includes("pgTable(")) {
        const inline = /pgTable\(\s*"([a-z_]+)"/.exec(line);
        table = inline ? inline[1]! : (/"([a-z_]+)"/.exec(lines[i + 1] ?? "")?.[1] ?? null);
      }
      const col = /text\("(\w*_ciphertext)"\)/.exec(line);
      if (col && table) found.add(`${table}.${col[1]}`);
    }
    const declared = new Set(CIPHERTEXT_COLUMNS.map((c) => `${c.table}.${c.column}`));
    expect([...found].sort()).toEqual([...declared].sort());
  });
});
