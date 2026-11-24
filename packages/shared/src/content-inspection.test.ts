/**
 * ADR-0362 — the shared vocabulary equals the extractor's, and the extractor's own unit tests pass.
 *
 * The extractor is Python (it runs only in the engine sandbox). Its tests are stdlib only; the PDF cases need
 * pypdfium2 and are skipped here unless it is installed (the image build runs them with REGULAIT_REQUIRE_PDFIUM=1).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTENT_EXTRACT_HARD_LIMITS,
  CONTENT_EXTRACT_RESULT_VERSION,
  CONTENT_REFUSAL_REASONS,
  contentExtractResultSchema,
} from "./content-inspection.js";
import { CONTENTEXTRACT_ENGINE_VERSION, CONTENTEXTRACT_MAX_BUNDLE_BYTES } from "./engines/contentextract.js";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../engines/contentextract");
const HAVE_PYTHON = spawnSync("python3", ["--version"]).status === 0;

function py(code: string): string {
  const r = spawnSync("python3", ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(DIR)}); ${code}`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

describe.skipIf(!HAVE_PYTHON)("ADR-0362 extractor parity", () => {
  it("refusal reasons, hard limits and result version match extract.py", () => {
    const got = JSON.parse(py("import extract, json; print(json.dumps({'r': extract.REFUSAL_REASONS, 'l': extract.HARD_LIMITS, 'v': extract.RESULT_VERSION}))")) as {
      r: string[];
      l: Record<string, number>;
      v: number;
    };
    expect(got.r).toEqual([...CONTENT_REFUSAL_REASONS]);
    expect(got.l).toEqual({ ...CONTENT_EXTRACT_HARD_LIMITS });
    expect(got.v).toBe(CONTENT_EXTRACT_RESULT_VERSION);
  });

  it("the extractor's version is the manifest's (ADR-0362 slice 1b)", () => {
    expect(py("import extract; print(extract.EXTRACTOR_VERSION)").trim()).toBe(CONTENTEXTRACT_ENGINE_VERSION);
    // the largest bundle the gateway queues is the largest the extractor reads
    expect(Number(py("import extract; print(extract.MAX_BUNDLE_BYTES)").trim())).toBe(CONTENTEXTRACT_MAX_BUNDLE_BYTES);
  });

  it("the extractor's unit tests pass", () => {
    const r = spawnSync("python3", ["-I", "-m", "unittest", "discover", "-s", DIR], { encoding: "utf8" });
    expect(r.stderr).toMatch(/\nOK/);
    expect(r.status).toBe(0);
  });

  it("a real result parses with the shared schema", () => {
    const out = py(
      "import extract, json, base64; " +
        "print(json.dumps(extract.run({'files': [{'id': 'a', 'dataBase64': base64.b64encode(b'hi').decode()}, {'id': 'b', 'dataBase64': base64.b64encode(b'\\x00\\x01').decode()}]}, extract.read_inline)))",
    );
    const parsed = contentExtractResultSchema.parse(JSON.parse(out));
    expect(parsed.files[0]).toEqual({ id: "a", status: "extracted", type: "text", text: "hi" });
    expect(parsed.files[1]).toMatchObject({ id: "b", status: "refused", reason: "unknown_type" });
  });
});

describe("ADR-0362 result schema", () => {
  it("refuses an unknown reason, a missing field and extra keys", () => {
    expect(contentExtractResultSchema.safeParse({ version: 1, files: [{ id: "a", status: "refused", type: "pdf", reason: "nope" }] }).success).toBe(false);
    expect(contentExtractResultSchema.safeParse({ version: 1, files: [{ id: "a", status: "extracted", type: "pdf" }] }).success).toBe(false);
    expect(contentExtractResultSchema.safeParse({ version: 1, files: [], extra: 1 }).success).toBe(false);
    expect(contentExtractResultSchema.safeParse({ version: 2, files: [] }).success).toBe(false);
  });
});
