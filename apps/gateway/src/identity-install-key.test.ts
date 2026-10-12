/**
 * ADR-0188 S7 — the install-generated identity ISSUER key (identity-signing-keys.ts), the receipt
 * key's twin (ADR-0189 R25 item 12). Engine runners and PDP clients authenticate with self tokens the
 * issuer signs, so a fresh install needs an issuer key before any of them can.
 *
 * No database: first-boot generation (0600 in a 0700 directory), idempotency and no overwrite, the
 * operator variable winning, the strict reader refusing a loose file, and the configuration view the
 * posture read and the signing-keys card show. Every key is generated at run time in a temporary
 * directory; no key material is committed.
 */
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateJwkThumbprint } from "jose";
import {
  configuredIdentitySigningKeys,
  ensureInstallIdentityKey,
  identitySigningKeyConfiguration,
  INSTALL_IDENTITY_KEY_FILE,
  installIdentityKeyPath,
} from "./identity-signing-keys.js";
import { INSTALL_RECEIPT_KEY_FILE } from "./receipt-signing-key.js";

const posix = process.platform !== "win32";
let sandbox: string;
let n = 0;
const freshDir = () => path.join(sandbox, `case-${++n}`);
const installEnv = (dir: string): NodeJS.ProcessEnv => ({ REGULAIT_INSTALL_SECRETS_DIR: dir }) as NodeJS.ProcessEnv;
const mode = (p: string) => statSync(p).mode & 0o777;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "ikey-test-"));
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe("ADR-0188 S7: the install-generated issuer key", () => {
  it("first boot creates one Ed25519 key, 0600 in a 0700 directory, and the issuer signs with it", async () => {
    const dir = freshDir();
    const r = await ensureInstallIdentityKey(installEnv(dir));
    expect(r.outcome).toBe("created");
    const file = path.join(dir, INSTALL_IDENTITY_KEY_FILE);
    expect(installIdentityKeyPath(installEnv(dir))).toBe(file);
    expect(readFileSync(file, "utf8")).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    if (posix) {
      expect(mode(file)).toBe(0o600);
      expect(mode(dir)).toBe(0o700);
    }
    const keys = await configuredIdentitySigningKeys(installEnv(dir));
    expect(keys).toHaveLength(1);
    // the kid is the RFC 7638 thumbprint of the public key, as for an operator key
    expect(keys[0]!.kid).toBe(await calculateJwkThumbprint(keys[0]!.publicJwk, "sha256"));
    expect("kid" in r && r.kid).toBe(keys[0]!.kid);
    expect(keys[0]!.privateKey.asymmetricKeyType).toBe("ed25519");
    // nothing else is left in the directory (no temporary file)
    expect(readdirSync(dir)).toEqual([INSTALL_IDENTITY_KEY_FILE]);
  });

  it("a second run (installer after first boot, or a restart) reuses the key and never overwrites it", async () => {
    const dir = freshDir();
    await ensureInstallIdentityKey(installEnv(dir));
    const before = readFileSync(path.join(dir, INSTALL_IDENTITY_KEY_FILE), "utf8");
    const again = await ensureInstallIdentityKey(installEnv(dir));
    expect(again.outcome).toBe("reused");
    expect(readFileSync(path.join(dir, INSTALL_IDENTITY_KEY_FILE), "utf8")).toBe(before);
  });

  it("lives beside the receipt key without touching it (its own file and its own temporary-file pattern)", async () => {
    const dir = freshDir();
    await ensureInstallIdentityKey(installEnv(dir));
    expect(readdirSync(dir)).not.toContain(INSTALL_RECEIPT_KEY_FILE);
  });

  it("the operator variable wins: nothing is generated, and its keys are the configured ones", async () => {
    const dir = freshDir();
    const opDir = mkdtempSync(path.join(sandbox, "op-"));
    const opFile = path.join(opDir, "issuer.pem");
    writeFileSync(opFile, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const env = { ...installEnv(dir), REGULAIT_IDENTITY_SIGNING_KEY: opFile } as NodeJS.ProcessEnv;
    expect((await ensureInstallIdentityKey(env)).outcome).toBe("operator_managed");
    expect(() => readdirSync(dir)).toThrow();
    const view = await identitySigningKeyConfiguration(env);
    expect(view.source).toBe("operator_managed");
    expect(view.configuredKids).toHaveLength(1);
  });

  it("no install secrets directory and no operator key: nothing generated, the view says missing", async () => {
    const env = {} as NodeJS.ProcessEnv;
    expect((await ensureInstallIdentityKey(env)).outcome).toBe("not_configured");
    const view = await identitySigningKeyConfiguration(env);
    expect(view.source).toBe("missing");
    expect(view.configuredKids).toEqual([]);
    expect(view.note).toMatch(/engine runners and PDP clients cannot authenticate/);
  });

  it("the view names an install-generated key by its kid only, never key material", async () => {
    const dir = freshDir();
    await ensureInstallIdentityKey(installEnv(dir));
    const view = await identitySigningKeyConfiguration(installEnv(dir));
    expect(view.source).toBe("install_generated");
    expect(view.configuredKids).toHaveLength(1);
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE|"d"/);
  });

  it.skipIf(!posix)("a loosened key file is refused, not used and not overwritten (fail closed)", async () => {
    const dir = freshDir();
    await ensureInstallIdentityKey(installEnv(dir));
    const file = path.join(dir, INSTALL_IDENTITY_KEY_FILE);
    const before = readFileSync(file, "utf8");
    chmodSync(file, 0o644);
    await expect(configuredIdentitySigningKeys(installEnv(dir))).rejects.toMatchObject({ code: "signing_key_config_invalid" });
    expect((await identitySigningKeyConfiguration(installEnv(dir))).source).toBe("invalid");
    expect((await ensureInstallIdentityKey(installEnv(dir), { now: () => Date.now() })).outcome).toBe("failed");
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
