/**
 * ADR-0063 — `REGULAIT_DATA_KEY` CUSTODY AND RESTORE-TIME VERIFICATION.
 *
 * ## The hole this closes
 *
 * `REGULAIT_DATA_KEY` is the AES-256-GCM envelope key over every stored secret
 * in the product: OIDC client secrets, TOTP secrets, model-provider API keys,
 * connector/git/PM tokens, SAML SP private keys, deploy-target credentials,
 * the ChatOps signing secret.
 *
 * ADR-0035 deliberately does NOT put that key in the S3 backup. Storing a key
 * beside the ciphertext it protects makes the envelope split decorative, so
 * that decision is correct and stands. Its consequence was recorded, in
 * writing, as the sharpest edge in the stack and then left open:
 *
 *   > Restoring that backup onto a NEW machine WITHOUT this key recovers every
 *   > user, every audit row, every project — and leaves every connector token,
 *   > model API key and TOTP secret PERMANENTLY undecryptable. There is no
 *   > recovery path, no support escalation, no reset.
 *   >   — `scripts/install.sh`, and ADR-0035 §"the sharpest edge"
 *
 * The split is deliberate. The missing *custody procedure* around it was not.
 * Before this module there was nothing anywhere that told an operator whether
 * the key they were holding was the right one — not at install, not in the
 * backup artifact, and not at boot. The first symptom was a production gateway
 * that came up perfectly and then failed every decryption.
 *
 * ## What is here
 *
 *  1. `dataKeyFingerprint` — a NON-SECRET, NON-INVERTIBLE identifier for a key.
 *  2. `verifyDataKeyOnBoot` — the boot gate. It records the fingerprint on
 *     first run, verifies it on every run after, and REFUSES TO START on a
 *     mismatch.
 *  3. `dataKeyPosture` / the attestation helpers — the honest custody record.
 *
 * ## 1. The fingerprint derivation, and why it is safe to publish
 *
 *     fingerprint = "dk1:" + hex( HMAC-SHA256( key   = <the 32 raw key bytes>,
 *                                              msg   = FINGERPRINT_DOMAIN )
 *                                 [0 .. 16) )
 *
 *     FINGERPRINT_DOMAIN = "regulait/data-key-fingerprint/v1"
 *
 * Three properties, each load-bearing:
 *
 *  - **It reveals nothing about the key.** HMAC-SHA256 is a PRF under its key;
 *    recovering the key from one output is a 2^256 preimage search, and the
 *    128-bit truncation removes information rather than adding any. There is no
 *    encoding, no prefix, no substring of the key anywhere in the output —
 *    `data-key.test.ts` asserts that adversarially rather than trusting the
 *    prose.
 *  - **It is domain-separated.** The fixed message string means this value can
 *    never collide with some other HMAC the product computes under the same key
 *    (today there is none; the constant is what keeps that true tomorrow).
 *  - **It is versioned.** `dk1:` names the derivation, so a future scheme can
 *    coexist with recorded values instead of silently comparing unlike things.
 *
 * Because it is safe to publish, it can go where it is actually useful: the
 * boot log next to the proxy/HSTS/egress posture lines, a column in this
 * deployment's own database (which IS inside the backup), the backup's manifest
 * and the S3 object metadata. That last one is the point — a restore runbook
 * can now answer *"do I have the right key for this dump?"* BEFORE restoring,
 * by comparing two strings.
 *
 * ## 2. The boot matrix
 *
 * | recorded    | running key | ciphertext probe          | outcome |
 * | ----------- | ----------- | ------------------------- | ------- |
 * | none        | none        | —                         | `no_key_configured` — nothing to check. Secret WRITES are already refused without a key; this module adds no new opinion. |
 * | none        | present     | no ciphertext exists      | `recorded` — first boot. |
 * | none        | present     | ciphertext, ≥1 decrypts   | `recorded` — first boot after upgrade, with proof. |
 * | none        | present     | ciphertext, NONE decrypts | **REFUSE** `undecryptable` — the key is wrong and recording it would launder the wrong answer into the record. |
 * | matches     | present     | —                         | `verified` — normal boot, `last_verified_at` bumped. |
 * | MISMATCH    | present     | —                         | **REFUSE** `mismatch` — the restore-onto-a-new-box case. |
 * | MISMATCH    | present     | — (rotation declared)     | `rotation_accepted` — see §4. |
 * | recorded    | none        | —                         | **REFUSE** `key_missing` — the record proves this deployment had a key; booting without it is the same accident with the evidence removed. |
 *
 * Note the third row. On a first boot after upgrade we do not merely assume the
 * running key is the right one — if there is existing ciphertext we try to
 * decrypt a sample of it first. That closes the one window where "record
 * whatever key is present" could have blessed the wrong key forever.
 *
 * ## 3. Why REFUSING TO START beats booting
 *
 * The alternative — log a warning and come up — was considered and rejected.
 *
 *  - **A gateway that boots with the wrong key is not degraded, it is
 *    misleading.** Every user logs in. Every page renders. Every list of
 *    connectors, model credentials and PM connections is fully populated. The
 *    failure appears only at the moment someone *uses* one, as a generic
 *    decryption error on an unrelated screen, hours or days later, by which
 *    time the restore is "done" and the old box may be gone.
 *  - **It corrupts on write.** Nothing stops an admin re-entering a credential
 *    under the new key while the old ciphertext sits beside it. The database
 *    ends up with rows under two different keys and no marker saying which is
 *    which — a state neither key can fully read, produced by an operator trying
 *    to fix the problem.
 *  - **The refusal is the diagnosis.** The failure mode this exists for is an
 *    operator who does not yet know they have the wrong key. A start-up refusal
 *    naming both fingerprints, at the exact moment they are performing the
 *    restore, is the only signal that arrives while the correct key is still
 *    recoverable from the source box.
 *  - **The cost of a false positive is bounded and the operator holds the
 *    remedy.** There is exactly one legitimate mismatch — a deliberate key
 *    rotation — and it has a documented, explicit, audited override (§4).
 *
 * This is the same reasoning `resolveHsts` and `resolveDeployMode` use for
 * throwing on a malformed value, applied one level up: a security control whose
 * quiet failure mode is "the operator believes they are protected" fails loudly
 * instead.
 *
 * ## 4. The legitimate mismatch — rotation
 *
 *     REGULAIT_DATA_KEY_ROTATED_FROM=<the fingerprint being left behind>
 *
 * Deliberately NOT a boolean. A boolean set once sits in an env file forever,
 * blessing every future mismatch including the accidental one this module
 * exists to catch. Naming the OLD fingerprint means the operator must have read
 * the refusal, the declaration is single-use by construction (it matches
 * exactly one recorded value), and a stale one is inert rather than dangerous.
 *
 * **It does not re-encrypt anything.** Full re-encryption of every ciphertext
 * column is specified as follow-up scope in ADR-0063 and is deliberately not
 * half-built here. The override is for an operator who has already re-encrypted
 * out of band, or who accepts that the existing ciphertext is being abandoned —
 * and the accepted rotation is audited with both fingerprints so the choice is
 * a permanent record rather than an env var nobody remembers setting.
 *
 * ## 5. What the attestation honestly is
 *
 * We cannot force an operator to store a key out-of-band, and we must not
 * pretend otherwise. What we can do is make the fingerprint visible, require an
 * explicit audited statement that it has been recorded somewhere else, and make
 * the ABSENCE of that statement visible everywhere the key matters. An
 * attestation records *a named human's claim*, with a method and a
 * non-secret location hint, at a timestamp, against a specific fingerprint. It
 * does not verify custody — nothing running on this box can. Its value is that
 * "nobody has ever said they have this key" stops being invisible.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DATA_KEY_ATTESTATION_METHODS,
  auditLog,
  dataKeyAttestations,
  dataKeyState,
  eq,
  sql,
  users,
  type DataKeyAttestationMethod,
  type DataKeyAttestationRow,
  type DataKeyStateRow,
  type Db,
} from "@regulait/db";
import { decryptSecret } from "./secrets.js";

export const DATA_KEY_ENV = "REGULAIT_DATA_KEY";
export const DATA_KEY_ROTATION_ENV = "REGULAIT_DATA_KEY_ROTATED_FROM";

/** the fixed domain-separation string. Changing it invalidates every recorded
 * fingerprint on every deployment — hence the `dk1:` version tag beside it. */
