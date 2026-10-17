// SD4 spike: the Node equivalent of go-probe/main.go, using the JOSE library the gateway and
// engine runner already pin (jose 6.2.12). It generates an Ed25519 key, builds an RFC 9449 DPoP
// proof and its RFC 7638 thumbprint, and lists the home directory. It sends nothing.
import { generateKeyPair, exportJWK, SignJWT, calculateJwkThumbprint } from "jose";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

async function main() {
const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
const jwk = await exportJWK(publicKey);
const jkt = await calculateJwkThumbprint(jwk);
const proof = await new SignJWT({
  htm: "POST",
  htu: "https://gateway.invalid/oauth/token",
  jti: randomBytes(16).toString("base64url"),
})
  .setProtectedHeader({ typ: "dpop+jwt", alg: "EdDSA", jwk })
  .setIssuedAt()
  .sign(privateKey);
let entries = 0;
try {
  entries = readdirSync(homedir()).length;
} catch {
  entries = -1;
}
console.log(
  `os=${process.platform} arch=${process.arch} jkt=${jkt} proof_len=${proof.length} home_entries=${entries}`,
);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
