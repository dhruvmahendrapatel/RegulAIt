/**
 * ADR-0055 — SHADOW-AI DISCOVERY, the pure half.
 *
 * WHAT THIS DEPLOYMENT CAN AND CANNOT DO — READ THIS FIRST
 * -------------------------------------------------------
 * ADR-0055 describes three "signal collectors". RegulAIt SHIPS NO COLLECTOR.
 * It cannot: this control plane does not sit on a customer's network, does not
 * hold their DNS resolver, does not run on their laptops, and a governance
 * product that quietly started sniffing traffic would be the exact thing it
 * exists to prevent. What ships is the other 90% of the ADR — an IMPORTER and
 * an ANALYZER over evidence the CUSTOMER already has:
 *
 *   `egress_log`    rows exported from a forward proxy / firewall / DNS
 *                   resolver / SIEM: "host X talked to destination Y, N times".
 *   `code_scan`     rows produced by a repo scan (the customer's own CI, or a
 *                   future RegulAIt scanner over `packages/git-provider`):
 *                   "repo R, path P, imports package K" / "…carries a key
 *                   fragment F".
 *   `saas_export`   rows from a SaaS admin console export: "app A from vendor
 *                   host V is installed / OAuth-granted".
 *   `self_reported` rows a human typed: "team T uses provider P for system S".
 *
 * That distinction is not a hedge, it is the design. Everything below is a pure
 * function of rows-in → findings-out, so the coverage claim a customer gets is
 * exactly "what you fed us", never "what exists".
 *
 * THE FOUR PROPERTIES THIS MODULE EXISTS TO GUARANTEE
 * --------------------------------------------------
 *  1. EVIDENCE IS UNTRUSTED INPUT. Every row schema is `.strict()`, every
 *     string is length-bounded, the batch is row-bounded and byte-bounded, and
 *     a pre-parse screen refuses any payload carrying a GOVERNED-OBJECT or
 *     PRIVILEGE word at any depth. An evidence file is a description of the
 *     world; it is never an instruction to the platform.
 *
 *  2. AN IMPORT CANNOT MINT GOVERNANCE. There is no field in any row schema
 *     that names a role, a grant, an entitlement, an agent to create, or an
 *     approval to open. `replacementAgentId` on a FINDING is resolved from the
 *     admin-maintained CATALOGUE, never from the file. The strongest thing an
 *     import can do is write a row into `shadow_ai_findings` that says "look at
 *     this" — which is a lead for a human, not a decision.
 *
 *  3. THE CATALOGUE IS DATA. Detection for a new provider is a catalogue row
 *     (`POST /v1/shadow-ai/catalogue`), never a deploy. `DEFAULT_AI_SIGNATURES`
 *     below is a SEED an admin can install and then edit or delete — it is not
 *     the matcher. The matcher (`classifyObservation`) has no provider name in
 *     it at all; delete every catalogue row and it matches nothing.
 *
 *  4. NO REGEX FROM DATA. An admin-editable regular expression evaluated
 *     against imported strings is a ReDoS primitive with an admin-shaped
 *     trigger. Key detection is therefore modelled as PREFIX + MINIMUM LENGTH
 *     (`sk-` + 40) rather than a pattern, and host detection as exact-or-
 *     dot-boundary-suffix. Both are linear and neither can be made to backtrack.
 *
 * WHAT WE STORE OF A LEAKED KEY
 * -----------------------------
 * At most `KEY_FRAGMENT_MAX` characters, and the analyzer redacts to
 * `KEY_FRAGMENT_KEPT` before a finding is written. The MATCH is driven by the
 * observed key's LENGTH (`keyLength`, an integer the scanner reports) and its
 * prefix — so evidence can be pre-redacted by the customer and still classify
 * correctly. A finding is a pointer to a secret, never a copy of one.
 */
import { z } from "zod";

// ===========================================================================
// 1. BOUNDS — the untrusted-input envelope
// ===========================================================================

/** rows in one import. A proxy log has millions; a customer chunks it. */
export const EVIDENCE_MAX_ROWS = 5_000;
/** raw request bytes accepted on the import route before anything is parsed */
export const EVIDENCE_MAX_BYTES = 2_000_000;
/** longest key fragment an evidence row may carry at all */
export const KEY_FRAGMENT_MAX = 12;
/** how much of it survives into a stored finding */
export const KEY_FRAGMENT_KEPT = 8;
/** DNS names are 253 octets; anything longer is not a hostname */
export const HOST_MAX = 253;

