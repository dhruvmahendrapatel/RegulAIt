/**
 * ADR-0189 slice B7 — our own install-scope AI BOM per release: the AI
 * dev-stack inventory, the release SBOM identity and BOM-Link (R9), the R17/R28
 * switch that keeps the release step inert, and the release workflow's shape
 * (security review F1, F5, F6).
 *
 * The switch has NO override in shipped code (F6): this file mocks
 * `./release-switch.js`, and reads the real value through `vi.importActual`.
 * Every rule has a NEGATIVE CONTROL beside its positive case (M-002, M-033).
 * Secret-shaped test values are built at run time (never a literal).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

const sw = vi.hoisted(() => ({ on: true }));
vi.mock("./release-switch.js", () => ({
  get AI_BOM_SNAPSHOTS_RELEASED() {
    return sw.on;
  },
}));

import * as bomApi from "../index.js";
import {
  AI_DEV_STACK_VERSION,
  AiDevStackError,
  AI_BOM_INSTALL_SUBJECT_ID,
  buildAiBom,
  buildReleaseSbomIdentity,
  checkReleaseSbomBytes,
  cycloneDxBomLink,
  normaliseAiBomRecords,
  parseAiDevStackInventory,
  runReleaseAiBomStep,
  verifiedReleaseSbomRecords,
  warmCycloneDxValidators,
  type AiBomRecordSet,
  type ReleaseAiBomInput,
} from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");
const checkedIn = () => JSON.parse(readFileSync(path.join(repo, "security/ai-dev-stack.json"), "utf8")) as { tools: Array<Record<string, unknown>> } & Record<string, unknown>;

const COMMIT = "a".repeat(40);
const T = "2026-10-10T12:00:00.000Z";
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const WS_SERIAL = "urn:uuid:11111111-2222-4333-8444-555555555555";
const IMG_SERIAL = "urn:uuid:66666666-7777-4888-9999-aaaaaaaaaaaa";
// built at run time: a credential-shaped canary and a runner path that must never reach a BOM
const CANARY_SECRET = ["ghp", "CANARY".repeat(6)].join("_");
const CANARY_PATH = ["", "home", "runner", "work", "CANARY-checkout"].join("/");
const sbom = (serial: string, version = 1) =>
  Buffer.from(JSON.stringify({
    bomFormat: "CycloneDX", specVersion: "1.6", serialNumber: serial, version,
    metadata: { component: { name: CANARY_PATH, type: "application" } },
    components: [{ type: "library", name: "left-pad", properties: [{ name: "aquasecurity:trivy:FilePath", value: `${CANARY_PATH}/node_modules` }, { name: "env", value: CANARY_SECRET }] }],
  }));
const WS = sbom(WS_SERIAL, 1);
const IMG = sbom(IMG_SERIAL, 3);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const identity = () => buildReleaseSbomIdentity({ commit: COMMIT, imageDigest: IMAGE_DIGEST, workspace: WS, image: IMG });
const input = (over: Partial<ReleaseAiBomInput> = {}): ReleaseAiBomInput => ({
  commit: COMMIT, committedAt: T, inventory: checkedIn(), sboms: { imageDigest: IMAGE_DIGEST, workspace: WS, image: IMG }, ...over,
});
/** the release step with the (mocked) switch on */
function built(over: Partial<ReleaseAiBomInput> = {}) {
  sw.on = true;
  const r = runReleaseAiBomStep(input(over));
  if (r.status !== "built") throw new Error("expected a build");
  return r;
}
type Doc = { metadata: { component: { externalReferences?: Array<{ type: string; url: string; hashes: Array<{ alg: string; content: string }> }>; properties?: Array<{ name: string; value: string }> } }; formulation?: Array<{ components: Array<{ "bom-ref": string; name: string }> }>; compositions: Array<{ aggregate: string; assemblies: string[] }> };
const docOf = (bytes: string) => JSON.parse(bytes) as Doc;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const installMeta = { id: "00000000-0000-4000-8000-000000000901", subjectKind: "install", subjectId: AI_BOM_INSTALL_SUBJECT_ID, version: 1, supersedes: null, trigger: "on_demand", createdAt: T } as const;
const outputOf = (recs: AiBomRecordSet) => {
  const b = buildAiBom(recs, installMeta, { cyclonedxVersions: ["1.7", "1.6"] });
  return [b.bodyBytes, ...b.renderings.map((r) => r.bytes)].join("\n");
};

