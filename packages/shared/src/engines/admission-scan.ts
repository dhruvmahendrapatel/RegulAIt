/**
 * ADR-0242 — the two admission-scan engines (Cisco mcp-scanner and skill-scanner), the pure half.
 *
 * Each engine image runs our driver (`engines/<id>/scan.py`) on one admission subject, offline, and writes a
 * `regulait.admission-scan.v1` report: rule ids, severities, item kinds and names, never subject text. This
 * module owns what the gateway does with that report:
 *
 *   1. `admissionScanReportSchema` — the strict shape, with caps; anything else is not a report.
 *   2. `interpretAdmissionScanReport` — report → `pass | fail | unknown` plus findings in the subject's own
 *      admission vocabulary (`McpAdmissionFinding`). A missing, invalid, failed or wrong-version report is
 *      `unknown`, never `pass` (ADR-0187 not-clean semantics).
 *   3. `engineAdmissionHold` — the gate's question: given whether the engine is on and the latest scan of THIS
 *      digest, does the subject hold? Off: the engine has no say. On: only a `pass` for the current digest lets
 *      it through. No scan yet, `unknown`, or `fail` all hold (fail closed).
 *
 * The thresholds are each subject's own: an MCP server holds at `high` (MCP_ADMISSION_HOLD_AT), a skill at
 * `medium` (SKILL_ADMISSION_HOLD_AT), the same lines the in-process scanners use. An `info` finding (for
 * example skill-scanner's MANIFEST_MISSING_LICENSE) is advice and never a finding here.
 */
import { z } from "zod";
import { MCP_ADMISSION_HOLD_AT, severityAtLeast, type McpAdmissionFinding, type McpAdmissionSeverity } from "../mcp-admission.js";
import { SKILL_ADMISSION_HOLD_AT } from "../skill-admission.js";

export const ADMISSION_SCAN_REPORT_SCHEMA = "regulait.admission-scan.v1";

/** the engines that scan an admission subject, and the subject each one scans */
// The report is untrusted output from a container that has just processed attacker-controlled content, so the
// gateway does not take its word for what ran (#727 review): the analyzer set and the rule-set digest are pinned
// here, to exactly what the driver emits and what engines/<id>/ commits (`yara-rules.sha256`, `rules.sha256`;
// admission-scan.test.ts keeps them in lockstep). Any other analyzer list, including an empty one, or any other
// digest makes the report `unknown`.
export const ADMISSION_SCAN_ENGINES = {
  mcpscanner: {
    subject: "mcp_server",
    version: "4.8.7",
    holdAt: MCP_ADMISSION_HOLD_AT,
    analyzers: ["yara", "schema"],
    rulesSha256: "61b5a21ad1b4279a6593e880448a39628daf8b11a1039b32ba09e149ad5261fa",
  },
  skillscanner: {
    subject: "builder_skill",
    version: "2.3.2",
    holdAt: SKILL_ADMISSION_HOLD_AT,
    analyzers: ["static_analyzer", "bytecode", "pipeline", "correlation"],
    rulesSha256: "1fce40df3c101daf610b3ff5cd4007bb0ce0ef32b9fdf42938566e22b183e1bd",
  },
} as const satisfies Record<string, { subject: string; version: string; holdAt: McpAdmissionSeverity; analyzers: readonly string[]; rulesSha256: string }>;
export type AdmissionScanEngineId = keyof typeof ADMISSION_SCAN_ENGINES;
export const ADMISSION_SCAN_ENGINE_IDS = Object.keys(ADMISSION_SCAN_ENGINES) as AdmissionScanEngineId[];

/** what an admission scan subject is (`admission_engine_scans.subject_kind`; mirrors the migration's CHECK) */
export const ADMISSION_SCAN_SUBJECT_KINDS = ["mcp_server", "builder_skill"] as const;
export type AdmissionScanSubjectKind = (typeof ADMISSION_SCAN_SUBJECT_KINDS)[number];

/** an admission engine scan's verdict (`admission_engine_scans.verdict`); only `pass` is clean */
export const ADMISSION_SCAN_VERDICTS = ["pass", "fail", "unknown"] as const;
export type AdmissionScanVerdict = (typeof ADMISSION_SCAN_VERDICTS)[number];

export function admissionScanEngineFor(subject: AdmissionScanSubjectKind): AdmissionScanEngineId {
  return subject === "mcp_server" ? "mcpscanner" : "skillscanner";
}

const ident = z.string().min(1).max(160).regex(/^[a-z0-9_.-]+$/);
const name = z.string().max(256);
const REPORT_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

