// Fresh-process renderer: `node render-cli.mjs <records.json>` prints the node version, the SHA-256 of every
// rendered byte string, and the (deterministic Ed25519) signature over the native body.
import { readFileSync } from 'node:fs';
import { renderAll } from './render.mjs';

const out = renderAll(JSON.parse(readFileSync(process.argv[2], 'utf8')));
process.stdout.write(JSON.stringify({ node: process.version, sha256: out.sha256, signature: out.signature }) + '\n');