// ===========================================================================
// 2. THE ESCALATION SCREEN — run on the RAW payload, before parsing
// ===========================================================================

/**
 * Words that have no business in a description of observed traffic. The strict
 * row schemas below already have nowhere to put them — this screen exists so
 * the refusal is SPECIFIC and AUDITED ("row 3 tried to set `grants`") instead
 * of a generic schema error, and so a future widening of a row schema cannot
 * silently open a door. Mirrors `screenForEscalation` in onboarding.ts, whose
 * reasoning applies verbatim.
 */
export const SHADOW_AI_FORBIDDEN_KEYS = [
  "isadmin",
  "admin",
  "superuser",
  "grants",
  "grant",
  "permissions",
  "entitlements",
  "roleid",
  "role",
  "roles",
  "agentid",
  "approve",
  "approved",
  "approveruserid",
  "userid",
  "apikey",
  "secret",
  "token",
  "password",
  "governed",
  "disposition",
  "severity",
] as const;

export interface EvidenceScreenFinding {
  path: string;
  key: string;
}

const normalizeKey = (k: string) => k.replace(/[_\-\s]/g, "").toLowerCase();

/**
 * Walk the parsed-but-not-validated payload for forbidden keys at any depth.
 * Depth-bounded (12) so a hostile deeply-nested document cannot blow the stack
 * before the schema ever sees it.
 */
export function screenEvidencePayload(payload: unknown, basePath = ""): EvidenceScreenFinding[] {
  const found: EvidenceScreenFinding[] = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const child = path ? `${path}.${k}` : k;
      if ((SHADOW_AI_FORBIDDEN_KEYS as readonly string[]).includes(normalizeKey(k))) {
        found.push({ path: child, key: k });
      }
      walk(v, child, depth + 1);
    }
  };
  walk(payload, basePath, 0);
  return found;
}

// ===========================================================================
// 3. THE CATALOGUE — data, not code
// ===========================================================================

export const AI_SIGNATURE_KINDS = ["hostname", "sdk_package", "api_key_prefix", "web_app"] as const;
export type AiSignatureKind = (typeof AI_SIGNATURE_KINDS)[number];

export const AI_MATCH_TYPES = ["exact_host", "host_suffix", "package", "key_prefix"] as const;
export type AiMatchType = (typeof AI_MATCH_TYPES)[number];

export interface AiSignature {
  provider: string;
  kind: AiSignatureKind;
  /** the host / package name / key prefix. Never a regular expression. */
  value: string;
  matchType: AiMatchType;
  /** `key_prefix` only: the minimum length of the FULL observed key */
  minLength?: number | null;
  /** the governed thing that would REPLACE this usage (an agent in the registry) */
  replacementAgentId?: string | null;
  /** free-text: how this row would be replaced if no agent is registered yet */
  replacementNote?: string | null;
  /** where the row came from — "regulait-seed", "admin", a vendor advisory URL */
  provenance: string;
  lastUpdatedAt?: string | Date | null;
  enabled: boolean;
}

