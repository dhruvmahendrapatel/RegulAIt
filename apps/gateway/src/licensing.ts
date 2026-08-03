/**
 * ADR-0052 — the GATEWAY half of LICENSING & SEAT MANAGEMENT.
 *
 *   `packages/shared/src/licensing.ts`  the document shape, the validity
 *                                       window, the ACTION-CLASS inventory and
 *                                       the split-posture decision, the seat
 *                                       grant, the tier feature read. Pure.
 *   THIS FILE                           the OFFLINE Ed25519 verification
 *                                       against a pinned keyring, the db, the
 *                                       API, the enforcement helpers and the
 *                                       audit rows.
 *
 * FIVE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 *
 *  1. VERIFICATION IS OFFLINE. There is no network call on any path in this
 *     file — no revocation endpoint, no timestamp authority, no license server.
 *     That is a requirement, not a side effect: ADR-0041 makes air-gapped the
 *     primary motion and there is no home to phone. `node:crypto`'s `verify`
 *     over a public key read from the local filesystem is the whole mechanism.
 *
 *  2. IT FAILS CLOSED ON A FORGERY AND OPEN ON AN ABSENCE, DELIBERATELY.
 *     A tampered document, a signature from a key this deployment does not pin,
 *     a malformed body — each is REFUSED outright, audited, and leaves whatever
 *     license was already installed exactly where it was. A forged license that
 *     could displace a valid one is the actual attack. A MISSING license, by
 *     contrast, is not an error: the deployment runs UNLICENSED — fully
 *     governed, every tier feature closed, no seat cap enforced, and visibly
 *     flagged. Bricking a fresh install would make the governance layer depend
 *     on the commercial one and would leave no way to reach the console to
 *     install the license.
 *
 *  3. THE SIGNATURE COVERS THE EXACT BYTES. `licenses.document` stores those
 *     bytes verbatim; the parsed columns beside it are a read model. Nothing
 *     re-canonicalises before verifying — the same rule
 *     `scripts/verify-update-bundle.sh` follows, and for the same reason: a
 *     verifier that re-serialises before checking accepts documents whose
 *     delivered bytes differ from what was signed.
 *
 *  4. EXPIRY DEGRADES, IT DOES NOT STOP. Every enforcement point calls the ONE
 *     pure decision function with its action class. Governance/safety/audit
 *     fail OPEN; commercial expansion fails CLOSED. See the pure module's
 *     header for the argument.
 *
 *  5. THERE IS ONE DEFINITION OF A SEAT. `countActiveSeats` is imported from
 *     `billing.ts` (ADR-0051) rather than reimplemented, so the number a
 *     customer is capped at and the number they are billed for cannot diverge.
 *
 * WHAT THIS FILE DOES NOT DO — stated here rather than only in the ADR:
 *   - It does not run a timer. ADR-0052 §1 describes verification "at boot and
 *     on a periodic timer"; there is no in-process scheduler in this codebase
 *     (ADRs 0044-0051 all landed the same way). `POST /v1/licenses/verify` is
 *     what an operator or an external cron drives, and `license_verifications`
 *     staying empty is how a deployment that never wires it SEES that.
 *   - It does not defend against a tampered host clock. Validity is evaluated
 *     against `new Date()` on the control-plane host, which is the customer's
 *     own machine. Disclosed, not mitigated.
 *   - It does not gate every enforcement point in the codebase. Two are wired
 *     (user provisioning, agent creation); the rest of the ADR-0052 §4 flag
 *     surface is modelled and unwired. The overview says which.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  and,
  auditLog,
  desc,
  eq,
  licenseVerifications,
  licenses,
  sql,
  type Db,
  type LicenseRow,
} from "@regulait/db";
import {
  LICENSE_ACTION_INVENTORY,
  LICENSE_FEATURES,
  LICENSE_POSTURE_NOTE,
  SEAT_DEFINITION_NOTE,
  evaluateLicenseWindow,
  evaluateLicensedAction,
  evaluateSeatGrant,
  featureEnabled,
  installLicenseSchema,
  licenseDocumentSchema,
  type LicenseActionClass,
  type LicenseDecision,
  type LicenseDocument,
  type LicenseState,
  type SeatDecision,
} from "@regulait/shared";
import { countActiveSeats } from "./billing.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const idParam = z.object({ id: z.string().uuid() });

// ---------------------------------------------------------------------------
// The pinned keyring
// ---------------------------------------------------------------------------

/**
 * `$REGULAIT_LICENSE_KEYRING` first (what a packaged deployment sets, e.g.
 * `/etc/regulait/license-keys`), otherwise `infra/license-keys/` in the
 * installed tree.
 *
 * A MISSING KEYRING REFUSES EVERY LICENSE. An unverifiable license is not a
 * license, and a missing keyring is not a reason to accept one.
 */