beforeAll(() => warmCycloneDxValidators(), 60_000);

describe("B7 AI dev-stack inventory (security/ai-dev-stack.json)", () => {
  it("the checked-in, reviewed inventory is valid and names no vendor-shaped or URL content", () => {
    const inv = parseAiDevStackInventory(checkedIn());
    expect(inv.v).toBe(AI_DEV_STACK_VERSION);
    expect(inv.tools.length).toBeGreaterThan(0);
    expect(inv.tools.map((t) => t.id)).toEqual([...inv.tools.map((t) => t.id)].sort());
    expect(JSON.stringify(checkedIn())).not.toMatch(/https?:|@/);
  });

  const bad = (mut: (inv: ReturnType<typeof checkedIn>) => void, rule: RegExp) => {
    const inv = checkedIn();
    mut(inv);
    expect(() => parseAiDevStackInventory(inv)).toThrow(AiDevStackError);
    expect(() => parseAiDevStackInventory(inv)).toThrow(rule);
  };
  it("refuses an email, a URL, credential material, an unknown key and an unknown enum", () => {
    bad((i) => { i.tools[0]!.description = "contact ops at ops@example.test"; }, /no email or URL/);
    bad((i) => { i.tools[0]!.description = "see https://example.test/x"; }, /no email or URL/);
    bad((i) => { i.tools[0]!.description = `uses key ${["AKIA", "CANARY".padEnd(16, "0")].join("")}`; }, /credential-shaped/);
    bad((i) => { i.tools[0]!.model = "x"; }, /unrecognized_keys/);
    bad((i) => { i.tools[0]!.category = "oracle"; }, /tools\.0\.category/);
    bad((i) => { i.tools[0]!.description = "x".repeat(401); }, /description/);
  });
  it("refuses duplicates, inconsistent data claims, bad dates and a bad review ref", () => {
    bad((i) => { i.tools.push({ ...i.tools[0]! }); }, /duplicate tool id/);
    bad((i) => { i.tools[0]!.networkEgress = false; }, /no network egress shares no data/);
    bad((i) => { i.tools[0]!.dataShared = ["none", "source_code"]; }, /stands alone/);
    bad((i) => { i.tools[0]!.introducedOn = "2026-02-30"; }, /calendar date/);
    bad((i) => { i.tools[0]!.introducedOn = "2099-01-01"; }, /after the review date/);
    bad((i) => { i.reviewRef = "someone"; }, /reviewRef/);
    bad((i) => { i.tools = []; }, /tools/);
  });
  it("an enum refusal never echoes the received value", () => {
    const inv = checkedIn();
    inv.tools[0]!.category = "XFIELDCANARY";
    expect(() => parseAiDevStackInventory(inv)).toThrow(/invalid_enum_value/);
    expect(() => parseAiDevStackInventory(inv)).not.toThrow(/XFIELD/);
  });
});

