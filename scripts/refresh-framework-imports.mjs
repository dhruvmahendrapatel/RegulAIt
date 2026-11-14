#!/usr/bin/env node
/**
 * ADR-0215 — refresh the vendored framework-import and regulatory-feed snapshots.
 *
 * A DEVELOPER tool. The product never downloads: it reads the snapshots this
 * script writes to `packages/shared/src/framework-imports-data/`. Run it, read
 * the diff, commit it. An admin then reviews and accepts the new content in the
 * product, where an import never overwrites a control they edited.
 *
 *   node scripts/refresh-framework-imports.mjs                 # download the pinned upstream revisions
 *   node scripts/refresh-framework-imports.mjs --from <dir>    # air-gapped: normalise files already on disk
 *   node scripts/refresh-framework-imports.mjs --only mitre-atlas
 *
 * `--from <dir>` reads `<dir>/<file>` for each source (the basename in the table
 * below), so a refresh can run with no network. Requires `pnpm -r build` first
 * (the normalisers are the compiled `@regulait/shared` ones the product uses).
 *
 * To move to a newer upstream release, change the pinned `revision` (and the
 * path, if the release renamed it) below, run this, and review the diff.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "packages/shared/src/framework-imports-data");
const fi = await import(path.join(root, "packages/shared/dist/framework-imports.js"));

const today = new Date().toISOString().slice(0, 10);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** pinned upstream sources. Licences were checked by hand against the upstream LICENSE file. */
const PACK_SOURCES = [
  {
    sourceId: "mitre-atlas",
    framework: "mitre-atlas",
    title: "MITRE ATLAS mitigations",
    publisher: "The MITRE Corporation",
    licence: "Apache-2.0",
    licenceUrl: "https://github.com/mitre-atlas/atlas-data/blob/main/LICENSE",
    repo: "mitre-atlas/atlas-data",
    revision: "f56c1468731d6428e5bf875263b4643b46d67437",
    file: "dist/v6/ATLAS-2026.10.yaml",
    parse: (bytes) => yaml.load(bytes.toString("utf8"), { schema: yaml.JSON_SCHEMA }),
    version: (doc) => String(doc.collection?.version ?? "unknown"),
    normalise: (doc, s) => fi.normaliseAtlasRelease(doc, { framework: s.framework, licence: s.licence }),
  },
  {
    // ADR-0293: the same pinned release, read for its tactics and techniques
    sourceId: "mitre-atlas-techniques",
    framework: "mitre-atlas-techniques",
    title: "MITRE ATLAS tactics and techniques",
    publisher: "The MITRE Corporation",
    licence: "Apache-2.0",
    licenceUrl: "https://github.com/mitre-atlas/atlas-data/blob/main/LICENSE",
    repo: "mitre-atlas/atlas-data",
    revision: "f56c1468731d6428e5bf875263b4643b46d67437",
    file: "dist/v6/ATLAS-2026.10.yaml",
    parse: (bytes) => yaml.load(bytes.toString("utf8"), { schema: yaml.JSON_SCHEMA }),
    version: (doc) => String(doc.collection?.version ?? "unknown"),
    normalise: (doc, s) => fi.normaliseAtlasTechniques(doc, { framework: s.framework, licence: s.licence }),
  },
  {
    sourceId: "nist-ai-rmf-oscal",
    framework: "nist-ai-rmf",
    title: "NIST AI RMF 1.0 (AI 100-1) subcategories",
    publisher: "National Institute of Standards and Technology",
    licence: "US-Gov-Public-Domain",
    licenceUrl: "https://github.com/usnistgov/oscal-content/blob/main/LICENSE.md",
    repo: "usnistgov/oscal-content",
    revision: "f0de6d8d8c059d374f15e0ae07508d82e370fc1d",
    file: "nist.gov/AI100-1/ver1/json/NIST_AI-RMF_v1_catalog.json",
    parse: (bytes) => JSON.parse(bytes.toString("utf8")),
    version: (doc) => String(doc.catalog?.metadata?.version ?? "unknown"),
    // ADR-0294: the Playbook's suggested actions become each subcategory's description
    supplements: [
      {
        title: "NIST AI RMF Playbook (suggested actions)",
        publisher: "National Institute of Standards and Technology",
        licence: "US-Gov-Public-Domain",
        licenceUrl: "https://www.nist.gov/oism/copyrights",
        url: "https://airc.nist.gov/docs/playbook.json",
        file: "playbook.json",
        // the AIRC serves no revision id: pin the bytes, and record the server's last-modified date
        revision: "AIRC playbook.json, last modified 2026-06-11",
        sha256: "aecbee3d3c8820816d295b11d10fb61324b17c25c2ff39ee95e2aa5654555bba",
      },
    ],
    normalise: (doc, s, supp) =>
      fi.withPlaybookActions(
        fi.normaliseOscalCatalog(doc, { framework: s.framework, classes: ["subcategory"], licence: s.licence }),
        JSON.parse(supp[0].toString("utf8")),
        { framework: s.framework },
      ),
  },
  {
    sourceId: "nist-csf-2-oscal",
    framework: "nist-csf-2",
    title: "NIST Cybersecurity Framework 2.0 subcategories",
    publisher: "National Institute of Standards and Technology",
    licence: "US-Gov-Public-Domain",
    licenceUrl: "https://github.com/usnistgov/oscal-content/blob/main/LICENSE.md",
    repo: "usnistgov/oscal-content",
    revision: "f0de6d8d8c059d374f15e0ae07508d82e370fc1d",
    file: "nist.gov/CSF/v2.0/json/NIST_CSF_v2.0_catalog.json",
    parse: (bytes) => JSON.parse(bytes.toString("utf8")),
    version: (doc) => String(doc.catalog?.metadata?.version ?? "unknown"),
    normalise: (doc, s) =>
      fi.normaliseOscalCatalog(doc, { framework: s.framework, classes: ["subcategory"], licence: s.licence }),
  },
  {
    // ADR-0294: NIST publishes AI 600-1 only as a PDF; poppler's `pdftotext -raw` (a developer
    // tool, never a product dependency) gives the text the pure normaliser reads
    sourceId: "nist-ai-600-1",
    framework: "nist-ai-600-1",
    title: "NIST AI 600-1 Generative AI Profile — suggested actions",
    publisher: "National Institute of Standards and Technology",
    licence: "US-Gov-Public-Domain",
    licenceUrl: "https://www.nist.gov/oism/copyrights",
    url: "https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf",
    file: "NIST.AI.600-1.pdf",
    revision: "NIST.AI.600-1 (July 2024), PDF last modified 2025-03-24",
    sha256: "6e73620ab6b64e90ef2c04bf0e0d6246185a2f4b1b13cab0df494496cff89b6a",
    parse: (bytes) => {
      const dir = mkdtempSync(path.join(tmpdir(), "ai600-"));
      try {
        writeFileSync(path.join(dir, "in.pdf"), bytes);
        execFileSync("pdftotext", ["-raw", "-enc", "UTF-8", path.join(dir, "in.pdf"), path.join(dir, "out.txt")]);
        return readFileSync(path.join(dir, "out.txt"), "utf8");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    version: () => "July 2024",
    normalise: (text, s) => fi.normaliseNistAi600Text(text, { framework: s.framework, licence: s.licence }),
  },
];

/** the Federal Register API: US federal government work, public domain */
const FEED_SOURCES = [
  {
    sourceId: "us-federal-register-ai",
    title: "US Federal Register — AI rules, proposed rules and presidential documents",
    publisher: "Office of the Federal Register (US National Archives)",
    licence: "US-Gov-Public-Domain",
    licenceUrl: "https://www.federalregister.gov/reader-aids/developer-resources/rest-api",
    file: "federal-register-ai.json",
    pages: 5,
    url: (page, since) => {
      const q = new URLSearchParams();
      q.set("per_page", "100");
      q.set("page", String(page));
      q.set("order", "newest");
      q.set("conditions[term]", '"artificial intelligence"');
      for (const t of ["RULE", "PRORULE", "PRESDOCU"]) q.append("conditions[type][]", t);
      q.set("conditions[publication_date][gte]", since);
      for (const f of ["document_number", "title", "type", "abstract", "publication_date", "effective_on", "html_url", "agencies"]) {
        q.append("fields[]", f);
      }
      return `https://www.federalregister.gov/api/v1/documents.json?${q}`;
    },
  },
];

const args = process.argv.slice(2);
const fromDir = args.includes("--from") ? path.resolve(args[args.indexOf("--from") + 1]) : null;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: "error" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const write = (name, value) => {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${path.relative(root, path.join(outDir, name))}`);
};

/** a download pinned by sha256 (a source with no revision in its URL): refused if the bytes moved */
async function pinnedBytes(url, file, expected) {
  const bytes = fromDir ? readFileSync(path.join(fromDir, file)) : await fetchBytes(url);
  if (sha256(bytes) !== expected) throw new Error(`${url}: sha256 ${sha256(bytes)} is not the pinned ${expected}; review and re-pin`);
  return bytes;
}

for (const s of PACK_SOURCES) {
  if (only && only !== s.sourceId) continue;
  const upstreamUrl = s.url ?? `https://raw.githubusercontent.com/${s.repo}/${s.revision}/${s.file}`;
  const bytes = s.sha256
    ? await pinnedBytes(upstreamUrl, s.file, s.sha256)
    : fromDir
      ? readFileSync(path.join(fromDir, path.basename(s.file)))
      : await fetchBytes(upstreamUrl);
  const supp = [];
  for (const x of s.supplements ?? []) supp.push(await pinnedBytes(x.url, x.file, x.sha256));
  const doc = s.parse(bytes);
  const snapshot = {
    schema: fi.FRAMEWORK_IMPORT_SCHEMA,
    source: {
      sourceId: s.sourceId,
      framework: s.framework,
      title: s.title,
      publisher: s.publisher,
      licence: s.licence,
      licenceUrl: s.licenceUrl,
      upstreamUrl,
      sourceVersion: s.version(doc),
      upstreamRevision: s.revision,
      upstreamSha256: sha256(bytes),
      retrievedOn: today,
      ...(s.supplements
        ? {
            supplements: s.supplements.map((x, i) => ({
              title: x.title,
              publisher: x.publisher,
              licence: x.licence,
              licenceUrl: x.licenceUrl,
              upstreamUrl: x.url,
              upstreamRevision: x.revision,
              upstreamSha256: sha256(supp[i]),
              retrievedOn: today,
            })),
          }
        : {}),
    },
    controls: s.normalise(doc, s, supp),
  };
  fi.frameworkImportSnapshotSchema.parse(snapshot);
  write(`${s.sourceId}.json`, snapshot);
}

for (const s of FEED_SOURCES) {
  if (only && only !== s.sourceId) continue;
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  let results = [];
  const raw = [];
  if (fromDir) {
    const bytes = readFileSync(path.join(fromDir, s.file));
    raw.push(bytes);
    results = JSON.parse(bytes.toString("utf8")).results ?? [];
  } else {
    for (let page = 1; page <= s.pages; page += 1) {
      const bytes = await fetchBytes(s.url(page, since));
      raw.push(bytes);
      const body = JSON.parse(bytes.toString("utf8"));
      results.push(...(body.results ?? []));
      if (!body.next_page_url) break;
    }
  }
  const snapshot = {
    schema: fi.REGULATORY_FEED_IMPORT_SCHEMA,
    source: {
      sourceId: s.sourceId,
      title: s.title,
      publisher: s.publisher,
      licence: s.licence,
      licenceUrl: s.licenceUrl,
      upstreamUrl: "https://www.federalregister.gov/api/v1/documents.json",
      sourceVersion: today,
      upstreamRevision: `search since ${since}`,
      upstreamSha256: sha256(Buffer.concat(raw)),
      retrievedOn: today,
    },
    entries: fi.normaliseFederalRegister(results, { retrievedOn: today }),
  };
  fi.regulatoryFeedSnapshotSchema.parse(snapshot);
  write(`${s.sourceId}.json`, snapshot);
}
