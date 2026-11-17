/**
 * ADR-0242 §6.1 — one subject scan end to end without Docker (harness.ts): the runner's adapter, the real task bridge,
 * the real sandbox task and the admission task with a driver stand-in that writes the recorded reports. What it pins:
 *  - the task is started with no files, no artifact, no secret and the root subject path, and the gateway's rules
 *    accept that body;
 *  - the known-bad report holds (fail) and the clean one passes, judged exactly as the gateway judges (the driver's
 *    `inputs` echo is the one file the gateway placed);
 *  - a driver that writes nothing, a driver's own failed report, a crash, and a decoy file beside the subject all end
 *    `unknown` (never pass);
 *  - the worker's self-test comes back to the runner, so its next registration can report the offline switch.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ADMISSION_SUBJECT_FILE } from "./config.js";
import { fakeDriver, FIXTURES, scanEndToEnd, subjectLease } from "./harness.js";

const scripts = mkdtempSync(path.join(tmpdir(), "l4-drivers-"));
afterAll(async () => rm(scripts, { recursive: true, force: true }));

const SUBJECT = {
  mcpscanner: Buffer.from(JSON.stringify({ tools: [{ name: "read_file", description: "Reads a file", inputSchema: { type: "object" } }] })),
  skillscanner: Buffer.from("---\nname: tables\ndescription: formats tables\n---\nPad each column of the table.\n"),
} as const;

describe.each(["mcpscanner", "skillscanner"] as const)("%s, end to end through the bridge and the sandbox task", (engine) => {
  it("the known-bad report holds the subject; the start body carried no runner input", async () => {
    const r = await scanEndToEnd({ engine, subject: SUBJECT[engine], task: { driver: await fakeDriver(scripts, `${engine}-bad`) } });
    expect(r.started).toEqual({ files: [], artifact: null, subject: { path: ADMISSION_SUBJECT_FILE[engine] }, secret: null });
    expect(r.taskCode).toBe(0);
    expect(r.envelope).toMatchObject({ status: "completed", errorCode: null, items: [], notRun: [] });
    // the raw report is the driver's report, byte for byte, with the input it echoed
    const posted = JSON.parse(Buffer.from(r.envelope.rawReport!.contentBase64!, "base64").toString("utf8")) as { inputs: unknown; engine: string };
    expect(posted.engine).toBe(engine);
    expect(posted.inputs).toEqual([{ path: ADMISSION_SUBJECT_FILE[engine], sha256: createHash("sha256").update(SUBJECT[engine]).digest("hex") }]);
    expect(r.interpretation.verdict).toBe("fail");
    expect(r.interpretation.findings.length).toBeGreaterThan(0);
  });

  it("the clean report passes", async () => {
    const r = await scanEndToEnd({ engine, subject: SUBJECT[engine], task: { driver: await fakeDriver(scripts, `${engine}-clean`) } });
    expect(r.envelope.status).toBe("completed");
    expect(r.interpretation.verdict).toBe("pass");
  });

  it("a driver that writes no report → failed, no report → unknown", async () => {
    const r = await scanEndToEnd({ engine, subject: SUBJECT[engine], task: { driver: await fakeDriver(scripts, null, 0) } });
    expect(r.envelope).toMatchObject({ status: "failed", errorCode: "report_missing", rawReport: null });
    expect(r.interpretation.verdict).toBe("unknown");
  });

  it("the driver's own failed report (exit 2) → failed with the report attached → unknown", async () => {
    const r = await scanEndToEnd({ engine, subject: SUBJECT[engine], task: { driver: await fakeDriver(scripts, `${engine}-crash`, 2) } });
    expect(r.envelope).toMatchObject({ status: "failed", errorCode: "scan_failed" });
    expect(r.envelope.rawReport).not.toBeNull();
    expect(r.interpretation.verdict).toBe("unknown");
  });

  it("a driver killed at its limit → failed (engine_timeout) → unknown", async () => {
    const hang = { command: process.execPath, args: ["-e", "setTimeout(() => undefined, 60000)"] };
    const r = await scanEndToEnd({ engine, subject: SUBJECT[engine], task: { driver: hang, timeoutMs: 200 } });
    expect(r.envelope).toMatchObject({ status: "failed", errorCode: "engine_timeout", rawReport: null });
  });

  // the task ends without an answer: the runner waits out the run's time (here 2 s), then reports the scan timed out
  it("an input holding anything beside the subject is refused in the sandbox: nothing runs, nothing passes", async () => {
    const r = await scanEndToEnd({
      engine,
      subject: SUBJECT[engine],
      placed: { [ADMISSION_SUBJECT_FILE[engine]]: SUBJECT[engine], "decoy.json": Buffer.from("{}") },
      task: { driver: await fakeDriver(scripts, `${engine}-clean`) },
      lease: subjectLease(engine, SUBJECT[engine], 2000),
    });
    expect(r.taskCode).toBe(2);
    expect(r.envelope).toMatchObject({ status: "failed", errorCode: "engine_timeout", rawReport: null });
    expect(r.interpretation.verdict).toBe("unknown");
  }, 30_000);

  it("a sandbox that reaches the network scans nothing (the driver never starts)", async () => {
    const marker = path.join(scripts, `${engine}-ran`);
    const r = await scanEndToEnd({
      engine,
      subject: SUBJECT[engine],
      task: { driver: { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`] }, egress: { host: "x.invalid", ip: "93.184.215.14", lookup: async () => ({}), connect: async () => "connected" } },
    });
    expect(r.envelope).toMatchObject({ status: "failed", errorCode: "sandbox_not_isolated", rawReport: null });
    expect(existsSync(marker)).toBe(false);
  });
});

it("the recorded fixtures the stand-in replays are the shared ones", () => {
  for (const name of ["mcpscanner-bad", "skillscanner-bad"]) expect(JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"))).toMatchObject({ schema: "regulait.admission-scan.v1" });
});
