import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.dirname(fileURLToPath(import.meta.url));
const digest = s => createHash('sha256').update(s).digest('hex');
const lockBytes = await readFile(path.join(root, 'package-lock.json'));
const lock = JSON.parse(lockBytes);
const allowed = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0']);
const rows = [], texts = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location) continue;
  assert.ok(!entry.dev, `unexpected development package ${location}`);
  const folder = path.join(root, location);
  const pkg = JSON.parse(await readFile(path.join(folder, 'package.json')));
  assert.equal(pkg.version, entry.version);
  assert.ok(allowed.has(pkg.license), `unadmitted ${pkg.name}: ${pkg.license}`);
  let files = (await readdir(folder)).filter(f => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  let text, source;
  if (files.length) {
    files.sort(); text = (await Promise.all(files.map(f => readFile(path.join(folder, f), 'utf8')))).join('\n');
    source = files.join(', ');
  } else if (pkg.name === 'abstract-logging') {
    text = await readFile(path.join(root, 'notices/abstract-logging-MIT.txt'), 'utf8');
    source = 'notices/abstract-logging-MIT.txt; primary-source provenance in notices/SOURCES.md';
  } else if (['pg-types', 'pgpass'].includes(pkg.name)) {
    const readme = await readFile(path.join(folder, 'README.md'), 'utf8');
    text = readme.slice(readme.toLowerCase().lastIndexOf('## license'));
    source = 'README.md licence section';
  } else if (pkg.name === 'koa-compose') {
    const notices = await readFile(path.join(root, 'node_modules/oidc-provider/THIRD-PARTY-NOTICES.md'), 'utf8');
    text = notices.slice(notices.indexOf('## koa-compose'), notices.indexOf('## @koa/router'));
    source = 'oidc-provider/THIRD-PARTY-NOTICES.md koa-compose section';
  } else throw new Error(`missing licence text ${pkg.name}`);
  assert.ok(/permission|redistribution|copyright/i.test(text), `empty notice ${pkg.name}`);
  rows.push({ name: pkg.name, version: pkg.version, location, licence: pkg.license, optional: Boolean(entry.optional),
    resolved: entry.resolved, integrity: entry.integrity, noticeSource: source, noticeSha256: digest(text) });
  texts.push(`\n## ${pkg.name} ${pkg.version} (${pkg.license})\n\nSource: ${source}\n\n${text.trim()}\n`);
}
rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const inventory = JSON.stringify({ lockSha256: digest(lockBytes), packages: rows }, null, 2) + '\n';
const oidcNotices = await readFile(path.join(root, 'node_modules/oidc-provider/THIRD-PARTY-NOTICES.md'), 'utf8');
const notices = '# Identity S0 dependency notices\n\nGenerated from the exact installed npm lock; upstream text retained verbatim.\n' + texts.join('\n') + '\n## oidc-provider bundled-code notices (verbatim)\n\n' + oidcNotices;
if (process.argv.includes('--write')) {
  await writeFile(path.join(root, 'licence-inventory.json'), inventory);
  await writeFile(path.join(root, 'THIRD_PARTY.md'), notices);
} else {
  assert.equal(await readFile(path.join(root, 'licence-inventory.json'), 'utf8'), inventory, 'inventory drift');
  assert.equal(await readFile(path.join(root, 'THIRD_PARTY.md'), 'utf8'), notices, 'notice drift');
}
const counts = {};
for (const r of rows) counts[r.licence] = (counts[r.licence] ?? 0) + 1;
process.stdout.write(JSON.stringify({ runtimePackages: rows.length, licences: counts, lockSha256: digest(lockBytes) }) + '\n');
