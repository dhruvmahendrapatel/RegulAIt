/**
 * ADR-0242 / ADR-0246 (lane L4): mcpscanner 4.8.7, measured on the clean-room vulnerable MCP fixtures. Each report
 * under packages/shared/src/engines/fixtures/admission-scan/vuln/ was written on 2026-11-17 by the built engine image
 * (engines/mcpscanner/Dockerfile) running our driver with --network=none --read-only --cap-drop=ALL as uid 10001, on
 * the tools.json `mcp-vuln-scan-inputs.mjs` writes. This test proves each recording is about the CURRENT fixture (its
 * echoed input digest equals today's bytes), so a fixture change cannot leave a stale measurement behind, and pins
 * which classes the engine holds at the MCP hold line (high). The other classes are caught by other controls (each
 * fixture's `expected`); the engine is defence in depth there, never the only control.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { vulnScanCases, vulnScanInput } from "./mcp-vuln-scan-inputs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "packages/shared/src/engines/fixtures/admission-scan/vuln");
const SEVERITY = ["info", "low", "medium", "high", "critical"];
/** the measured result: the (class, phase) pairs the engine holds at high or above */
const HELD_BY_ENGINE = new Set(["tool-poisoning-approved", "tool-shadowing-approved"]);

describe("mcpscanner on the clean-room vulnerable MCP fixtures (measured)", () => {
  for (const { id, phase } of vulnScanCases()) {
    const name = `${id}-${phase}`;
    it(`${name}: the recording is about today's fixture, and the engine ${HELD_BY_ENGINE.has(name) ? "holds" : "does not hold"} it`, () => {
      const report = JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8"));
      expect(report).toMatchObject({ schema: "regulait.admission-scan.v1", engine: "mcpscanner", engineVersion: "4.8.7", status: "completed" });
      const sha = createHash("sha256").update(vulnScanInput(id, phase)).digest("hex");
      expect(report.inputs).toEqual([{ path: "tools.json", sha256: sha }]);
      const held = report.findings.some((f) => SEVERITY.indexOf(f.severity) >= SEVERITY.indexOf("high"));
      expect(held).toBe(HELD_BY_ENGINE.has(name));
    });
  }

  it("every recording has a case, and every case a recording", async () => {
    const { readdirSync } = await import("node:fs");
    const recorded = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
    expect(recorded).toEqual(vulnScanCases().map(({ id, phase }) => `${id}-${phase}`).sort());
  });
});
