/**
 * ADR-0242 — the admission-scan engines' pure half. The fixtures under fixtures/admission-scan are REAL reports:
 * each was written by the engine image as built (engines/<id>/Dockerfile) running the driver with
 * `--network=none` on the engine's own fixture (engines/<id>/fixtures), on 2026-11-07. `crash` is a malformed
 * manifest (mcpscanner) and a directory with no SKILL.md (skillscanner); `cloudkey` is the driver refusing to
 * start with a cloud analyzer key in its environment.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_IDS, ENGINE_KINDS } from "./contract.js";
import { ENGINE_MANIFEST } from "./manifest.js";
import {
  ADMISSION_SCAN_ENGINES,
  admissionScanEngineFor,
  engineAdmissionHold,
  interpretAdmissionScanReport,
} from "./admission-scan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(here, "fixtures/admission-scan", `${name}.json`), "utf8"));

describe("ADR-0242 admission-scan reports (recorded from the built images)", () => {
  it("mcpscanner flags the known-bad manifest at high, so the server holds", () => {
    const r = interpretAdmissionScanReport(fixture("mcpscanner-bad"), { engine: "mcpscanner" });
    expect(r.verdict).toBe("fail");
    expect(r.findings.map((f) => f.rule)).toEqual(["mcpscanner.yara.aisubtech_1_1_1", "mcpscanner.yara.aisubtech_8_2_3"]);
    expect(r.findings.every((f) => f.severity === "high" && f.tool === "add" && f.where === "engine:mcpscanner:tool")).toBe(true);
    // counts only: the duplicate exfiltration hit is folded into one finding with count 2, and no text rides along
    expect(r.findings.find((f) => f.rule.endsWith("8_2_3"))?.count).toBe(2);
    expect(JSON.stringify(r)).not.toMatch(/id_rsa|\.aws|IMPORTANT|Do not tell/);
  });

  it("mcpscanner passes the clean manifest", () => {
    const r = interpretAdmissionScanReport(fixture("mcpscanner-clean"), { engine: "mcpscanner" });
    expect(r).toMatchObject({ verdict: "pass", findings: [] });
    expect(r.rulesSha256).toBe(readFileSync(path.join(root, "engines/mcpscanner/yara-rules.sha256"), "utf8").trim());
  });

  it("skillscanner flags the known-bad skill and passes the clean one (an info finding is advice, not a finding)", () => {
    const bad = interpretAdmissionScanReport(fixture("skillscanner-bad"), { engine: "skillscanner" });
    expect(bad.verdict).toBe("fail");
    expect(bad.findings.some((f) => f.severity === "critical" && f.rule === "skillscanner.yara_prompt_injection_generic")).toBe(true);
    expect(bad.findings.some((f) => f.rule === "skillscanner.manifest_missing_license")).toBe(false);
    const clean = interpretAdmissionScanReport(fixture("skillscanner-clean"), { engine: "skillscanner" });
    expect(clean).toMatchObject({ verdict: "pass", findings: [] });
  });

  it("an engine crash, a refused cloud key, a missing or invalid report are unknown, never pass", () => {
    for (const [name, engine] of [
      ["mcpscanner-crash", "mcpscanner"],
      ["mcpscanner-cloudkey", "mcpscanner"],
      ["skillscanner-crash", "skillscanner"],
    ] as const) {
      expect(interpretAdmissionScanReport(fixture(name), { engine }).verdict).toBe("unknown");
    }
    expect(interpretAdmissionScanReport(null, { engine: "mcpscanner" }).verdict).toBe("unknown");
    expect(interpretAdmissionScanReport({ status: "completed" }, { engine: "mcpscanner" }).verdict).toBe("unknown");
    expect(interpretAdmissionScanReport("{}", { engine: "skillscanner" }).verdict).toBe("unknown");
  });

  it("a report from the other engine, another version, with an unscanned item or with nothing scanned is unknown", () => {
    expect(interpretAdmissionScanReport(fixture("mcpscanner-clean"), { engine: "skillscanner" }).verdict).toBe("unknown");
    expect(interpretAdmissionScanReport(fixture("mcpscanner-clean"), { engine: "mcpscanner", version: "4.8.8" }).verdict).toBe("unknown");
    const clean = fixture("mcpscanner-clean") as { items: Array<{ status: string }> };
    expect(interpretAdmissionScanReport({ ...clean, items: [{ ...clean.items[0], status: "failed" }] }, { engine: "mcpscanner" }).verdict).toBe("unknown");
    expect(interpretAdmissionScanReport({ ...clean, items: [] }, { engine: "mcpscanner" }).verdict).toBe("unknown");
    // an unexpected field (for example engine text) is not a report
    expect(interpretAdmissionScanReport({ ...clean, tool_description: "x" }, { engine: "mcpscanner" }).verdict).toBe("unknown");
  });

  it("the hold line is each subject's own: a medium finding holds a skill but not an MCP server", () => {
    const base = fixture("mcpscanner-clean") as Record<string, unknown>;
    const medium = { ...base, findings: [{ rule: "mcpscanner.yara.x", severity: "medium", kind: "tool", name: "add" }] };
    expect(interpretAdmissionScanReport(medium, { engine: "mcpscanner" }).verdict).toBe("pass");
    const sk = fixture("skillscanner-clean") as Record<string, unknown>;
    const skMedium = { ...sk, findings: [{ rule: "skillscanner.x", severity: "medium", kind: "prompt_injection", name: "SKILL.md" }] };
    expect(interpretAdmissionScanReport(skMedium, { engine: "skillscanner" }).verdict).toBe("fail");
  });
});

describe("ADR-0242 the gate's decision (fail closed)", () => {
  it("off: the engine has no say", () => {
    expect(engineAdmissionHold({ engineEnabled: false, scan: null })).toEqual({ holds: false, status: "off", findings: [] });
    expect(engineAdmissionHold({ engineEnabled: false, scan: { verdict: "fail", findings: [] } }).holds).toBe(false);
  });
  it("on: no scan of this digest, unknown and fail hold; only pass admits", () => {
    expect(engineAdmissionHold({ engineEnabled: true, scan: null })).toMatchObject({ holds: true, status: "pending" });
    expect(engineAdmissionHold({ engineEnabled: true, scan: { verdict: "unknown", findings: [] } })).toMatchObject({ holds: true, status: "unknown" });
    expect(engineAdmissionHold({ engineEnabled: true, scan: { verdict: "fail", findings: [] } })).toMatchObject({ holds: true, status: "fail" });
    expect(engineAdmissionHold({ engineEnabled: true, scan: { verdict: "pass", findings: [] } })).toMatchObject({ holds: false, status: "pass" });
  });
});

describe("ADR-0242 the manifest, the images and the lockfiles agree", () => {
  it("both engines are registered, off-able and unpublished (no digest, so they cannot be enabled)", () => {
    expect(ENGINE_KINDS).toContain("admission_scan");
    for (const id of ["mcpscanner", "skillscanner"] as const) {
      expect(ENGINE_IDS).toContain(id);
      const m = ENGINE_MANIFEST[id];
      expect(m).toMatchObject({ kind: "admission_scan", imageDigest: null, taskImage: null, needsModelAccess: false, licence: "Apache-2.0" });
      expect(m.version).toBe(ADMISSION_SCAN_ENGINES[id].version);
    }
    expect(admissionScanEngineFor("mcp_server")).toBe("mcpscanner");
    expect(admissionScanEngineFor("builder_skill")).toBe("skillscanner");
  });

  it.each([
    ["mcpscanner", "cisco-ai-mcp-scanner", "4.8.7"],
    ["skillscanner", "cisco-ai-skill-scanner", "2.3.2"],
  ])("%s: the requirements pin %s==%s by hash, and the Dockerfile and driver name the same version", (id, pkg, version) => {
    const req = readFileSync(path.join(root, "engines", id, "requirements.txt"), "utf8");
    expect(req).toMatch(new RegExp(`^${pkg}==${version.replace(/\./g, "\\.")} \\\\\\n    --hash=sha256:[0-9a-f]{64}$`, "m"));
    // every pinned line carries exactly one hash
    const pins = req.split("\n").filter((l) => /^[A-Za-z0-9_.-]+==/.test(l));
    expect(req.match(/--hash=sha256:[0-9a-f]{64}/g)?.length).toBe(pins.length);
    const docker = readFileSync(path.join(root, "engines", id, "Dockerfile"), "utf8");
    expect(docker).toContain(`org.regulait.engine-version="${version}"`);
    // every base image is pinned by digest
    for (const from of docker.split("\n").filter((l) => l.startsWith("FROM "))) expect(from).toMatch(/@sha256:[0-9a-f]{64}/);
    expect(docker).toContain("--require-hashes");
    expect(docker).toContain("RUN --network=none");
    const driver = readFileSync(path.join(root, "engines", id, "scan.py"), "utf8");
    expect(driver).toContain(`ENGINE_VERSION = "${version}"`);
  });

  it("the GPL and end-of-life pieces stay out: no pcodedmp, and yara-python only from source", () => {
    expect(readFileSync(path.join(root, "engines/skillscanner/requirements.txt"), "utf8")).not.toMatch(/^pcodedmp==/m);
    expect(readFileSync(path.join(root, "engines/mcpscanner/requirements.txt"), "utf8")).not.toMatch(/^yara-python==/m);
    expect(readFileSync(path.join(root, "engines/mcpscanner/requirements-sdist.txt"), "utf8")).toMatch(/^yara-python==4\.5\.4 \\\n    --hash=sha256:[0-9a-f]{64}$/m);
  });

  it("the published advisories stay fixed: litellm and filelock overridden, the CEL helper rebuilt with Go 1.27.3", () => {
    for (const id of ["mcpscanner", "skillscanner"]) {
      const req = readFileSync(path.join(root, "engines", id, "requirements.txt"), "utf8");
      expect(req).toMatch(/^litellm==1\.108\.2 \\$/m);
      expect(req).toMatch(/^filelock==4\.2\.9 \\$/m);
    }
    const docker = readFileSync(path.join(root, "engines/skillscanner/Dockerfile"), "utf8");
    expect(docker).toMatch(/^FROM --platform=linux\/amd64 golang:1\.27-trixie@sha256:[0-9a-f]{64} AS cel$/m);
    expect(docker).toContain('test "$(go env GOVERSION)" = "go1.27.3"');
    expect(docker).toContain("cel-helper.py \"$SP\" /build/cel/skill-scanner-cel-go-linux-amd64 go1.27.3");
  });

  it("the drivers build no remote analyzer and refuse cloud credentials", () => {
    const mcp = readFileSync(path.join(root, "engines/mcpscanner/scan.py"), "utf8");
    expect(mcp).toContain("analyzers = [YaraAnalyzer(rules_dir=RULES_DIR), SchemaReferenceAnalyzer()]");
    expect(mcp).not.toMatch(/import (LLMAnalyzer|ApiAnalyzer|VirusTotalAnalyzer)|from mcpscanner\.core\.analyzers\.(llm|api|virustotal|meta|behavioral|vulnerable_package)/);
    for (const k of ["MCP_SCANNER_API_KEY", "MCP_SCANNER_LLM_API_KEY", "VIRUSTOTAL_API_KEY"]) expect(mcp).toContain(`"${k}"`);
    expect(mcp).toContain('"LITELLM_LOCAL_MODEL_COST_MAP": "True"');
    const skill = readFileSync(path.join(root, "engines/skillscanner/scan.py"), "utf8");
    expect(skill).toContain("analyzers = build_core_analyzers(policy)");
    expect(skill).not.toMatch(/\bbuild_analyzers\(/);
    for (const k of ["SKILL_SCANNER_LLM_API_KEY", "VIRUSTOTAL_API_KEY", "AI_DEFENSE_API_KEY"]) expect(skill).toContain(`"${k}"`);
  });
});
