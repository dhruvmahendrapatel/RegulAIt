#!/usr/bin/env node
// ADR-0256 — sign an MCP catalogue bundle OFFLINE, for import into an air-gapped install.
//
//   node scripts/mcp-catalogue-bundle-sign.mjs <bundle.json> <ed25519-private.pem> <keyId> > request.json
//
// <bundle.json> is the exact text `GET /v1/mcp-catalogue/bundle?registryId=` returned on a connected install. The
// signature covers those exact bytes, so the file is never re-serialised. The output is the body for
// `POST /v1/mcp-catalogue/bundles`. Make a key pair with:
//
//   openssl genpkey -algorithm ed25519 -out bundle-signing.pem
//   openssl pkey -in bundle-signing.pem -pubout -out bundle-signing.pub.pem
//
// and list the PUBLIC key on the air-gapped install as REGULAIT_MCP_CATALOGUE_BUNDLE_KEYS='[{"keyId":"...","publicKeyPem":"..."}]'.
// Uses only node:crypto. The private key never leaves the machine this runs on.
import { signOfflineBundle } from "./lib/offline-bundle.mjs";
import { readFileSync } from "node:fs";

const [bundlePath, keyPath, keyId] = process.argv.slice(2);
if (!bundlePath || !keyPath || !keyId) {
  process.stderr.write("usage: mcp-catalogue-bundle-sign.mjs <bundle.json> <ed25519-private.pem> <keyId>\n");
  process.exit(2);
}
try {
  process.stdout.write(JSON.stringify(signOfflineBundle(readFileSync(bundlePath,"utf8"),readFileSync(keyPath,"utf8"),keyId,"regulait.mcp-catalogue-bundle/v1"))+"\n");
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}
