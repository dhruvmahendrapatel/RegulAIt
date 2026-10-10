#!/usr/bin/env node
/**
 * ADR-0187 B5-G (decision 142) — read garak's OWN probe metadata out of the pinned release, so the
 * shared catalogue's detector and OWASP-tag columns are GENERATED from upstream and cannot drift.
 *
 * Input: the wheel's `garak/resources/plugin_cache.json` (plain JSON data shipped in the wheel; it
 * is read, nothing is executed). For every probe it keeps the class name, `active`, the
 * `primary_detector` (the only detector garak runs when `extended_detectors` is false, which our
 * config always sets) and the `owasp:llmNN` tags (garak's 2023 OWASP numbering, R10).
 * A probe entry without the expected fields is an error (exit 1): a release that changes the shape
 * fails loudly.
 *
 * Usage:
 *   node extract-probe-metadata.mjs <path to plugin_cache.json> --ts   > packages/shared/src/engines/garak-upstream.ts
 *   node extract-probe-metadata.mjs <path to plugin_cache.json> --json (what the opt-in drift test compares)
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [file, mode] = process.argv.slice(2);
if (!file || (mode !== "--ts" && mode !== "--json")) {
  console.error("usage: extract-probe-metadata.mjs <plugin_cache.json> --ts|--json");
  process.exit(2);
}
const raw = readFileSync(file);
const sha256 = createHash("sha256").update(raw).digest("hex");
const cache = JSON.parse(raw.toString("utf8"));
if (!cache || typeof cache.probes !== "object") {
  console.error("plugin_cache.json has no probes object");
  process.exit(1);
}

const probes = [];
for (const [key, meta] of Object.entries(cache.probes)) {
  if (!key.startsWith("probes.")) {
    console.error(`unexpected probe key ${key}`);
    process.exit(1);
  }
  const name = key.slice("probes.".length);
  if (name.startsWith("base.")) continue; // abstract base classes, never runnable
  if (typeof meta.active !== "boolean" || !Array.isArray(meta.tags) || !("primary_detector" in meta)) {
    console.error(`probe ${name} lacks active/tags/primary_detector`);
    process.exit(1);
  }
  const detector = meta.primary_detector === null ? null : String(meta.primary_detector);
  const owasp = meta.tags.filter((t) => typeof t === "string" && /^owasp:llm\d\d$/.test(t)).sort();
  probes.push({ probe: name, active: meta.active, detector, owasp });
}
probes.sort((a, b) => (a.probe < b.probe ? -1 : a.probe > b.probe ? 1 : 0));

const version = process.env.GARAK_VERSION ?? "0.17.0";
if (mode === "--json") {
  process.stdout.write(JSON.stringify({ version, sha256, probes }, null, 2) + "\n");
} else {
  const lines = [];
  lines.push("/**");
  lines.push(" * GENERATED — do not edit. ADR-0187 B5-G decision 142: garak's own probe metadata, read from the");
  lines.push(" * pinned release's `garak/resources/plugin_cache.json` by engines/garak/extract-probe-metadata.mjs");
  lines.push(" * (read as data, nothing executed).");
  lines.push(" *");
  lines.push(` * Package:  PyPI \`garak==${version}\` (wheel sha256 9a67e6298e4d7025358fecafa9d473c77ff70acdae103aa5251ad60fca3db145)`);
  lines.push(" * Source:   garak/resources/plugin_cache.json");
  lines.push(` * sha256:   ${sha256}`);
  lines.push(" *");
  lines.push(" * `detector` is the probe's primary detector: the only one garak runs with `extended_detectors: false`,");
  lines.push(" * which the runner always sets. `owasp` are garak's own tags, in the 2023 OWASP LLM Top 10 numbering");
  lines.push(" * (R10): upstream data only, never read to map a probe. The 2025 mapping is our own per-probe table,");
  lines.push(" * garak-owasp-2025.ts (ADR-0187 decision 213). To update: pin a new release, re-run the extractor,");
  lines.push(" * re-read R10, and re-review every row of that table (its test fails until you do).");
  lines.push(" */");
  lines.push(`export const GARAK_UPSTREAM_VERSION = ${JSON.stringify(version)};`);
  lines.push(`export const GARAK_UPSTREAM_SOURCE_SHA256 = ${JSON.stringify(sha256)};`);
  lines.push("");
  lines.push("export interface GarakUpstreamProbe {");
  lines.push("  /** `module.Class`, as garak names it in its report */");
  lines.push("  probe: string;");
  lines.push("  active: boolean;");
  lines.push("  /** the primary detector, `module.Class`, or null when the probe names none */");
  lines.push("  detector: string | null;");
  lines.push("  /** garak's `owasp:llmNN` tags (2023 numbering) */");
  lines.push("  owasp: readonly string[];");
  lines.push("}");
  lines.push("");
  lines.push("export const GARAK_UPSTREAM_PROBES: readonly GarakUpstreamProbe[] = Object.freeze([");
  for (const p of probes) {
    lines.push(`  { probe: ${JSON.stringify(p.probe)}, active: ${p.active}, detector: ${JSON.stringify(p.detector)}, owasp: ${JSON.stringify(p.owasp)} },`);
  }
  lines.push("]);");
  process.stdout.write(lines.join("\n") + "\n");
}