export const FINGERPRINT_DOMAIN = "regulait/data-key-fingerprint/v1";
export const FINGERPRINT_PREFIX = "dk1:";
/** 128 bits. Collision-irrelevant here (we compare one value to one value) and
 * short enough that a human can read it off a screen and compare it. */
export const FINGERPRINT_BYTES = 16;

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** stable ruleIds — one audit query answers "what happened to this key" */
export const DATA_KEY_RULE_IDS = {
  recorded: "data-key-fingerprint-recorded",
  verified: "data-key-fingerprint-verified",
  mismatch: "data-key-fingerprint-mismatch",
  undecryptable: "data-key-ciphertext-undecryptable",
  keyMissing: "data-key-missing",
  rotated: "data-key-rotation-accepted",
  attested: "data-key-custody-attested",
} as const;

// ---------------------------------------------------------------------------
// 1. THE FINGERPRINT
// ---------------------------------------------------------------------------

/** Same validation the envelope itself applies, so a key that cannot encrypt
 * can never acquire a fingerprint either. */
function keyBytes(dataKeyHex: string): Buffer {
  const key = Buffer.from(dataKeyHex, "hex");
  if (key.length !== 32) throw new Error("data key must be 32 bytes (64 hex chars)");
  return key;
}

/**
 * The non-secret, non-invertible identifier for a data key. See the module
 * header §1 for the derivation and why publishing it is safe.
 */
