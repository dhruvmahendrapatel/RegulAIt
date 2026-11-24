/** Shared local signing path for offline catalogue and detection bundles. Never prints the private key. */
import { createPrivateKey, sign } from "node:crypto";
export function signOfflineBundle(bundle, privateKeyPem, keyId, expectedFormat) {
  const key=createPrivateKey(privateKeyPem);
  if(key.asymmetricKeyType!=="ed25519") throw new Error("the signing key must be Ed25519");
  let parsed;
  try {parsed=JSON.parse(bundle);} catch {throw new Error("the bundle is not JSON");}
  if(parsed?.format!==expectedFormat) throw new Error(`the bundle is not a ${expectedFormat} document`);
  return {bundle,signature:sign(null,Buffer.from(bundle,"utf8"),key).toString("base64"),keyId};
}
