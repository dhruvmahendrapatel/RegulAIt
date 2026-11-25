/**
 * ADR-0242 §6.1 — a test harness (tests only; not exported from the package index): one subject scan, end to end,
 * without Docker or a gateway, through every piece the image runs:
 *
 *   the runner's adapter → the exchange (`subject.json`) → the REAL task bridge → a relay standing in for the gateway
 *   and the executor (it checks the start body against the shared schema and the gateway's own #843 rules, then writes
 *   the GATEWAY's subject file at the input root) → the REAL sandbox task (`runSandboxTask` with `subjectFiles`) → the
 *   admission task (self-test, then a driver stand-in run as a child process group) → frames → the bridge → the
 *   exchange → the envelope, parsed as the gateway parses it, and the report interpreted as the gateway interprets it.
 *
 * The driver stand-in writes a recorded `regulait.admission-scan.v1` report (packages/shared fixtures) with the
 * `inputs` it read, as engines/<id>/scan.py does.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { ExecutorTaskBridge } from "@regulait/engine-runner";
import { runSandboxTask } from "@regulait/engine-runner/worker";
import {
  ENGINE_RESULT_VERSION,
  engineResultEnvelopeSchema,
  engineTaskInputUploadSchema,
  interpretAdmissionScanReport,
  type AdmissionScanEngineId,
  type AdmissionScanInterpretation,
  type EngineLease,
  type EngineResultEnvelope,
  type EngineTaskFramesResponse,
  type EngineTaskInputUpload,
} from "@regulait/shared";
import { admissionScanAdapter } from "./adapter.js";
import { ADMISSION_SUBJECT_FILE, pinnedVersion, type SubjectEngineId } from "./config.js";
import { SubjectExchange } from "./exchange.js";
import { admissionScanTask, type AdmissionTaskOptions } from "./task.js";

export const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../shared/src/engines/fixtures/admission-scan");

/** a no-egress probe (the sandbox reaches nothing) */
export const NO_EGRESS = {
  host: "egress-probe.invalid",
  ip: "93.184.215.14",
  lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })),
  connect: async () => "denied" as const,
};
export const RUNTIME = () => ({ kernelRelease: "4.4.0", procVersionGvisor: true, uid: 10001, capEff: "0000000000000000", noNewPrivs: 1, seccomp: 2 });

/**
 * A driver stand-in: `node <script> <in> <out>` writes `fixture` with the `inputs` it read under <in> (path and
 * sha256 of every file, sorted) and exits `exitCode`. `fixture: null` writes nothing.
 */
export async function fakeDriver(dir: string, fixture: string | null, exitCode = 0, extra: Record<string, unknown> = {}): Promise<{ command: string; args: string[] }> {
  const script = path.join(dir, `driver-${randomUUID()}.mjs`);
  await writeFile(
    script,
    `import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [inDir, out] = process.argv.slice(2);
const fixture = ${JSON.stringify(fixture === null ? null : path.join(FIXTURES, `${fixture}.json`))};
if (fixture) {
  const inputs = readdirSync(inDir).sort().map((n) => ({ path: n, sha256: createHash("sha256").update(readFileSync(path.join(inDir, n))).digest("hex") }));
  writeFileSync(out, JSON.stringify({ ...JSON.parse(readFileSync(fixture, "utf8")), inputs, ...${JSON.stringify(extra)} }));
}
process.exit(${exitCode});
`,
  );
  return { command: process.execPath, args: [script] };
}

export function subjectLease(engine: SubjectEngineId, subject: Buffer | null, deadlineMs = 60_000): EngineLease {
  return {
    runId: randomUUID(),
    engineId: engine,
    engineVersion: pinnedVersion(engine),
    spec: { config: { sets: ["scan"], params: {} }, trials: 1 },
    target: null,
    judge: null,
    artifacts: [],
    subject: subject ? { file: ADMISSION_SUBJECT_FILE[engine], sha256: createHash("sha256").update(subject).digest("hex"), size: subject.length } : null,
    deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
    budgetUsd: null,
  };
}

/** the gateway's task-start rules for a subject run (engine-tasks.ts, #843 security review), or the refusal */
export function gatewayStartRefusal(engine: SubjectEngineId, body: unknown): string | null {
  const parsed = engineTaskInputUploadSchema.safeParse(body);
  if (!parsed.success) return "engine_task_input_invalid";
  const u = parsed.data;
  if (!u.subject) return "no subject";
  if (u.files.length !== 0) return "runner files";
  if (u.artifact !== null) return "an artifact";
  if (u.subject.path !== ADMISSION_SUBJECT_FILE[engine]) return "not the root subject name";
  if (u.secret !== null) return "a secret";
  return null;
}

export interface EndToEndResult {
  started: EngineTaskInputUpload | null;
  envelope: EngineResultEnvelope;
  interpretation: AdmissionScanInterpretation;
  taskCode: number | null;
}