export function licenseKeyringDir(): string {
  const fromEnv = process.env.REGULAIT_LICENSE_KEYRING;
  if (fromEnv) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../infra/license-keys");
}

export function pinnedLicenseKeyIds(dir = licenseKeyringDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".pub"))
    .map((f) => f.slice(0, -4))
    .sort();
}

export interface VerifyOk {
  ok: true;
  ruleId: "license-signature-verified";
  reason: string;
  document: LicenseDocument;
  documentBytes: Buffer;
  documentSha256: string;
}
export interface VerifyRefusal {
  ok: false;
  ruleId: string;
  reason: string;
}

/**
 * OFFLINE verification. Every branch below is a REFUSAL, never a warning, and
 * there is deliberately no override:
 *
 *   * the keyring directory is absent
 *   * the key id names a key this deployment has never been given (PINNING —
 *     a valid signature from an unknown key is still refused)
 *   * the base64 does not decode
 *   * the signature does not verify over the delivered bytes (TAMPERING, or a
 *     different private key: operationally the same answer)
 *   * the body is not a well-formed license document
 *
 * The `signingKeyId` shape is re-checked here even though the zod schema
 * already constrains it, because it is used to build a filesystem path and a
 * defence that lives in only one layer is a defence that gets refactored away.
 */
export function verifyLicenseArtifact(input: {
  documentBase64: string;
  signature: string;
  signingKeyId: string;
  keyringDir?: string;
}): VerifyOk | VerifyRefusal {
  const dir = input.keyringDir ?? licenseKeyringDir();

  if (!/^[A-Za-z0-9._-]+$/.test(input.signingKeyId)) {
    return {
      ok: false,
      ruleId: "license-key-id-malformed",
      reason:
        `signingKeyId '${input.signingKeyId}' contains characters that are not permitted in a key id. ` +
        "A key id names a file in the pinned keyring; only [A-Za-z0-9._-] is allowed.",
    };
  }
  if (!existsSync(dir)) {
    return {
      ok: false,
      ruleId: "license-keyring-missing",
      reason:
        `the pinned license keyring is not present at ${dir}. Without it there is nothing to verify ` +
        "against, and an unverifiable license is refused rather than trusted.",
    };
  }
  const pubPath = path.join(dir, `${input.signingKeyId}.pub`);
  if (!existsSync(pubPath)) {
    return {
      ok: false,
      ruleId: "license-signing-key-not-pinned",
      reason:
        `UNKNOWN SIGNING KEY '${input.signingKeyId}'. This deployment pins: ` +
        `${pinnedLicenseKeyIds(dir).join(", ") || "<none>"}. A license signed by a key you were never ` +
        "given is refused even if its signature is internally valid — that is what pinning means.",
    };
  }

  let documentBytes: Buffer;
  let signatureBytes: Buffer;
  try {
    documentBytes = Buffer.from(input.documentBase64, "base64");
    signatureBytes = Buffer.from(input.signature, "base64");
    if (documentBytes.length === 0 || signatureBytes.length === 0) throw new Error("empty");
  } catch {
    return { ok: false, ruleId: "license-encoding-invalid", reason: "the document or signature is not valid base64" };
  }

  let verified = false;
  try {
    const key = createPublicKey(readFileSync(pubPath));
    // Ed25519: the algorithm argument is null — it signs the message itself,
    // so there is no digest choice and no padding mode to get wrong.
    verified = cryptoVerify(null, documentBytes, key, signatureBytes);
  } catch (err) {
    return {
      ok: false,
      ruleId: "license-verification-error",
      reason: `verification could not be performed with ${input.signingKeyId}: ${(err as Error).message}`,
    };
  }
  if (!verified) {
    return {
      ok: false,
      ruleId: "license-signature-invalid",
      reason:
        `SIGNATURE DOES NOT VERIFY under '${input.signingKeyId}'. Either the document was modified after ` +
        "signing, or it was signed by a different private key than the one this deployment pins. Both " +
        "mean the same thing operationally: it is refused, and the license already installed is left " +
        "exactly as it was.",
    };
  }

  // Only NOW is the body parsed. Verifying first is the point: the signature is
  // the authority and the parse is a convenience, so a malformed body from a
  // valid signer is a different (and much less alarming) failure than a
  // well-formed body from an unknown one.
  let document: LicenseDocument;
  try {
    document = licenseDocumentSchema.parse(JSON.parse(documentBytes.toString("utf8")));
  } catch (err) {
    return {
      ok: false,
      ruleId: "license-document-malformed",
      reason:
        "the signature verified, but the document is not a well-formed regulait.license/1 body: " +
        `${(err as Error).message}`,
    };
  }

  return {
    ok: true,
    ruleId: "license-signature-verified",
    reason: `signature verifies under the pinned key '${input.signingKeyId}' — checked locally, no network call`,
    document,
    documentBytes,
    documentSha256: createHash("sha256").update(documentBytes).digest("hex"),
  };
}

