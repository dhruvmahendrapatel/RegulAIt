// ADR-0189 slice B8: the known-answer bundle writer used by docs/ops/BOM_VERIFICATION.md step 2.
// Needs `pnpm -r build` (CI's build-and-test-base job builds before `vitest run --dir scripts`).
// Each case runs the real CLIs as an auditor would: write a vector's bundle, then verify it with
// scripts/verify-bom.mjs using only the trust arguments the writer printed.
import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(path.join(here, "../packages/shared/test-vectors/decision-bom/b4-vectors.json"), "utf8"));
const node = (script, args) => spawnSync(process.execPath, [path.join(here, script), ...args], { encoding: "utf8" });

function writeAndVerify(id) {
  const out = mkdtempSync(path.join(tmpdir(), `b8-${id}-`));
  const w = node("bom-vector-bundle.mjs", [id, out]);
  expect(w.status, w.stderr).toBe(0);
  const archive = readdirSync(out).find((f) => f.endsWith(".tar.gz"));
  const trust = /verify-bom\.mjs trust arguments: (.*)\n/.exec(w.stdout)[1].split(" ");
  const v = node("verify-bom.mjs", [path.join(out, archive), ...trust]);
  return { out, archive: path.join(out, archive), stdout: w.stdout, verify: v };
}
const vec = (id) => [...vectors.positives, ...vectors.negatives].find((x) => x.id === id);

