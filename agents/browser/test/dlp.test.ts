/**
 * ADR-0334: the extension's RE2 credential table against the one shared list.
 *  1. its ids equal the shared `dlp.secret.*` CREDENTIAL_MATERIAL_RULES, in order;
 *  2. the shared rules' source digests equal the endpoint agent's recorded digests (agents/endpoint/internal/secrets/
 *     testdata/rules.json): when a shared rule changes, that file is regenerated only after the RE2 tables (Go and
 *     this one) are updated, so a changed shared rule fails here until this table is looked at too;
 *  3. every endpoint vector gives the same rule ids here as the shared JavaScript rules and the Go table expect.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_MATERIAL_RULES } from "@regulait/shared";
import { dlpRuleIds, matchDlp } from "../src/dlp.js";

const testdata = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../endpoint/internal/secrets/testdata");
const shared = CREDENTIAL_MATERIAL_RULES.filter((r) => r.id.startsWith("dlp.secret."));

interface Vector { name: string; parts: { lit?: string; rep?: string; n?: number }[]; expect: string[] }
const vectors = (JSON.parse(readFileSync(path.join(testdata, "vectors.json"), "utf8")) as { vectors: Vector[] }).vectors;
const assemble = (v: Vector) => v.parts.map((p) => (p.lit ?? "") + (p.rep ? p.rep.repeat(p.n ?? 0) : "")).join("");

describe("ADR-0334 DLP: the shared dlp.secret.* rules in RE2", () => {
  it("has the shared ids in the shared order", () => {
    expect(dlpRuleIds()).toEqual(shared.map((r) => r.id));
  });

  it("the shared rules are the ones the RE2 tables were last checked against", () => {
    const recorded = (JSON.parse(readFileSync(path.join(testdata, "rules.json"), "utf8")) as { rules: { id: string; sourceSha256: string }[] }).rules;
    expect(shared.map((r) => ({ id: r.id, sourceSha256: createHash("sha256").update(`${r.re.source}/${r.re.flags}`).digest("hex") }))).toEqual(recorded);
  });

  it.each(vectors.map((v) => [v.name, v] as const))("vector: %s", (_name, v) => {
    expect(matchDlp(assemble(v))).toEqual(v.expect);
  });

  it("returns ids only, honours the enabled list, and ignores blank input", () => {
    const aws = "id=AKIA" + "Q".repeat(16);
    expect(matchDlp(aws, ["dlp.secret.jwt"])).toEqual([]);
    expect(matchDlp(aws, ["dlp.secret.aws_key"])).toEqual(["dlp.secret.aws_key"]);
    expect(matchDlp("   ")).toEqual([]);
    for (const id of matchDlp(aws)) expect(id.startsWith("dlp.secret.")).toBe(true);
  });

  it("checks only the first 64 KiB, in linear time", () => {
    const tail = "x".repeat(70 * 1024) + "AKIA" + "Q".repeat(16);
    expect(matchDlp(tail)).toEqual([]);
    const t0 = Date.now();
    matchDlp("a".repeat(64 * 1024) + "=" + "-".repeat(1000));
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