// ---------------------------------------------------------------------------
// The installed license
// ---------------------------------------------------------------------------

export interface ResolvedLicense {
  row: LicenseRow | null;
  document: LicenseDocument | null;
  state: LicenseState;
  reason: string;
  expiresAt: string | null;
  graceEndsAt: string | null;
  daysRemaining: number | null;
}

/**
 * The license in force, and the state it resolves to right now.
 *
 * The document is rebuilt from the STORED BYTES rather than from the parsed
 * columns, so what is enforced is what was signed. If those bytes somehow no
 * longer parse, the row is treated as ABSENT rather than as its own read model
 * — a license we cannot re-derive from its signed form is not one we should be
 * enforcing a seat cap from.
 */
export async function resolveLicense(db: Db, now = new Date()): Promise<ResolvedLicense> {
  const [row] = await db.select().from(licenses).where(eq(licenses.status, "active")).limit(1);
  if (!row) {
    return {
      row: null,
      document: null,
      state: "absent",
      reason:
        "no license is installed: this deployment runs UNLICENSED. Governance, approvals, guardrails " +
        "and audit are fully operational; every tier feature is CLOSED and no seat cap is enforced.",
      expiresAt: null,
      graceEndsAt: null,
      daysRemaining: null,
    };
  }
  let document: LicenseDocument;
  try {
    document = licenseDocumentSchema.parse(JSON.parse(row.document));
  } catch {
    return {
      row,
      document: null,
      state: "absent",
      reason:
        "the installed license row's signed bytes no longer parse as a regulait.license/1 document. " +
        "It is treated as ABSENT rather than as its stored read model: a license that cannot be " +
        "re-derived from the bytes that were signed is not one to enforce a seat cap from.",
      expiresAt: null,
      graceEndsAt: null,
      daysRemaining: null,
    };
  }
  const w = evaluateLicenseWindow(document, now);
  return {
    row,
    document,
    state: w.state,
    reason: w.reason,
    expiresAt: w.expiresAt,
    graceEndsAt: w.graceEndsAt,
    daysRemaining: Number(w.daysRemaining.toFixed(3)),
  };
}

/**
 * THE ENFORCEMENT ENTRY POINT. Every gated call site uses this rather than
 * re-deriving the posture, because ADR-0052 §Consequences says plainly that a
 * miscategorised path is a real bug — and two copies of a rule are how one of
 * them ends up miscategorised.
 */
export async function licenseGate(
  db: Db,
  actionClass: LicenseActionClass,
  now = new Date(),
): Promise<LicenseDecision & { resolved: ResolvedLicense }> {
  const resolved = await resolveLicense(db, now);
  const decision = evaluateLicensedAction({
    license: resolved.document,
    state: resolved.state,
    actionClass,
  });
  return { ...decision, resolved };
}