describe("bom-vector-bundle.mjs", { timeout: 60_000 }, () => {
  it.each(["P01", "A01", "A02", "A03"])("positive %s: writes the pinned tar, and verify-bom.mjs answers VALID (exit 0)", (id) => {
    const r = writeAndVerify(id);
    const tar = gunzipSync(readFileSync(r.archive));
    expect(createHash("sha256").update(tar).digest("hex")).toBe(vec(id).bundle.tarSha256);
    expect(r.stdout).toContain("expected outcome: valid");
    expect(r.verify.stdout).toContain("OUTCOME: VALID");
    expect(r.verify.status).toBe(0);
  });

  it.each([
    ["NA01", "[invalid] rendering_hashes (cyclonedx-1.7): hash_mismatch"],
    ["N-M01", "[invalid] bundle_manifest_signature: signature_mismatch"],
    ["N-B12", "[invalid] receipt_signature: unknown_key"],
  ])("negative %s: verify-bom.mjs answers INVALID (exit 1) with the vector's named check", (id, line) => {
    const r = writeAndVerify(id);
    expect(r.stdout).toContain("expected outcome: invalid");
    expect(r.verify.stdout).toContain(line);
    expect(r.verify.stdout).toContain("OUTCOME: INVALID");
    expect(r.verify.status).toBe(1);
  });

  // B8 review M1: every vector is either refused (exactly the set below) or verifies to its expected outcome
  it("sweep: every B4 vector is refused or yields its expected outcome through verify-bom.mjs", async () => {
    const REFUSED = ["N-M16", "N-M18", "P20", "P21", "N-M02", "N-M04", "N-M05"];
    const nodeAsync = (script, args) =>
      new Promise((resolve) => execFile(process.execPath, [path.join(here, script), ...args], { encoding: "utf8" }, (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));
    const one = async (x) => {
      const out = mkdtempSync(path.join(tmpdir(), `b8-sweep-${x.id}-`));
      const w = await nodeAsync("bom-vector-bundle.mjs", [x.id, out]);
      if (REFUSED.includes(x.id)) return w.status === 1 && !readdirSync(out).length ? null : `${x.id}: expected a refusal, got exit ${w.status}`;
      if (w.status !== 0) return `${x.id}: writer exit ${w.status} ${w.stderr.trim()}`;
      const archive = readdirSync(out).find((f) => f.endsWith(".tar.gz"));
      const trust = /verify-bom\.mjs trust arguments: (.*)\n/.exec(w.stdout)[1].split(" ");
      const r = await nodeAsync("verify-bom.mjs", [path.join(out, archive), ...trust, "--json"]);
      let report;
      try {
        report = JSON.parse(r.stdout);
      } catch {
        return `${x.id}: no JSON report (exit ${r.status})`;
      }
      if (report.outcome !== x.expect.outcome) return `${x.id}: expected ${x.expect.outcome}, got ${report.outcome}`;
      // B8 recheck L2: every check the vector names, with its result and reason (and ref when given), or its absence
      for (const [check, want] of Object.entries(x.expect.checks ?? {})) {
        const got = report.checks.filter((c) => c.check === check && (want === "absent" || want.ref === undefined || c.ref === want.ref));
        if (want === "absent") {
          if (got.length) return `${x.id}: ${check} should be absent`;
        } else if (!got.some((c) => c.status === want.result && (c.reason ?? null) === (want.reason ?? null))) {
          return `${x.id}: ${check} expected ${want.result}${want.reason ? ` ${want.reason}` : ""}, got ${JSON.stringify(got.map((c) => [c.status, c.reason]))}`;
        }
      }
      return null;
    };
    const queue = [...vectors.positives, ...vectors.negatives];
    expect(queue.length).toBe(141);
    const wrong = [];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let x = queue.shift(); x; x = queue.shift()) {
        const w = await one(x);
        if (w) wrong.push(w);
      }
    }));
    expect(wrong).toEqual([]);
  }, 600_000);

  it("B8 recheck L2: refuses an offline export keyring fingerprint that is not its key's, and a trust root with no boundary", () => {
    const p01 = vec("P01");
    const wrongFpr = JSON.parse(JSON.stringify(p01));
    wrongFpr.id = "T-FPR";
    wrongFpr.trust.export.keyring[0].fingerprint = `sha256:${"0".repeat(64)}`;
    const noBoundary = JSON.parse(JSON.stringify(p01));
    noBoundary.id = "T-NOB";
    delete noBoundary.trust.receipt.keyring.receiptV2FromAuditSeq;
    const file = path.join(mkdtempSync(path.join(tmpdir(), "b8-vec-")), "vectors.json");
    writeFileSync(file, JSON.stringify({ ...vectors, positives: [...vectors.positives, wrongFpr, noBoundary] }));
    for (const [id, msg] of [["T-FPR", "names a fingerprint that is not its key's"], ["T-NOB", "states no receipt v2 boundary"]]) {
      const out = mkdtempSync(path.join(tmpdir(), `b8-${id}-`));
      const r = node("bom-vector-bundle.mjs", ["--vectors", file, id, out]);
      expect(r.status, id).toBe(1);
      expect(r.stderr).toContain(msg);
      expect(readdirSync(out)).toEqual([]);
    }
    // the same file still writes the unmodified P01
    expect(node("bom-vector-bundle.mjs", ["--vectors", file, "P01", mkdtempSync(path.join(tmpdir(), "b8-P01b-"))]).status).toBe(0);
  });

  it("the gzip member has no flags and MTIME 0 (B4.1), so the product's reader accepts it", () => {
    const r = writeAndVerify("A01");
    const gz = readFileSync(r.archive);
    expect(gz[3]).toBe(0);
    expect(gz.readUInt32LE(4)).toBe(0);
  });

  it("refuses a non-file entry (N-M16, N-M18), an online trust root (P20, P21, N-M02, N-M05) and an unknown id, writing nothing; usage is exit 2", () => {
    const out = mkdtempSync(path.join(tmpdir(), "b8-refuse-"));
    for (const id of ["N-M16", "N-M18", "P99", "P20", "P21", "N-M02", "N-M04", "N-M05"]) {
      const r = node("bom-vector-bundle.mjs", [id, out]);
      expect(r.status).toBe(1);
      expect(readdirSync(out)).toEqual([]);
    }
    expect(node("bom-vector-bundle.mjs", ["P01"]).status).toBe(2);
    expect(node("bom-vector-bundle.mjs", ["P01", out, "extra"]).status).toBe(2);
  });
});