export const admissionScanReportSchema = z.discriminatedUnion("status", [
  z.strictObject({
    schema: z.literal(ADMISSION_SCAN_REPORT_SCHEMA),
    engine: z.enum(["mcpscanner", "skillscanner"]),
    engineVersion: z.string().max(32),
    status: z.literal("completed"),
    analyzers: z.array(ident).max(16),
    rulesSha256: z.string().regex(/^[0-9a-f]{64}$/),
    items: z.array(z.strictObject({ kind: ident, name, status: z.enum(["completed", "failed"]) })).max(5000),
    findings: z.array(z.strictObject({ rule: ident, severity: z.enum(REPORT_SEVERITIES), kind: ident, name })).max(5000),
  }),
  z.strictObject({
    schema: z.literal(ADMISSION_SCAN_REPORT_SCHEMA),
    engine: z.enum(["mcpscanner", "skillscanner"]),
    engineVersion: z.string().max(32),
    status: z.literal("failed"),
    error: z.string().max(200),
    analyzers: z.array(ident).max(16).optional(),
    rulesSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    items: z.array(z.strictObject({ kind: ident, name, status: z.enum(["completed", "failed"]) })).max(5000).optional(),
    findings: z.array(z.strictObject({ rule: ident, severity: z.enum(REPORT_SEVERITIES), kind: ident, name })).max(5000).optional(),
  }),
]);
export type AdmissionScanReport = z.infer<typeof admissionScanReportSchema>;

export interface AdmissionScanInterpretation {
  verdict: AdmissionScanVerdict;
  /** counts-only findings in the admission vocabulary, aggregated per (rule, severity, item) */
  findings: McpAdmissionFinding[];
  /** a short, fixed reason; never engine output */
  reason: string;
  rulesSha256: string | null;
}

const UNKNOWN = (reason: string, rulesSha256: string | null = null): AdmissionScanInterpretation => ({ verdict: "unknown", findings: [], reason, rulesSha256 });

/**
 * One report → one verdict. The engine id and version are what the gateway asked for; a report that names
 * another engine or version, that fails, or that does not parse, is `unknown`.
 */
export function interpretAdmissionScanReport(raw: unknown, expect: { engine: AdmissionScanEngineId; version?: string }): AdmissionScanInterpretation {
  if (raw === null || raw === undefined) return UNKNOWN("no report");
  const parsed = admissionScanReportSchema.safeParse(raw);
  if (!parsed.success) return UNKNOWN("the report is not a regulait.admission-scan.v1 report");
  const r = parsed.data;
  const spec = ADMISSION_SCAN_ENGINES[expect.engine];
  const version = expect.version ?? spec.version;
  // fixed text only: nothing the report says is echoed into a reason (an audit row carries it)
  if (r.engine !== expect.engine || r.engineVersion !== version) return UNKNOWN(`the report names another engine or version than ${expect.engine} ${version}`);
  if (r.status !== "completed") return UNKNOWN("the engine reported a failed scan");
  if (r.rulesSha256 !== spec.rulesSha256) return UNKNOWN("the report's rule-set digest is not the pinned one");
  const ran = [...r.analyzers].sort();
  const pinned = [...spec.analyzers].sort();
  if (ran.length !== pinned.length || ran.some((a, i) => a !== pinned[i])) return UNKNOWN("the report's analyzer set is not the pinned one");
  if (r.items.length === 0) return UNKNOWN("the engine scanned nothing", r.rulesSha256);
  if (r.items.some((i) => i.status !== "completed")) return UNKNOWN("an item did not scan", r.rulesSha256);
  const counts = new Map<string, McpAdmissionFinding>();
  for (const f of r.findings) {
    if (f.severity === "info") continue;
    const key = `${f.rule}\0${f.severity}\0${f.name}`;
    const prev = counts.get(key);
    if (prev) prev.count += 1;
    else counts.set(key, { rule: f.rule, severity: f.severity, tool: f.name, where: `engine:${r.engine}:${f.kind}`, count: 1 });
  }
  const findings = [...counts.values()].sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.tool < b.tool ? -1 : 1));
  const holdAt = ADMISSION_SCAN_ENGINES[expect.engine].holdAt;
  const holds = findings.some((f) => severityAtLeast(f.severity, holdAt));
  return { verdict: holds ? "fail" : "pass", findings, reason: holds ? `the engine found something at or above ${holdAt}` : "no finding at or above the hold line", rulesSha256: r.rulesSha256 };
}

export interface EngineAdmissionInput {
  /** the engine row's `enabled` (ADR-0187 decision 3: off by default, enabled by an admin after its self-test) */
  engineEnabled: boolean;
  /** the latest recorded scan of this subject AT ITS CURRENT DIGEST, or null when there is none */
  scan: { verdict: AdmissionScanVerdict; findings: readonly McpAdmissionFinding[] } | null;
}

export interface EngineAdmissionOutcome {
  holds: boolean;
  /** `off`: the engine has no say; `pending`: on, but no scan of this digest yet; then the scan's verdict */
  status: "off" | "pending" | AdmissionScanVerdict;
  findings: readonly McpAdmissionFinding[];
}

/** the gate's question, fail closed: with the engine on, only a `pass` for the current digest admits */
export function engineAdmissionHold(input: EngineAdmissionInput): EngineAdmissionOutcome {
  if (!input.engineEnabled) return { holds: false, status: "off", findings: [] };
  if (!input.scan) return { holds: true, status: "pending", findings: [] };
  return { holds: input.scan.verdict !== "pass", status: input.scan.verdict, findings: input.scan.verdict === "fail" ? input.scan.findings : [] };
}