describe("B7 release SBOM identity and BOM-Link (R9)", () => {
  it("reads serial, version and the exact-bytes SHA-256 of each SBOM", () => {
    expect(identity().sboms).toEqual([
      { kind: "image", serialNumber: IMG_SERIAL, version: 3, sha256: sha(IMG) },
      { kind: "workspace", serialNumber: WS_SERIAL, version: 1, sha256: sha(WS) },
    ]);
    expect(cycloneDxBomLink(WS_SERIAL, 1)).toBe("urn:cdx:11111111-2222-4333-8444-555555555555/1");
  });
  it("refuses an SBOM with no serial or version, a bad commit or digest, and a swapped SBOM file", () => {
    expect(() => buildReleaseSbomIdentity({ commit: COMMIT, imageDigest: IMAGE_DIGEST, workspace: Buffer.from(JSON.stringify({ bomFormat: "CycloneDX", version: 1 })), image: IMG })).toThrow(/serialNumber/);
    expect(() => buildReleaseSbomIdentity({ commit: COMMIT, imageDigest: IMAGE_DIGEST, workspace: Buffer.from(JSON.stringify({ bomFormat: "CycloneDX", serialNumber: WS_SERIAL })), image: IMG })).toThrow(/version/);
    expect(() => buildReleaseSbomIdentity({ commit: "nope", imageDigest: IMAGE_DIGEST, workspace: WS, image: IMG })).toThrow(/commit/);
    expect(() => built({ sboms: { imageDigest: "sha256:$(id)", workspace: WS, image: IMG } })).toThrow(/imageDigest/);
    expect(() => checkReleaseSbomBytes(identity(), { workspace: WS, image: IMG })).not.toThrow();
    expect(() => checkReleaseSbomBytes(identity(), { workspace: sbom(WS_SERIAL, 2), image: IMG })).toThrow(/does not match the signed identity/);
  });
  it("install time: only a signature-verified identity becomes records", () => {
    expect(() => verifiedReleaseSbomRecords(identity(), { signatureVerified: false, method: "sigstore_keyless_signature" })).toThrow(/not verified/);
    expect(verifiedReleaseSbomRecords(identity(), { signatureVerified: true, method: "sigstore_keyless_signature" })[0]!.identityBasis).toBe("sigstore_keyless_signature");
    // a record with any other basis is refused by the normaliser
    const recs = clone(built().build.records);
    (recs.releaseSboms![0] as { identityBasis: string }).identityBasis = "trust_me";
    expect(() => normaliseAiBomRecords(recs)).toThrow(/identityBasis/);
  });
  it("BOM-Link refs on the install root match the identity file exactly", () => {
    const r = built();
    const root = docOf(r.build.renderings[0]!.bytes).metadata.component;
    const f = identity();
    expect(r.identity).toEqual(f);
    expect(JSON.parse(r.files.find((x) => x.name === "release-sbom-identity.json")!.bytes)).toEqual(f);
    expect(root.externalReferences).toEqual(
      f.sboms.map((s) => expect.objectContaining({ type: "bom", url: cycloneDxBomLink(s.serialNumber, s.version), hashes: [{ alg: "SHA-256", content: s.sha256 }] })),
    );
    expect(root.properties).toEqual(expect.arrayContaining([{ name: "regulait:release:commit", value: COMMIT }, { name: "regulait:release:imageDigest", value: IMAGE_DIGEST }]));
    expect(r.build.gaps.filter((g) => g.reason === "release_sbom_identity_not_available")).toEqual([]);
    expect(r.build.records.releaseSboms!.map((x) => x.identityBasis)).toEqual(["derived_in_release_build", "derived_in_release_build"]);
  });
  it("without SBOMs: no identity file, no externalReferences, and the install root stays incomplete", () => {
    const r = built({ sboms: null });
    const doc = docOf(r.build.renderings[0]!.bytes);
    expect(r.files.map((f) => f.name)).toEqual(["ai-bom.native.json", "ai-bom.cyclonedx-1.7.json"]);
    expect(doc.metadata.component.externalReferences).toBeUndefined();
    expect(r.build.gaps).toContainEqual({ ref: "install", field: "externalReferences", reason: "release_sbom_identity_not_available" });
    expect(doc.compositions.some((c) => c.aggregate === "incomplete" && c.assemblies.includes("install"))).toBe(true);
    expect(doc.compositions.some((c) => c.aggregate === "complete")).toBe(false);
  });
  it("release records are refused on any subject but the install", () => {
    const recs = clone(built().build.records);
    const agent = { kind: "agent" as const, id: "00000000-0000-4000-8000-000000000002" };
    expect(() => normaliseAiBomRecords({ ...recs, subject: agent })).toThrow(/only an install snapshot/);
    expect(() => normaliseAiBomRecords({ ...recs, releaseSboms: [], subject: agent })).toThrow(/devStackTools: only an install snapshot/);
  });
});

