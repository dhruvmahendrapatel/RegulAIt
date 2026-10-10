#!/usr/bin/env node
/** Offline conversion: only committed, hash-checked snapshots. Never execute upstream code. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(root, 'packages/shared/src/detection-content');
const { RE2JS } = createRequire(path.join(root, 'packages/shared/package.json'))('re2js');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sources = {};
for (const project of ['pipelock', 'nemo', 'agt']) {
  const meta = JSON.parse(readFileSync(path.join(base, 'vendor', project, 'PROVENANCE.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(meta.commit)) throw Error('Unpinned source');
  const files = new Map();
  for (const file of meta.files) {
    if (file.path.split('/').some((part) => ['enterprise', 'ee', '..'].includes(part)) || path.isAbsolute(file.path)) throw Error('Excluded vendor path');
    const bytes = readFileSync(path.join(base, 'vendor', project, file.path));
    if (sha(bytes) !== file.sha256) throw Error(`Source hash changed: ${project}/${file.path}`);
    files.set(file.path, bytes.toString('utf8'));
  }
  sources[project] = { meta, files, sha256: sha(JSON.stringify([...meta.files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) };
}
const secrets = [], injections = [], heuristics = [], manifests = [];
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
function compile(pattern, ci) { RE2JS.compile(pattern, ci ? RE2JS.CASE_INSENSITIVE : 0); }
function manifest(id, project, rules, notImported) {
  const source = sources[project];
  manifests.push({ id, source: project, repo: source.meta.repo, commit: source.meta.commit, sha256: source.sha256, licence: project === 'agt' ? 'MIT' : 'Apache-2.0', rules, notImported, retrievedAt: source.meta.retrievedAt });
}
const go = sources.pipelock.files.get('internal/config/dlp_patterns.go');
const constants = new Map([...go.matchAll(/\b(\w+)\s*=\s*(`[^`]*`|"(?:\\.|[^"\\])*")/g)].map((match) => [match[1], match[2][0] === '`' ? match[2].slice(1,-1) : JSON.parse(match[2])]));
function expression(raw) {
  const parts = raw.match(/`[^`]*`|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_]*|\+/g) ?? [];
  if (parts.join('').replace(/\s/g,'') !== raw.replace(/\s/g,'')) throw Error('Unsupported Go expression');
  return parts.filter((part) => part !== '+').map((part) => part[0] === '`' ? part.slice(1,-1) : part[0] === '"' ? JSON.parse(part) : constants.has(part) ? constants.get(part) : (() => { throw Error('Unresolved Go constant'); })()).join('');
}
const omittedSecrets = [];
for (const match of go.matchAll(/^\s*\{Name: "([^"]+)", Regex: (.*?), Severity:([^\n]*)/gm)) {
  const id = `pipelock.secrets.${slug(match[1])}`;
  try {
    if (match[1] === 'Ethereum Address') throw Error('Preset-only rule, not in the default Pipelock set');
    if (/\bValidator:/.test(match[3])) throw Error('Requires upstream checksum validator outside the regex-only seam');
    let pattern = expression(match[2]);
    const boundary = constants.get('ProviderKeyLeftBoundaryRegex');
    const leftBoundary = boundary && pattern.startsWith(boundary) ? 'ascii_identifier' : undefined;
    if (leftBoundary) pattern = pattern.slice(boundary.length);
    compile(pattern, true);
    const hosts = /CredentialAudienceHosts:\s*\[\]string\{([^}]+)\}/.exec(match[3]);
    const named = /CredentialAudienceHosts:\s*(\w+)/.exec(match[3]);
    let audienceHosts;
    if (hosts) audienceHosts = [...hosts[1].matchAll(/"([^"]+)"/g)].map((row) => row[1]);
    else if (named) {
      const def = new RegExp(`var ${named[1]} = \\[\\]string\\{([^}]+)\\}`).exec(go);
      if (!def) throw Error('Unresolved credential-audience host list');
      audienceHosts = [...def[1].matchAll(/"([^"]+)"/g)].map((row) => row[1]);
    }
    // A host exemption must not silently discard its carrier/path/cryptographic
    // constraints. Redaction remains imported, but those exemptions fail closed.
    if (/CredentialAudience(?:CarrierMask|AuthorizationOnly|GitHosts|RegistryHosts):/.test(match[3])) {
      audienceHosts = [];
      omittedSecrets.push({ id: `${id}.audience_exemption`, reason: 'Carrier/path/cryptographic audience exemption is not representable in the host-only seam; no exemption granted' });
    }
    secrets.push({ id, pack: 'pipelock-secrets', pattern, caseInsensitive: true, ...(leftBoundary ? { leftBoundary } : {}), ...(audienceHosts ? { audienceHosts } : {}) });
  } catch (error) { omittedSecrets.push({ id, reason: error.message }); }
}
if (!secrets.length) throw Error('No Pipelock rules converted');
manifest('pipelock-secrets', 'pipelock', secrets.length, omittedSecrets);
const normal = sources.pipelock.files.get('internal/normalize/normalize.go');
const confusableText = normal.slice(normal.indexOf('var confusableMap ='), normal.indexOf('\n}', normal.indexOf('var confusableMap =')));
const confusables = [...confusableText.matchAll(/'\\u([0-9A-Fa-f]{4})':\s*'([^']+)'/g)].map((row) => [parseInt(row[1],16), row[2]]);
const rangesText = normal.slice(normal.indexOf('var InvisibleRanges ='), normal.indexOf('// confusableMap'));
const invisibleRanges = [...rangesText.matchAll(/Lo:\s*0x([a-f0-9]+), Hi:\s*0x([a-f0-9]+)/gi)].map((row) => [parseInt(row[1],16), parseInt(row[2],16)]);
const whitespaceText = normal.slice(normal.indexOf('func Whitespace('), normal.indexOf('// StripExoticWhitespace'));
const whitespace = [...new Set([...whitespaceText.matchAll(/'\\u([a-f0-9]{4})'/gi)].map((row) => parseInt(row[1],16)))];
if (confusables.length < 50 || invisibleRanges.length < 10 || whitespace.length < 10) throw Error('Normalization source structure changed');
manifest('pipelock-normalise', 'pipelock', 6, []);
const omittedNemo = [];
for (const [filename, text] of sources.nemo.files) {
  if (!filename.endsWith('.yara')) continue;
  for (const match of text.matchAll(/\brule\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const id = `nemo.yara.injection.${match[1]}`;
    const condition = match[2].split(/\bcondition:/)[1]?.trim();
    const supported = /^(any|[1-9]\d*)\s+of\s+them$/.exec(condition ?? '');
    if (!supported) { omittedNemo.push({ id, reason: 'Condition requires grouping, order, offsets or loops; ADR-0186 permits only any/N of them' }); continue; }
    const strings = match[2].split(/\bstrings:/)[1]?.split(/\bcondition:/)[0] ?? '';
    const patterns = []; let ci;
    try {
      for (const row of strings.trim().split('\n')) {
        const rule = /^\s*\$\w+\s*=\s*("(?:\\.|[^"\\])*"|\/(?:\\.|[^/\\])*\/)(i|\s+nocase)?\s*$/.exec(row);
        if (!rule) throw Error('Unsupported YARA string/modifier');
        const nextCi = !!rule[2]; if (ci !== undefined && ci !== nextCi) throw Error('Mixed case modifiers outside the rule-wide seam'); ci = nextCi;
        const pattern = rule[1][0] === '"' ? JSON.parse(rule[1]).replace(/[.*+?^${}()|[\]\\]/g,'\\$&') : rule[1].slice(1,-1);
        compile(pattern, ci); patterns.push(pattern);
      }
      const minMatches = supported[1] === 'any' ? 1 : Number(supported[1]);
      if (!patterns.length || minMatches > patterns.length) throw Error('Unsatisfiable YARA threshold');
      injections.push({ id, pack: 'nemo-yara-injection', category: 'nemo_injection', patterns, minMatches, caseInsensitive: !!ci });
    } catch (error) { omittedNemo.push({ id, reason: error.message }); }
  }
}
manifest('nemo-yara-injection','nemo',injections.length,omittedNemo);
const python = sources.agt.files.get('agent-governance-python/agent-os/src/agent_os/mcp_security.py');
const omittedAgt = [];
const groups = ['INVISIBLE_UNICODE','HIDDEN_COMMENT','HIDDEN_INSTRUCTION','ROLE_OVERRIDE'];
for (const group of groups) {
  const block = new RegExp(`_${group}_PATTERNS:[^=]+=[ \\t]*\\[([\\s\\S]*?)\\n\\]`).exec(python)?.[1];
  if (!block) throw Error(`AGT group not found: ${group}`);
  let index = 0;
  for (const row of block.matchAll(/re\.compile\(r"((?:\\.|[^"\\])*)"(?:,\s*re\.(IGNORECASE|DOTALL))?\)/g)) {
    const id = `agt.mcp.${group.toLowerCase()}.${++index}`;
    try {
      let pattern = row[1].replace(/\\u([0-9a-fA-F]{4})/g, (_,hex) => `\\x{${hex}}`);
      if (row[2] === 'DOTALL') pattern = `(?s:${pattern})`;
      const caseInsensitive = row[2] === 'IGNORECASE'; compile(pattern, caseInsensitive);
      heuristics.push({ id, pack:'agt-mcp-heuristics', severity: group === 'ROLE_OVERRIDE' ? 'medium' : 'critical', where:['description'], pattern, caseInsensitive });
    } catch (error) { omittedAgt.push({ id, reason:error.message }); }
  }
}
for (const [id, reason] of [['encoded_payload','Needs decode and suspicious-keyword checks, not a literal shape match'],['exfiltration','Broad sample URLs/transfer words require local policy review before admission blocking'],['privilege_escalation','Broad sample admin/code words require local policy review before admission blocking'],['typosquatting','Requires approved reference-name/history context outside the stateless pattern seam'],['rug_pull','Requires prior fingerprints outside the stateless pattern seam'],['cross_server','Requires cross-server identity context outside the stateless pattern seam']]) omittedAgt.push({ id:`agt.mcp.${id}`,reason });
manifest('agt-mcp-heuristics','agt',heuristics.length,omittedAgt);
// ADR-0186 decision 31 (B4I-02): per-rule scan plans derived from RE2's OWN compiled program, so the
// proof follows the engine's parse, case folding and quantifier expansion rather than a second parser.
//   prefilter: positions 1..k of every match, each a class that contains every code point RE2 can consume
//     there (the union over all NFA states reachable after i runes; empty-width assertions pass through, so
//     the class is a superset). k stops where a match could already end (minimum length) or at 24. Every
//     match therefore starts at a prefilter hit, and a run without one needs no RE2 scan at all.
//   maxLength: the longest path through the program in UTF-16 units (a rune that can be astral counts 2),
//     or null when the program has a reachable loop. A bounded rule is matched in a window of maxLength + 1
//     units after each hit plus one unit of left context, which reproduces the full-text leftmost-first
//     match exactly; an unbounded rule falls back to one RE2 scan of the text when it has a hit.
// The program layout is re2js's; the derivation is pinned to the exact version that defines it.
const re2jsPackage = JSON.parse(readFileSync(path.join(path.dirname(createRequire(path.join(root, 'packages/shared/package.json')).resolve('re2js')), '..', 'package.json'), 'utf8'));
if (re2jsPackage.version !== '2.8.6') throw Error(`Scan plans are derived from the re2js 2.8.6 program layout; review it for ${re2jsPackage.version}`);
const OP = { ALT: 1, ALT_MATCH: 2, CAPTURE: 3, EMPTY_WIDTH: 4, FAIL: 5, MATCH: 6, NOP: 7, RUNE: 8, RUNE1: 9, RUNE_ANY: 10, RUNE_ANY_NOT_NL: 11 };
const PREFILTER_POSITIONS = 24, MAX_RUNE = 0x10ffff;
function runeRanges(inst) {
  if (inst.op === OP.RUNE_ANY) return [[0, MAX_RUNE]];
  if (inst.op === OP.RUNE_ANY_NOT_NL) return [[0, 9], [11, MAX_RUNE]];
  const runes = inst.runes;
  if (runes.length === 1) {
    if ((inst.arg & 1) === 0) return [[runes[0], runes[0]]]; // RE2Flags.FOLD_CASE unset
    const char = String.fromCodePoint(runes[0]);
    // RE2 simple case folding of an ASCII letter: its two cases, plus U+017F for s and U+212A for k.
    // Any other folded literal is widened to every code point (still a superset).
    if (!/^[A-Za-z]$/.test(char)) return [[0, MAX_RUNE]];
    const points = [char.toLowerCase(), char.toUpperCase()].map((c) => c.codePointAt(0));
    if (/s/i.test(char)) points.push(0x17f);
    if (/k/i.test(char)) points.push(0x212a);
    return points.map((c) => [c, c]);
  }
  const out = [];
  for (let i = 0; i < runes.length; i += 2) out.push([runes[i], runes[i + 1]]);
  return out;
}
function scanPlan(pattern, caseInsensitive) {
  const prog = RE2JS.compile(pattern, caseInsensitive ? RE2JS.CASE_INSENSITIVE : 0).re2().prog;
  const inst = prog.inst;
  const closure = (pcs) => {
    const seen = new Set(), runes = []; let match = false; const stack = [...pcs];
    while (stack.length) {
      const pc = stack.pop(); if (seen.has(pc)) continue; seen.add(pc);
      const i = inst[pc];
      if (i.op === OP.ALT || i.op === OP.ALT_MATCH) stack.push(i.out, i.arg);
      else if (i.op === OP.CAPTURE || i.op === OP.EMPTY_WIDTH || i.op === OP.NOP) stack.push(i.out);
      else if (i.op === OP.MATCH) match = true;
      else if (i.op >= OP.RUNE && i.op <= OP.RUNE_ANY_NOT_NL) runes.push(i);
      else if (i.op !== OP.FAIL) return null; // a lookbehind or unknown instruction: no plan, full scan
    }
    return { runes, match };
  };
  const classes = [];
  let state = closure([prog.start]);
  while (state && !state.match && state.runes.length && classes.length < PREFILTER_POSITIONS) {
    const merged = [];
    for (const [lo, hi] of state.runes.flatMap(runeRanges).sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi); else merged.push([lo, hi]);
    }
    classes.push(merged);
    state = closure(state.runes.map((i) => i.out));
  }
  if (!state || !classes.length) return null;
  const memo = new Map(), active = new Set();
  const longest = (pc) => {
    if (memo.has(pc)) return memo.get(pc);
    if (active.has(pc)) return Infinity;
    active.add(pc);
    const i = inst[pc]; let value;
    if (i.op === OP.ALT || i.op === OP.ALT_MATCH) value = Math.max(longest(i.out), longest(i.arg));
    else if (i.op === OP.CAPTURE || i.op === OP.EMPTY_WIDTH || i.op === OP.NOP) value = longest(i.out);
    else if (i.op === OP.MATCH) value = 0;
    else if (i.op === OP.FAIL) value = -Infinity;
    else value = (runeRanges(i).some(([, hi]) => hi > 0xffff) ? 2 : 1) + longest(i.out);
    active.delete(pc); memo.set(pc, value); return value;
  };
  const max = longest(prog.start);
  const point = (c) => /^[A-Za-z0-9]$/.test(String.fromCodePoint(c)) ? String.fromCodePoint(c) : `\\u{${c.toString(16)}}`;
  const prefilter = classes.map((ranges) => `[${ranges.map(([lo, hi]) => lo === hi ? point(lo) : `${point(lo)}-${point(hi)}`).join('')}]`).join('');
  new RegExp(prefilter, 'gu'); // must compile in the runtime's flags
  return { prefilter, maxLength: Number.isFinite(max) ? max : null };
}
// Self-check of the derivation on shapes whose answers are known by hand.
for (const [pattern, ci, prefilter, maxLength] of [
  [String.raw`\b\d{3}-\d{2}-\d{4}\b`, false, '[0-9][0-9][0-9][\\u{2d}][0-9][0-9][\\u{2d}][0-9][0-9][0-9][0-9]', 11],
  ['ab+', false, '[a][b]', null], ['(?:x|yz)', false, '[x-y]', 2], ['k', true, '[Kk\\u{212a}]', 1],
]) {
  const got = scanPlan(pattern, ci);
  if (got?.prefilter !== prefilter || got?.maxLength !== maxLength) throw Error(`Scan plan self-check failed for ${pattern}: ${JSON.stringify(got)}`);
}
const scanPlans = Object.fromEntries(secrets.flatMap((rule) => { const plan = scanPlan(rule.pattern, rule.caseInsensitive); return plan ? [[rule.id, plan]] : []; }));
const outputs = { GENERATED_SECRET_SCAN_PLANS:scanPlans, GENERATED_SECRET_RULES:secrets, GENERATED_INJECTION_RULES:injections, GENERATED_MCP_HEURISTICS:heuristics, GENERATED_PACK_MANIFESTS:manifests, NORMALISE_CONFUSABLES:confusables, NORMALISE_INVISIBLE_RANGES:invisibleRanges, NORMALISE_WHITESPACE:whitespace };
const result = '// Generated offline by scripts/vendor/convert-detection-content.mjs; do not edit.\n' + Object.entries(outputs).map(([name,value]) => `export const ${name} = ${JSON.stringify(value,null,2)} as const;\n`).join('\n');
const output = path.join(base,'generated.ts');
if (process.argv.includes('--check')) { if (readFileSync(output,'utf8') !== result) throw Error('Generated detection content differs; rerun converter'); }
else writeFileSync(output,result);
process.stdout.write(JSON.stringify(manifests.map(({id,rules,notImported}) => ({id,rules,notImported:notImported.length})))+'\n');