export interface EndToEndRun {
  started: EngineTaskInputUpload | null;
  envelope: EngineResultEnvelope;
  /** the raw report's bytes parsed as JSON, only for a completed run (as the gateway reads it) */
  report: unknown;
  taskCode: number | null;
}

/** one scan through the adapter, the bridge and the sandbox task, judged as the gateway judges it */
export async function scanEndToEnd(args: {
  engine: AdmissionScanEngineId;
  subject: Buffer;
  placed?: Record<string, Buffer>;
  task?: AdmissionTaskOptions;
  lease?: EngineLease;
}): Promise<EndToEndResult> {
  const r = await runEndToEnd(args);
  const s = r.started as EngineTaskInputUpload | null;
  const interpretation = interpretAdmissionScanReport(r.report, {
    engine: args.engine,
    input: s?.subject ? { path: s.subject.path, sha256: createHash("sha256").update(args.subject).digest("hex") } : null,
  });
  return { started: r.started, envelope: r.envelope, interpretation, taskCode: r.taskCode };
}

/** one run of any subject engine through the adapter, the bridge and the sandbox task (ADR-0362: the extractor too) */
export async function runEndToEnd(args: {
  engine: SubjectEngineId;
  subject: Buffer;
  /** what the executor writes at the input root (default: `subject`, under the gateway's name) */
  placed?: Record<string, Buffer>;
  task?: AdmissionTaskOptions;
  lease?: EngineLease;
}): Promise<EndToEndRun> {
  const root = await mkdtemp(path.join(tmpdir(), "adr0242-l4-"));
  const abort = new AbortController();
  try {
    const jobs = path.join(root, "jobs");
    const results = path.join(root, "results");
    await mkdir(jobs);
    await mkdir(results);
    let started: EngineTaskInputUpload | null = null;
    let taskCode: number | null = null;
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const frames: string[] = [];
    let eof = false;
    createInterface({ input: stdout }).on("line", (l) => frames.push(l));
    stdout.on("end", () => (eof = true));
    const client = {
      taskInput: async (_runId: string, body: EngineTaskInputUpload) => {
        const refusal = gatewayStartRefusal(args.engine, body);
        if (refusal) return { status: 422, error: "engine_task_input_invalid", reason: refusal };
        started = body;
        // the executor's side: the gateway's own subject file, written at the input root
        const input = path.join(root, "sandbox-in");
        await mkdir(input);
        for (const [name, bytes] of Object.entries(args.placed ?? { [body.subject!.path]: args.subject })) await writeFile(path.join(input, name), bytes);
        void runSandboxTask({
          gateway: false,
          subjectFiles: [ADMISSION_SUBJECT_FILE[args.engine]],
          jobsRoot: input,
          workRoot: path.join(root, "sandbox-work"),
          stdout,
          stdin,
          readSecret: () => null,
          run: admissionScanTask(args.engine, { engineVersion: () => pinnedVersion(args.engine), egress: NO_EGRESS, runtime: RUNTIME, credentialPaths: [], ...args.task }),
        }).then((code) => {
          taskCode = code;
          stdout.end();
        });
        return { status: 201, error: null, reason: null };
      },
      taskFrames: async (_runId: string, from: number): Promise<EngineTaskFramesResponse> => {
        for (let i = 0; i < 100 && frames.length <= from && !eof; i++) await new Promise((r) => setTimeout(r, 10));
        const out = frames.slice(from, from + 64).map((data, i) => ({ seq: from + i, data }));
        const next = from + out.length;
        return { state: eof && next >= frames.length ? "ended" : "running", frames: out, nextSeq: next, eof: eof && next >= frames.length, refusal: null };
      },
      taskPost: async () => undefined,
    };
    const bridge = new ExecutorTaskBridge({ client, jobsRoot: jobs, resultsRoot: results, gatewayBaseUrl: "http://gateway:3000/v1", pollMs: 5 });
    void bridge.run(abort.signal);
    const lease = args.lease ?? subjectLease(args.engine, args.subject, 20_000);
    const adapter = admissionScanAdapter({ engine: args.engine, executor: new SubjectExchange(jobs, results, { pollMs: 5, graceMs: 0 }), reportMarginMs: 0 });
    const body = await adapter(lease, { workDir: root, signal: new AbortController().signal, progress: () => undefined });
    const envelope = engineResultEnvelopeSchema.parse({ version: ENGINE_RESULT_VERSION, runId: lease.runId, engineId: args.engine, engineVersion: lease.engineVersion, ...body });
    // as the gateway: the report is the raw report's bytes; only a completed run's report is recorded
    const report = envelope.status === "completed" && envelope.rawReport?.contentBase64 !== undefined ? (JSON.parse(Buffer.from(envelope.rawReport.contentBase64, "base64").toString("utf8")) as unknown) : null;
    return { started, envelope, report, taskCode };
  } finally {
    abort.abort();
    await rm(root, { recursive: true, force: true });
  }
}
