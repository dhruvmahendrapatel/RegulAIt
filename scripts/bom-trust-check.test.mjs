// ADR-0189 slice B8 (review M2, L1): the scripted trust-record comparison of docs/ops/BOM_VERIFICATION.md step 3.
// Needs `pnpm -r build`. Keys are the B4 vectors' published TEST-ONLY CANARY public keys.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(path.join(here, "../packages/shared/test-vectors/decision-bom/b4-vectors.json"), "utf8"));
const key = (id) => vectors.keys.find((k) => k.keyId === id);
const dir = mkdtempSync(path.join(tmpdir(), "b8-trust-"));
const file = (name, value) => {
  const f = path.join(dir, name);
  writeFileSync(f, typeof value === "string" ? value : JSON.stringify(value));
  return f;
};
const run = (...args) => spawnSync(process.execPath, [path.join(here, "bom-trust-check.mjs"), ...args], { encoding: "utf8" });

const exp1 = key("TEST-ONLY-CANARY-export-key-1");
const exp2 = key("TEST-ONLY-CANARY-export-key-2");
const rec1 = key("TEST-ONLY-CANARY-receipt-key-1");
const rec2 = key("TEST-ONLY-CANARY-receipt-key-2");
const record = file("record.json", { exportFingerprints: [exp1.fingerprint], receiptFingerprints: { [rec1.keyId]: rec1.fingerprint }, receiptV2FromAuditSeq: 42 });
const pub1 = file("export-1.pub", exp1.publicKeyPem);
const pub2 = file("export-2.pub", exp2.publicKeyPem);
const keyring = (keys, boundary) => file(`kr-${Math.random().toString(16).slice(2)}.json`, { keys: keys.map((k) => ({ keyId: k.keyId, jwk: k.jwk })), ...boundary });

describe("bom-trust-check.mjs", { timeout: 60_000 }, () => {
  it("every key and the boundary in the record: MATCH, exit 0", () => {
    const r = run("--record", record, "--export-pub", pub1, "--receipt-keyring", keyring([rec1], { receiptV2FromAuditSeq: 42 }));
    expect(r.stdout).toContain("TRUST RECORD: MATCH");
    expect(r.status).toBe(0);
  });
  it("a key not in the record is NOT trusted (exit 1): an export key, a receipt key", () => {
    expect(run("--record", record, "--export-pub", pub2).status).toBe(1);
    const r = run("--record", record, "--receipt-keyring", keyring([rec1, rec2], { receiptV2FromAuditSeq: 42 }));
    expect(r.stdout).toContain(`NOT IN RECORD  receipt key ${rec2.keyId}`);
    expect(r.status).toBe(1);
  });
  it("the boundary must be present and the recorded one (absent is not null; H1)", () => {
    expect(run("--record", record, "--receipt-keyring", keyring([rec1], {})).status).toBe(1);
    expect(run("--record", record, "--receipt-keyring", keyring([rec1], { receiptV2FromAuditSeq: null })).status).toBe(1);
    expect(run("--record", record, "--receipt-keyring", keyring([rec1], { receiptV2FromAuditSeq: 43 })).status).toBe(1);
  });
  it("a malformed record, an unreadable file and usage errors exit 2", () => {
    expect(run("--record", file("bad.json", { exportFingerprints: [] }), "--export-pub", pub1).status).toBe(2);
    expect(run("--record", file("junk.json", "CANARY-not-json"), "--export-pub", pub1).stderr).not.toContain("CANARY");
    expect(run("--record", record).status).toBe(2);
    expect(run("--export-pub", pub1).status).toBe(2);
    expect(run("--record", record, "--export-pub", file("notkey.pub", "x")).status).toBe(2);
  });
});