export const catalogueSignatureSchema = z
  .object({
    provider: z.string().min(1).max(100),
    kind: z.enum(AI_SIGNATURE_KINDS),
    value: z.string().min(1).max(HOST_MAX),
    matchType: z.enum(AI_MATCH_TYPES),
    minLength: z.number().int().min(1).max(512).nullish(),
    replacementAgentId: z.string().uuid().nullish(),
    replacementNote: z.string().max(500).nullish(),
    provenance: z.string().min(1).max(300).default("admin"),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((s) => s.kind !== "api_key_prefix" || typeof s.minLength === "number", {
    message:
      "an api_key_prefix signature needs a minLength — a bare prefix with no length bound would match every string that happens to start with it",
  })
  .refine(
    (s) =>
      (s.kind === "sdk_package") === (s.matchType === "package") &&
      (s.kind === "api_key_prefix") === (s.matchType === "key_prefix"),
    { message: "matchType must agree with kind (sdk_package↔package, api_key_prefix↔key_prefix)" },
  );

export type CatalogueSignatureInput = z.infer<typeof catalogueSignatureSchema>;

/**
 * THE SEED. Shipped so a fresh deployment is not blank, explicitly NOT the
 * matcher: it is installed by `POST /v1/shadow-ai/catalogue/seed`, and every
 * row is thereafter editable and deletable like any admin-authored row.
 *
 * `lastUpdatedAt`/`provenance` are on every row precisely because this list
 * ROTS — ADR-0055 says so plainly. A customer can see the freshness of their
 * detection surface and add their own in-house endpoint without waiting for us.
 */
export const DEFAULT_AI_SIGNATURES: ReadonlyArray<Omit<AiSignature, "lastUpdatedAt">> = Object.freeze([
  // --- hostnames (egress / DNS / proxy evidence) ---------------------------
  { provider: "openai", kind: "hostname", value: "api.openai.com", matchType: "exact_host", provenance: "regulait-seed", enabled: true },
  { provider: "anthropic", kind: "hostname", value: "api.anthropic.com", matchType: "exact_host", provenance: "regulait-seed", enabled: true },
  { provider: "google", kind: "hostname", value: "generativelanguage.googleapis.com", matchType: "exact_host", provenance: "regulait-seed", enabled: true },
  { provider: "mistral", kind: "hostname", value: "api.mistral.ai", matchType: "exact_host", provenance: "regulait-seed", enabled: true },
  { provider: "cohere", kind: "hostname", value: "api.cohere.ai", matchType: "exact_host", provenance: "regulait-seed", enabled: true },
  { provider: "azure-openai", kind: "hostname", value: "openai.azure.com", matchType: "host_suffix", provenance: "regulait-seed", enabled: true },
  { provider: "aws-bedrock", kind: "hostname", value: "bedrock-runtime.amazonaws.com", matchType: "host_suffix", provenance: "regulait-seed", enabled: true },
  // --- consumer web apps (SaaS-export / browser evidence) ------------------
  { provider: "openai", kind: "web_app", value: "chat.openai.com", matchType: "exact_host", provenance: "regulait-seed", enabled: true },
  { provider: "anthropic", kind: "web_app", value: "claude.ai", matchType: "exact_host", provenance: "regulait-seed", enabled: true },
  // --- SDK packages (code-scan evidence) -----------------------------------
  { provider: "openai", kind: "sdk_package", value: "openai", matchType: "package", provenance: "regulait-seed", enabled: true },
  { provider: "anthropic", kind: "sdk_package", value: "@anthropic-ai/sdk", matchType: "package", provenance: "regulait-seed", enabled: true },
  { provider: "anthropic", kind: "sdk_package", value: "anthropic", matchType: "package", provenance: "regulait-seed", enabled: true },
  { provider: "google", kind: "sdk_package", value: "google-generativeai", matchType: "package", provenance: "regulait-seed", enabled: true },
  { provider: "mistral", kind: "sdk_package", value: "mistralai", matchType: "package", provenance: "regulait-seed", enabled: true },
  { provider: "cohere", kind: "sdk_package", value: "cohere", matchType: "package", provenance: "regulait-seed", enabled: true },
  { provider: "ollama", kind: "sdk_package", value: "ollama", matchType: "package", provenance: "regulait-seed", enabled: true },
  // --- key prefixes (code-scan evidence; prefix + LENGTH, never a regex) ---
  { provider: "openai", kind: "api_key_prefix", value: "sk-", matchType: "key_prefix", minLength: 40, provenance: "regulait-seed", enabled: true },
  { provider: "anthropic", kind: "api_key_prefix", value: "sk-ant-", matchType: "key_prefix", minLength: 40, provenance: "regulait-seed", enabled: true },
  { provider: "google", kind: "api_key_prefix", value: "AIza", matchType: "key_prefix", minLength: 35, provenance: "regulait-seed", enabled: true },
]);

// ===========================================================================
// 4. EVIDENCE ROW SCHEMAS — strict, bounded, and privilege-free by shape
// ===========================================================================

export const EVIDENCE_KINDS = ["egress_log", "code_scan", "saas_export", "self_reported"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const isoish = z.string().min(4).max(40);

export const egressLogRowSchema = z
  .object({
    observedAt: isoish.optional(),
    /** the destination the client talked to. May arrive as a bare host or URL. */
    destinationHost: z.string().min(1).max(2048),
    /** who did it, AS THE CUSTOMER'S LOG NAMES THEM — an IP, a hostname, an
     * email. Deliberately opaque: it is never resolved to a RegulAIt user, and
     * a row that named one would still not confer anything on them. */
    sourceIdentity: z.string().max(200).nullish(),
    requestCount: z.number().int().min(1).max(1_000_000_000).nullish(),
  })
  .strict();

export const codeScanRowSchema = z
  .object({
    observedAt: isoish.optional(),
    repo: z.string().min(1).max(300),
    path: z.string().max(500).nullish(),
    packageName: z.string().max(200).nullish(),
    /** a REDACTED fragment. Longer than KEY_FRAGMENT_MAX is refused outright —
     * we will not accept a whole credential "for analysis". */
    keyFragment: z.string().max(KEY_FRAGMENT_MAX).nullish(),
    /** the FULL observed key's length, reported by the scanner. This is what
     * makes prefix+length matching work on pre-redacted evidence. */
    keyLength: z.number().int().min(1).max(512).nullish(),
  })
  .strict()
  .refine((r) => Boolean(r.packageName) || Boolean(r.keyFragment), {
    message: "a code_scan row must report a packageName or a keyFragment — a bare path observes nothing",
  });

export const saasExportRowSchema = z
  .object({
    observedAt: isoish.optional(),
    appName: z.string().min(1).max(200),
    vendorHost: z.string().min(1).max(2048),
    grantedBy: z.string().max(200).nullish(),
    installCount: z.number().int().min(1).max(1_000_000).nullish(),
  })
  .strict();

export const selfReportedRowSchema = z
  .object({
    observedAt: isoish.optional(),
    owner: z.string().min(1).max(200),
    system: z.string().min(1).max(300),
    /** the provider the human NAMES. Still classified against the catalogue —
     * a self-report of an unknown provider is an unmatched observation, not a
     * new catalogue entry. A file cannot extend detection. */
    provider: z.string().min(1).max(100),
    note: z.string().max(500).nullish(),
  })
  .strict();

export const evidenceImportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("egress_log"),
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    source: z.string().max(200).optional(),
    rows: z.array(egressLogRowSchema).min(1).max(EVIDENCE_MAX_ROWS),
  }).strict(),
  z.object({
    kind: z.literal("code_scan"),
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    source: z.string().max(200).optional(),
    rows: z.array(codeScanRowSchema).min(1).max(EVIDENCE_MAX_ROWS),
  }).strict(),
  z.object({
    kind: z.literal("saas_export"),
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    source: z.string().max(200).optional(),
    rows: z.array(saasExportRowSchema).min(1).max(EVIDENCE_MAX_ROWS),
  }).strict(),
  z.object({
    kind: z.literal("self_reported"),
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    source: z.string().max(200).optional(),
    rows: z.array(selfReportedRowSchema).min(1).max(EVIDENCE_MAX_ROWS),
  }).strict(),
]);

