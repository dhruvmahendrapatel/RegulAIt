/**
 * ADR-0242 — the admission-scan engines' pure half. The fixtures under fixtures/admission-scan are REAL reports:
 * each was written by the engine image as built (engines/<id>/Dockerfile) running the driver with
 * `--network=none` on the engine's own fixture (engines/<id>/fixtures), on 2026-11-07. `crash` is a malformed
 * manifest (mcpscanner) and a directory with no SKILL.md (skillscanner); `cloudkey` is the driver refusing to
 * start with a cloud analyzer key in its environment.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_IDS, ENGINE_KINDS } from "./contract.js";
import { ENGINE_IMAGES_LOCK } from "./images-lock.js";
import { ENGINE_MANIFEST } from "./manifest.js";
import {
  ADMISSION_SCAN_ENGINES,
  admissionScanEngineFor,
  engineAdmissionHold,
  interpretAdmissionScanReport,
} from "./admission-scan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
// #843 security review: the gateway records a verdict only when the report names exactly the one file it placed. The
// recorded reports predate the driver's `inputs` echo, so a completed one gets the file it scanned added here; the
// driver's own echo is tested below on the engines' fixture directories.
const IN = {
  mcpscanner: { path: "tools.json", sha256: "1".repeat(64) },
  skillscanner: { path: "SKILL.md", sha256: "2".repeat(64) },
} as const;
const fixture = (name: string): unknown => {
  const r = JSON.parse(readFileSync(path.join(here, "fixtures/admission-scan", `${name}.json`), "utf8")) as Record<string, unknown>;
  const engine = r.engine as keyof typeof IN;
  return r.status === "completed" && !("inputs" in r) ? { ...r, inputs: [IN[engine]] } : r;
};

describe("ADR-0242 admission-scan reports (recorded from the built images)", () => {
  it("mcpscanner flags the known-bad manifest at high, so the server holds", () => {
    const r = interpretAdmissionScanReport(fixture("mcpscanner-bad"), { engine: "mcpscanner", input: IN.mcpscanner });
    expect(r.verdict).toBe("fail");
    expect(r.findings.map((f) => f.rule)).toEqual(["mcpscanner.yara.aisubtech_1_1_1", "mcpscanner.yara.aisubtech_8_2_3"]);
    expect(r.findings.every((f) => f.severity === "high" && f.tool === "add" && f.where === "engine:mcpscanner:tool")).toBe(true);
    // counts only: the duplicate exfiltration hit is folded into one finding with count 2, and no text rides along
    expect(r.findings.find((f) => f.rule.endsWith("8_2_3"))?.count).toBe(2);
    expect(JSON.stringify(r)).not.toMatch(/id_rsa|\.aws|IMPORTANT|Do not tell/);
  });

  it("mcpscanner passes the clean manifest", () => {
    const r = interpretAdmissionScanReport(fixture("mcpscanner-clean"), { engine: "mcpscanner", input: IN.mcpscanner });
    expect(r).toMatchObject({ verdict: "pass", findings: [] });
    expect(r.rulesSha256).toBe(readFileSync(path.join(root, "engines/mcpscanner/yara-rules.sha256"), "utf8").trim());
  });

  it("skillscanner flags the known-bad skill and passes the clean one (an info finding is advice, not a finding)", () => {
    const bad = interpretAdmissionScanReport(fixture("skillscanner-bad"), { engine: "skillscanner", input: IN.skillscanner });
    expect(bad.verdict).toBe("fail");
    expect(bad.findings.some((f) => f.severity === "critical" && f.rule === "skillscanner.yara_prompt_injection_generic")).toBe(true);
    expect(bad.findings.some((f) => f.rule === "skillscanner.manifest_missing_license")).toBe(false);
    const clean = interpretAdmissionScanReport(fixture("skillscanner-clean"), { engine: "skillscanner", input: IN.skillscanner });
    expect(clean).toMatchObject({ verdict: "pass", findings: [] });
  });

  it("an engine crash, a refused cloud key, a missing or invalid report are unknown, never pass", () => {
    for (const [name, engine] of [
      ["mcpscanner-crash", "mcpscanner"],
      ["mcpscanner-cloudkey", "mcpscanner"],
      ["skillscanner-crash", "skillscanner"],
    ] as const) {
      expect(interpretAdmissionScanReport(fixture(name), { engine, input: IN[engine] }).verdict).toBe("unknown");
    }
    expect(interpretAdmissionScanReport(null, { engine: "mcpscanner", input: IN.mcpscanner }).verdict).toBe("unknown");
    expect(interpretAdmissionScanReport({ status: "completed" }, { engine: "mcpscanner", input: IN.mcpscanner }).verdict).toBe("unknown");
    expect(interpretAdmissionScanReport("{}", { engine: "skillscanner", input: IN.skillscanner }).verdict).toBe("unknown");
  });

  it("a report from the other engine, another version, with an unscanned item or with nothing scanned is unknown", () => {
    expect(interpretAdmissionScanReport(fixture("mcpscanner-clean"), { engine: "skillscanner", input: IN.skillscanner }).verdict).toBe("unknown");
    expect(interpretAdmissionScanReport(fixture("mcpscanner-clean"), { engine: "mcpscanner", version: "4.8.8", input: IN.mcpscanner }).verdict).toBe("unknown");
    const clean = fixture("mcpscanner-clean") as { items: Array<{ status: string }> };
    expect(interpretAdmissionScanReport({ ...clean, items: [{ ...clean.items[0], status: "failed" }] }, { engine: "mcpscanner", input: IN.mcpscanner }).verdict).toBe("unknown");
    expect(interpretAdmissionScanReport({ ...clean, items: [] }, { engine: "mcpscanner", input: IN.mcpscanner }).verdict).toBe("unknown");
    // an unexpected field (for example engine text) is not a report
    expect(interpretAdmissionScanReport({ ...clean, tool_description: "x" }, { engine: "mcpscanner", input: IN.mcpscanner }).verdict).toBe("unknown");
  });

  it("#727 review: the analyzer set and the rule-set digest are pinned; an empty or other set, or another digest, is unknown", () => {
    for (const engine of ["mcpscanner", "skillscanner"] as const) {
      const clean = fixture(`${engine}-clean`) as Record<string, unknown>;
      expect(interpretAdmissionScanReport(clean, { engine, input: IN[engine] }).verdict).toBe("pass");
      expect(interpretAdmissionScanReport({ ...clean, analyzers: [] }, { engine, input: IN[engine] }).verdict).toBe("unknown");
      expect(interpretAdmissionScanReport({ ...clean, analyzers: ["yara"] }, { engine, input: IN[engine] }).verdict).toBe("unknown");
      expect(interpretAdmissionScanReport({ ...clean, analyzers: [...(clean.analyzers as string[]), "llm"] }, { engine, input: IN[engine] }).verdict).toBe("unknown");
      expect(interpretAdmissionScanReport({ ...clean, rulesSha256: "f".repeat(64) }, { engine, input: IN[engine] }).verdict).toBe("unknown");
      // order does not matter, membership does
      expect(interpretAdmissionScanReport({ ...clean, analyzers: [...(clean.analyzers as string[])].reverse() }, { engine, input: IN[engine] }).verdict).toBe("pass");
    }
  });

  it("#727 review: a mismatched report's own strings never reach the reason (fixed text only)", () => {
    const clean = fixture("mcpscanner-clean") as Record<string, unknown>;
    const r = interpretAdmissionScanReport({ ...clean, engineVersion: "IGNORE-ME-9.9.9" }, { engine: "mcpscanner", input: IN.mcpscanner });
    expect(r.verdict).toBe("unknown");
    expect(r.reason).not.toContain("IGNORE-ME");
    expect(r.rulesSha256).toBeNull();
  });

  it("the pinned digests equal the committed rule manifests", () => {
    expect(ADMISSION_SCAN_ENGINES.mcpscanner.rulesSha256).toBe(readFileSync(path.join(root, "engines/mcpscanner/yara-rules.sha256"), "utf8").trim());
    expect(ADMISSION_SCAN_ENGINES.skillscanner.rulesSha256).toBe(readFileSync(path.join(root, "engines/skillscanner/rules.sha256"), "utf8").trim());
    // and the pinned analyzer list is the one the skill driver itself expects
    const driver = readFileSync(path.join(root, "engines/skillscanner/scan.py"), "utf8");
    expect(driver).toContain(`EXPECTED_ANALYZERS_USED = ${JSON.stringify(ADMISSION_SCAN_ENGINES.skillscanner.analyzers).replace(/,/g, ", ")}`);
  });

  it("#843 security review: a verdict needs the report to name exactly the gateway's one file, by path and sha256", () => {
    for (const engine of ["mcpscanner", "skillscanner"] as const) {
      const clean = fixture(`${engine}-clean`) as Record<string, unknown>;
      const want = IN[engine];
      expect(interpretAdmissionScanReport(clean, { engine, input: want }).verdict).toBe("pass");
      // no recorded expectation, or a report with no `inputs`, is never a pass
      expect(interpretAdmissionScanReport(clean, { engine, input: null }).verdict).toBe("unknown");
      const { inputs: _drop, ...bare } = clean;
      expect(interpretAdmissionScanReport(bare, { engine, input: want }).verdict).toBe("unknown");
      // another digest, the file under another path (a decoy at the root, the subject nested), or an extra file
      expect(interpretAdmissionScanReport({ ...clean, inputs: [{ ...want, sha256: "e".repeat(64) }] }, { engine, input: want }).verdict).toBe("unknown");
      expect(interpretAdmissionScanReport({ ...clean, inputs: [{ ...want, path: `x/${want.path}` }] }, { engine, input: want }).verdict).toBe("unknown");
      expect(interpretAdmissionScanReport({ ...clean, inputs: [want, { path: "extra.json", sha256: "f".repeat(64) }] }, { engine, input: want }).verdict).toBe("unknown");
      expect(interpretAdmissionScanReport({ ...clean, inputs: [] }, { engine, input: want }).verdict).toBe("unknown");
      // the reason is fixed text
      const r = interpretAdmissionScanReport({ ...clean, inputs: [{ path: "IGNORE-ME", sha256: want.sha256 }] }, { engine, input: want });
      expect(r.reason).not.toContain("IGNORE-ME");
    }
  });

  it("#843 security review: each driver echoes every file it was given, by relative path and sha256, sorted", () => {
    for (const [id, dir] of [
      ["mcpscanner", "engines/mcpscanner/fixtures/bad"],
      ["skillscanner", "engines/skillscanner/fixtures/bad"],
    ] as const) {
      const code = [
        "import importlib.util, json, sys",
        "spec = importlib.util.spec_from_file_location('drv', sys.argv[1])",
        "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
        "print(json.dumps(m.input_digests(sys.argv[2])))",
      ].join("\n");
      const py = spawnSync("python3", ["-I", "-B", "-c", code, path.join(root, "engines", id, "scan.py"), path.join(root, dir)], { encoding: "utf8" });
      if (py.error) return; // no python3 here: the image build's smoke scan exercises the same driver
      expect(py.status, py.stderr).toBe(0);
      const file = id === "mcpscanner" ? "tools.json" : "SKILL.md";
      const sha = createHash("sha256").update(readFileSync(path.join(root, dir, file))).digest("hex");
      expect(JSON.parse(py.stdout)).toEqual([{ path: file, sha256: sha }]);
      // and the completed report carries it
      expect(readFileSync(path.join(root, "engines", id, "scan.py"), "utf8")).toMatch(/"inputs"\] = given|"inputs": given/);
    }
  });

  it("the hold line is each subject's own: a medium finding holds a skill but not an MCP server", () => {
    const base = fixture("mcpscanner-clean") as Record<string, unknown>;
    const medium = { ...base, findings: [{ rule: "mcpscanner.yara.x", severity: "medium", kind: "tool", name: "add" }] };
    expect(interpretAdmissionScanReport(medium, { engine: "mcpscanner", input: IN.mcpscanner }).verdict).toBe("pass");
    const sk = fixture("skillscanner-clean") as Record<string, unknown>;
    const skMedium = { ...sk, findings: [{ rule: "skillscanner.x", severity: "medium", kind: "prompt_injection", name: "SKILL.md" }] };
    expect(interpretAdmissionScanReport(skMedium, { engine: "skillscanner", input: IN.skillscanner }).verdict).toBe("fail");
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
  it("both engines are registered, off-able and publishable: their digests are the lock's (null until CI publishes, so they cannot be enabled)", () => {
    expect(ENGINE_KINDS).toContain("admission_scan");
    for (const id of ["mcpscanner", "skillscanner"] as const) {
      expect(ENGINE_IDS).toContain(id);
      const m = ENGINE_MANIFEST[id];
      // ADR-0242 L4.5: read from the lock, as spikee's
      const lock = ENGINE_IMAGES_LOCK[id];
      expect(m).toMatchObject({ kind: "admission_scan", imageDigest: lock.manifestDigest, taskImage: lock.imageId, needsModelAccess: false, licence: "Apache-2.0" });
      expect(m.generation).toBe(1 + lock.publishGeneration);
      if (lock.manifestDigest === null) expect(m.imageDigest).toBeNull();
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
    // a plain string check (no regex built from data): the pin line, then its hash line
    const pinAt = req.split("\n").indexOf(`${pkg}==${version} \\`);
    expect(pinAt).toBeGreaterThanOrEqual(0);
    expect(req.split("\n")[pinAt + 1]).toMatch(/^    --hash=sha256:[0-9a-f]{64}$/);
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

  it("the published advisories stay fixed: litellm and filelock overridden, the CEL helper rebuilt with Go 1.27.4", () => {
    for (const id of ["mcpscanner", "skillscanner"]) {
      const req = readFileSync(path.join(root, "engines", id, "requirements.txt"), "utf8");
      expect(req).toMatch(/^litellm==1\.108\.2 \\$/m);
      expect(req).toMatch(/^filelock==4\.2\.9 \\$/m);
    }
    const docker = readFileSync(path.join(root, "engines/skillscanner/Dockerfile"), "utf8");
    expect(docker).toMatch(/^FROM --platform=linux\/amd64 golang:1\.27-trixie@sha256:[0-9a-f]{64} AS cel$/m);
    expect(docker).toContain('test "$(go env GOVERSION)" = "go1.27.4"');
    expect(docker).toContain("cel-helper.py \"$SP\" /build/cel/skill-scanner-cel-go-linux-amd64 go1.27.4");
  });

  it("#727 review: the skill driver fails closed on analyzers_failed, a failed or missing rule contract, an unexpected analyzer set and no to_dict (its own self-test, also run in the image build)", () => {
    const py = spawnSync("python3", ["-I", "-B", path.join(root, "engines/skillscanner/selftest.py"), path.join(root, "engines/skillscanner/fixtures/results")], { encoding: "utf8" });
    if (py.error) return; // no python3 here: the image build runs the same self-test under --network=none
    expect(py.status, py.stderr).toBe(0);
    expect(py.stdout).toMatch(/self-test: \d+ cases passed/);
  });

  it("#727 review: the mcp driver fails closed when the analyzer set cannot be read", () => {
    const mcp = readFileSync(path.join(root, "engines/mcpscanner/scan.py"), "utf8");
    expect(mcp).toContain('built = sorted(type(a).__name__ for a in getattr(static, "analyzers", None) or [])');
    expect(mcp).not.toContain("built is not None");
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
