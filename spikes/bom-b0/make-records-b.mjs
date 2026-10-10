// Writes fixtures/records-b.json: the SAME facts as records-a.json, as a second replica could hand them to the
// builder: every array reversed and every object's keys inserted in reverse order. Run once; committed.
import { readFileSync, writeFileSync } from 'node:fs';

const flip = (v) => {
  if (Array.isArray(v)) return v.map(flip).reverse();
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).reverse()) o[k] = flip(v[k]);
    return o;
  }
  return v;
};
const a = JSON.parse(readFileSync(new URL('./fixtures/records-a.json', import.meta.url), 'utf8'));
writeFileSync(new URL('./fixtures/records-b.json', import.meta.url), JSON.stringify(flip(a), null, 1) + '\n');