export type EvidenceImport = z.infer<typeof evidenceImportSchema>;

// ===========================================================================
// 5. NORMALIZATION + MATCHING — linear, and with no provider name in it
// ===========================================================================

/**
 * A proxy log's "destination" column is not a hostname: it may be a URL, may
 * carry a port, may be uppercase, may have a trailing root dot. Normalize to a
 * bare lowercase host or return null. Returning null is a NON-match, never a
 * throw — one malformed line in a five-thousand-line export must not fail the
 * whole import.
 */
export function normalizeEvidenceHost(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  // strip a :port that is not part of an IPv6 literal
  if (!s.startsWith("[") && /:\d+$/.test(s)) s = s.replace(/:\d+$/, "");
  s = s.replace(/\.$/, "").toLowerCase();
  if (!s || s.length > HOST_MAX) return null;
  // a host is dot-separated labels of letters/digits/hyphen (or an IP literal)
  if (!/^[a-z0-9.:_\-[\]]+$/.test(s)) return null;
  return s;
}

/**
 * Exact, or a DOT-BOUNDARY suffix. The boundary is the whole point:
 * `openai.com` must match `api.openai.com` and must NOT match
 * `notopenai.com`, and no signature may ever match `api.openai.com.evil.net`.
 */
export function hostMatchesSignature(host: string, sig: AiSignature): boolean {
  if (sig.kind !== "hostname" && sig.kind !== "web_app") return false;
  const h = normalizeEvidenceHost(host);
  if (!h) return false;
  const v = sig.value.trim().replace(/\.$/, "").toLowerCase();
  if (!v) return false;
  if (sig.matchType === "exact_host") return h === v;
  if (sig.matchType === "host_suffix") return h === v || h.endsWith(`.${v}`);
  return false;
}

