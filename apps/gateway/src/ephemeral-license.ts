/**
 * The seeder's OPT-IN EPHEMERAL LICENSE (`REGULAIT_EPHEMERAL_LICENSE=1`), as a
 * function so its re-run behaviour can be tested on its own.
 *
 * THE KEY IS MINTED HERE AND THROWN AWAY, and that is the whole design. The
 * committed dev key's private half was destroyed on generation on purpose, so
 * nothing in this repository can mint a license the DEFAULT keyring accepts —
 * the correct fail-closed direction, and retaining a private half to make this
 * convenient would quietly undo it. Instead this generates a fresh keypair,
 * writes only the PUBLIC half into a scratch keyring outside the source tree,
 * signs one short-dated license, and never writes the private half anywhere.
 *
 * RE-RUNS KEEP A GOOD LICENCE. Under Docker the image's start command runs the
 * seeder on EVERY boot (SEED_DEMO=1), so this runs on every
 * `docker compose restart gateway`. When the installed licence is valid, has
 * more than {@link EPHEMERAL_LICENSE_RENEW_DAYS} days left and still verifies
 * under THIS keyring, it is kept and nothing is minted — the licence a
 * presenter set a demo password under survives a restart. Anything else (no
 * licence, expired, nearly expired, or a keyring that no longer holds the
 * signing key, e.g. a fresh scratch directory) mints a new one, as before.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "@regulait/db";
import { LICENSE_FEATURES, LICENSE_SCHEMA_ID, canonicalLicenseBytes } from "@regulait/shared";
import { resolveLicense, verifyLicenseArtifact } from "./licensing.js";

export const EPHEMERAL_LICENSE_KEY_ID = "regulait-seed-ephemeral";
/** a licence with this many days left or fewer is re-minted on the next run */
export const EPHEMERAL_LICENSE_RENEW_DAYS = 7;
const LIFETIME_DAYS = 30;

export type EphemeralLicenseInject = (opts: {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  payload: Record<string, string>;
}) => Promise<{ statusCode: number; body: string }>;

export interface EnsureEphemeralLicenseResult {
  action: "kept" | "minted";
  licenseId: string;
  line: string;
}

export async function ensureEphemeralLicense(input: {
  db: Db;
  inject: EphemeralLicenseInject;
  headers: Record<string, string>;
  keyringDir: string;
  now?: Date;
}): Promise<EnsureEphemeralLicenseResult> {
  const { db, inject, headers, keyringDir } = input;
  const now = input.now ?? new Date();

  // ---- keep a licence that is still good, under THIS keyring ---------------
  const current = await resolveLicense(db, now);
  if (
    current.row &&
    current.document &&
    current.state === "valid" &&
    current.daysRemaining !== null &&
    current.daysRemaining > EPHEMERAL_LICENSE_RENEW_DAYS
  ) {
    const reverified = verifyLicenseArtifact({
      documentBase64: Buffer.from(current.row.document, "utf8").toString("base64"),
      signature: current.row.signature,
      signingKeyId: current.row.signingKeyId,
      keyringDir,
    });
    if (reverified.ok) {
      return {
        action: "kept",
        licenseId: current.document.licenseId,
        line:
          `  license  kept: '${current.document.licenseId}' is valid (${Math.floor(current.daysRemaining)}d left) ` +
          `and verifies under keyring ${keyringDir} — nothing minted`,
      };
    }
  }

  // ---- otherwise mint one ---------------------------------------------------
  mkdirSync(keyringDir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    path.join(keyringDir, `${EPHEMERAL_LICENSE_KEY_ID}.pub`),
    publicKey.export({ type: "spki", format: "pem" }).toString(),
    "utf8",
  );
  const nowIso = now.toISOString();
  const doc = {
    schema: LICENSE_SCHEMA_ID as "regulait.license/1",
    licenseId: `seed-${now.getTime()}`,
    tenant: "regulAIt seeded environment — NOT A PRODUCTION DEPLOYMENT",
    tier: "enterprise",
    seatCap: 25,
    features: [...LICENSE_FEATURES] as string[],
    deploymentMode: "hosted" as const,
    issuedAt: nowIso,
    notBefore: nowIso,
    expiresAt: new Date(now.getTime() + LIFETIME_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    graceDays: 0,
    hardStopOnExpiry: false,
  };
  // sign the EXACT BYTES delivered — the verifier checks the signature over
  // what arrives, never over a re-parse
  const bytes = Buffer.from(canonicalLicenseBytes(doc), "utf8");
  const installed = await inject({
    method: "POST",
    url: "/v1/licenses",
    headers,
    payload: {
      documentBase64: bytes.toString("base64"),
      signature: sign(null, bytes, privateKey).toString("base64"),
      signingKeyId: EPHEMERAL_LICENSE_KEY_ID,
    },
  });
  if (installed.statusCode !== 200 && installed.statusCode !== 201) {
    throw new Error(
      `ephemeral license install failed (${installed.statusCode}): ${installed.body.slice(0, 300)}`,
    );
  }
  return {
    action: "minted",
    licenseId: doc.licenseId,
    line: `  license  ephemeral (${LIFETIME_DAYS}d, all features), keyring ${keyringDir} — NOT production`,
  };
}
