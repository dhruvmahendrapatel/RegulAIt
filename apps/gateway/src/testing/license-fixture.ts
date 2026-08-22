/**
 * A REAL license install for suites whose surfaces are tier-gated (ADR-0052
 * §4): since the sso_saml / scim_provisioning flags became ENFORCED at their
 * creation routes, a suite that creates SAML providers or SCIM tokens needs a
 * license granting those features — an unlicensed deployment refuses them,
 * exactly as `GET /v1/licenses/status` has reported since the ADR shipped.
 *
 * Same discipline as licensing.test.ts, deliberately: a REAL Ed25519 keypair
 * generated in memory, only its public half written into a temporary keyring,
 * `REGULAIT_LICENSE_KEYRING` pointed at it for exactly the duration of the
 * install and restored after (M-012 — never leave a process-wide knob
 * flipped), and the artifact installed through the REAL route so the exact
 * verification path every deployment runs is the one the fixture exercises.
 * No committed secret, nothing for .gitignore to catch.
 *
 * SHARED-STATE DISCIPLINE: `licenses` is an ORG SINGLETON — at most one active
 * row, and a stray one would change how every other suite's user creation and
 * tier-gated routes behave. `removeLicenseFixture` clears both licensing
 * tables so the deployment ends the suite UNLICENSED exactly as it started;
 * call it in afterAll via closeAll-style ordering (before ending the pool).
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { licenseVerifications, licenses, type Db } from "@regulait/db";
import {
  LICENSE_SCHEMA_ID,
  canonicalLicenseBytes,
  licenseDocumentSchema,
  type LicenseFeature,
} from "@regulait/shared";

/** the far future every fixture license is valid until */
const FIXTURE_EXPIRY = "2099-01-01T00:00:00.000Z";

export interface LicenseFixtureOptions {
  /** tier flags this suite needs granted (ADR-0052 §4) */
  features: LicenseFeature[];
  /** admin/bootstrap Authorization header for POST /v1/licenses */
  auth: { authorization: string };
  tier?: string;
  seatCap?: number;
}

/** minimal inject surface so the fixture works with any buildApp return */
interface Injectable {
  inject(opts: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload: unknown;
  }): Promise<{ statusCode: number; body: string }>;
}

/**
 * Generate an ephemeral keypair, sign a license granting `features`, install
 * it through the real route, and restore `REGULAIT_LICENSE_KEYRING`. Throws
 * (with the response body) if the install is refused — a fixture that silently
 * failed to license the suite would let every downstream refusal masquerade as
 * the behaviour under test.
 */
export async function installLicenseFixture(
  app: Injectable,
  opts: LicenseFixtureOptions,
): Promise<void> {
  const keyring = mkdtempSync(path.join(tmpdir(), "regulait-license-fixture-"));
  const prevKeyring = process.env.REGULAIT_LICENSE_KEYRING;
  try {
    const keyId = "fixture-key";
    const kp = generateKeyPairSync("ed25519");
    writeFileSync(
      path.join(keyring, `${keyId}.pub`),
      kp.publicKey.export({ type: "spki", format: "pem" }) as string,
    );
    const doc = licenseDocumentSchema.parse({
      schema: LICENSE_SCHEMA_ID,
      licenseId: `fixture-${process.pid}-${Date.now()}`,
      tenant: "test-fixture",
      tier: opts.tier ?? "enterprise",
      seatCap: opts.seatCap ?? 10_000,
      features: opts.features,
      deploymentMode: "byoc",
      issuedAt: "2026-01-01T00:00:00.000Z",
      notBefore: "2026-01-01T00:00:00.000Z",
      expiresAt: FIXTURE_EXPIRY,
      graceDays: 30,
    });
    const bytes = Buffer.from(canonicalLicenseBytes(doc), "utf8");
    const signature = cryptoSign(null, bytes, kp.privateKey).toString("base64");
    process.env.REGULAIT_LICENSE_KEYRING = keyring;
    const res = await app.inject({
      method: "POST",
      url: "/v1/licenses",
      headers: opts.auth,
      payload: {
        documentBase64: bytes.toString("base64"),
        signature,
        signingKeyId: keyId,
      },
    });
    if (res.statusCode !== 201) {
      throw new Error(`license fixture install refused (${res.statusCode}): ${res.body}`);
    }
  } finally {
    if (prevKeyring === undefined) delete process.env.REGULAIT_LICENSE_KEYRING;
    else process.env.REGULAIT_LICENSE_KEYRING = prevKeyring;
    rmSync(keyring, { recursive: true, force: true });
  }
}

/** clear both licensing tables — the deployment ends the suite UNLICENSED */
export async function removeLicenseFixture(db: Db): Promise<void> {
  await db.delete(licenseVerifications);
  await db.delete(licenses);
}