/** Package names are compared whole. `openai-mock` is a different package. */
export function packageMatchesSignature(pkg: string, sig: AiSignature): boolean {
  if (sig.kind !== "sdk_package") return false;
  return pkg.trim().toLowerCase() === sig.value.trim().toLowerCase();
}

/**
 * Prefix AND length. Length is what separates a real credential from a test
 * fixture or a variable named `sk-example`: `sk-` alone matches thousands of
 * innocent strings, `sk-` + 40 characters matches a key.
 */
export function keyMatchesSignature(fragment: string, fullLength: number | null | undefined, sig: AiSignature): boolean {
  if (sig.kind !== "api_key_prefix") return false;
  const min = sig.minLength ?? 0;
  if (min <= 0) return false;
  const f = fragment.trim();
  const v = sig.value.trim();
  if (!f.startsWith(v)) return false;
  const observed = typeof fullLength === "number" ? fullLength : f.length;
  return observed >= min;
}

// ===========================================================================
// 6. OBSERVATIONS → CLASSIFICATION
// ===========================================================================

export type ShadowAiSubjectKind = "host" | "repo" | "saas_app" | "system";

export interface Observation {
  subjectKind: ShadowAiSubjectKind;
  /** the thing that would be REMEDIATED — the repo, the calling host, the app */
  subject: string;
  signalSource: EvidenceKind;
  observedAt: string;
  count: number;
  host?: string | null;
  packageName?: string | null;
  keyFragment?: string | null;
  keyLength?: number | null;
  declaredProvider?: string | null;
  detail?: Record<string, unknown>;
}

export const SHADOW_AI_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type ShadowAiSeverity = (typeof SHADOW_AI_SEVERITIES)[number];
const SEVERITY_RANK: Record<ShadowAiSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export const SHADOW_AI_CONFIDENCES = ["low", "medium", "high"] as const;
export type ShadowAiConfidence = (typeof SHADOW_AI_CONFIDENCES)[number];

export const SHADOW_AI_DISPOSITIONS = ["open", "confirmed", "sanctioned", "false_positive", "remediated"] as const;
export type ShadowAiDisposition = (typeof SHADOW_AI_DISPOSITIONS)[number];

export interface Classification {
  matched: boolean;
  provider: string | null;
  signatureKind: AiSignatureKind | null;
  matchedValue: string | null;
  severity: ShadowAiSeverity;
  replacementAgentId: string | null;
  replacementNote: string | null;
  reason: string;
}

const UNMATCHED: Classification = Object.freeze({
  matched: false,
  provider: null,
  signatureKind: null,
  matchedValue: null,
  severity: "low",
  replacementAgentId: null,
  replacementNote: null,
  reason: "no enabled catalogue signature matched this observation",
});

/**
 * SEVERITY IS DERIVED FROM WHAT THE SIGNAL IMPLIES (ADR-0055 §6), not from the
 * source that produced it:
 *
 *   critical  a catalogue-matched API KEY in source — simultaneously an
 *             ungoverned-usage signal and a live credential exposure.
 *   high      an observed CALL to a model endpoint (egress/DNS) — traffic
 *             actually left, ungoverned.
 *   medium    a consumer AI WEB APP, or a human-declared ungoverned system —
 *             real usage, but no evidence of an API integration to re-route.
 *   low       an SDK DEPENDENCY with no observed call. A capability, not an
 *             act. This tier is why the inventory is workable: a wall of
 *             `low` package hits never buries the one `critical`.
 */
