/**
 * TEST ONLY (ADR-0188 S9 follow-up) — a SPIFFE bundle endpoint on loopback:
 * an HTTPS server presenting a synthetic X.509-SVID (or any `TestCert`),
 * serving whatever body and status the test sets. The private key is exported
 * from the in-memory WebCrypto key per run and never written anywhere.
 */
import https from "node:https";
import { webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { TestCert } from "./x509-fixtures.js";

export interface BundleEndpointFixture {
  port: number;
  /** what the next requests are answered with */
  set(body: string, status?: number): void;
  /** requests served so far */
  readonly requests: number;
  close(): Promise<void>;
}

const pem = (label: string, der: ArrayBuffer | Buffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END ${label}-----\n`;

/** `leaf` is the server certificate; `chain` any intermediates sent after it */
export async function bundleEndpointServer(leaf: TestCert, chain: TestCert[] = []): Promise<BundleEndpointFixture> {
  const key = pem("PRIVATE KEY", await webcrypto.subtle.exportKey("pkcs8", leaf.key.privateKey));
  let body = "{}";
  let status = 200;
  let requests = 0;
  const server = https.createServer({ key, cert: [leaf.pem, ...chain.map((c) => c.pem)].join("") }, (req, res) => {
    requests++;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    set(b: string, s = 200) {
      body = b;
      status = s;
    },
    get requests() {
      return requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
