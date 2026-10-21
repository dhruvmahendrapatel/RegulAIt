#!/usr/bin/env node
/**
 * ENG-IMG reproducible builds (ADR-0187 addendum 2026-10-21) — the three files an engine image build writes that are
 * not a function of its inputs alone, made so. Every other source of variation is handled by the build itself
 * (scripts/build-engine-image.sh: SOURCE_DATE_EPOCH, buildx `rewrite-timestamp=true`, a clean git-archive context, a
 * pinned BuildKit).
 *
 *   node scripts/engine-images-normalise.mjs lock <images-lock.ts>        the build context's generated lock module
 *   node scripts/engine-images-normalise.mjs modules-yaml <.modules.yaml>  inside the image build (pnpm deploy)
 *   node scripts/engine-images-normalise.mjs cyclonedx <sbom.cdx.json>     inside the promptfoo build (npm sbom)
 *
 * `lock`: packages/shared/src/engines/images-lock.ts is GENERATED from engines/images.lock.json, so every lock PR
 * changes it, and every engine image would embed the digests of the images published before it. No engine reads
 * them (the runner reports the digest compose gives it, REGULAIT_ENGINE_IMAGE_DIGEST; only the gateway admits by the
 * lock). Left in, a lock merge would change the next build's inputs and its digest, and the next lock, without end.
 * The build context therefore carries the all-null form `renderTs` writes before the first publish, and the publish
 * gate (engine-images-gate.mjs) does not count the file as an image input. The rewrite is strict: anything but the
 * exact 18 value lines of the generated shape fails the build.
 *
 * `modules-yaml`: pnpm writes node_modules/.modules.yaml with the time of the install (`prunedAt`) and the hoisted
 * packages in the order the concurrent install finished them. The keys are sorted and `prunedAt` is set from
 * SOURCE_DATE_EPOCH. Nothing at run time reads the file (there is no pnpm in the image).
 *
 * `cyclonedx`: `npm sbom` writes a random `serialNumber` and the current `metadata.timestamp`. The timestamp is set
 * from SOURCE_DATE_EPOCH and the serial number is derived from the document's own content (RFC 4122 layout, version
 * 5 bits), so one input set always yields one SBOM.
 *
 * Without SOURCE_DATE_EPOCH (a hand-run `docker build`), the times are left as written and only the ordering and the
 * serial number are fixed.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export class NormaliseError extends Error {}

const LOCK_VALUE = /^( {4})(repository|manifestDigest|imageId|sourceCommit|publishedAt|publishGeneration): (.*),$/;

/** the generated lock module with every recorded value replaced by its pre-publish value (null, generation 0) */
export function neutraliseLock(text) {
  let n = 0;
  const out = text.split("\n").map((line) => {
    const m = LOCK_VALUE.exec(line);
    if (!m) return line;
    const [, indent, key, value] = m;
    const ok = key === "publishGeneration" ? /^\d+$/.test(value) : value === "null" || /^"[^"\\]*"$/.test(value);
    if (!ok) throw new NormaliseError(`images-lock: unexpected value for ${key}: ${value}`);
    n += 1;
    return `${indent}${key}: ${key === "publishGeneration" ? "0" : "null"},`;
  });
  if (n !== 18) throw new NormaliseError(`images-lock: expected 18 value lines (3 engines x 6 fields), found ${n}; the generated shape changed`);
  const result = out.join("\n");
  if (/sha256:[0-9a-f]{64}|"[0-9a-f]{40}"/.test(result)) throw new NormaliseError("images-lock: a digest or commit is still present after the rewrite");
  return result;
}

function epochDate(epoch) {
  if (epoch === undefined || epoch === "") return undefined;
  if (!/^\d+$/.test(epoch)) throw new NormaliseError(`SOURCE_DATE_EPOCH must be whole seconds, not ${JSON.stringify(epoch)}`);
  return new Date(Number(epoch) * 1000);
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** pnpm's .modules.yaml (JSON) with sorted keys and `prunedAt` from the epoch */
export function normaliseModulesYaml(text, epoch) {
  const doc = sortKeys(JSON.parse(text));
  const at = epochDate(epoch);
  if (at && "prunedAt" in doc) doc.prunedAt = at.toUTCString();
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** a CycloneDX JSON document with its timestamp from the epoch and a content-derived serial number */
export function normaliseCycloneDx(text, epoch) {
  const doc = JSON.parse(text);
  const at = epochDate(epoch);
  if (at) {
    if (!doc.metadata || typeof doc.metadata !== "object") throw new NormaliseError("cyclonedx: the document has no metadata");
    doc.metadata.timestamp = at.toISOString();
  }
  // the serial number is hashed out of the content, then written back in its own place (key order is kept)
  const { serialNumber: _random, ...content } = doc;
  const h = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  doc.serialNumber = `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const MODES = { lock: (t) => neutraliseLock(t), "modules-yaml": normaliseModulesYaml, cyclonedx: normaliseCycloneDx };

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [mode, file] = process.argv.slice(2);
  try {
    if (!MODES[mode] || !file) throw new NormaliseError("usage: engine-images-normalise.mjs lock|modules-yaml|cyclonedx <file>");
    writeFileSync(file, MODES[mode](readFileSync(file, "utf8"), process.env.SOURCE_DATE_EPOCH));
    console.log(`engine-images-normalise: ${mode} ${file}`);
  } catch (e) {
    console.error(`engine-images-normalise: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
