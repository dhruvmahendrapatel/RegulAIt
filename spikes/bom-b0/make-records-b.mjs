// Writes fixtures/records-b.json: the SAME facts as records-a.json, as a second replica could hand them to the
// builder: every array reversed and every object's keys inserted in reverse order. Run once; committed.
import { readFileSync, writeFileSync } from 'node:fs';

// Arrays INSIDE a jsonb value (a model card's data_claims) are data, not row order: a replica returns them as stored,
// so only their object keys are reordered.
const flip = (v, keepArrays = false) => {
  if (Array.isArray(v)) { const m = v.map((x) => flip(x, keepArrays)); return keepArrays ? m : m.reverse(); }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).reverse()) o[k] = flip(v[k], keepArrays || k === 'dataClaims');
    return o;
  }
  return v;
};
const a = JSON.parse(readFileSync(new URL('./fixtures/records-a.json', import.meta.url), 'utf8'));
writeFileSync(new URL('./fixtures/records-b.json', import.meta.url), JSON.stringify(flip(a), null, 1) + '\n');