export function dataKeyFingerprint(dataKeyHex: string): string {
  const digest = createHmac("sha256", keyBytes(dataKeyHex)).update(FINGERPRINT_DOMAIN, "utf8").digest();
  return FINGERPRINT_PREFIX + digest.subarray(0, FINGERPRINT_BYTES).toString("hex");
}

/** `null` for "this process has no key at all", which is a legitimate state
 * (secret writes are simply refused) and not a misconfiguration on its own. */
export function fingerprintOrNull(dataKeyHex: string | undefined | null): string | null {
  if (dataKeyHex === undefined || dataKeyHex === null || dataKeyHex.trim() === "") return null;
  return dataKeyFingerprint(dataKeyHex.trim());
}

/** constant-time compare of two fingerprints. They are not secret; this is
 * hygiene, not a requirement, and it also normalizes the length check. */
export function fingerprintsMatch(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// 2. THE CIPHERTEXT PROBE
// ---------------------------------------------------------------------------

/**
 * EVERY column in the schema that holds a `REGULAIT_DATA_KEY` envelope.
 *
 * This list is the answer to "what does losing the key actually cost", it is
 * what the first-boot probe samples, and it is the work list for the rotation
 * follow-up in ADR-0063. `data-key.test.ts` asserts it stays in step with the
 * schema by grepping for `*_ciphertext` columns — a thirteenth column added
 * without a line here fails the build rather than quietly escaping the probe.
 */
export const CIPHERTEXT_COLUMNS: ReadonlyArray<{ table: string; column: string; what: string }> = [
  { table: "users", column: "totp_secret_ciphertext", what: "TOTP enrolment secrets" },
  { table: "oidc_providers", column: "client_secret_ciphertext", what: "OIDC client secrets" },
  { table: "saml_providers", column: "sp_private_key_ciphertext", what: "SAML SP private keys" },
  { table: "model_credentials", column: "key_ciphertext", what: "platform model API keys" },
  { table: "user_model_credentials", column: "key_ciphertext", what: "per-user model API keys" },
  { table: "custom_model_providers", column: "key_ciphertext", what: "custom provider API keys" },
  { table: "connector_credentials", column: "token_ciphertext", what: "connector tokens" },
  { table: "git_connections", column: "token_ciphertext", what: "git provider tokens" },
  { table: "pm_connections", column: "token_ciphertext", what: "PM tool tokens" },
  { table: "pm_connections", column: "webhook_secret_ciphertext", what: "PM webhook secrets" },
  { table: "deploy_targets", column: "credential_ciphertext", what: "deploy-target credentials" },
  { table: "chatops_connections", column: "signing_secret_ciphertext", what: "ChatOps signing secrets" },
];

export interface CiphertextProbe {
  /** how many stored ciphertexts we looked at (0 = a deployment with no secrets yet) */
  sampled: number;
  /** how many of them the running key opened */
  decrypted: number;
  /** the columns that contributed a sample, for the refusal message */
  columns: string[];
}

/**
 * Try the running key against a bounded sample of real stored ciphertext.
 *
 * This is what makes the first-boot record a PROOF rather than an assumption.
 * `perColumn` is small on purpose: one successful decryption already settles
 * the question, and a boot gate must not turn into a table scan.
 *
 * A MIXED result (some decrypt, some do not) counts as success. That state can
 * only arise from a partially-completed out-of-band re-encryption, and in that
 * situation refusing to boot removes the only tool the operator has for
 * finishing it. It is reported in `sampled`/`decrypted` so the boot line can
 * say so.
 */
export async function probeCiphertext(
  db: Db,
  dataKeyHex: string,
  perColumn = 2,
): Promise<CiphertextProbe> {
  const parts = CIPHERTEXT_COLUMNS.map(
    (c) =>
      `(SELECT '${c.table}.${c.column}' AS src, ${c.column} AS v FROM ${c.table} ` +
      `WHERE ${c.column} IS NOT NULL LIMIT ${perColumn})`,
  );
  const res = await db.execute(sql.raw(parts.join(" UNION ALL ")));
  const rows = (res as unknown as { rows: Array<{ src: string; v: string }> }).rows ?? [];

  let decrypted = 0;
  const columns = new Set<string>();
  for (const row of rows) {
    columns.add(row.src);
    try {
      decryptSecret(dataKeyHex, row.v);
      decrypted += 1;
    } catch {
      // a GCM tag failure here is the signal, not an error to propagate
    }
  }
  return { sampled: rows.length, decrypted, columns: [...columns].sort() };
}

// ---------------------------------------------------------------------------
// 3. THE BOOT DECISION (pure)
// ---------------------------------------------------------------------------

export type DataKeyBootCode =
  | "no_key_configured"
  | "recorded"
  | "verified"
  | "rotation_accepted"
  | "mismatch"
  | "key_missing"
  | "undecryptable";

export interface DataKeyBootDecision {
  code: DataKeyBootCode;
  /** false = the gateway must not start */
  ok: boolean;
  /** operator-facing sentence. On a refusal this IS the error message. */
  message: string;
}

export interface DataKeyBootInput {
  /** fingerprint of the key this process is running with, or null for none */
  current: string | null;
  /** fingerprint this deployment's ciphertext was written under, or null */
  recorded: string | null;
  /** `REGULAIT_DATA_KEY_ROTATED_FROM`, trimmed, or null */
  rotatedFrom: string | null;
  /** null when no probe was run (no key, or nothing to prove) */
  probe: CiphertextProbe | null;
}

/**
 * THE WHOLE MATRIX, as one pure function. Kept separate from the database so
 * every branch — including the two refusals — is exercised directly rather than
 * only through an integration path that has to arrange a real restore.
 */
export function decideDataKeyBoot(input: DataKeyBootInput): DataKeyBootDecision {
  const { current, recorded, rotatedFrom, probe } = input;

  if (current === null) {
    if (recorded === null) {
      return {
        code: "no_key_configured",
        ok: true,
        message:
          `${DATA_KEY_ENV} is not set — no stored secret can be written or read. ` +
          `Nothing to verify; this is a disclosed state, not a misconfiguration.`,
      };
    }
    return {
      code: "key_missing",
      ok: false,
      message:
        `REFUSING TO START: this database records data-key fingerprint ${recorded}, but ` +
        `${DATA_KEY_ENV} is not set in this process.\n\n` +
        `  This deployment HAS stored secrets under a key. Booting without it would come up ` +
        `looking healthy and fail every decryption — see the refusal reasoning in ADR-0063.\n\n` +
        `  Set ${DATA_KEY_ENV} to the key whose fingerprint is ${recorded}. If that key is ` +
        `genuinely lost, see docs/ops/DB_BACKUP.md — the credentials must be re-entered by hand ` +
        `and the rotation path (${DATA_KEY_ROTATION_ENV}) is how you declare that deliberately.`,
    };
  }

  if (recorded === null) {
    if (probe && probe.sampled > 0 && probe.decrypted === 0) {
      return {
        code: "undecryptable",
        ok: false,
        message:
          `REFUSING TO START: no data-key fingerprint has been recorded yet, and the key this ` +
          `process is running with (${current}) could not decrypt ANY of the ${probe.sampled} ` +
          `stored ciphertext value(s) sampled from ${probe.columns.join(", ")}.\n\n` +
          `  This is the wrong key for this database. Recording it now would write the wrong ` +
          `answer into the permanent record, so this boot is refused instead.\n\n` +
          `  Set ${DATA_KEY_ENV} to the key this data was encrypted under. If it is genuinely ` +
          `lost, declare that deliberately: see the rotation path in ADR-0063 and ` +
          `docs/ops/DB_BACKUP.md.`,
      };
    }
    const proof =
      probe && probe.sampled > 0
        ? ` (verified: it decrypted ${probe.decrypted}/${probe.sampled} sampled stored ciphertexts)`
        : " (this deployment has no stored ciphertext yet, so there was nothing to verify against)";
    return {
      code: "recorded",
      ok: true,
      message:
        `data key ${current} recorded as this deployment's key${proof}. ` +
        `RECORD IT OUT-OF-BAND NOW and attest it (POST /v1/security/data-key/attestations): ` +
        `the backup deliberately does not contain it.`,
    };
  }

  if (fingerprintsMatch(current, recorded)) {
    return {
      code: "verified",
      ok: true,
      message: `data key ${current} — matches the fingerprint this deployment's ciphertext was written under`,
    };
  }

  if (rotatedFrom !== null && fingerprintsMatch(rotatedFrom, recorded)) {
    return {
      code: "rotation_accepted",
      ok: true,
      message:
        `DATA KEY ROTATION ACCEPTED: ${recorded} -> ${current}, declared by ` +
        `${DATA_KEY_ROTATION_ENV}. Nothing has been re-encrypted by this process — any ` +
        `ciphertext still written under ${recorded} is now UNREADABLE unless it was ` +
        `re-encrypted out of band. Remove ${DATA_KEY_ROTATION_ENV} from the environment now ` +
        `that it has been consumed, and attest the new key.`,
    };
  }

  const staleDeclaration =
    rotatedFrom !== null
      ? `\n\n  (${DATA_KEY_ROTATION_ENV} is set to ${rotatedFrom}, which is NOT the recorded ` +
        `fingerprint ${recorded} — a rotation declaration must name the key being left behind, ` +
        `so this one does not apply and was ignored.)`
      : "";

  return {
    code: "mismatch",
    ok: false,
    message:
      `REFUSING TO START: DATA KEY MISMATCH.\n\n` +
      `    recorded (what this database's ciphertext was written under): ${recorded}\n` +
      `    running  (${DATA_KEY_ENV} in this process):                   ${current}\n\n` +
      `  These are different keys. Every OIDC client secret, TOTP secret, model API key, ` +
      `connector/git/PM token, SAML SP key and deploy credential in this database was ` +
      `encrypted under ${recorded} and CANNOT be decrypted by ${current}.\n\n` +
      `  This is almost always a RESTORE ONTO A NEW BOX without the original key. The gateway ` +
      `refuses rather than booting: an app that starts and then silently fails every ` +
      `decryption looks healthy, hides the fault for days, and invites an admin to re-enter ` +
      `credentials under the new key — leaving rows under two keys that neither can fully read.\n\n` +
      `  WHAT TO DO:\n` +
      `    1. Recover the key whose fingerprint is ${recorded} (password manager, KMS, escrow — ` +
      `wherever the custody attestation says it went) and set ${DATA_KEY_ENV} to it.\n` +
      `    2. If that key is genuinely gone, this is a deliberate rotation and every existing ` +
      `secret must be re-entered by hand. Declare it explicitly:\n` +
      `         ${DATA_KEY_ROTATION_ENV}=${recorded}\n` +
      `       The acceptance is audited with both fingerprints.\n` +
      `    3. See docs/ops/DB_BACKUP.md and ADR-0063.` +
      staleDeclaration,
  };
}

/** the error thrown when the gateway must not start */
export class DataKeyBootError extends Error {
  constructor(
    readonly decision: DataKeyBootDecision,
    readonly recorded: string | null,
    readonly current: string | null,
  ) {
    super(decision.message);
    this.name = "DataKeyBootError";
  }
}

// ---------------------------------------------------------------------------
// 4. THE BOOT GATE
// ---------------------------------------------------------------------------

export interface DataKeyBootResult extends DataKeyBootDecision {
  recorded: string | null;
  current: string | null;
  probe: CiphertextProbe | null;
  /** false when nobody has ever attested custody of the CURRENT fingerprint */
  attested: boolean;
}

async function readState(db: Db): Promise<DataKeyStateRow | undefined> {
  const [row] = await db.select().from(dataKeyState).limit(1);
  return row;
}

async function audit(
  db: Db,
  args: {
    ruleId: string;
    effect: "allow" | "deny";
    reason: string;
    detail: Record<string, unknown>;
    userId?: string | null;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: args.userId ?? NIL_USER,
    objectType: "data_key",
    objectId: null,
    detail: { subsystem: "data-key-custody", ...args.detail },
    effect: args.effect,
    ruleId: args.ruleId,
    ruleChain: [],
    reason: args.reason,
  });
}