describe("B7 install-scope rendering", () => {
  it("is deterministic: tool order and repeated builds give identical bytes", () => {
    const a = built();
    const shuffled = checkedIn();
    shuffled.tools.reverse();
    const b = built({ inventory: shuffled });
    expect(b.build.bodyBytes).toBe(a.build.bodyBytes);
    expect(b.files).toEqual(a.files);
    expect(a.build.body.snapshot).toMatchObject({ subjectKind: "install", subjectId: AI_BOM_INSTALL_SUBJECT_ID, version: 1, supersedes: null, createdAt: T });
    // another release commit is another snapshot
    expect(built({ commit: "b".repeat(40), sboms: null }).build.body.snapshot.id).not.toBe(a.build.body.snapshot.id);
  });
  it("renders every inventory tool as a formulation component, never an install component, with its version gap", () => {
    const b = built().build;
    const doc = docOf(b.renderings[0]!.bytes) as Doc & { components?: unknown[] };
    const ids = parseAiDevStackInventory(checkedIn()).tools.map((t) => t.id);
    expect(doc.formulation?.[0]?.components.map((c) => c.name)).toEqual(ids);
    expect(doc.components ?? []).toEqual([]);
    for (const id of ids) expect(b.gaps).toContainEqual({ ref: `dev-tool:${id}`, field: "version", reason: "dev_stack_version_not_recorded" });
    expect(b.renderings.map((r) => r.format)).toEqual(["cyclonedx-1.7"]);
  });
  it("CANARY: no SBOM content, runner path or secret leaks into the native body or any rendering", () => {
    for (const f of built().files.filter((x) => x.name.startsWith("ai-bom."))) {
      expect(f.bytes).not.toContain("CANARY");
      expect(f.bytes).not.toContain("/home/");
      expect(f.bytes).not.toContain("left-pad");
      expect(f.bytes).not.toContain("trivy");
    }
  });
});

describe("X41 policy on B7's own record lists", () => {
  it("every string field of releaseSboms and devStackTools refuses a credential or a URL, never echoing it", () => {
    const canaries = [
      ["sk", `XFIELDCANARY${"q".repeat(20)}`].join("-"),
      ["https:", "", "internal.example", "XFIELDPATH", "doc?signature=XFIELDQUERY"].join("/"),
      `XFIELDCANARY-sk-${"q".repeat(20)}:x`,
      "//internal.example/XFIELDPATH?q=XFIELDQUERY",
      "internal.example/XFIELDPATH?sig=XFIELDQUERY",
    ];
    const base = built().build.records;
    let n = 0;
    for (const list of ["releaseSboms", "devStackTools"] as const) {
      const fields = Object.entries(base[list]![0]!).filter(([, v]) => typeof v === "string" || Array.isArray(v)).map(([k]) => k);
      for (const k of fields) {
        for (const canary of canaries) {
          const recs = clone(base);
          const r = recs[list]![0] as unknown as Record<string, unknown>;
          r[k] = Array.isArray(r[k]) ? [canary] : canary;
          n++;
          let out = "";
          try {
            out = outputOf(recs);
          } catch (e) {
            expect((e as Error).message, `${list}.${k}`).not.toMatch(/XFIELD|internal\.example/);
            continue;
          }
          expect(out.includes("XFIELD"), `${list}.${k}`).toBe(false);
        }
      }
    }
    expect(n).toBeGreaterThan(50);
  });
});

describe("B7 the release step is inert until the R17 switch flips (R28, F6)", () => {
  it("the real switch is off", async () => {
    const real = await vi.importActual<typeof import("./release-switch.js")>("./release-switch.js");
    expect(real.AI_BOM_SNAPSHOTS_RELEASED).toBe(false);
  });
  it("switch off: the step builds nothing, even on input that would be refused", () => {
    sw.on = false;
    try {
      expect(runReleaseAiBomStep(input())).toEqual({ status: "inert", reason: "ai_bom_snapshots_not_released" });
      expect(runReleaseAiBomStep(input({ inventory: { v: "nope" }, committedAt: "never" }))).toMatchObject({ status: "inert" });
    } finally {
      sw.on = true;
    }
  });
  it("NEGATIVE CONTROL (mocked switch on): the same step builds and returns files", () => {
    expect(built().files.map((f) => f.name)).toEqual(["release-sbom-identity.json", "ai-bom.native.json", "ai-bom.cyclonedx-1.7.json"]);
  });
  it("F6: no override and no build path that skips the switch is exported", () => {
    expect(runReleaseAiBomStep.length).toBe(1);
    const exported = Object.keys(bomApi);
    for (const name of ["buildReleaseAiBom", "releaseAiBomRecords"]) expect(exported).not.toContain(name);
    const src = readFileSync(path.join(here, "release-ai-bom.ts"), "utf8");
    expect(src).not.toMatch(/released\s*\?\?|opts\.released|released\?:/);
  });
});

