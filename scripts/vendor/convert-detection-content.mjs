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
// Conservative proof for a candidate-only speed gate: every token capable
// of consuming ASCII space must be a \s with a flexible quantifier. Then a
// nonempty run of spaces can be collapsed to one without losing a match.
function flexibleSpaces(pattern) {
  for (let i=0;i<pattern.length;i++) {
    const char=pattern[i];
    if (char === '[') {
      const end=pattern.indexOf(']',i+1); if(end<0) return false;
      const body=pattern.slice(i+1,end);
      if(body.includes('[') || body.includes(' ') || /\\[xupP0-9]/.test(body)) return false;
      if(body.startsWith('^') && !body.includes('\\s')) return false;
      if(!body.startsWith('^') && /\\[sDW]/.test(body)) return false;
      for(const match of body.matchAll(/([^\\])-([^\\])/g)) if(match[1].charCodeAt(0)<=32 && match[2].charCodeAt(0)>=32) return false;
      i=end;
    } else if(char === '\\') {
      const next=pattern[++i];
      if(next === 's') { if(!['*','+','?'].includes(pattern[i+1])) return false; }
      else if(['D','W','x','u','p','P',' '].includes(next) || /^[0-9]$/.test(next??'')) return false;
    } else if(char === '.' || char === ' ') return false;
  }
  return true;
}
const spaceRunSafeIds = secrets.filter((rule) => flexibleSpaces(rule.pattern)).map(rule=>rule.id);
const outputs = { GENERATED_SPACE_RUN_SAFE_IDS:spaceRunSafeIds, GENERATED_SECRET_RULES:secrets, GENERATED_INJECTION_RULES:injections, GENERATED_MCP_HEURISTICS:heuristics, GENERATED_PACK_MANIFESTS:manifests, NORMALISE_CONFUSABLES:confusables, NORMALISE_INVISIBLE_RANGES:invisibleRanges, NORMALISE_WHITESPACE:whitespace };
const result = '// Generated offline by scripts/vendor/convert-detection-content.mjs; do not edit.\n' + Object.entries(outputs).map(([name,value]) => `export const ${name} = ${JSON.stringify(value,null,2)} as const;\n`).join('\n');
const output = path.join(base,'generated.ts');
if (process.argv.includes('--check')) { if (readFileSync(output,'utf8') !== result) throw Error('Generated detection content differs; rerun converter'); }
else writeFileSync(output,result);
process.stdout.write(JSON.stringify(manifests.map(({id,rules,notImported}) => ({id,rules,notImported:notImported.length})))+'\n');
