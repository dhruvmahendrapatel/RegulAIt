#!/usr/bin/env node
// ADR-0367: offline signing; no network, payload rewrite, or key material in output.
import { readFileSync } from "node:fs";
import { signOfflineBundle } from "./lib/offline-bundle.mjs";
const [bundlePath,keyPath,keyId]=process.argv.slice(2);
if(!bundlePath||!keyPath||!keyId) {
  process.stderr.write("usage: detection-feed-sign.mjs <feed.json> <ed25519-private.pem> <keyId>\n");
  process.exit(2);
}
try {process.stdout.write(JSON.stringify(signOfflineBundle(readFileSync(bundlePath,"utf8"),readFileSync(keyPath,"utf8"),keyId,"regulait.detection-feed/v1"))+"\n");}
catch {process.stderr.write("the feed could not be signed; check the document format and Ed25519 key\n");process.exit(2);}