export function classifyObservation(obs: Observation, catalogue: readonly AiSignature[]): Classification {
  const enabled = catalogue.filter((s) => s.enabled);
  const hit = (sig: AiSignature, severity: ShadowAiSeverity, matchedValue: string, reason: string): Classification => ({
    matched: true,
    provider: sig.provider,
    signatureKind: sig.kind,
    matchedValue,
    severity,
    replacementAgentId: sig.replacementAgentId ?? null,
    replacementNote: sig.replacementNote ?? null,
    reason,
  });

  // MOST SPECIFIC WINS. `sk-ant-` and `sk-` both match an Anthropic key, and
  // `openai.azure.com` and `azure.com` would both match a tenant host. Taking
  // the FIRST match would make the verdict depend on catalogue insert order —
  // the same evidence classified as a different provider depending on the order
  // rows happen to come back in. So the longest matching signature value wins,
  // deterministically, for both keys and hosts.
  const longest = (a: AiSignature, b: AiSignature) => (b.value.length - a.value.length);

  // 1. a leaked key outranks everything else this observation could say
  if (obs.keyFragment) {
    const fragment = obs.keyFragment;
    const keyHits = enabled.filter((sig) => keyMatchesSignature(fragment, obs.keyLength ?? null, sig)).sort(longest);
    const sig = keyHits[0];
    if (sig) {
      return hit(
        sig,
        "critical",
        sig.value,
        `a hard-coded credential matching the ${sig.provider} key signature (prefix '${sig.value}', >= ${sig.minLength} chars) was reported in ${obs.subject} — this is both ungoverned usage and a live credential exposure`,
      );
    }
  }

  // 2. an observed call to a model endpoint
  if (obs.host) {
    const host = obs.host;
    // an EXACT host signature is more specific than any suffix, whatever their
    // string lengths
    const hostHits = enabled
      .filter((sig) => sig.kind === "hostname" && hostMatchesSignature(host, sig))
      .sort((a, b) => Number(b.matchType === "exact_host") - Number(a.matchType === "exact_host") || longest(a, b));
    const hostSig = hostHits[0];
    if (hostSig) {
      return hit(
        hostSig,
        "high",
        hostSig.value,
        `${obs.subject} was observed reaching ${normalizeEvidenceHost(host)}, which matches the ${hostSig.provider} API endpoint signature — model traffic left without passing the gateway`,
      );
    }
    const appHits = enabled
      .filter((sig) => sig.kind === "web_app" && hostMatchesSignature(host, sig))
      .sort((a, b) => Number(b.matchType === "exact_host") - Number(a.matchType === "exact_host") || longest(a, b));
    const appSig = appHits[0];
    if (appSig) {
      return hit(
        appSig,
        "medium",
        appSig.value,
        `${obs.subject} was observed reaching the ${appSig.provider} consumer AI web app (${normalizeEvidenceHost(host)}) — usage outside any API we can re-route`,
      );
    }
  }

  // 3. a capability, not an act
  if (obs.packageName) {
    for (const sig of enabled) {
      if (packageMatchesSignature(obs.packageName, sig)) {
        return hit(
          sig,
          "low",
          sig.value,
          `${obs.subject} depends on '${obs.packageName}', the ${sig.provider} SDK — a capability to call a model outside the gateway, not evidence that it did`,
        );
      }
    }
  }

  // 4. a human said so. Still catalogue-checked: the declared provider must be
  //    one the catalogue KNOWS, or the row is an unmatched observation. A file
  //    cannot introduce a provider.
  if (obs.declaredProvider) {
    const declared = obs.declaredProvider.trim().toLowerCase();
    const sig = enabled.find((s) => s.provider.toLowerCase() === declared);
    if (sig) {
      return hit(
        sig,
        "medium",
        sig.provider,
        `${obs.subject} was self-reported as using ${sig.provider} outside RegulAIt`,
      );
    }
  }

  return UNMATCHED;
}

// ===========================================================================
// 7. CORRELATION — one real usage, however many signals saw it
// ===========================================================================

export interface CorrelatedFinding {
  subjectKind: ShadowAiSubjectKind;
  subject: string;
  provider: string;
  signalSources: EvidenceKind[];
  signatureKinds: AiSignatureKind[];
  firstSeenAt: string;
  lastSeenAt: string;
  observationCount: number;
  severity: ShadowAiSeverity;
  confidence: ShadowAiConfidence;
  replacementAgentId: string | null;
  replacementNote: string | null;
  evidence: Array<{ source: EvidenceKind; matchedValue: string; reason: string; observedAt: string }>;
}

