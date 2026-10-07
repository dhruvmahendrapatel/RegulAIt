/**
 * ADR-0186 V — VENDORED DETECTION CONTENT, the data (slice V, Codex).
 *
 * The foundation ships these EMPTY and `normaliseForInjection` as the
 * identity, so every consumer behaves exactly as before batch 4. Slice V fills
 * them from `vendor/{pipelock,nemo,agt}/` (PROVENANCE.json + upstream
 * LICENSE/NOTICE, nothing from `enterprise/` or `ee/`) through
 * `scripts/vendor/*.mjs`, and does not edit `guardrails.ts`, `audit-scrub.ts`
 * or the gateway's `mcp-admission.ts`, which call these only through
 * `./match.ts`.
 */
import type {
  VendoredInjectionRule,
  VendoredMcpHeuristic,
  VendoredPackManifest,
  VendoredSecretRule,
} from "./types.js";

export type {
  VendoredInjectionRule,
  VendoredMcpHeuristic,
  VendoredPackManifest,
  VendoredSecretRule,
} from "./types.js";

/** pipelock-secrets */
export const VENDORED_SECRET_RULES: readonly VendoredSecretRule[] = [];

/** nemo-yara-injection */
export const VENDORED_INJECTION_RULES: readonly VendoredInjectionRule[] = [];

/** agt-mcp-heuristics */
export const VENDORED_MCP_HEURISTICS: readonly VendoredMcpHeuristic[] = [];

/** one manifest per pack that has content (empty until slice V lands) */
export const VENDORED_PACK_MANIFESTS: readonly VendoredPackManifest[] = [];

/**
 * pipelock-normalise: the text the injection rules (built-in and vendored)
 * read. Must be TOTAL and LINEAR in the input length, and must never throw.
 * The foundation's version is the identity.
 */
export function normaliseForInjection(text: string): string {
  return text;
}
