/**
 * ADR-0334: the device key and the request proofs.
 *
 * At first start the service worker creates a P-256 key pair with WebCrypto, `extractable: false`, and keeps the
 * CryptoKey objects in IndexedDB (structured clone keeps them non-extractable: page script cannot read them, and the
 * private key's bytes never exist in JavaScript). Nothing secret is kept in `chrome.storage`; the device id stored
 * there identifies the key, it does not prove anything. Hardware-binding the key (the endpoint agent's TPM or Secure
 * Enclave key, through native messaging) is a recorded follow-up.
 *
 * Every request after registration carries a compact JWS (ES256) over the method, the path, the SHA-256 of the exact
 * body, the time and a fresh one-use id. The gateway refuses a replayed id, a stale time and another body.
 */
import { base64url, CompactSign, exportJWK } from "jose";
import { BROWSER_PROOF_TYP } from "@regulait/shared/browser-governance/constants";
import type { BrowserPublicJwk } from "@regulait/shared/browser-governance";

export async function generateDeviceKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
}

export async function publicJwkOf(pair: CryptoKeyPair): Promise<BrowserPublicJwk> {
  const jwk = await exportJWK(pair.publicKey);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("not a P-256 public key");
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

export async function bodyDigest(body: string): Promise<string> {
  return base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))));
}

/** the proof for one POST of `body` to `path`; `nowSeconds` is the local clock (the gateway allows a small skew) */
export async function makeProof(privateKey: CryptoKey, path: string, body: string, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<string> {
  const claims = { htm: "POST", htu: path, iat: nowSeconds, jti: crypto.randomUUID(), bd: await bodyDigest(body) };
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader({ alg: "ES256", typ: BROWSER_PROOF_TYP }).sign(privateKey);
}

// ---- IndexedDB: one store, one record ------------------------------------------------------------------------------

const DB_NAME = "regulait-device";
const STORE = "keys";
const KEY = "device";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

export async function loadDeviceKey(): Promise<CryptoKeyPair | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as CryptoKeyPair | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error("indexedDB read failed"));
    });
  } finally {
    db.close();
  }
}

export async function saveDeviceKey(pair: CryptoKeyPair): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(pair, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("indexedDB write failed"));
    });
  } finally {
    db.close();
  }
}