/** The seat check, over the ONE seat definition (ADR-0051's `countActiveSeats`). */
export async function seatGate(db: Db, now = new Date()): Promise<SeatDecision & { state: LicenseState }> {
  const resolved = await resolveLicense(db, now);
  const activeSeats = await countActiveSeats(db);
  return {
    ...evaluateSeatGrant({ license: resolved.document, state: resolved.state, activeSeats }),
    state: resolved.state,
  };
}

/** Tier feature read, for any call site that needs one. */
export async function licenseFeature(db: Db, feature: string, now = new Date()) {
  const resolved = await resolveLicense(db, now);
  return featureEnabled(resolved.document, feature, resolved.state);
}

async function recordVerification(
  db: Db,
  v: {
    licenseRowId?: string | null;
    trigger: "install" | "periodic" | "manual";
    ok: boolean;
    state: "absent" | "not_yet_valid" | "valid" | "grace" | "expired" | "invalid";
    ruleId: string;
    reason: string;
    seatCap?: number | null;
    activeSeats?: number | null;
    signingKeyId?: string | null;
    checkedByUserId?: string | null;
    detail?: Record<string, unknown>;
  },
) {
  await db.insert(licenseVerifications).values({
    licenseRowId: v.licenseRowId ?? null,
    trigger: v.trigger,
    ok: v.ok,
    state: v.state,
    ruleId: v.ruleId,
    reason: v.reason,
    seatCap: v.seatCap ?? null,
    activeSeats: v.activeSeats ?? null,
    signingKeyId: v.signingKeyId ?? null,
    checkedByUserId: v.checkedByUserId ?? null,
    detail: v.detail ?? null,
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerLicensingRoutes(app: FastifyInstance, db: Db): void {
  async function audit(
    actor: string | null,
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
    effect: "allow" | "deny" = "allow",
  ) {
    await db.insert(auditLog).values({
      userId: actor ?? NO_IDENTITY,
      objectType: "license",
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  }

  /**
   * INSTALL. Verify OFFLINE first, refuse outright on any failure, and only
   * then write. A refusal leaves the previously installed license untouched —
   * that is the whole point, because displacing a valid license with a forged
   * one is the attack this is defending against.
   */
  app.post("/v1/licenses", async (req, reply) => {
    const body = installLicenseSchema.parse(req.body);
    const result = verifyLicenseArtifact(body);

    if (!result.ok) {
      await recordVerification(db, {
        trigger: "install",
        ok: false,
        state: "invalid",
        ruleId: result.ruleId,
        reason: result.reason,
        signingKeyId: body.signingKeyId,
        checkedByUserId: req.authCtx.userId ?? null,
      });
      await audit(
        req.authCtx.userId ?? null,
        null,
        result.ruleId,
        `license installation REFUSED: ${result.reason} The license already installed (if any) is ` +
          "unchanged — a refused artifact never displaces the one in force.",
        { phase: "install", signingKeyId: body.signingKeyId },
        "deny",
      );
      return reply.status(400).send({ error: "license_refused", ruleId: result.ruleId, detail: result.reason });
    }

    const doc = result.document;
    // installing the SAME artifact twice is recognised rather than duplicated
    const [existing] = await db
      .select()
      .from(licenses)
      .where(eq(licenses.documentSha256, result.documentSha256));
    if (existing) {
      const resolved = await resolveLicense(db);
      return reply.status(200).send({
        license: existing,
        installed: false,
        state: resolved.state,
        note: "This exact license artifact is already installed; nothing changed.",
      });
    }

    const now = new Date();
    await db
      .update(licenses)
      .set({ status: "superseded", supersededAt: now })
      .where(eq(licenses.status, "active"));
    const [row] = await db
      .insert(licenses)
      .values({
        document: result.documentBytes.toString("utf8"),
        documentSha256: result.documentSha256,
        signature: body.signature,
        signingKeyId: body.signingKeyId,
        licenseId: doc.licenseId,
        tenant: doc.tenant,
        tier: doc.tier,
        seatCap: doc.seatCap,
        features: doc.features,
        deploymentMode: doc.deploymentMode,
        issuedAt: new Date(doc.issuedAt),
        notBefore: new Date(doc.notBefore),
        expiresAt: new Date(doc.expiresAt),
        graceDays: doc.graceDays,
        hardStopOnExpiry: doc.hardStopOnExpiry,
        status: "active",
        installedByUserId: req.authCtx.userId ?? null,
      })
      .returning();

    const window = evaluateLicenseWindow(doc, now);
    const activeSeats = await countActiveSeats(db);
    await recordVerification(db, {
      licenseRowId: row!.id,
      trigger: "install",
      ok: true,
      state: window.state,
      ruleId: "license-signature-verified",
      reason: result.reason,
      seatCap: doc.seatCap,
      activeSeats,
      signingKeyId: body.signingKeyId,
      checkedByUserId: req.authCtx.userId ?? null,
    });
    await audit(
      req.authCtx.userId ?? null,
      row!.id,
      "license-installed",
      `admin installed a license for '${doc.tenant}' (tier '${doc.tier}', ${doc.seatCap} seat(s), ` +
        `${doc.deploymentMode}, valid ${doc.notBefore} → ${doc.expiresAt} +${doc.graceDays}d grace). ` +
        `Verified OFFLINE against the pinned key '${body.signingKeyId}' — no network call was made, ` +
        `which is what makes this work in an air-gapped deployment. Current state: ${window.state}. ` +
        `${activeSeats} seat(s) are active against a cap of ${doc.seatCap}` +
        (activeSeats > doc.seatCap
          ? " — ALREADY OVER CAP: no existing user is affected, and the next provisioning is refused."
          : "."),
      {
        phase: "install",
        tenant: doc.tenant,
        tier: doc.tier,
        seatCap: doc.seatCap,
        deploymentMode: doc.deploymentMode,
        state: window.state,
        activeSeats,
        signingKeyId: body.signingKeyId,
        hardStopOnExpiry: doc.hardStopOnExpiry,
      },
    );

    return reply.status(201).send({
      license: row,
      installed: true,
      state: window.state,
      window,
      activeSeats,
      posture: LICENSE_POSTURE_NOTE,
    });
  });

  app.get("/v1/licenses", async () => {
    const rows = await db.select().from(licenses).orderBy(desc(licenses.installedAt));
    return {
      licenses: rows,
      note:
        "Append-only history. Installing a license supersedes the previous one; nothing is deleted, so " +
        "'what was in force when' stays answerable.",
    };
  });

  /** the status a console banner renders, and the honest posture beside it */
  app.get("/v1/licenses/status", async (req) => {
    const resolved = await resolveLicense(db);
    const activeSeats = await countActiveSeats(db);
    const seat = evaluateSeatGrant({
      license: resolved.document,
      state: resolved.state,
      activeSeats,
    });
    const [lastCheck] = await db
      .select()
      .from(licenseVerifications)
      .orderBy(desc(licenseVerifications.at))
      .limit(1);
    return {
      licensed: resolved.document !== null,
      state: resolved.state,
      reason: resolved.reason,
      tenant: resolved.row?.tenant ?? null,
      tier: resolved.row?.tier ?? null,
      deploymentMode: resolved.row?.deploymentMode ?? null,
      expiresAt: resolved.expiresAt,
      graceEndsAt: resolved.graceEndsAt,
      daysRemaining: resolved.daysRemaining,
      hardStopOnExpiry: resolved.row?.hardStopOnExpiry ?? false,
      seats: {
        active: activeSeats,
        cap: seat.seatCap,
        remaining: seat.remaining,
        canProvision: seat.allowed,
        ruleId: seat.ruleId,
        reason: seat.reason,
        definition: SEAT_DEFINITION_NOTE,
      },
      features: Object.fromEntries(
        LICENSE_FEATURES.map((f) => [f, featureEnabled(resolved.document, f, resolved.state).enabled]),
      ),
      actionClasses: {
        read: evaluateLicensedAction({ license: resolved.document, state: resolved.state, actionClass: "read" }),
        governance: evaluateLicensedAction({
          license: resolved.document,
          state: resolved.state,
          actionClass: "governance",
        }),
        expansion: evaluateLicensedAction({
          license: resolved.document,
          state: resolved.state,
          actionClass: "expansion",
        }),
      },
      inventory: LICENSE_ACTION_INVENTORY,
      keyring: { dir: licenseKeyringDir(), pinnedKeyIds: pinnedLicenseKeyIds() },
      lastVerifiedAt: lastCheck?.at ?? null,
      schedulerPresent: false,
      phoneHome: false,
      enforcementPointsWired: ["user.provision", "agent.create"],
      posture: LICENSE_POSTURE_NOTE,
      note:
        "Verification is OFFLINE and makes no network call of any kind — there is no license server to " +
        "reach and no revocation list to check, because the flagship deployment is air-gapped. ADR-0064's " +
        "scheduler deliberately has NO job here: POST /v1/licenses/verify is the endpoint an operator or an " +
        "external cron drives, and `lastVerifiedAt` staying null is how that is visible rather than " +
        "silent. Validity is decided against THIS HOST'S CLOCK, which is the customer's own machine — " +
        "an offline license cannot defend against clock tampering, and that is disclosed rather than " +
        "pretended away. " +
        (req.authCtx.isAdmin ? "" : ""),
    };
  });

  /**
   * THE PERIODIC VERIFIER, as an ENDPOINT — the same shape ADR-0045's expiry
   * sweep, ADR-0047's schedule sweep, ADR-0049's anomaly evaluator and
   * ADR-0051's period close take, and for the same reason: there is no
   * scheduler here to hang it on.
   *
   * Re-verifies the SIGNATURE over the stored bytes, not just the window — a
   * row edited directly in the database is exactly what this is for.
   */
  app.post("/v1/licenses/verify", async (req) => {
    const now = new Date();
    const [row] = await db.select().from(licenses).where(eq(licenses.status, "active")).limit(1);
    const activeSeats = await countActiveSeats(db);

    if (!row) {
      await recordVerification(db, {
        trigger: "periodic",
        ok: true,
        state: "absent",
        ruleId: "license-absent-unlicensed",
        reason: "no license is installed; the deployment runs UNLICENSED and fully governed",
        activeSeats,
        checkedByUserId: req.authCtx.userId ?? null,
      });
      return {
        licensed: false,
        state: "absent",
        ok: true,
        activeSeats,
        note:
          "No license is installed. This is not an error: the deployment runs UNLICENSED — fully " +
          "governed and audited, every tier feature closed, no seat cap enforced. Nothing calls this " +
          "endpoint on a timer; drive it from cron.",
      };
    }

    const result = verifyLicenseArtifact({
      documentBase64: Buffer.from(row.document, "utf8").toString("base64"),
      signature: row.signature,
      signingKeyId: row.signingKeyId,
    });
    if (!result.ok) {
      // The stored row no longer verifies. It is NOT auto-deleted: destroying
      // evidence on a failed check would be the wrong instinct for a governance
      // product. It is recorded loudly and the deployment continues to be
      // governed — the safety layer is never a casualty of a licensing problem.
      await recordVerification(db, {
        licenseRowId: row.id,
        trigger: "periodic",
        ok: false,
        state: "invalid",
        ruleId: result.ruleId,
        reason: result.reason,
        signingKeyId: row.signingKeyId,
        activeSeats,
        checkedByUserId: req.authCtx.userId ?? null,
      });
      await audit(
        req.authCtx.userId ?? null,
        row.id,
        result.ruleId,
        `the INSTALLED license no longer verifies: ${result.reason} The row is retained rather than ` +
          "deleted (destroying evidence on a failed check is the wrong instinct for a governance " +
          "product) and governance continues unaffected.",
        { phase: "periodic-verify", signingKeyId: row.signingKeyId },
        "deny",
      );
      return { licensed: true, state: "invalid", ok: false, ruleId: result.ruleId, detail: result.reason };
    }

    const window = evaluateLicenseWindow(result.document, now);
    await recordVerification(db, {
      licenseRowId: row.id,
      trigger: "periodic",
      ok: true,
      state: window.state,
      ruleId: `license-${window.state}`,
      reason: window.reason,
      seatCap: result.document.seatCap,
      activeSeats,
      signingKeyId: row.signingKeyId,
      checkedByUserId: req.authCtx.userId ?? null,
    });
    if (window.state === "grace" || window.state === "expired") {
      await audit(
        req.authCtx.userId ?? null,
        row.id,
        window.state === "grace" ? "license-grace-warning" : "license-expired-warning",
        window.reason + " " + LICENSE_POSTURE_NOTE,
        { phase: "periodic-verify", state: window.state, daysRemaining: window.daysRemaining },
        "deny",
      );
    }
    return {
      licensed: true,
      ok: true,
      state: window.state,
      window,
      activeSeats,
      seatCap: result.document.seatCap,
      posture: LICENSE_POSTURE_NOTE,
      note:
        "Nothing calls this on a timer — there is no in-process scheduler in this codebase. This " +
        "re-checks the SIGNATURE over the stored bytes as well as the window, so a row edited " +
        "directly in the database is caught here. No network call is made.",
    };
  });

  app.get("/v1/licenses/verifications", async () => {
    const rows = await db
      .select()
      .from(licenseVerifications)
      .orderBy(desc(licenseVerifications.at))
      .limit(100);
    return {
      verifications: rows,
      schedulerPresent: false,
      note:
        "Every install, every operator-driven check and every REFUSAL — including artifacts that were " +
        "refused and therefore never became a license row. An empty table means this deployment has " +
        "never verified anything.",
    };
  });

  app.get("/v1/licenses/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(licenses).where(eq(licenses.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_license" });
    return { license: row };
  });
}

// ---------------------------------------------------------------------------
// Enforcement helpers used by other modules
// ---------------------------------------------------------------------------

/**
 * Refuse an EXPANSION-class act when the license says so, audited. Returns null
 * when the act may proceed.
 *
 * Deliberately a helper rather than a global preHandler: §5's split only works
 * if each call site declares its own action class, and a blanket middleware
 * would have to guess — which is precisely the miscategorisation the ADR warns
 * about.
 */
export async function refuseIfExpansionBlocked(
  db: Db,
  args: { actorUserId: string | null; objectType: "user" | "agent"; what: string },
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const gate = await licenseGate(db, "expansion");
  if (gate.allowed) return null;
  await db.insert(auditLog).values({
    userId: args.actorUserId ?? NO_IDENTITY,
    objectType: "license",
    objectId: gate.resolved.row?.id ?? null,
    detail: {
      phase: "expansion-gate",
      what: args.what,
      state: gate.state,
      licenseTier: gate.resolved.row?.tier ?? null,
    },
    effect: "deny",
    ruleId: gate.ruleId,
    ruleChain: [],
    reason:
      `${args.what} refused: ${gate.reason} Governance, approvals, guardrails and audit logging are ` +
      "unaffected and keep running — this is an expansion gate, not a service gate.",
  });
  return {
    status: 403,
    body: {
      error: "license_expansion_refused",
      ruleId: gate.ruleId,
      state: gate.state,
      detail: gate.reason,
    },
  };
}

/**
 * Refuse a new SEAT when the cap is reached or the license has lapsed, audited.
 * Returns null when provisioning may proceed.
 *
 * Never revokes. ADR-0052 §3: seat enforcement is a GROWTH gate, not a SERVICE
 * gate — going over cap (which happens legitimately when a smaller license is
 * installed onto a larger deployment) refuses the next provisioning and touches
 * nobody who already exists.
 */
export async function refuseIfSeatCapReached(
  db: Db,
  args: { actorUserId: string | null; email: string },
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const seat = await seatGate(db);
  if (seat.allowed) return null;
  const resolved = await resolveLicense(db);
  await db.insert(auditLog).values({
    userId: args.actorUserId ?? NO_IDENTITY,
    objectType: "license",
    objectId: resolved.row?.id ?? null,
    detail: {
      phase: "seat-gate",
      email: args.email,
      activeSeats: seat.activeSeats,
      seatCap: seat.seatCap,
      state: seat.state,
    },
    effect: "deny",
    ruleId: seat.ruleId,
    ruleChain: [],
    reason: `provisioning '${args.email}' refused: ${seat.reason}`,
  });
  return {
    status: 403,
    body: {
      error: seat.ruleId === "seat_cap_reached" ? "seat_cap_reached" : "license_expansion_refused",
      ruleId: seat.ruleId,
      activeSeats: seat.activeSeats,
      seatCap: seat.seatCap,
      detail: seat.reason,
    },
  };
}

/** exported for the admin surface and the tests */
export { LICENSE_ACTION_INVENTORY, LICENSE_POSTURE_NOTE, SEAT_DEFINITION_NOTE };
export type { LicenseDocument, LicenseState, LicenseActionClass };
