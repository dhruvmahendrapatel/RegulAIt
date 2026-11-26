import { describe,it,expect } from "vitest";
import { generateKeyPairSync,verify } from "node:crypto";
import { signOfflineBundle } from "./lib/offline-bundle.mjs";
const keys=generateKeyPairSync("ed25519");
const pem=keys.privateKey.export({format:"pem",type:"pkcs8"});
describe("one offline signer for catalogue and detection content",()=>{
 it.each(["regulait.mcp-catalogue-bundle/v1","regulait.detection-feed/v1"])("signs exact document bytes: %s",format=>{
  const bundle=JSON.stringify({format})+"\n";
  const signed=signOfflineBundle(bundle,pem,"fixture",format);
  expect(signed.bundle).toBe(bundle);
  expect(verify(null,Buffer.from(bundle),keys.publicKey,Buffer.from(signed.signature,"base64"))).toBe(true);
  expect(JSON.stringify(signed)).not.toContain("PRIVATE KEY");
 });
 it("refuses another purpose, malformed JSON and a different key algorithm",()=>{
  expect(()=>signOfflineBundle('{"format":"wrong"}',pem,"fixture","regulait.detection-feed/v1")).toThrow();
  expect(()=>signOfflineBundle('not JSON',pem,"fixture","regulait.detection-feed/v1")).toThrow();
  const other=generateKeyPairSync("rsa",{modulusLength:2048});
  expect(()=>signOfflineBundle('{"format":"regulait.detection-feed/v1"}',other.privateKey.export({format:"pem",type:"pkcs8"}),"fixture","regulait.detection-feed/v1")).toThrow("Ed25519");
 });
});
