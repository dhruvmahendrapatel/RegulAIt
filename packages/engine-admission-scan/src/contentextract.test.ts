/**
 * ADR-0362 slice 1b — the content extractor as the shim's third subject engine, end to end without Docker
 * (harness.ts): the runner's adapter, the real task bridge, the real sandbox task and the admission task running the
 * REAL extractor (`python3 -I engines/contentextract/extract.py <bundle.json> <report>`) on the gateway's bundle.
 *
 * What it pins:
 *  - the task is started with no files, no artifact, no secret and the root `bundle.json`, which the gateway's rules
 *    accept (and refuse for another engine's name);
 *  - the extractor reads the bundle FILE (not the input root) and its result comes back byte for byte as the raw
 *    report, and parses with the shared `contentExtractResultSchema`;
 *  - a decoy file beside the bundle, a bundle that is not JSON and a driver that writes nothing never produce a
 *    completed run with a result (fail closed: the gateway then treats every file as refused).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CONTENT_EXTRACT_HARD_LIMITS, contentExtractResultSchema } from "@regulait/shared";
import { ADMISSION_SUBJECT_FILE } from "./config.js";
import { ADMISSION_REPORT_MAX_BYTES } from "./exchange.js";
import { fakeDriver, gatewayStartRefusal, runEndToEnd, subjectLease } from "./harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const EXTRACT = path.join(ROOT, "engines/contentextract/extract.py");
const HAVE_PYTHON = spawnSync("python3", ["--version"]).status === 0;
const realDriver = { command: "python3", args: ["-I", EXTRACT] };
const scripts = mkdtempSync(path.join(tmpdir(), "e43-drivers-"));
afterAll(async () => rm(scripts, { recursive: true, force: true }));

const bundle = (files: Array<{ id: string; text?: string; bytes?: Buffer }>) =>
  Buffer.from(JSON.stringify({ files: files.map((f) => ({ id: f.id, name: `${f.id}.txt`, dataBase64: (f.bytes ?? Buffer.from(f.text ?? "", "utf8")).toString("base64") })) }));

describe("ADR-0362: the start body", () => {
  it("is the gateway's bundle.json alone, and the gateway's rules accept only that name for this engine", () => {
    expect(ADMISSION_SUBJECT_FILE.contentextract).toBe("bundle.json");
    const body = { files: [], artifact: null, subject: { path: "bundle.json" }, secret: null };
    expect(gatewayStartRefusal("contentextract", body)).toBeNull();
    expect(gatewayStartRefusal("contentextract", { ...body, subject: { path: "tools.json" } })).not.toBeNull();
    expect(gatewayStartRefusal("mcpscanner", body)).not.toBeNull();
  });
});

describe.skipIf(!HAVE_PYTHON)("ADR-0362: the real extractor through the bridge and the sandbox task", () => {
  it("extracts the bundle's text and refuses an unknown type; the result is the raw report, byte for byte", async () => {
    const subject = bundle([{ id: "a0", text: "card 4111 1111 1111 1111" }, { id: "a1", bytes: Buffer.from([0, 1, 2, 3]) }]);
    const r = await runEndToEnd({ engine: "contentextract", subject, task: { driver: realDriver } });
    expect(r.started).toEqual({ files: [], artifact: null, subject: { path: "bundle.json" }, secret: null });
    expect(r.taskCode).toBe(0);
    expect(r.envelope).toMatchObject({ status: "completed", errorCode: null, items: [], notRun: [] });
    const result = contentExtractResultSchema.parse(r.report);
    expect(result.files[0]).toEqual({ id: "a0", status: "extracted", type: "text", text: "card 4111 1111 1111 1111" });
    expect(result.files[1]).toMatchObject({ id: "a1", status: "refused", reason: "unknown_type" });
  });

  it("a bundle that is not JSON: the extractor fails, so no completed result is posted", async () => {
    const r = await runEndToEnd({ engine: "contentextract", subject: Buffer.from("not json"), task: { driver: realDriver } });
    expect(r.envelope.status).toBe("failed");
    expect(r.report).toBeNull();
  });

  it("a decoy file beside the bundle: the sandbox task refuses to run (the input root holds only the gateway's file)", async () => {
    const subject = bundle([{ id: "a0", text: "hello" }]);
    const r = await runEndToEnd({
      engine: "contentextract",
      subject,
      placed: { "bundle.json": subject, "decoy.json": Buffer.from("{}") },
      task: { driver: realDriver },
      lease: subjectLease("contentextract", subject, 2000),
    });
    expect(r.taskCode).toBe(2);
    expect(r.envelope).toMatchObject({ status: "failed", errorCode: "engine_timeout", rawReport: null });
    expect(r.report).toBeNull();
  }, 30_000);

  it("ADR-0362 text cap: a result at the cap of 4-byte characters fits under the raw-report cap; one that escapes larger fails closed", async () => {
    expect(CONTENT_EXTRACT_HARD_LIMITS.maxTextChars).toBe(750_000);
    // the worst ordinary text: every character 4 UTF-8 bytes, exactly at the cap
    const atCap = "\u{1F600}".repeat(CONTENT_EXTRACT_HARD_LIMITS.maxTextChars);
    const ok = await runEndToEnd({ engine: "contentextract", subject: bundle([{ id: "a0", text: atCap }]), task: { driver: realDriver } });
    expect(ok.envelope).toMatchObject({ status: "completed", errorCode: null });
    expect(ok.envelope.rawReport!.bytes).toBeLessThanOrEqual(ADMISSION_REPORT_MAX_BYTES);
    expect(contentExtractResultSchema.parse(ok.report).files[0]).toMatchObject({ id: "a0", status: "extracted" });
    // control characters escape to six bytes each: the report is over the cap, so nothing is posted (every file refused)
    const escaped = "\u0001".repeat(CONTENT_EXTRACT_HARD_LIMITS.maxTextChars);
    const over = await runEndToEnd({ engine: "contentextract", subject: bundle([{ id: "a0", text: escaped }]), task: { driver: realDriver } });
    expect(over.envelope).toMatchObject({ status: "failed", errorCode: "report_too_large", rawReport: null });
    expect(over.report).toBeNull();
  }, 60_000);

  it("a driver that writes nothing: failed, no report", async () => {
    const r = await runEndToEnd({ engine: "contentextract", subject: bundle([{ id: "a0", text: "x" }]), task: { driver: await fakeDriver(scripts, null) } });
    expect(r.envelope).toMatchObject({ status: "failed", errorCode: "report_missing", rawReport: null });
    expect(r.report).toBeNull();
  });
});
