/**
 * ADR-0189 R25 item 12 — the install-generated receipt signing key (receipt-signing-key.ts).
 *
 * No database: generation, idempotency, no overwrite, permissions, the create-exclusive race (real
 * processes), the posture states, fail-closed generation, and the installer's --check render. Every
 * key here is generated at run time in a temporary directory; no key material is committed.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, chownSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadReceiptSigningKey } from "./decision-receipts.js";
import {
  checkReceiptSigningKey,
  ensureInstallReceiptKey,
  INSTALL_RECEIPT_KEY_FILE,
  installReceiptKeyId,
  ReceiptKeyError,
  receiptSigningKeyPosture,
  removeStaleInstallKeyTemps,
  resolveReceiptSigningKey,
  STALE_TMP_MS,
} from "./receipt-signing-key.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const posix = process.platform !== "win32";
let sandbox: string;
let n = 0;
const freshDir = () => path.join(sandbox, `case-${++n}`);
const installEnv = (dir: string): NodeJS.ProcessEnv => ({ REGULAIT_INSTALL_SECRETS_DIR: dir }) as NodeJS.ProcessEnv;
const pem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const mode = (p: string) => statSync(p).mode & 0o777;

beforeAll(() => { sandbox = mkdtempSync(path.join(os.tmpdir(), "rkey-test-")); });
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe("first-boot generation", () => {
  it("creates one PKCS#8 Ed25519 key, mode 0600, in a 0700 directory, and resolves it as install_generated", () => {
    const dir = freshDir();
    const r = ensureInstallReceiptKey(installEnv(dir));
    expect(r.outcome).toBe("created");
    if (r.outcome !== "created") return;
    const file = path.join(dir, INSTALL_RECEIPT_KEY_FILE);
    expect(r.path).toBe(file);
    expect(readFileSync(file, "utf8")).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    if (posix) {
      expect(mode(file)).toBe(0o600);
      expect(mode(dir)).toBe(0o700);
    }
    expect(r.keyId).toMatch(/^install-ed25519-[0-9a-f]{32}$/);
    expect(r.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const key = resolveReceiptSigningKey(installEnv(dir));
    expect(key?.source).toBe("install_generated");
    expect(key?.keyId).toBe(r.keyId);
    expect(key?.privateKey.asymmetricKeyType).toBe("ed25519");
    // nothing else is left behind in the directory (no temporary file)
    expect(readdirSync(dir)).toEqual([INSTALL_RECEIPT_KEY_FILE]);
  });

  it("is idempotent: a second boot reuses the key, byte for byte", () => {
    const dir = freshDir();
    const first = ensureInstallReceiptKey(installEnv(dir));
    const bytes = readFileSync(path.join(dir, INSTALL_RECEIPT_KEY_FILE));
    const second = ensureInstallReceiptKey(installEnv(dir));
    expect(second.outcome).toBe("reused");
    expect(second).toMatchObject({ keyId: (first as { keyId: string }).keyId });
    expect(readFileSync(path.join(dir, INSTALL_RECEIPT_KEY_FILE)).equals(bytes)).toBe(true);
  });

  it("the key id is derived from the public key, so a replacement key gets a new id", () => {
    const a = ensureInstallReceiptKey(installEnv(freshDir()));
    const b = ensureInstallReceiptKey(installEnv(freshDir()));
    expect((a as { keyId: string }).keyId).not.toBe((b as { keyId: string }).keyId);
    const jwk = resolveReceiptSigningKey(installEnv(path.dirname((a as { path: string }).path)))!.jwk;
    expect(installReceiptKeyId(jwk)).toBe((a as { keyId: string }).keyId);
  });

  it("never overwrites an existing file, even an unusable one, and reports it", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, INSTALL_RECEIPT_KEY_FILE);
    writeFileSync(file, "not a key\n", { mode: 0o600 });
    const r = ensureInstallReceiptKey(installEnv(dir));
    expect(r.outcome).toBe("failed");
    expect(readFileSync(file, "utf8")).toBe("not a key\n");
    expect(() => resolveReceiptSigningKey(installEnv(dir))).toThrow(ReceiptKeyError);
    expect(receiptSigningKeyPosture(installEnv(dir)).state).toBe("invalid");
  });

  it.runIf(posix)("refuses an install key readable by group or others, and a symlinked one", () => {
    const dir = freshDir();
    ensureInstallReceiptKey(installEnv(dir));
    const file = path.join(dir, INSTALL_RECEIPT_KEY_FILE);
    chmodSync(file, 0o644);
    expect(() => resolveReceiptSigningKey(installEnv(dir))).toThrow(ReceiptKeyError);
    expect(receiptSigningKeyPosture(installEnv(dir)).state).toBe("invalid");
    // and the ensure step leaves it alone rather than "repairing" it
    expect(ensureInstallReceiptKey(installEnv(dir)).outcome).toBe("failed");
    expect(mode(file)).toBe(0o644);

    const linked = freshDir();
    mkdirSync(linked, { recursive: true, mode: 0o700 });
    chmodSync(file, 0o600);
    symlinkSync(file, path.join(linked, INSTALL_RECEIPT_KEY_FILE));
    // opened O_NOFOLLOW: a symlink is never followed, even to a good key
    expect(() => resolveReceiptSigningKey(installEnv(linked))).toThrow(ReceiptKeyError);
    expect(resolveReceiptSigningKey(installEnv(dir))?.source).toBe("install_generated");
  });

  it.runIf(posix)("refuses a key with a second hard link, and one in a directory with group or other access", () => {
    const dir = freshDir();
    ensureInstallReceiptKey(installEnv(dir));
    const file = path.join(dir, INSTALL_RECEIPT_KEY_FILE);
    const elsewhere = freshDir();
    mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
    linkSync(file, path.join(elsewhere, "copy.pem"));
    expect(() => resolveReceiptSigningKey(installEnv(dir))).toThrow(ReceiptKeyError);
    rmSync(path.join(elsewhere, "copy.pem"));
    expect(resolveReceiptSigningKey(installEnv(dir))?.source).toBe("install_generated");
    chmodSync(dir, 0o750);
    expect(() => resolveReceiptSigningKey(installEnv(dir))).toThrow(ReceiptKeyError);
    expect(receiptSigningKeyPosture(installEnv(dir)).state).toBe("invalid");
    chmodSync(dir, 0o700);
    expect(resolveReceiptSigningKey(installEnv(dir))?.source).toBe("install_generated");
  });

  it.runIf(posix && process.getuid?.() === 0)("refuses a key file or directory owned by another user", () => {
    const dir = freshDir();
    ensureInstallReceiptKey(installEnv(dir));
    const file = path.join(dir, INSTALL_RECEIPT_KEY_FILE);
    chownSync(file, 1000, 1000);
    expect(() => resolveReceiptSigningKey(installEnv(dir))).toThrow(ReceiptKeyError);
    chownSync(file, 0, 0);
    chownSync(dir, 1000, 1000);
    expect(() => resolveReceiptSigningKey(installEnv(dir))).toThrow(ReceiptKeyError);
  });

  it("removes a crashed generation's stale temporary file, and never a fresh one or the key", () => {
    const dir = freshDir();
    ensureInstallReceiptKey(installEnv(dir));
    const stale = path.join(dir, `.${INSTALL_RECEIPT_KEY_FILE}.4242.0123456789ab.tmp`);
    const fresh = path.join(dir, `.${INSTALL_RECEIPT_KEY_FILE}.4243.ba9876543210.tmp`);
    const unrelated = path.join(dir, "notes.tmp");
    for (const f of [stale, fresh, unrelated]) writeFileSync(f, "x", { mode: 0o600 });
    const old = new Date(Date.now() - STALE_TMP_MS - 5_000);
    utimesSync(stale, old, old);
    utimesSync(unrelated, old, old);
    expect(removeStaleInstallKeyTemps(dir)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([`.${INSTALL_RECEIPT_KEY_FILE}.4243.ba9876543210.tmp`, INSTALL_RECEIPT_KEY_FILE, "notes.tmp"].sort());
    // and the boot path sweeps them too: an hour from now the fresh one is stale
    expect(ensureInstallReceiptKey(installEnv(dir), { now: () => Date.now() + 3_600_000 }).outcome).toBe("reused");
    expect(readdirSync(dir).sort()).toEqual([INSTALL_RECEIPT_KEY_FILE, "notes.tmp"].sort());
  });

  it.runIf(posix)("#353 follow-up: a crash between publishing the key and removing its temporary file heals from the posture path once that file is stale", () => {
    const dir = freshDir();
    ensureInstallReceiptKey(installEnv(dir));
    const file = path.join(dir, INSTALL_RECEIPT_KEY_FILE);
    const tmp = path.join(dir, `.${INSTALL_RECEIPT_KEY_FILE}.4244.00112233aabb.tmp`);
    linkSync(file, tmp); // the crashed generator's temporary file: a second link to the key
    // fresh, it may be a generation in flight: left alone, and the two-link key is refused
    expect(() => resolveReceiptSigningKey(installEnv(dir))).toThrow(ReceiptKeyError);
    expect(receiptSigningKeyPosture(installEnv(dir)).state).toBe("invalid");
    expect(existsSync(tmp)).toBe(true);
    // stale: the posture read (no restart, no ensure) removes it and the key resolves again, unchanged
    const keyBefore = readFileSync(file, "utf8");
    const old = new Date(Date.now() - STALE_TMP_MS - 5_000);
    utimesSync(tmp, old, old);
    expect(receiptSigningKeyPosture(installEnv(dir)).state).toBe("install_generated");
    expect(existsSync(tmp)).toBe(false);
    expect(statSync(file).nlink).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(keyBefore);
    // a refusal with no stale temporary file to remove still stands (here: group access on the directory)
    chmodSync(dir, 0o750);
    expect(() => resolveReceiptSigningKey(installEnv(dir))).toThrow(ReceiptKeyError);
    chmodSync(dir, 0o700);
  });

  it("does nothing while the operator variables are set (a test or demo that sets its own key generates nothing)", () => {
    const dir = freshDir();
    const opDir = freshDir();
    mkdirSync(opDir, { recursive: true });
    const opFile = path.join(opDir, "operator.pem");
    writeFileSync(opFile, pem(), { mode: 0o600 });
    const env = { ...installEnv(dir), REGULAIT_RECEIPT_SIGNING_KEY: opFile, REGULAIT_RECEIPT_SIGNING_KEY_ID: "operator-key-1" };
    expect(ensureInstallReceiptKey(env)).toEqual({ outcome: "operator_managed" });
    expect(existsSync(dir)).toBe(false);
    // only ONE operator variable set still counts as "the operator claims the key": nothing generated
    expect(ensureInstallReceiptKey({ ...installEnv(dir), REGULAIT_RECEIPT_SIGNING_KEY_ID: "x" })).toEqual({ outcome: "operator_managed" });
    expect(existsSync(dir)).toBe(false);
  });

  it("with no install secrets directory there is nowhere to keep a key: not_configured, nothing written", () => {
    expect(ensureInstallReceiptKey({})).toEqual({ outcome: "not_configured" });
    expect(resolveReceiptSigningKey({})).toBeNull();
  });
});

describe("concurrent first boots (create-exclusive)", () => {
  it("a boot that loses the race reuses the winner's key and discards its own", () => {
    const dir = freshDir();
    const winner = freshDir();
    const won = ensureInstallReceiptKey(installEnv(winner));
    const r = ensureInstallReceiptKey(installEnv(dir), {
      generate: () => {
        // another boot publishes its key between our existence check and our link
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(dir, INSTALL_RECEIPT_KEY_FILE), readFileSync((won as { path: string }).path), { mode: 0o600 });
        return { privateKeyPem: pem() };
      },
    });
    expect(r).toMatchObject({ outcome: "reused", keyId: (won as { keyId: string }).keyId });
    expect(readdirSync(dir)).toEqual([INSTALL_RECEIPT_KEY_FILE]);
  });

  const cli = path.resolve(here, "../dist/receipt-key-init.js");
  it.runIf(existsSync(cli))("eight processes started together end with exactly one key, and all report it", async () => {
    const dir = freshDir();
    const runs = await Promise.all(
      Array.from({ length: 8 }, () =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          const env: NodeJS.ProcessEnv = { ...process.env, REGULAIT_INSTALL_SECRETS_DIR: dir };
          delete env.REGULAIT_RECEIPT_SIGNING_KEY;
          delete env.REGULAIT_RECEIPT_SIGNING_KEY_ID;
          const child = spawn(process.execPath, [cli], { env });
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (out += d));
          child.on("close", (code) => resolve({ code, out }));
        }),
      ),
    );
    expect(runs.map((r) => r.code)).toEqual(Array(8).fill(0));
    const ids = new Set(runs.map((r) => /install-ed25519-[0-9a-f]{32}/.exec(r.out)?.[0]));
    expect(ids.size).toBe(1);
    expect(runs.filter((r) => r.out.includes("on this boot")).length).toBe(1);
    expect(readdirSync(dir)).toEqual([INSTALL_RECEIPT_KEY_FILE]);
    const keyBody = readFileSync(path.join(dir, INSTALL_RECEIPT_KEY_FILE), "utf8").split("\n")[1]!;
    for (const r of runs) {
      expect(r.out).not.toContain("PRIVATE KEY");
      expect(r.out).not.toContain(keyBody);
    }
  }, 30_000);
});

describe("the boot log and installer RESOLVE the key (an unusable operator key is invalid, exit 1)", () => {
  const cli = path.resolve(here, "../dist/receipt-key-init.js");
  const run = (env: NodeJS.ProcessEnv) => {
    const full: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ["REGULAIT_RECEIPT_SIGNING_KEY", "REGULAIT_RECEIPT_SIGNING_KEY_ID", "REGULAIT_INSTALL_SECRETS_DIR"]) delete full[k];
    const r = spawnSync(process.execPath, [cli], { env: { ...full, ...env }, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("checkReceiptSigningKey: only _KEY_ID, a missing file, and a non-key are invalid with exit code 1", () => {
    const dir = freshDir();
    for (const env of [
      { ...installEnv(dir), REGULAIT_RECEIPT_SIGNING_KEY_ID: "operator-key-1" },
      { ...installEnv(dir), REGULAIT_RECEIPT_SIGNING_KEY: "/nonexistent/receipt.pem", REGULAIT_RECEIPT_SIGNING_KEY_ID: "operator-key-1" },
      { ...installEnv(dir), REGULAIT_RECEIPT_SIGNING_KEY: "/nonexistent/receipt.pem" },
    ] as NodeJS.ProcessEnv[]) {
      const c = checkReceiptSigningKey(env);
      expect(c.ensure.outcome).toBe("operator_managed");
      expect(c.posture.state).toBe("invalid");
      expect(c.exitCode).toBe(1);
      expect(c.line).toMatch(/^invalid/);
    }
    expect(existsSync(dir)).toBe(false); // and nothing was generated beside the broken operator key
  });

  it("checkReceiptSigningKey: a usable operator key is operator-managed, exit 0", () => {
    const opDir = freshDir();
    mkdirSync(opDir, { recursive: true, mode: 0o700 });
    const opFile = path.join(opDir, "operator.pem");
    writeFileSync(opFile, pem(), { mode: 0o600 });
    const c = checkReceiptSigningKey({ REGULAIT_RECEIPT_SIGNING_KEY: opFile, REGULAIT_RECEIPT_SIGNING_KEY_ID: "operator-key-1" } as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ exitCode: 0, posture: { state: "operator_managed", keyId: "operator-key-1" } });
    expect(c.line).toMatch(/^operator-managed: operator-key-1 \(sha256:/);
  });

  it.runIf(existsSync(cli))("the CLI exits 1 and prints invalid for only _KEY_ID set, and for _KEY=/nonexistent", () => {
    const onlyId = run({ REGULAIT_RECEIPT_SIGNING_KEY_ID: "operator-key-1" });
    expect(onlyId.code).toBe(1);
    expect(onlyId.out).toMatch(/^receipt signing key: invalid/);
    const missing = run({ REGULAIT_RECEIPT_SIGNING_KEY: "/nonexistent/receipt.pem", REGULAIT_RECEIPT_SIGNING_KEY_ID: "operator-key-1" });
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/^receipt signing key: invalid/);
  });

  it.runIf(existsSync(cli))("the CLI exits 2 with nowhere to keep a key, and 0 with an install key", () => {
    expect(run({}).code).toBe(2);
    const ok = run({ REGULAIT_INSTALL_SECRETS_DIR: freshDir() });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^receipt signing key: install-generated on this boot: install-ed25519-/);
  });
});

describe("fail closed when generation fails", () => {
  it("a generator that throws leaves no key, and every signer still sees none", () => {
    const dir = freshDir();
    const r = ensureInstallReceiptKey(installEnv(dir), { generate: () => { throw new Error("entropy unavailable"); } });
    expect(r.outcome).toBe("failed");
    expect(existsSync(path.join(dir, INSTALL_RECEIPT_KEY_FILE))).toBe(false);
    expect(resolveReceiptSigningKey(installEnv(dir))).toBeNull();
    expect(receiptSigningKeyPosture(installEnv(dir)).state).toBe("missing");
    const check = checkReceiptSigningKey(installEnv(dir), { generate: () => { throw new Error("entropy unavailable"); } });
    expect(check.exitCode).toBe(1);
    expect(check.line).toContain("sign-offs stay refused");
  });

  it("a generator that returns something other than an Ed25519 key writes nothing", () => {
    const dir = freshDir();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(ensureInstallReceiptKey(installEnv(dir), { generate: () => ({ privateKeyPem: rsa }) }).outcome).toBe("failed");
    expect(existsSync(path.join(dir, INSTALL_RECEIPT_KEY_FILE))).toBe(false);
  });

  it("an unwritable location fails without throwing", () => {
    const blocker = path.join(freshDir(), "a-file");
    mkdirSync(path.dirname(blocker), { recursive: true });
    writeFileSync(blocker, "x");
    const r = ensureInstallReceiptKey(installEnv(path.join(blocker, "sub")));
    expect(r.outcome).toBe("failed");
  });

  it("the shared loader every sign-off uses returns null (refused), never a key, after a failed generation", () => {
    const dir = freshDir();
    ensureInstallReceiptKey(installEnv(dir), { generate: () => { throw new Error("boom"); } });
    const saved = { dir: process.env.REGULAIT_INSTALL_SECRETS_DIR, file: process.env.REGULAIT_RECEIPT_SIGNING_KEY, id: process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID };
    try {
      delete process.env.REGULAIT_RECEIPT_SIGNING_KEY;
      delete process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID;
      process.env.REGULAIT_INSTALL_SECRETS_DIR = dir;
      expect(loadReceiptSigningKey()).toBeNull();
      // and once a key IS generated, the same loader signs with it
      ensureInstallReceiptKey(installEnv(dir));
      expect(loadReceiptSigningKey()?.keyId).toMatch(/^install-ed25519-/);
    } finally {
      for (const [k, v] of [["REGULAIT_INSTALL_SECRETS_DIR", saved.dir], ["REGULAIT_RECEIPT_SIGNING_KEY", saved.file], ["REGULAIT_RECEIPT_SIGNING_KEY_ID", saved.id]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("posture: install_generated | operator_managed | missing | invalid", () => {
  it("names the source, the key id and the public fingerprint, and never the private key", () => {
    const dir = freshDir();
    ensureInstallReceiptKey(installEnv(dir));
    const p = receiptSigningKeyPosture(installEnv(dir));
    expect(p).toMatchObject({ state: "install_generated", publicKeys: "/v1/receipts/keys" });
    expect(p.keyId).toMatch(/^install-ed25519-/);
    expect(p.publicKeyFingerprint).toMatch(/^sha256:/);
    const body = readFileSync(path.join(dir, INSTALL_RECEIPT_KEY_FILE), "utf8").split("\n")[1]!;
    const json = JSON.stringify(p);
    expect(json).not.toContain("PRIVATE");
    expect(json).not.toContain(body);
    expect(json).not.toContain('"d"');
  });

  it("operator variables win over an install-generated key", () => {
    const dir = freshDir();
    ensureInstallReceiptKey(installEnv(dir));
    const opFile = path.join(dir, "operator.pem");
    writeFileSync(opFile, pem(), { mode: 0o600 });
    const env = { ...installEnv(dir), REGULAIT_RECEIPT_SIGNING_KEY: opFile, REGULAIT_RECEIPT_SIGNING_KEY_ID: "operator-key-1" };
    expect(receiptSigningKeyPosture(env)).toMatchObject({ state: "operator_managed", keyId: "operator-key-1" });
    expect(resolveReceiptSigningKey(env)?.source).toBe("operator_managed");
  });

  it("a broken operator key is invalid and never falls back to the install key", () => {
    const dir = freshDir();
    ensureInstallReceiptKey(installEnv(dir));
    const halfConfigured = { ...installEnv(dir), REGULAIT_RECEIPT_SIGNING_KEY_ID: "operator-key-1" };
    expect(receiptSigningKeyPosture(halfConfigured).state).toBe("invalid");
    expect(() => resolveReceiptSigningKey(halfConfigured)).toThrow(ReceiptKeyError);
    const missingFile = { ...installEnv(dir), REGULAIT_RECEIPT_SIGNING_KEY: path.join(dir, "absent.pem"), REGULAIT_RECEIPT_SIGNING_KEY_ID: "k" };
    expect(receiptSigningKeyPosture(missingFile).state).toBe("invalid");
  });

  it("missing when nothing is configured", () => {
    expect(receiptSigningKeyPosture({})).toMatchObject({ state: "missing", keyId: null, publicKeyFingerprint: null });
    expect(receiptSigningKeyPosture(installEnv(freshDir())).state).toBe("missing");
  });
});

describe("scripts/install.sh --check renders the receipt key choice", () => {
  const INSTALL = path.join(root, "scripts/install.sh");
  const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
  function runCheck(dir: string, args: string[] = []): { status: number; output: string } {
    const dataKey = execFileSync("openssl", ["rand", "-hex", "32"], { encoding: "utf8" }).trim();
    const env = { ...process.env };
    for (const k of ["REGULAIT_DEMO_LICENSE", "REGULAIT_RECEIPT_KEY_HOST_FILE", "REGULAIT_RECEIPT_KEY_HOST_ID"]) delete env[k];
    const r = spawnSync("bash", [INSTALL, "--check", "--yes", "--mode", "byoc", "--domain", "rkey.example", "--dir", dir, "--data-key", dataKey, "--min-disk-gb", "0", ...args], {
      encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("#353 follow-up: the installer's receipt-key step is fatal on exit 1 and on exit 2 (no secrets directory), and only warns when the check could not run", () => {
    // the step's own `case` block, run with the installer's die/ok/warn stubbed: what each exit code does
    const script = readFileSync(INSTALL, "utf8");
    const start = script.indexOf('case "$RECEIPT_KEY_RC:$RECEIPT_KEY_LINE" in');
    const end = script.indexOf("\nesac", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = script.slice(start, end + "\nesac".length);
    const run = (rc: number, line: string) =>
      spawnSync("bash", ["-c", `die() { echo "DIE"; exit 9; }; ok() { echo "OK"; }; warn() { echo "WARN"; }; PROJECT=p; RECEIPT_KEY_RC="$1"; RECEIPT_KEY_LINE="$2"\n${block}\necho "CONTINUED"`, "case", String(rc), line], { encoding: "utf8" });
    expect(run(0, "receipt signing key: install-generated: k (f)")).toMatchObject({ status: 0, stdout: "OK\nCONTINUED\n" });
    expect(run(1, "receipt signing key: invalid — x")).toMatchObject({ status: 9, stdout: "DIE\n" });
    expect(run(2, "receipt signing key: missing — none configured and REGULAIT_INSTALL_SECRETS_DIR is unset")).toMatchObject({ status: 9, stdout: "DIE\n" });
    // the gateway could not be reached (docker exec failed): no key verdict at all, so a warning, not a refusal
    expect(run(125, "Error response from daemon: container not running")).toMatchObject({ status: 0, stdout: "WARN\nWARN\nCONTINUED\n" });
  });

  it.runIf(hasOpenssl)("default: install-generated, nothing about the key in .env or the override", () => {
    const dir = freshDir();
    const r = runCheck(dir);
    expect(r.status, r.output.slice(-2000)).toBe(0);
    expect(r.output).toContain("install-generated");
    expect(readFileSync(path.join(dir, ".env"), "utf8")).not.toContain("RECEIPT");
    expect(readFileSync(path.join(dir, "compose.install.yml"), "utf8")).not.toContain("receipt");
  });

  it.runIf(hasOpenssl)("operator-managed: mounted read-only, both variables rendered, preserved on a re-run, the key never echoed", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "operator-receipt.pem");
    const keyPem = pem();
    writeFileSync(keyFile, keyPem, { mode: 0o600 });
    const r = runCheck(dir, ["--receipt-key-file", keyFile, "--receipt-key-id", "operator-receipt-1"]);
    expect(r.status).toBe(0);
    const env = readFileSync(path.join(dir, ".env"), "utf8");
    expect(env).toContain(`REGULAIT_RECEIPT_KEY_HOST_FILE=${keyFile}\n`);
    expect(env).toContain("REGULAIT_RECEIPT_KEY_HOST_ID=operator-receipt-1\n");
    // .env is interpolation input only; the base compose file no longer forwards these, the override sets them
    expect(env).not.toMatch(/^REGULAIT_RECEIPT_SIGNING_KEY/m);
    const override = readFileSync(path.join(dir, "compose.install.yml"), "utf8");
    expect(override).toContain('      REGULAIT_RECEIPT_SIGNING_KEY: "/run/secrets/regulait-receipt-signing-key"\n');
    expect(override).toContain('      REGULAIT_RECEIPT_SIGNING_KEY_ID: "operator-receipt-1"\n');
    expect(override).toContain(`    volumes:\n      - "${keyFile}:/run/secrets/regulait-receipt-signing-key:ro"\n`);
    const body = keyPem.split("\n")[1]!;
    expect(r.output).not.toContain(body);
    expect(env).not.toContain(body);
    // a re-run with no flags keeps the operator key
    const again = runCheck(dir);
    expect(again.status).toBe(0);
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toContain("REGULAIT_RECEIPT_KEY_HOST_ID=operator-receipt-1\n");
    expect(readFileSync(path.join(dir, "compose.install.yml"), "utf8")).toContain('REGULAIT_RECEIPT_SIGNING_KEY_ID: "operator-receipt-1"');
  });

  it.runIf(hasOpenssl)("refuses a key path outside the allowlist ^/[A-Za-z0-9._/@+-]+$ (no $, backslash, #, newline, space, colon, quotes, relative)", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    for (const bad of [`${dir}/$HOME.pem`, `${dir}/a\\b.pem`, `${dir}/a#b.pem`, `${dir}/a\nb.pem`, `${dir}/a b.pem`, `${dir}/a:b.pem`, `${dir}/a"b.pem`, `${dir}/a'b.pem`, "relative/key.pem"]) {
      const r = runCheck(dir, ["--receipt-key-file", bad, "--receipt-key-id", "k1"]);
      expect(r.status, bad).not.toBe(0);
      expect(r.output, bad).toContain("--receipt-key-file");
      expect(existsSync(path.join(dir, "compose.install.yml")), bad).toBe(false);
    }
  });

  it.runIf(hasOpenssl && posix)("warns when the key file is not owned by uid 1000 (the container's node user)", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "operator-receipt.pem");
    writeFileSync(keyFile, pem(), { mode: 0o600 });
    const owner = statSync(keyFile).uid;
    const r = runCheck(dir, ["--receipt-key-file", keyFile, "--receipt-key-id", "operator-receipt-1"]);
    expect(r.status, r.output.slice(-2000)).toBe(0);
    if (owner !== 1000) expect(r.output).toMatch(/owned by uid \d+, not 1000/);
  });

  it.runIf(hasOpenssl)("refuses half a configuration, a bad key id, and a file that is not an Ed25519 key", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "k.pem");
    writeFileSync(keyFile, pem(), { mode: 0o600 });
    expect(runCheck(dir, ["--receipt-key-file", keyFile]).status).not.toBe(0);
    expect(runCheck(dir, ["--receipt-key-file", keyFile, "--receipt-key-id", "bad id!"]).status).not.toBe(0);
    const notKey = path.join(dir, "not-a-key.pem");
    writeFileSync(notKey, "hello\n", { mode: 0o600 });
    const r = runCheck(dir, ["--receipt-key-file", notKey, "--receipt-key-id", "k1"]);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("not a readable PKCS#8 Ed25519 private key");
  });
});
