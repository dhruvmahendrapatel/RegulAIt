/**
 * ADR-0189 slice B7 — our own install-scope AI BOM per release: the AI
 * dev-stack inventory, the release SBOM identity and BOM-Link (R9), and the
 * R17/R28 switch that keeps the release step inert.
 *
 * Every rule has a NEGATIVE CONTROL beside its positive case (M-002, M-033).
 * Secret-shaped test values are built at run time (never a literal).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AI_BOM_SNAPSHOTS_RELEASED,
  AI_DEV_STACK_VERSION,
  AiDevStackError,
  buildReleaseAiBom,
  buildReleaseSbomIdentity,
  checkReleaseSbomBytes,
  cycloneDxBomLink,
  normaliseAiBomRecords,
  parseAiDevStackInventory,
  releaseAiBomRecords,
  runReleaseAiBomStep,
  verifiedReleaseSbomRecords,
  warmCycloneDxValidators,
  AI_BOM_INSTALL_SUBJECT_ID,
  buildAiBom,
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
const VERIFIED = { signatureVerified: true, method: "sigstore_keyless_ci" as const };
const input = (over: Partial<ReleaseAiBomInput> = {}): ReleaseAiBomInput => ({
  commit: COMMIT, committedAt: T, inventory: checkedIn(), sbomIdentity: identity(), sbomIdentityVerification: VERIFIED, ...over,
});
type Doc = { metadata: { component: { externalReferences?: Array<{ type: string; url: string; hashes: Array<{ alg: string; content: string }> }>; properties?: Array<{ name: string; value: string }> } }; formulation?: Array<{ components: Array<{ "bom-ref": string; name: string }> }>; compositions: Array<{ aggregate: string; assemblies: string[] }> };
const docOf = (bytes: string) => JSON.parse(bytes) as Doc;
const buildReleaseAiBomFrom = (recs: ReturnType<typeof releaseAiBomRecords>) => {
  const b = buildAiBom(recs, { id: "00000000-0000-4000-8000-000000000901", subjectKind: "install", subjectId: AI_BOM_INSTALL_SUBJECT_ID, version: 1, supersedes: null, trigger: "on_demand", createdAt: T }, { cyclonedxVersions: ["1.7", "1.6"] });
  return [b.bodyBytes, ...b.renderings.map((r) => r.bytes)].join("\n");
};

beforeAll(() => warmCycloneDxValidators(), 60_000);

describe("B7 AI dev-stack inventory (security/ai-dev-stack.json)", () => {
  it("the checked-in, reviewed inventory is valid and names no vendor-shaped or URL content", () => {
    const inv = parseAiDevStackInventory(checkedIn());
    expect(inv.v).toBe(AI_DEV_STACK_VERSION);
    expect(inv.tools.length).toBeGreaterThan(0);
    expect(inv.tools.map((t) => t.id)).toEqual([...inv.tools.map((t) => t.id)].sort());
    const text = JSON.stringify(checkedIn());
    expect(text).not.toMatch(/https?:|@/);
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
});

describe("B7 release SBOM identity and BOM-Link (R9)", () => {
  it("reads serial, version and the exact-bytes SHA-256 of each SBOM", () => {
    const f = identity();
    expect(f.sboms).toEqual([
      { kind: "image", serialNumber: IMG_SERIAL, version: 3, sha256: sha(IMG) },
      { kind: "workspace", serialNumber: WS_SERIAL, version: 1, sha256: sha(WS) },
    ]);
    expect(cycloneDxBomLink(WS_SERIAL, 1)).toBe("urn:cdx:11111111-2222-4333-8444-555555555555/1");
  });
  it("refuses an SBOM with no serial or version, and a swapped SBOM file", () => {
    expect(() => buildReleaseSbomIdentity({ commit: COMMIT, imageDigest: IMAGE_DIGEST, workspace: Buffer.from(JSON.stringify({ bomFormat: "CycloneDX", version: 1 })), image: IMG })).toThrow(/serialNumber/);
    expect(() => buildReleaseSbomIdentity({ commit: COMMIT, imageDigest: IMAGE_DIGEST, workspace: Buffer.from(JSON.stringify({ bomFormat: "CycloneDX", serialNumber: WS_SERIAL })), image: IMG })).toThrow(/version/);
    expect(() => buildReleaseSbomIdentity({ commit: "nope", imageDigest: IMAGE_DIGEST, workspace: WS, image: IMG })).toThrow(/commit/);
    expect(() => checkReleaseSbomBytes(identity(), { workspace: WS, image: IMG })).not.toThrow();
    expect(() => checkReleaseSbomBytes(identity(), { workspace: sbom(WS_SERIAL, 2), image: IMG })).toThrow(/does not match the signed identity/);
  });
  it("only a signature-verified identity becomes records", () => {
    expect(() => verifiedReleaseSbomRecords(identity(), { signatureVerified: false, method: "sigstore_keyless_ci" })).toThrow(/not verified/);
    expect(() => releaseAiBomRecords(input({ sbomIdentityVerification: null }))).toThrow(/without its signature check/);
    expect(() => releaseAiBomRecords(input({ commit: "b".repeat(40) }))).toThrow(/another release commit/);
    // forging the record past the helper is refused by the normaliser too
    const recs = releaseAiBomRecords(input());
    (recs.releaseSboms![0] as { signatureVerified: unknown }).signatureVerified = false;
    expect(() => normaliseAiBomRecords(recs)).toThrow(/signature-verified/);
  });
  it("BOM-Link refs on the install root match the identity file exactly", () => {
    const b = buildReleaseAiBom(input());
    const root = docOf(b.renderings[0]!.bytes).metadata.component;
    const f = identity();
    expect(root.externalReferences).toEqual(
      f.sboms.map((s) => expect.objectContaining({ type: "bom", url: cycloneDxBomLink(s.serialNumber, s.version), hashes: [{ alg: "SHA-256", content: s.sha256 }] })),
    );
    expect(root.properties).toEqual(expect.arrayContaining([{ name: "regulait:release:commit", value: COMMIT }, { name: "regulait:release:imageDigest", value: IMAGE_DIGEST }]));
    expect(b.gaps.filter((g) => g.reason === "release_sbom_identity_not_available")).toEqual([]);
    expect(b.body.records.releaseSboms).toHaveLength(2);
  });
  it("without a verified identity: no externalReferences and the install root stays incomplete", () => {
    const b = buildReleaseAiBom(input({ sbomIdentity: null, sbomIdentityVerification: null }));
    const doc = docOf(b.renderings[0]!.bytes);
    expect(doc.metadata.component.externalReferences).toBeUndefined();
    expect(b.gaps).toContainEqual({ ref: "install", field: "externalReferences", reason: "release_sbom_identity_not_available" });
    expect(doc.compositions.some((c) => c.aggregate === "incomplete" && c.assemblies.includes("install"))).toBe(true);
    expect(doc.compositions.some((c) => c.aggregate === "complete")).toBe(false);
  });
  it("release records are refused on any subject but the install", () => {
    const recs = releaseAiBomRecords(input());
    expect(() => normaliseAiBomRecords({ ...recs, subject: { kind: "agent", id: "00000000-0000-4000-8000-000000000002" } })).toThrow(/only an install snapshot/);
    expect(() => normaliseAiBomRecords({ ...recs, releaseSboms: [], subject: { kind: "agent", id: "00000000-0000-4000-8000-000000000002" } })).toThrow(/devStackTools: only an install snapshot/);
  });
});

describe("B7 install-scope rendering", () => {
  it("is deterministic: tool order and repeated builds give identical bytes", () => {
    const a = buildReleaseAiBom(input());
    const shuffled = checkedIn();
    shuffled.tools.reverse();
    const b = buildReleaseAiBom(input({ inventory: shuffled }));
    expect(b.bodyBytes).toBe(a.bodyBytes);
    expect(b.renderings.map((r) => r.bytes)).toEqual(a.renderings.map((r) => r.bytes));
    expect(a.body.snapshot).toMatchObject({ subjectKind: "install", subjectId: AI_BOM_INSTALL_SUBJECT_ID, version: 1, supersedes: null, createdAt: T });
    // another release commit is another snapshot
    const other = buildReleaseAiBom(input({ commit: "b".repeat(40), sbomIdentity: null, sbomIdentityVerification: null }));
    expect(other.body.snapshot.id).not.toBe(a.body.snapshot.id);
  });
  it("renders every inventory tool as a formulation component, never an install component, with its version gap", () => {
    const b = buildReleaseAiBom(input());
    const doc = docOf(b.renderings[0]!.bytes) as Doc & { components?: unknown[] };
    const ids = parseAiDevStackInventory(checkedIn()).tools.map((t) => t.id);
    expect(doc.formulation?.[0]?.components.map((c) => c.name)).toEqual(ids);
    expect(doc.components ?? []).toEqual([]);
    for (const id of ids) expect(b.gaps).toContainEqual({ ref: `dev-tool:${id}`, field: "version", reason: "dev_stack_version_not_recorded" });
    expect(b.renderings.map((r) => r.format)).toEqual(["cyclonedx-1.7"]);
  });
  it("CANARY: no SBOM content, runner path or secret leaks into the native body or any rendering", () => {
    const b = buildReleaseAiBom(input());
    for (const bytes of [b.bodyBytes, ...b.renderings.map((r) => r.bytes)]) {
      expect(bytes).not.toContain("CANARY");
      expect(bytes).not.toContain("/home/");
      expect(bytes).not.toContain("left-pad");
      expect(bytes).not.toContain("trivy");
    }
  });
});

describe("X41 policy on B7's own record lists", () => {
  it("every string field of releaseSboms and devStackTools refuses a credential or a URL, never echoing it", () => {
    const secret = ["sk", `XFIELDCANARY${"q".repeat(20)}`].join("-");
    const url = ["https:", "", "internal.example", "XFIELDPATH", "doc?signature=XFIELDQUERY"].join("/");
    let n = 0;
    for (const list of ["releaseSboms", "devStackTools"] as const) {
      const fields = Object.entries(releaseAiBomRecords(input())[list]![0]!).filter(([, v]) => typeof v === "string" || Array.isArray(v)).map(([k]) => k);
      for (const k of fields) {
        for (const canary of [secret, url]) {
          const recs = releaseAiBomRecords(input());
          const r = recs[list]![0] as unknown as Record<string, unknown>;
          r[k] = Array.isArray(r[k]) ? [canary] : canary;
          n++;
          let out = "";
          try {
            out = [buildReleaseAiBomFrom(recs)].join("");
          } catch (e) {
            expect((e as Error).message).not.toMatch(/XFIELD/);
            continue;
          }
          expect(out.includes("XFIELD"), `${list}.${k}`).toBe(false);
        }
      }
    }
    expect(n).toBeGreaterThan(20);
  });
});

describe("B7 the release step is inert until the R17 switch flips (R28)", () => {
  it("the switch is off and the step builds nothing", () => {
    expect(AI_BOM_SNAPSHOTS_RELEASED).toBe(false);
    expect(runReleaseAiBomStep(input())).toEqual({ status: "inert", reason: "ai_bom_snapshots_not_released" });
    // inert even on input that would be refused: nothing is parsed while off
    expect(runReleaseAiBomStep(input({ inventory: { v: "nope" } }))).toMatchObject({ status: "inert" });
  });
  it("NEGATIVE CONTROL (harness only): with the switch on, the same step builds and returns files", () => {
    const r = runReleaseAiBomStep(input(), { released: true });
    expect(r.status).toBe("built");
    if (r.status !== "built") return;
    expect(r.files.map((f) => f.name)).toEqual(["ai-bom.native.json", "ai-bom.cyclonedx-1.7.json"]);
    expect(r.files[0]!.bytes).toBe(r.build.bodyBytes);
  });
  it("security.yml gates every producing step of the release job on the switch", () => {
    const wf = readFileSync(path.join(repo, ".github/workflows/security.yml"), "utf8");
    const start = wf.indexOf("\n  release-ai-bom:\n");
    expect(start).toBeGreaterThan(0);
    const end = wf.indexOf("\n  # ----", start + 1);
    const job = wf.slice(start, end);
    expect(job).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    const steps = job.split("\n      - ").slice(1);
    const switchAt = steps.findIndex((s) => s.includes("id: switch"));
    expect(switchAt).toBeGreaterThan(0);
    const after = steps.slice(switchAt + 1);
    expect(after.length).toBeGreaterThanOrEqual(5);
    for (const s of after) {
      const gated = s.includes("if: steps.switch.outputs.released == 'true'");
      const inertNote = s.includes("if: steps.switch.outputs.released != 'true'") && !s.includes("cosign") && !s.includes("upload-artifact");
      expect(gated || inertNote).toBe(true);
    }
    // nothing before the switch signs, downloads or uploads
    for (const s of steps.slice(0, switchAt)) expect(s).not.toMatch(/cosign|upload-artifact|download-artifact/);
  });
});
