// ADR-0324: the release-key ceremony tooling and the release workflow.
// The dry run performs the whole ceremony with throwaway keys in a temp dir and proves that a signed release
// verifies while each tampering, stolen-key and rollback case is refused for the right reason.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (args) => spawnSync("bash", args, { cwd: repo, encoding: "utf8", timeout: 170_000 });
const KEYRING = path.join(repo, "infra/release-keys");

describe("release-key ceremony dry run (ADR-0324)", () => {
  it("signs and verifies a release, and refuses every attack case", () => {
    const r = run(["scripts/release-ceremony.sh", "dry-run"]);
    const out = r.stdout + r.stderr;
    expect(out, out).toMatch(/DRY RUN PASSED: (\d+)\/\1 checks/);
    expect(r.status, out).toBe(0);
    // non-vacuity: the refusals ran, with their reasons checked inside the dry run
    for (const line of [
      "an UNSIGNED candidate is not a release",
      "a validly signed release under an attacker's own root",
      "after the rotation, the STOLEN key's new release is refused",
      "the stolen key replaying the OLD keyring (serial 1) to un-revoke itself",
      "provenance of a different build swapped in",
      "a candidate with no SBOM fails verification",
    ]) {
      expect(out).toContain(`[refused] ${line}`);
    }
    expect(Number(out.match(/DRY RUN PASSED: (\d+)/)[1])).toBeGreaterThanOrEqual(38);
    expect(out).toContain("[refused] apply-update-bundle.sh refuses a stolen key's bundle that plants its own .pub");
    expect(out).toContain("[pass]    the refused bundle left the install directory untouched");
    // the throwaway keys are deleted
    const dir = out.match(/DRY RUN in (\S+)/)[1];
    expect(existsSync(dir)).toBe(false);
  }, 180_000);
});

describe("dry-run-only passphrase modes are refused on a real run (#853 S1)", () => {
  const out = mkdtempSync(path.join(tmpdir(), "e9-real-keygen-"));
  const keygen = (pass, env = {}) =>
    spawnSync("bash", ["scripts/release-ceremony.sh", "keygen", "--role", "root", "--id", "probe", "--out", out, "--pass", pass, "--allow-network"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  it.each([["none"], ["pass:not-a-real-passphrase"]])("keygen --pass %s fails and writes no key", (pass) => {
    const r = keygen(pass);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("is refused");
    expect(existsSync(path.join(out, "probe.pem"))).toBe(false);
  });
  it("a dry-run marker pointing anywhere but a dry-run temp dir does not unlock them", () => {
    const r = keygen("none", { REGULAIT_CEREMONY_DRY_RUN_DIR: out });
    expect(r.status).not.toBe(0);
    expect(existsSync(path.join(out, "probe.pem"))).toBe(false);
  });
});

describe("the committed keyring", () => {
  it("is either the untouched development keyring or a root-signed statement that verifies", () => {
    const strict = existsSync(path.join(KEYRING, "keyring.json"));
    const r = run(["scripts/verify-release.sh", "--keyring-only", "infra/release-keys", ...(strict ? [] : ["--allow-dev-keyring"])]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it("holds no private key material", () => {
    const walk = (d) => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
    for (const f of walk(KEYRING)) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/PRIVATE KEY/);
      expect(f).not.toMatch(/\.(pem|key)$/);
    }
  });

  it("a release cannot be verified against the development keyring", () => {
    if (existsSync(path.join(KEYRING, "keyring.json"))) return;
    const r = run(["scripts/release-ceremony.sh", "current-signing-key", "--keyring", "infra/release-keys"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("run the release-key ceremony first");
  });
});

describe("release.yml (ADR-0324)", () => {
  const wf = yaml.load(readFileSync(path.join(repo, ".github/workflows/release.yml"), "utf8"));
  const text = readFileSync(path.join(repo, ".github/workflows/release.yml"), "utf8");

  it("reads only, by default; only the gated attest job may mint an OIDC token", () => {
    expect(wf.permissions).toEqual({});
    for (const [name, job] of Object.entries(wf.jobs)) {
      const p = job.permissions ?? {};
      if (name === "attest") {
        expect(p["id-token"]).toBe("write");
        expect(job.if).toContain("vars.RELEASE_PROVENANCE_PUBLISH_APPROVED == 'true'");
      } else {
        expect(p["id-token"], name).toBeUndefined();
      }
      for (const v of Object.values(p)) expect(["read", "none", ...(name === "attest" ? ["write"] : [])]).toContain(v);
    }
  });

  it("never holds a signing key: no secrets, no --key, and the candidate is built --unsigned", () => {
    expect(text).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
    expect(text).not.toMatch(/--key\s/);
    expect(text).toContain("--unsigned");
  });

  it("pins every action to a full commit SHA", () => {
    const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(2);
    for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/);
  });

  it("verifies published releases and fails on an unsigned asset", () => {
    expect(Object.keys(wf.on)).toEqual(expect.arrayContaining(["push", "release"]));
    expect(wf.on.release.types).toEqual(["published"]);
    expect(text).toContain("scripts/verify-release.sh");
    expect(text).toContain("unsigned.tar.gz");
  });
});