describe("B7 release workflow shape (F1, F5)", () => {
  const wf = readFileSync(path.join(repo, ".github/workflows/release-ai-bom.yml"), "utf8");
  const job = (name: string) => {
    const start = wf.indexOf(`\n  ${name}:\n`);
    expect(start).toBeGreaterThan(0);
    const next = wf.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
    return next === -1 ? wf.slice(start) : wf.slice(start, start + 1 + next);
  };
  it("is its own workflow, triggered by a successful Security run on main, with no default permissions", () => {
    expect(wf).toContain("workflow_run:");
    expect(wf).toContain("workflows: [Security]");
    // round 3: only this repository's own security.yml run
    expect(job("build")).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
    expect(job("build")).toContain("github.event.workflow_run.path == '.github/workflows/security.yml'");
    expect(wf).not.toContain("pull_request_target");
    expect(wf).toMatch(/\npermissions: \{\}\n/);
    const security = readFileSync(path.join(repo, ".github/workflows/security.yml"), "utf8");
    expect(security).not.toContain("node scripts/release-ai-bom.mjs");
    expect(security).not.toMatch(/\n  release-ai-bom:\n/);
  });
  it("build holds no signing identity; every producing step after the switch is gated", () => {
    const b = job("build");
    expect(b).not.toContain("id-token");
    expect(b).not.toContain("cosign");
    const steps = b.split("\n      - ").slice(1);
    const switchAt = steps.findIndex((s) => s.includes("id: switch"));
    expect(switchAt).toBeGreaterThan(0);
    const after = steps.slice(switchAt + 1);
    expect(after.length).toBeGreaterThanOrEqual(5);
    for (const s of after) {
      const gated = s.includes("if: steps.switch.outputs.released == 'true'");
      const inertNote = s.includes("if: steps.switch.outputs.released != 'true'") && !/upload-artifact|download-artifact|release-ai-bom\.mjs build/.test(s);
      expect(gated || inertNote, s.split("\n")[0]).toBe(true);
    }
    for (const s of steps.slice(0, switchAt)) expect(s).not.toMatch(/upload-artifact|download-artifact/);
  });
  it("sign is gated on the switch, holds only id-token, runs cosign only and pins this workflow's identity", () => {
    const s = job("sign");
    expect(s).toContain("if: needs.build.outputs.released == 'true'");
    expect(s).toMatch(/permissions:\n {6}id-token: write\n {4}steps:/);
    expect(s).not.toMatch(/pnpm|setup-node|checkout|\bnode\b|release-ai-bom\.mjs/);
    expect(s).toContain('.github/workflows/release-ai-bom.yml@refs/heads/main"');
    expect(s).toContain("--certificate-github-workflow-sha");
  });
  it("no expression is expanded inside a run: block", () => {
    const lines = wf.split("\n");
    let inRun = false;
    let runIndent = 0;
    for (const line of lines) {
      const indent = line.length - line.trimStart().length;
      if (/^\s*run: \|/.test(line)) { inRun = true; runIndent = indent; continue; }
      if (inRun && line.trim() !== "" && indent <= runIndent) inRun = false;
      if (/^\s*run: [^|]/.test(line)) expect(line).not.toContain("${{");
      if (inRun) expect(line, line).not.toContain("${{");
    }
  });
  it("F5: the switch, builder, CLI and workflow are WATCHED and code-owned", () => {
    const security = readFileSync(path.join(repo, ".github/workflows/security.yml"), "utf8");
    const owners = readFileSync(path.join(repo, ".github/CODEOWNERS"), "utf8");
    for (const f of [".github/workflows/release-ai-bom.yml", "scripts/release-ai-bom.mjs", "packages/shared/src/bom/release-switch.ts", "packages/shared/src/bom/release-ai-bom.ts", "packages/shared/src/bom/release-sbom-identity.ts"]) {
      expect(security).toMatch(new RegExp(`WATCHED: .* ${f.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} `));
      expect(owners).toContain(`/${f} `);
    }
  });
});
