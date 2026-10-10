// ADR-0186 T — the checker for the hand-written OTLP ingest-shape fixtures in
// this directory. Test-only: it is plain JavaScript beside the fixtures (types
// in check-ingest-shape.d.mts) so both the pure test in packages/shared and the
// wire test in apps/gateway use ONE checker without either package exporting
// test code. Every violation is a sentence, so a failure says what broke.
import { readFileSync } from "node:fs";

/** @param {"langfuse" | "phoenix"} name */
export function loadIngestFixture(name) {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8"));
}

const attrMap = (attrs) => new Map((attrs ?? []).map((a) => [a.key, a.value]));
const scalar = (v) => (v ? Object.values(v)[0] : undefined);

function hasType(v, t) {
  if (!(t in v)) return false;
  const x = v[t];
  if (t === "intValue") return typeof x === "string" && /^-?[0-9]+$/.test(x);
  if (t === "doubleValue") return typeof x === "number";
  if (t === "stringValue") return typeof x === "string";
  if (t === "boolValue") return typeof x === "boolean";
  return typeof x === "object" && x !== null;
}

/**
 * Check a parsed OTLP/HTTP JSON ExportTraceServiceRequest against one fixture
 * and one export profile. Returns the violations (empty = satisfies).
 */
export function checkIngestShape(body, fx, profile, opts) {
  const out = [];
  const rules = fx.profiles[profile];
  if (!rules) return [`${fx.tool}: the fixture has no rules for profile ${profile}`];
  const rs = body["resourceSpans"];
  if (!Array.isArray(rs) || rs.length === 0) return ["resourceSpans missing or empty"];
  const seenKinds = new Set();
  for (const r of rs) {
    const res = attrMap(r["resource"]?.attributes);
    for (const k of rules.resourceAttributes?.keys ?? []) if (!res.has(k)) out.push(`resource: missing ${k}`);
    const scopes = r["scopeSpans"];
    if (!Array.isArray(scopes) || scopes.length === 0) {
      out.push("scopeSpans missing or empty");
      continue;
    }
    for (const sc of scopes) {
      for (const s of sc["spans"] ?? []) {
        const a = attrMap(s.attributes);
        const ours = String(scalar(a.get("regulait.span.kind")) ?? "?");
        const where = `span '${String(s["name"])}' (${ours})`;
        seenKinds.add(ours);
        for (const [field, pattern] of Object.entries(fx.span.required)) {
          const v = s[field];
          if (typeof v !== "string" || !new RegExp(pattern).test(v)) {
            out.push(`${where}: ${field} = ${JSON.stringify(v)} does not match ${pattern}`);
          }
        }
        if (typeof s["kind"] !== "number" || !Number.isInteger(s["kind"]) || s["kind"] < 0 || s["kind"] > 5) {
          out.push(`${where}: kind = ${JSON.stringify(s["kind"])} is not an OTLP SpanKind`);
        }
        for (const key of a.keys()) {
          const bad = (fx.forbiddenKeySegments?.segments ?? []).find((seg) => key.split(".").includes(seg));
          if (bad) out.push(`${where}: key ${key} has the reserved segment ${bad}`);
        }
        for (const k of rules.everySpan?.allOf ?? []) if (!a.has(k)) out.push(`${where}: missing ${k}`);
        const kindRules = rules.byKind?.[ours];
        const enums = { ...(rules.everySpan?.enums ?? {}), ...(kindRules?.enums ?? {}) };
        for (const [k, allowed] of Object.entries(enums)) {
          const v = scalar(a.get(k));
          if (v !== undefined && !allowed.includes(String(v))) out.push(`${where}: ${k} = ${String(v)} not in ${allowed.join("|")}`);
          if (v === undefined && kindRules?.enums?.[k]) out.push(`${where}: missing ${k}`);
        }
        if (opts.sessionTrace) {
          for (const k of rules.everySpanOfASession?.keys ?? []) if (!a.has(k)) out.push(`${where}: missing ${k} (must be on every span)`);
        }
        if (!kindRules) continue;
        for (const k of kindRules.allOf ?? []) if (!a.has(k)) out.push(`${where}: missing ${k}`);
        for (const group of kindRules.anyOf ?? []) if (!group.some((k) => a.has(k))) out.push(`${where}: none of ${group.join(", ")}`);
        if (opts.includeContent) {
          for (const group of kindRules.contentAnyOf ?? []) {
            if (!group.some((k) => a.has(k))) out.push(`${where}: content capture is on but none of ${group.join(", ")}`);
          }
        }
        for (const [k, t] of Object.entries(kindRules.valueTypes ?? {})) {
          const v = a.get(k);
          if (v && !hasType(v, t)) out.push(`${where}: ${k} should be ${t}, got ${JSON.stringify(v)}`);
        }
      }
    }
  }
  // the fixture must actually be exercised: every kind it has rules for is in the trace
  for (const k of opts.requireKinds ?? Object.keys(rules.byKind ?? {})) {
    if (!seenKinds.has(k)) out.push(`no ${k} span in the trace (fixture not exercised)`);
  }
  return out;
}
