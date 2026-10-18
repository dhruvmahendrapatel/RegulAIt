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

export interface BodyMode {
  chunked?: boolean;
  declaredLength?: number;
}

export interface BundleEndpointFixture {
  port: number;
  /**
   * what the next requests are answered with. `chunked`: the body in 16 KiB writes with no content-length (streamed);
   * `declaredLength`: that content-length is sent, then the body, and the response is left open (never ended)
   */
  set(body: string, status?: number, opts?: BodyMode): void;
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
  let mode: BodyMode = {};
  let requests = 0;
  const server = https.createServer({ key, cert: [leaf.pem, ...chain.map((c) => c.pem)].join("") }, (req, res) => {
    requests++;
    if (mode.declaredLength !== undefined) {
      res.writeHead(status, { "content-type": "application/json", "content-length": String(mode.declaredLength) });
      res.write(body);
      return;
    }
    if (mode.chunked) {
      res.writeHead(status, { "content-type": "application/json" });
      for (let i = 0; i < body.length; i += 16_384) res.write(body.slice(i, i + 16_384));
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    set(b: string, s = 200, m: BodyMode = {}) {
      body = b;
      status = s;
      mode = m;
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
