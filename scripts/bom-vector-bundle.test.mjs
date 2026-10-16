// ADR-0189 slice B8: the known-answer bundle writer used by docs/ops/BOM_VERIFICATION.md step 2.
// Needs `pnpm -r build` (CI's build-and-test-base job builds before `vitest run --dir scripts`).
// Each case runs the real CLIs as an auditor would: write a vector's bundle, then verify it with
// scripts/verify-bom.mjs using only the trust arguments the writer printed.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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

describe("bom-vector-bundle.mjs", () => {
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

  it("the gzip member has no flags and MTIME 0 (B4.1), so the product's reader accepts it", () => {
    const r = writeAndVerify("A01");
    const gz = readFileSync(r.archive);
    expect(gz[3]).toBe(0);
    expect(gz.readUInt32LE(4)).toBe(0);
  });

  it("refuses a vector holding a non-file entry (N-M16 directory, N-M18 symlink) and an unknown id; usage is exit 2", () => {
    const out = mkdtempSync(path.join(tmpdir(), "b8-refuse-"));
    for (const id of ["N-M16", "N-M18", "P99"]) {
      const r = node("bom-vector-bundle.mjs", [id, out]);
      expect(r.status).toBe(1);
      expect(readdirSync(out)).toEqual([]);
    }
    expect(node("bom-vector-bundle.mjs", ["P01"]).status).toBe(2);
    expect(node("bom-vector-bundle.mjs", ["P01", out, "extra"]).status).toBe(2);
  });
});