/**
 * THE BOOT GATE. Call this after migrations and BEFORE the server listens.
 *
 * Deliberately NOT inside `buildApp`. Constructing an app object is not the act
 * that puts a deployment into service, `buildApp` is synchronous and used by
 * ~100 test files, and a control that fires on construction would be a control
 * every fixture has to work around — which is how controls end up disabled. The
 * gate belongs on the boot path (`boot.ts` / `main.ts`), where "start" actually
 * means start, and `boot.test.ts` drives that real path.
 *
 * @throws {DataKeyBootError} when the gateway must not start.
 */
export async function verifyDataKeyOnBoot(
  db: Db,
  dataKeyHex: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DataKeyBootResult> {
  const current = fingerprintOrNull(dataKeyHex);
  const state = await readState(db);
  const recorded = state?.fingerprint ?? null;
  const rotatedRaw = env[DATA_KEY_ROTATION_ENV];
  const rotatedFrom = rotatedRaw && rotatedRaw.trim() !== "" ? rotatedRaw.trim() : null;

  // The probe only matters on the "nothing recorded yet" branch: everywhere
  // else the recorded fingerprint is the stronger, cheaper answer.
  const probe =
    current !== null && recorded === null ? await probeCiphertext(db, (dataKeyHex as string).trim()) : null;

  const decision = decideDataKeyBoot({ current, recorded, rotatedFrom, probe });

  switch (decision.code) {
    case "recorded":
      await db
        .insert(dataKeyState)
        .values({ fingerprint: current! })
        .onConflictDoUpdate({
          target: dataKeyState.id,
          set: { fingerprint: current!, lastVerifiedAt: new Date() },
        });
      await audit(db, {
        ruleId: DATA_KEY_RULE_IDS.recorded,
        effect: "allow",
        reason: decision.message,
        detail: {
          fingerprint: current,
          sampledCiphertexts: probe?.sampled ?? 0,
          decryptedCiphertexts: probe?.decrypted ?? 0,
        },
      });
      break;

    case "verified":
      await db.update(dataKeyState).set({ lastVerifiedAt: new Date() }).where(eq(dataKeyState.id, state!.id));
      break;

    case "rotation_accepted":
      await db
        .update(dataKeyState)
        .set({
          fingerprint: current!,
          rotatedFrom: recorded,
          rotatedAt: new Date(),
          recordedAt: new Date(),
          lastVerifiedAt: new Date(),
        })
        .where(eq(dataKeyState.id, state!.id));
      await audit(db, {
        ruleId: DATA_KEY_RULE_IDS.rotated,
        effect: "allow",
        reason: decision.message,
        detail: { from: recorded, to: current, declaredVia: DATA_KEY_ROTATION_ENV },
      });
      break;

    // --- the three refusals. Each is filed BEFORE the throw, so the reason a
    // --- deployment would not come up is in the trail rather than only in a
    // --- console nobody was watching.
    case "mismatch":
      await audit(db, {
        ruleId: DATA_KEY_RULE_IDS.mismatch,
        effect: "deny",
        reason: decision.message,
        detail: { recorded, running: current },
      });
      throw new DataKeyBootError(decision, recorded, current);

    case "undecryptable":
      await audit(db, {
        ruleId: DATA_KEY_RULE_IDS.undecryptable,
        effect: "deny",
        reason: decision.message,
        detail: {
          running: current,
          sampledCiphertexts: probe?.sampled ?? 0,
          columns: probe?.columns ?? [],
        },
      });
      throw new DataKeyBootError(decision, recorded, current);

    case "key_missing":
      await audit(db, {
        ruleId: DATA_KEY_RULE_IDS.keyMissing,
        effect: "deny",
        reason: decision.message,
        detail: { recorded },
      });
      throw new DataKeyBootError(decision, recorded, current);

    case "no_key_configured":
      break;
  }

  const attested = current === null ? false : await hasAttestation(db, current);
  return { ...decision, recorded, current, probe, attested };
}

/** one line an operator can read in the boot log, beside proxy/HSTS/egress */
export function describeDataKey(result: DataKeyBootResult): string {
  if (result.code === "no_key_configured") return result.message;
  const custody = result.attested
    ? "custody attested"
    : "NO CUSTODY ATTESTATION ON FILE — nobody has recorded that this key is stored anywhere but this box";
  return `${result.current} [${result.code}] — ${custody}`;
}

// ---------------------------------------------------------------------------
// 5. CUSTODY ATTESTATION
// ---------------------------------------------------------------------------

export async function hasAttestation(db: Db, fingerprint: string): Promise<boolean> {
  const [row] = await db
    .select({ id: dataKeyAttestations.id })
    .from(dataKeyAttestations)
    .where(eq(dataKeyAttestations.fingerprint, fingerprint))
    .limit(1);
  return row !== undefined;
}

export async function latestAttestation(
  db: Db,
  fingerprint: string,
): Promise<DataKeyAttestationRow | undefined> {
  const [row] = await db
    .select()
    .from(dataKeyAttestations)
    .where(eq(dataKeyAttestations.fingerprint, fingerprint))
    .orderBy(sql`${dataKeyAttestations.attestedAt} DESC`)
    .limit(1);
  return row;
}

export interface RecordAttestationArgs {
  fingerprint: string;
  actorUserId: string | null;
  actorLabel: string;
  method: DataKeyAttestationMethod;
  locationHint?: string | null;
  note?: string | null;
}

/**
 * File a custody claim. Audited with the actor and the fingerprint, because an
 * attestation is a statement someone can later be held to — an unaudited one is
 * the checkbox this design exists to avoid being.
 */
export async function recordAttestation(
  db: Db,
  args: RecordAttestationArgs,
): Promise<DataKeyAttestationRow> {
  const [row] = await db
    .insert(dataKeyAttestations)
    .values({
      fingerprint: args.fingerprint,
      attestedByUserId: args.actorUserId,
      attestedByLabel: args.actorLabel,
      method: args.method,
      locationHint: args.locationHint ?? null,
      note: args.note ?? null,
    })
    .returning();
  await audit(db, {
    userId: args.actorUserId,
    ruleId: DATA_KEY_RULE_IDS.attested,
    effect: "allow",
    reason:
      `${args.actorLabel} attests that data key ${args.fingerprint} has been recorded ` +
      `out-of-band (${args.method}). RegulAIt records this CLAIM; it cannot verify custody.`,
    detail: {
      fingerprint: args.fingerprint,
      method: args.method,
      locationHint: args.locationHint ?? null,
    },
  });
  return row!;
}

export interface DataKeyPosture {
  /** null when this process runs with no key at all */
  fingerprint: string | null;
  /** what the database says its ciphertext was written under */
  recordedFingerprint: string | null;
  recordedAt: Date | null;
  lastVerifiedAt: Date | null;
  rotatedFrom: string | null;
  rotatedAt: Date | null;
  matches: boolean;
  attested: boolean;
  attestationCount: number;
  latestAttestation: DataKeyAttestationRow | undefined;
  /** the things an operator should act on, in words */
  warnings: string[];
}

/** the read behind `GET /v1/security/data-key`, the admin card and the backup
 * script's sidecar. One computation, so those three cannot disagree. */
export async function dataKeyPosture(db: Db, dataKeyHex: string | undefined | null): Promise<DataKeyPosture> {
  const fingerprint = fingerprintOrNull(dataKeyHex);
  const state = await readState(db);
  const recordedFingerprint = state?.fingerprint ?? null;
  const target = fingerprint ?? recordedFingerprint;

  const rows = target
    ? await db
        .select()
        .from(dataKeyAttestations)
        .where(eq(dataKeyAttestations.fingerprint, target))
        .orderBy(sql`${dataKeyAttestations.attestedAt} DESC`)
    : [];

  const warnings: string[] = [];
  if (fingerprint === null) {
    warnings.push(
      `${DATA_KEY_ENV} is not set in the gateway process — no stored secret can be written or read.`,
    );
  }
  if (recordedFingerprint === null && fingerprint !== null) {
    warnings.push(
      "No fingerprint has been recorded for this deployment yet. It is written on the next gateway boot.",
    );
  }
  if (fingerprint !== null && recordedFingerprint !== null && !fingerprintsMatch(fingerprint, recordedFingerprint)) {
    warnings.push(
      `The running key (${fingerprint}) is NOT the key this deployment's ciphertext was written ` +
        `under (${recordedFingerprint}). A gateway boot would refuse.`,
    );
  }
  if (rows.length === 0 && target !== null) {
    warnings.push(
      `NO CUSTODY ATTESTATION on file for ${target}. Nobody has recorded that this key exists ` +
        `anywhere other than this machine — which means a backup of this deployment may not be ` +
        `restorable. The key is deliberately NOT in the backup (ADR-0035).`,
    );
  }

  return {
    fingerprint,
    recordedFingerprint,
    recordedAt: state?.recordedAt ?? null,
    lastVerifiedAt: state?.lastVerifiedAt ?? null,
    rotatedFrom: state?.rotatedFrom ?? null,
    rotatedAt: state?.rotatedAt ?? null,
    matches: fingerprintsMatch(fingerprint, recordedFingerprint),
    attested: rows.length > 0,
    attestationCount: rows.length,
    latestAttestation: rows[0],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 6. THE ADMIN SURFACE
// ---------------------------------------------------------------------------

/**
 * `locationHint` and `note` are free text an operator types while looking at a
 * key. This refuses anything that contains 64 hex characters in a row — i.e.
 * somebody pasting the key itself into the field meant to say where they PUT
 * the key. That would write the key into the database, in plaintext, inside the
 * backup, which is the exact failure this whole ADR exists to prevent.
 */
const LOOKS_LIKE_A_KEY = /[0-9a-f]{64}/i;

const attestSchema = z
  .object({
    method: z.enum(DATA_KEY_ATTESTATION_METHODS),
    locationHint: z.string().min(1).max(500).optional(),
    note: z.string().min(1).max(2000).optional(),
    /** an explicit statement, not an implied one. The body must say yes. */
    confirmRecordedOutOfBand: z.literal(true),
  })
  .strict();

export function registerDataKeyRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { dataKey?: string } = {},
): void {
  // Admin-only via the global gate (deliberately NOT in NON_ADMIN_ROUTES): the
  // fingerprint is not secret, but WHO holds the deployment's envelope key and
  // whether anyone has said so is org-wide custody posture.

  app.get("/v1/security/data-key", async () => {
    const posture = await dataKeyPosture(db, opts.dataKey);
    return {
      fingerprint: posture.fingerprint,
      recordedFingerprint: posture.recordedFingerprint,
      recordedAt: posture.recordedAt,
      lastVerifiedAt: posture.lastVerifiedAt,
      rotatedFrom: posture.rotatedFrom,
      rotatedAt: posture.rotatedAt,
      matches: posture.matches,
      attested: posture.attested,
      attestationCount: posture.attestationCount,
      latestAttestation: posture.latestAttestation
        ? {
            id: posture.latestAttestation.id,
            fingerprint: posture.latestAttestation.fingerprint,
            attestedByUserId: posture.latestAttestation.attestedByUserId,
            attestedByLabel: posture.latestAttestation.attestedByLabel,
            method: posture.latestAttestation.method,
            locationHint: posture.latestAttestation.locationHint,
            attestedAt: posture.latestAttestation.attestedAt,
          }
        : null,
      warnings: posture.warnings,
      derivation:
        `The fingerprint is "${FINGERPRINT_PREFIX}" + the first ${FINGERPRINT_BYTES} bytes of ` +
        `HMAC-SHA256(key = the raw data key, msg = "${FINGERPRINT_DOMAIN}"), hex. It is a PRF ` +
        `output: it identifies the key and reveals nothing about it, which is why it is safe in ` +
        `logs, in this database and in backup metadata.`,
      posture:
        `${DATA_KEY_ENV} is the AES-256-GCM envelope over every stored secret and is ` +
        `DELIBERATELY NOT in the backup (ADR-0035) — a key stored beside its own ciphertext is ` +
        `not an envelope. A restore onto a box without it recovers every row and leaves every ` +
        `credential permanently undecryptable, so the gateway REFUSES TO START when the running ` +
        `key does not match the recorded fingerprint. An attestation records a human's CLAIM ` +
        `that the key is held elsewhere; RegulAIt cannot verify custody and does not pretend to.`,
    };
  });

  app.get("/v1/security/data-key/attestations", async () => {
    const posture = await dataKeyPosture(db, opts.dataKey);
    const target = posture.fingerprint ?? posture.recordedFingerprint;
    const rows = target
      ? await db
          .select()
          .from(dataKeyAttestations)
          .where(eq(dataKeyAttestations.fingerprint, target))
          .orderBy(sql`${dataKeyAttestations.attestedAt} DESC`)
      : [];
    return {
      fingerprint: target,
      attested: rows.length > 0,
      attestations: rows.map((r) => ({
        id: r.id,
        fingerprint: r.fingerprint,
        attestedByUserId: r.attestedByUserId,
        attestedByLabel: r.attestedByLabel,
        method: r.method,
        locationHint: r.locationHint,
        note: r.note,
        attestedAt: r.attestedAt,
      })),
    };
  });

  app.post("/v1/security/data-key/attestations", async (req, reply) => {
    const body = attestSchema.parse(req.body);
    const fingerprint = fingerprintOrNull(opts.dataKey);
    if (fingerprint === null) {
      return reply.status(400).send({
        error: "no_data_key",
        detail:
          `${DATA_KEY_ENV} is not set in this gateway process, so there is no key to attest ` +
          `custody of. Set it and restart before attesting.`,
      });
    }
    for (const [field, value] of [
      ["locationHint", body.locationHint],
      ["note", body.note],
    ] as const) {
      if (value && LOOKS_LIKE_A_KEY.test(value)) {
        return reply.status(400).send({
          error: "looks_like_key_material",
          detail:
            `${field} contains 64 hex characters — that is the shape of the data key itself. ` +
            `This field records WHERE the key is stored, never the key. Writing it here would ` +
            `put it in plaintext in the database and therefore in the backup, which is exactly ` +
            `what the envelope split exists to prevent.`,
        });
      }
    }

    const actorUserId = req.authCtx.userId;
    let actorLabel = `bootstrap token (${req.authCtx.via})`;
    if (actorUserId) {
      const [u] = await db
        .select({ email: users.email, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, actorUserId))
        .limit(1);
      actorLabel = u ? `${u.displayName ?? u.email} <${u.email}>` : actorUserId;
    }

    const row = await recordAttestation(db, {
      fingerprint,
      actorUserId,
      actorLabel,
      method: body.method,
      locationHint: body.locationHint ?? null,
      note: body.note ?? null,
    });

    return reply.status(201).send({
      id: row.id,
      fingerprint: row.fingerprint,
      attestedByLabel: row.attestedByLabel,
      method: row.method,
      attestedAt: row.attestedAt,
      limits:
        "This records your CLAIM that the key is stored out-of-band. RegulAIt cannot reach into " +
        "a password manager, a KMS or a safe — it does not verify custody and never will. What " +
        "it now guarantees is that the ABSENCE of this claim is visible: on the boot line, in " +
        "this endpoint, and in every backup run's own output.",
    });
  });
}
