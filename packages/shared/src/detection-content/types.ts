/**
 * ADR-0186 V — the SHAPE of vendored detection content (foundation).
 *
 * The data itself lives in `./index.ts` (Codex's slice V fills it from
 * `vendor/{pipelock,nemo,agt}/` through `scripts/vendor/*.mjs`); the matching
 * semantics live in `./match.ts`; the consumers (`guardrails.ts`,
 * `audit-scrub.ts`, the gateway's `mcp-admission.ts`) call only `match.ts`.
 *
 * Every pattern is RE2 syntax and runs on `re2js` (linear time, no
 * backtracking): a rule that RE2 cannot compile is not imported (it is listed
 * in its pack's `notImported` with the reason), never run on the native engine.
 */
import type { McpAdmissionSeverity } from "../mcp-admission.js";
import type { VendoredDetectionPack } from "../batch4.js";

/** pipelock-secrets: one credential shape. Matches are REDACTED on the audit
 * path (marker `[redacted:<rule>:<len>:<fp>]`, ADR-0099) and counted (rule id
 * and count only) by the DLP detector. */
export interface VendoredSecretRule {
  /** stable id, e.g. `pipelock.secrets.aws_access_key` */
  id: string;
  pack: "pipelock-secrets";
  /** RE2 source */
  pattern: string;
  caseInsensitive?: boolean;
  /** Separate the provider delimiter check from the redacted token span. */
  leftBoundary?: "ascii_identifier";
  /** hosts this credential may legitimately be sent to (outbound enforcement,
   * slice V); absent/empty = no outbound exemption; the host-only seam does not
   * represent upstream carrier/path/cryptographic grants */
  audienceHosts?: readonly string[];
}

/** nemo-yara-injection: one YARA rule converted to data. Only `any of them`
 * (minMatches 1) and `N of them` conditions are imported. */
export interface VendoredInjectionRule {
  /** stable id, e.g. `nemo.yara.injection.<rule>` */
  id: string;
  pack: "nemo-yara-injection";
  /** the guardrail category a hit counts under (prompt_injection detector) */
  category: string;
  /** RE2 sources, one per YARA string */
  patterns: readonly string[];
  /** how many DISTINCT patterns must match for the rule to fire (YARA `N of them`) */
  minMatches: number;
  caseInsensitive?: boolean;
}

/** agt-mcp-heuristics: one admission heuristic over an MCP tool manifest */
export interface VendoredMcpHeuristic {
  /** stable id, e.g. `agt.mcp.<heuristic>` */
  id: string;
  pack: "agt-mcp-heuristics";
  severity: McpAdmissionSeverity;
  /** which scan units it reads: the tool's `name`, its `description`, or any
   * `inputSchema…` unit (property descriptions and titles) */
  where: readonly ("name" | "description" | "inputSchema")[];
  /** RE2 source */
  pattern: string;
  caseInsensitive?: boolean;
}

/** one pack's provenance, as `GET /v1/detection-content` reports it */
export interface VendoredPackManifest {
  id: VendoredDetectionPack;
  /** upstream project name */
  source: string;
  repo: string;
  commit: string;
  /** sha256 of the vendored file(s) as retrieved */
  sha256: string;
  /** SPDX licence id */
  licence: string;
  rules: number;
  notImported: ReadonlyArray<{ id: string; reason: string }>;
  retrievedAt: string;
}
