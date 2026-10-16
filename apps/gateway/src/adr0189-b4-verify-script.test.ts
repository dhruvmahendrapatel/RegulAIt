/**
 * ADR-0189 slice B4 — the OFFLINE tools an auditor runs, against the
 * specification-only vectors (`packages/shared/test-vectors/decision-bom/`).
 *
 *  - `scripts/verify-bom.mjs` (R19: one tool for both subjects) verifies a
 *    Decision BOM and an AI BOM bundle under an out-of-band trust root, exits 0
 *    valid, 3 unverifiable, 1 invalid, and refuses (2) to run without both
 *    trust roots; the bundle's own keys are never trusted.
 *  - `scripts/verify-export-bundle.sh` (B4.7-5) accepts `export-bundle/3` and
 *    checks its envelope with stock tools, and still refuses a tampered one.
 *
 * Needs the built packages (`pnpm -r build`): the script imports the dist.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const VERIFY_BOM = path.join(ROOT, "scripts/verify-bom.mjs");
const VERIFY_SH = path.join(ROOT, "scripts/verify-export-bundle.sh");
const corpus = JSON.parse(readFileSync(path.join(ROOT, "packages/shared/test-vectors/decision-bom/b4-vectors.json"), "utf8"));
type Entry = { name: string; type: string; text: string; linkname?: string };
type Vector = { id: string; bundle: { entries?: Entry[]; base?: string; replace?: Record<string, string> } };
const positives = new Map<string, Vector>((corpus.positives as Vector[]).map((p) => [p.id, p]));
const all = new Map<string, Vector>(([...corpus.positives, ...corpus.negatives] as Vector[]).map((p) => [p.id, p]));
const EXPORT_FPR = "sha256:3133075a6bffc999dede86075e66ac42685946d768c1ffbfdacb7c7009096b20";
const RECEIPT_FPR = "sha256:505e806bf46aedd490d099490e7e8d69bd2dec822045e37703cfb4749c746deb";

function tarOf(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.text ?? "", "utf8");
    const h = Buffer.alloc(512);
    let [prefix, name] = ["", e.name];
    if (Buffer.byteLength(name) > 99) {
      const at = name.lastIndexOf("/", 154);
      [prefix, name] = [name.slice(0, at), name.slice(at + 1)];
    }
    const size = e.type === "file" ? body.length : 0;
    const put = (o: number, s: string) => h.write(s, o, "latin1");
    h.write(name, 0, "utf8");
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, `${size.toString(8).padStart(11, "0")}\0`);
    put(136, "00000000000\0");
    put(148, "        ");
    put(156, e.type === "file" ? "0" : e.type === "directory" ? "5" : "2");
    put(257, "ustar\0");
    put(263, "00");
    if (prefix) h.write(prefix, 345, "utf8");
    let sum = 0;
    for (const b of h) sum += b;
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    parts.push(h);
    if (size) parts.push(body, Buffer.alloc((512 - (size % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const entriesOf = (id: string): Entry[] => {
  const v = all.get(id)!;
  if (v.bundle.entries) return v.bundle.entries;
  const r = v.bundle.replace ?? {};
  return positives.get(v.bundle.base!)!.bundle.entries!.map((e) => (e.name in r ? { ...e, text: r[e.name]! } : e));
};

let dir: string;
const bundle = (id: string) => path.join(dir, `${id}.tar.gz`);
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "b4-script-"));
  for (const id of ["P01", "P02", "P14", "P28", "A02", "A03", "N-M01", "N-M09", "N-B07", "N-L01", "N-R12"]) writeFileSync(bundle(id), gzipSync(tarOf(entriesOf(id))));
  writeFileSync(path.join(dir, "receipt-keys.json"), JSON.stringify(corpus.positives[0].trust.receipt.keyring));
  const { receiptV2FromAuditSeq: _boundary, ...keysOnly } = corpus.positives[0].trust.receipt.keyring as Record<string, unknown>;
  writeFileSync(path.join(dir, "receipt-keys-no-boundary.json"), JSON.stringify(keysOnly));
  writeFileSync(path.join(dir, "receipt-keys-null-boundary.json"), JSON.stringify({ ...keysOnly, receiptV2FromAuditSeq: null }));
  writeFileSync(path.join(dir, "receipt-keys-boundary-100.json"), JSON.stringify({ ...keysOnly, receiptV2FromAuditSeq: 100 }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const verifyBom = (...args: string[]) => spawnSync(process.execPath, [VERIFY_BOM, ...args], { encoding: "utf8", timeout: 60_000 });
const withTrust = (id: string, ...extra: string[]) =>
  verifyBom(bundle(id), "--fingerprint", EXPORT_FPR, "--receipt-keyring", path.join(dir, "receipt-keys.json"), "--now", "2026-10-11T00:00:00.000Z", ...extra);

describe("ADR-0189 R19: scripts/verify-bom.mjs, one offline tool for both subjects", () => {
  it("valid Decision BOM and AI BOM bundles exit 0; the JSON report meets the vectors", () => {
    for (const id of ["P01", "P02", "P28", "A02", "A03"]) {
      // P02's trust root records the boundary at 100 (a v1 receipt below it): its own keyring file says so (a flag
      // never overrides a keyring's boundary, B8 recheck L1)
      const r =
        id === "P02"
          ? verifyBom(bundle(id), "--fingerprint", EXPORT_FPR, "--receipt-keyring", path.join(dir, "receipt-keys-boundary-100.json"), "--now", "2026-10-11T00:00:00.000Z", "--json")
          : withTrust(id, "--json");
      expect(r.status, `${id}: ${r.stderr}${r.stdout.slice(0, 400)}`).toBe(0);
      expect(JSON.parse(r.stdout).outcome, id).toBe("valid");
    }
  });
  it("an anchored BOM with no timestamp token exits 3 (unverifiable, not by design)", () => {
    expect(withTrust("P14").status).toBe(3);
  });
  it("a broken manifest, a doctored README, a rogue-signed body and a mismatched BOM-Link exit 1", () => {
    for (const id of ["N-M01", "N-M09", "N-B07", "N-L01"]) {
      const r = withTrust(id, "--json");
      expect(r.status, id).toBe(1);
      expect(JSON.parse(r.stdout).outcome, id).toBe("invalid");
    }
  });
  it("pinned receipt fingerprints work as a trust root, with the boundary given on the command line", () => {
    const r = verifyBom(bundle("P01"), "--fingerprint", EXPORT_FPR, "--receipt-fingerprint", RECEIPT_FPR, "--receipt-v2-from", "42", "--now", "2026-10-11T00:00:00.000Z");
    expect(r.status, r.stdout).toBe(0);
    // with no boundary a v2 receipt is invalid (B4.9 G10): nothing emits v2 before the recorded cutover
    expect(verifyBom(bundle("P01"), "--fingerprint", EXPORT_FPR, "--receipt-fingerprint", RECEIPT_FPR, "--receipt-v2-from", "none").status).toBe(1);
  });
  it("B8 review H1: a keyring with NO receipt v2 boundary is refused (absent is not null); null and a value are honoured", () => {
    const noBoundary = path.join(dir, "receipt-keys-no-boundary.json");
    const nullBoundary = path.join(dir, "receipt-keys-null-boundary.json");
    // absent: refused, whatever the bundle (the reviewer's case: N-R12 came out VALID when absent read as null)
    for (const id of ["N-R12", "A02"]) {
      const r = verifyBom(bundle(id), "--fingerprint", EXPORT_FPR, "--receipt-keyring", noBoundary, "--now", "2026-10-11T00:00:00.000Z");
      expect(r.status, id).toBe(2);
      expect(r.stderr).toContain("no receiptV2FromAuditSeq");
    }
    // pinned fingerprints carry no boundary either: --receipt-v2-from is required
    expect(verifyBom(bundle("P01"), "--fingerprint", EXPORT_FPR, "--receipt-fingerprint", RECEIPT_FPR, "--now", "2026-10-11T00:00:00.000Z").status).toBe(2);
    // an explicit null is "no cutover recorded": an AI BOM verifies
    expect(verifyBom(bundle("A02"), "--fingerprint", EXPORT_FPR, "--receipt-keyring", nullBoundary, "--now", "2026-10-11T00:00:00.000Z").status).toBe(0);
    // a value is enforced: N-R12's v1 receipt at the boundary is invalid, from the file or stated on the command line
    const fromFile = withTrust("N-R12", "--json");
    expect(fromFile.status).toBe(1);
    expect(JSON.parse(fromFile.stdout).checks).toContainEqual(expect.objectContaining({ check: "receipt_facts_binding", status: "invalid", reason: "v1_receipt_after_boundary" }));
    expect(verifyBom(bundle("N-R12"), "--fingerprint", EXPORT_FPR, "--receipt-keyring", noBoundary, "--receipt-v2-from", "42", "--now", "2026-10-11T00:00:00.000Z").status).toBe(1);
  });
  it("B8 recheck L1: --receipt-v2-from never overrides a boundary the keyring states; it must match or be refused", () => {
    const now = ["--now", "2026-10-11T00:00:00.000Z"];
    const kr = (f: string) => ["--fingerprint", EXPORT_FPR, "--receipt-keyring", path.join(dir, f)];
    // the reviewer's case: keyring 42, flag none, N-R12 must not come out VALID
    const conflict = verifyBom(bundle("N-R12"), ...kr("receipt-keys.json"), "--receipt-v2-from", "none", ...now);
    expect(conflict.status).toBe(2);
    expect(conflict.stderr).toContain("conflicting receipt v2 boundaries: the keyring states 42, --receipt-v2-from states none");
    // an explicit null in the keyring conflicts with a number, too
    expect(verifyBom(bundle("A02"), ...kr("receipt-keys-null-boundary.json"), "--receipt-v2-from", "42", ...now).status).toBe(2);
    // a matching flag is accepted, and the boundary is enforced
    expect(verifyBom(bundle("N-R12"), ...kr("receipt-keys.json"), "--receipt-v2-from", "42", ...now).status).toBe(1);
    expect(verifyBom(bundle("A02"), ...kr("receipt-keys-null-boundary.json"), "--receipt-v2-from", "none", ...now).status).toBe(0);
  });
  it("B8 recheck L3: a malformed or oversized keyring, and an oversized bundle, exit 2 without echoing content", () => {
    const junk = path.join(dir, "junk-keyring.json");
    writeFileSync(junk, "CANARY-not-json");
    const r = verifyBom(bundle("A02"), "--fingerprint", EXPORT_FPR, "--receipt-keyring", junk);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--receipt-keyring is not readable JSON");
    expect(r.stderr + r.stdout).not.toContain("CANARY");
    const big = path.join(dir, "big-keyring.json");
    writeFileSync(big, "");
    truncateSync(big, 1024 * 1024 + 1);
    expect(verifyBom(bundle("A02"), "--fingerprint", EXPORT_FPR, "--receipt-keyring", big).stderr).toContain("not a regular file of at most 1048576 bytes");
    const bigBundle = path.join(dir, "big.tar.gz");
    writeFileSync(bigBundle, "");
    truncateSync(bigBundle, 64 * 1024 * 1024 + 1);
    const b = verifyBom(bigBundle, "--fingerprint", EXPORT_FPR, "--receipt-keyring", path.join(dir, "receipt-keys.json"));
    expect(b.status).toBe(2);
    expect(b.stderr).toContain("the bundle is not a regular file of at most 67108864 bytes");
  });
  it("review item 2: a crafted file is reported invalid (exit 1), never a crash", () => {
    const junk = path.join(dir, "junk.tar.gz");
    writeFileSync(junk, Buffer.concat([gzipSync(Buffer.from("[".repeat(200_000))), gzipSync(Buffer.alloc(512))]));
    const r = verifyBom(junk, "--fingerprint", EXPORT_FPR, "--receipt-keyring", path.join(dir, "receipt-keys.json"), "--json");
    expect(r.status, r.stderr).toBe(1);
    expect(JSON.parse(r.stdout).outcome).toBe("invalid");
  });
  it("refuses to run without both out-of-band trust roots (the bundle's own keys are never the authority)", () => {
    expect(verifyBom(bundle("P01")).status).toBe(2);
    expect(verifyBom(bundle("P01"), "--fingerprint", EXPORT_FPR).status).toBe(2);
    expect(verifyBom(bundle("P01"), "--receipt-keyring", path.join(dir, "receipt-keys.json")).status).toBe(2);
  });
});

describe("ADR-0189 B4.7-5: scripts/verify-export-bundle.sh checks an export-bundle/3 envelope", () => {
  const sh = (id: string) => spawnSync("bash", [VERIFY_SH, bundle(id), "--fingerprint", EXPORT_FPR, "--quiet"], { encoding: "utf8", timeout: 60_000 });
  it("accepts the Decision BOM and AI BOM bundles", () => {
    for (const id of ["P01", "P14", "P28", "A02", "A03"]) expect(sh(id).status, `${id}: ${sh(id).stderr}`).toBe(0);
  });
  it("refuses a manifest signature that does not verify and a file that changed after signing", () => {
    expect(sh("N-M01").stderr).toContain("SIGNATURE DOES NOT VERIFY");
    expect(sh("N-M09").stderr).toContain("CONTENT DIGEST MISMATCH");
  });
});