/**
 * CONFIDENCE IS CORROBORATION COUNT, and nothing else (ADR-0055 §6). Three
 * independent collectors saying the same thing is a different claim from one
 * saying it three times, so the same source repeated does not raise it — the
 * set of DISTINCT sources does.
 */
export function confidenceFor(distinctSources: number): ShadowAiConfidence {
  if (distinctSources >= 3) return "high";
  if (distinctSources === 2) return "medium";
  return "low";
}

/** The dedup key ADR-0055 §3 names: (system/repo/host, provider). */
export function correlationKey(subjectKind: ShadowAiSubjectKind, subject: string, provider: string): string {
  return `${subjectKind}|${subject.trim().toLowerCase()}|${provider.trim().toLowerCase()}`;
}

export function correlateObservations(
  pairs: ReadonlyArray<{ observation: Observation; classification: Classification }>,
): CorrelatedFinding[] {
  const byKey = new Map<string, CorrelatedFinding>();
  for (const { observation: o, classification: c } of pairs) {
    if (!c.matched || !c.provider) continue;
    const key = correlationKey(o.subjectKind, o.subject, c.provider);
    const at = o.observedAt;
    const existing = byKey.get(key);
    const evidenceItem = {
      source: o.signalSource,
      matchedValue: c.matchedValue ?? "",
      reason: c.reason,
      observedAt: at,
    };
    if (!existing) {
      byKey.set(key, {
        subjectKind: o.subjectKind,
        subject: o.subject,
        provider: c.provider,
        signalSources: [o.signalSource],
        signatureKinds: c.signatureKind ? [c.signatureKind] : [],
        firstSeenAt: at,
        lastSeenAt: at,
        observationCount: o.count,
        severity: c.severity,
        confidence: confidenceFor(1),
        replacementAgentId: c.replacementAgentId,
        replacementNote: c.replacementNote,
        // bounded: a finding is a lead, not a log store
        evidence: [evidenceItem],
      });
      continue;
    }
    if (!existing.signalSources.includes(o.signalSource)) existing.signalSources.push(o.signalSource);
    if (c.signatureKind && !existing.signatureKinds.includes(c.signatureKind)) {
      existing.signatureKinds.push(c.signatureKind);
    }
    if (at < existing.firstSeenAt) existing.firstSeenAt = at;
    if (at > existing.lastSeenAt) existing.lastSeenAt = at;
    existing.observationCount += o.count;
    if (SEVERITY_RANK[c.severity] > SEVERITY_RANK[existing.severity]) existing.severity = c.severity;
    existing.confidence = confidenceFor(existing.signalSources.length);
    // the first catalogue row that names a replacement wins; a later row that
    // names none must not erase it
    if (!existing.replacementAgentId && c.replacementAgentId) existing.replacementAgentId = c.replacementAgentId;
    if (!existing.replacementNote && c.replacementNote) existing.replacementNote = c.replacementNote;
    if (existing.evidence.length < 20) existing.evidence.push(evidenceItem);
  }
  return [...byKey.values()];
}

// ===========================================================================
// 8. ROWS → OBSERVATIONS
// ===========================================================================

/** Redact a key fragment down to what a finding is allowed to remember. */
export function redactKeyFragment(fragment: string): string {
  return fragment.slice(0, KEY_FRAGMENT_KEPT);
}

/**
 * Translate a validated import into observations. Pure and total: a row that
 * normalizes to nothing (an unparseable destination) is DROPPED with a count,
 * never thrown — a single bad line in a proxy export is not a reason to refuse
 * a customer's whole evidence file.
 */
