// ADR-0252: the shared append-only docs are written at merge time, not on each branch.
//
// - The ADR index (internal/decisions/README.md): a PR adds only its ADR file. `foldAdrIndex` adds the missing row
//   from the file's own header (`# ADR-NNNN: Title`, `- **Status**:`, `- **Date**:`, or `- **Index**:` to override
//   the title cell) in number order. Existing rows are never rewritten.
// - STATE.md and PENDING.md: a PR adds a fragment file under internal/fragments/ whose first line names the place it
//   goes (`<!-- fold: state-recap -->`). `foldFragments` moves each fragment to its marker
//   (`<!-- fold:state-recap newest-first -->`) and the caller deletes the fragment (towncrier's pattern).
//
// Both are pure (text in, text out) and run by scripts/assign-at-merge.mjs.

const ROW_RE = /^\| *\[(\d{4})\]/;
const ADR_FILE_RE = /^(\d{4})-.*\.md$/;

/** a GFM table cell: a `|` is escaped, and line breaks are folded */
const cell = (s) => s.replace(/\s+/g, " ").trim().replace(/(?<!\\)\|/g, "\\|");

/** the index row for one ADR file, from its header; throws naming what is missing */
export function adrRow(name, text) {
  const id = ADR_FILE_RE.exec(name)?.[1];
  if (!id) throw new Error(`${name}: not an ADR file name (NNNN-slug.md)`);
  const head = text.slice(0, 4000);
  // the template's header (`- **Status**:`), and the older plain one (`# 0010 — Title`, `Status: …`)
  const title = /^- \*\*Index\*\*:\s*(.+)$/m.exec(head)?.[1] ?? /^# (?:ADR-)?\d{4}(?::| —| -)\s*(.+)$/m.exec(head)?.[1];
  const statusLine = /^(?:- \*\*Status\*\*:?|Status:)\s*(.+)$/m.exec(head)?.[1];
  const date = /^(?:- \*\*Date\*\*:?|Date:)\s*(\d{4}-\d{2}-\d{2})/m.exec(head)?.[1];
  const missing = [!title && "a `# ADR-NNNN: Title` heading", !statusLine && "a `- **Status**:` line", !date && "a `- **Date**: YYYY-MM-DD` line"].filter(Boolean);
  if (missing.length) throw new Error(`${name}: the index row is built from the ADR's header, which lacks ${missing.join(", ")}`);
  // the status cell is the status itself, without the parenthetical or the sentence after it
  const status = statusLine.split(/ \(|; |\. /)[0].replace(/\.$/, "");
  return `| [${id}](${name}) | ${cell(title)} | ${cell(status)} | ${date} |`;
}

/** README text with a row added for every ADR file that has none, each in number order; existing rows untouched */
export function foldAdrIndex(readme, adrFiles) {
  const lines = readme.split("\n");
  const have = new Set(lines.map((l) => ROW_RE.exec(l)?.[1]).filter(Boolean));
  const add = adrFiles
    .filter((f) => ADR_FILE_RE.test(f.name) && !have.has(f.name.slice(0, 4)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const ids = [...have];
  const fileIds = adrFiles.filter((f) => ADR_FILE_RE.test(f.name)).map((f) => f.name.slice(0, 4));
  const dupes = fileIds.filter((id, i) => fileIds.indexOf(id) !== i);
  if (dupes.length) throw new Error(`two ADR files share the number ${[...new Set(dupes)].join(", ")}; renumber one before it merges`);
  if (add.length === 0) return { text: readme, added: [] };
  if (ids.length === 0) throw new Error("the ADR index has no rows to add after");
  for (const f of add) {
    const row = adrRow(f.name, f.text);
    const id = Number(f.name.slice(0, 4));
    const rowIdx = lines.map((l, i) => [ROW_RE.exec(l)?.[1], i]).filter(([n]) => n);
    const after = rowIdx.filter(([n]) => Number(n) < id).pop();
    const at = after ? after[1] + 1 : rowIdx[0][1];
    lines.splice(at, 0, row);
  }
  return { text: lines.join("\n"), added: add.map((f) => f.name.slice(0, 4)) };
}

const MARKER_RE = /^<!-- fold:([a-z0-9-]+)((?: [a-z-]+)*) -->$/;
const FRAGMENT_HEAD_RE = /^<!-- fold: ?([a-z0-9-]+) -->\n/;

/** the fold markers in a text: name → { line, newestFirst, rows } */
export function markers(text) {
  const out = new Map();
  text.split("\n").forEach((l, line) => {
    const m = MARKER_RE.exec(l);
    if (!m) return;
    const opts = m[2].trim().split(" ").filter(Boolean);
    const unknown = opts.filter((o) => o !== "newest-first" && o !== "rows");
    if (unknown.length) throw new Error(`fold marker ${m[1]}: unknown option ${unknown.join(", ")}`);
    if (out.has(m[1])) throw new Error(`fold marker ${m[1]} appears twice`);
    out.set(m[1], { line, newestFirst: opts.includes("newest-first"), rows: opts.includes("rows") });
  });
  return out;
}

/**
 * Move fragments into their targets. `targets` maps a path to its text; `fragments` are { name, text } whose first
 * line is `<!-- fold: NAME -->`. Fragments for one marker go in file-name order (newest-first markers: reversed), as
 * one batch: before the marker, or right after it for newest-first. A `rows` marker joins fragments with no blank
 * line (table rows); otherwise each fragment is a block followed by a blank line. Returns the new texts and the
 * fragment names folded. Throws on a fragment with no header or naming no marker.
 */
export function foldFragments(targets, fragments) {
  const where = new Map();
  for (const [file, text] of targets) for (const [name, m] of markers(text)) {
    if (where.has(name)) throw new Error(`fold marker ${name} is in both ${where.get(name).file} and ${file}`);
    where.set(name, { file, ...m });
  }
  const byMarker = new Map();
  for (const f of [...fragments].sort((a, b) => a.name.localeCompare(b.name))) {
    const m = FRAGMENT_HEAD_RE.exec(f.text);
    if (!m) throw new Error(`fragment ${f.name}: its first line must be <!-- fold: NAME --> (one of ${[...where.keys()].join(", ")})`);
    if (!where.has(m[1])) throw new Error(`fragment ${f.name}: no target has the fold marker ${m[1]} (known: ${[...where.keys()].join(", ")})`);
    const body = f.text.slice(m[0].length).replace(/^\n+/, "").replace(/\s+$/, "");
    if (!body) throw new Error(`fragment ${f.name} is empty`);
    if (!byMarker.has(m[1])) byMarker.set(m[1], []);
    byMarker.get(m[1]).push(body);
  }
  const out = new Map(targets);
  // insert from the bottom of each file up, so earlier marker line numbers stay valid
  const jobs = [...byMarker].map(([name, bodies]) => ({ name, bodies, ...where.get(name) })).sort((a, b) => b.line - a.line);
  for (const j of jobs) {
    const lines = out.get(j.file).split("\n");
    const bodies = j.newestFirst ? [...j.bodies].reverse() : j.bodies;
    const chunk = j.rows ? bodies.flatMap((b) => b.split("\n")) : bodies.flatMap((b) => [...b.split("\n"), ""]);
    if (j.newestFirst) lines.splice(j.line + 1, 0, ...(j.rows ? chunk : ["", ...chunk.slice(0, -1)]));
    else lines.splice(j.line, 0, ...chunk);
    out.set(j.file, lines.join("\n"));
  }
  return { targets: out, folded: [...fragments].map((f) => f.name).sort() };
}