export function observationsFromImport(
  imp: EvidenceImport,
  now: Date = new Date(),
): { observations: Observation[]; dropped: number } {
  const fallback = now.toISOString();
  const observations: Observation[] = [];
  let dropped = 0;

  if (imp.kind === "egress_log") {
    for (const r of imp.rows) {
      const host = normalizeEvidenceHost(r.destinationHost);
      if (!host) {
        dropped += 1;
        continue;
      }
      observations.push({
        subjectKind: "host",
        subject: (r.sourceIdentity ?? "unattributed").trim() || "unattributed",
        signalSource: "egress_log",
        observedAt: r.observedAt ?? fallback,
        count: r.requestCount ?? 1,
        host,
      });
    }
  } else if (imp.kind === "code_scan") {
    for (const r of imp.rows) {
      observations.push({
        subjectKind: "repo",
        subject: r.repo,
        signalSource: "code_scan",
        observedAt: r.observedAt ?? fallback,
        count: 1,
        packageName: r.packageName ?? null,
        keyFragment: r.keyFragment ? redactKeyFragment(r.keyFragment) : null,
        keyLength: r.keyLength ?? null,
        detail: r.path ? { path: r.path } : {},
      });
    }
  } else if (imp.kind === "saas_export") {
    for (const r of imp.rows) {
      const host = normalizeEvidenceHost(r.vendorHost);
      if (!host) {
        dropped += 1;
        continue;
      }
      observations.push({
        subjectKind: "saas_app",
        subject: r.appName,
        signalSource: "saas_export",
        observedAt: r.observedAt ?? fallback,
        count: r.installCount ?? 1,
        host,
        detail: r.grantedBy ? { grantedBy: r.grantedBy } : {},
      });
    }
  } else {
    for (const r of imp.rows) {
      observations.push({
        subjectKind: "system",
        subject: `${r.owner} / ${r.system}`,
        signalSource: "self_reported",
        observedAt: r.observedAt ?? fallback,
        count: 1,
        declaredProvider: r.provider,
        detail: r.note ? { note: r.note } : {},
      });
    }
  }
  return { observations, dropped };
}

/** The whole analysis, as one pure call. Import in, findings out. */
export function analyzeImport(
  imp: EvidenceImport,
  catalogue: readonly AiSignature[],
  now: Date = new Date(),
): {
  findings: CorrelatedFinding[];
  observed: number;
  matched: number;
  unmatched: number;
  dropped: number;
} {
  const { observations, dropped } = observationsFromImport(imp, now);
  const pairs = observations.map((observation) => ({
    observation,
    classification: classifyObservation(observation, catalogue),
  }));
  const matched = pairs.filter((p) => p.classification.matched).length;
  return {
    findings: correlateObservations(pairs),
    observed: observations.length,
    matched,
    unmatched: pairs.length - matched,
    dropped,
  };
}

// ===========================================================================
// 9. THE COVERAGE SCORECARD — a model, not a claim
// ===========================================================================

export interface CoverageInput {
  kind: EvidenceKind;
  imports: number;
  rows: number;
  lastImportedAt: string | null;
}

export interface CoverageScorecard {
  sources: Array<CoverageInput & { on: boolean; whatItSees: string; whatItMisses: string }>;
  sourcesOn: number;
  sourcesPossible: number;
  /** the sentence a customer is entitled to, instead of "complete visibility" */
  statement: string;
}

const SOURCE_NOTES: Record<EvidenceKind, { whatItSees: string; whatItMisses: string }> = {
  egress_log: {
    whatItSees: "that a host reached a model API, and roughly how often",
    whatItMisses: "prompt content (deliberately), and anything egressing through a channel you do not export to us",
  },
  code_scan: {
    whatItSees: "SDK dependencies and hard-coded key fragments in the repos you scanned",
    whatItMisses: "keys injected at runtime, secrets in a manager we never read, and every repo not scanned",
  },
  saas_export: {
    whatItSees: "AI apps installed or OAuth-granted in the SaaS tenants you exported",
    whatItMisses: "browser-only consumer usage, and any tenant not exported",
  },
  self_reported: {
    whatItSees: "exactly what a human chose to declare",
    whatItMisses: "everything nobody declared",
  },
};

export function coverageScorecard(inputs: readonly CoverageInput[]): CoverageScorecard {
  const byKind = new Map(inputs.map((i) => [i.kind, i]));
  const sources = EVIDENCE_KINDS.map((kind) => {
    const i = byKind.get(kind) ?? { kind, imports: 0, rows: 0, lastImportedAt: null };
    return { ...i, on: i.imports > 0, ...SOURCE_NOTES[kind] };
  });
  const sourcesOn = sources.filter((s) => s.on).length;
  return {
    sources,
    sourcesOn,
    sourcesPossible: EVIDENCE_KINDS.length,
    statement:
      `Discovery has analyzed ${sourcesOn} of ${EVIDENCE_KINDS.length} evidence classes. ` +
      `regulAIt ships no collector: every finding below derives from evidence you supplied, so this inventory ` +
      `reduces shadow AI — it does not prove its absence.`,
  };
}
