/**
 * ADR-0190 I4 follow-up (the executor's TLS front): the executor pins the CA bundle it trusts for the gateway.
 * Certificates and keys are generated at run time with openssl (nothing secret-shaped is committed).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutorConfigError, probeGatewayReachable } from "./client.js";
import { pinGatewayCa, splitPemCertificates } from "./main.js";

let dir: string;
const file = (n: string) => join(dir, n);
const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });

function makeCa(name: string): void {
  openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", file(`${name}.key`), "-out", file(`${name}.crt`),
    "-days", "2", "-subj", `/CN=${name}`, "-addext", "basicConstraints=critical,CA:TRUE");
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "executor-ca-"));
  makeCa("front-ca");
  makeCa("other-ca");
  openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", file("leaf.key"), "-out", file("leaf.csr"), "-subj", "/CN=localhost");
  writeFileSync(file("leaf.ext"), "subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\n");
  openssl("x509", "-req", "-in", file("leaf.csr"), "-CA", file("front-ca.crt"), "-CAkey", file("front-ca.key"), "-CAcreateserial",
    "-out", file("leaf.crt"), "-days", "1", "-extfile", file("leaf.ext"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pinGatewayCa", () => {
  const https = "https://executor-front:8443";

  it("refuses NODE_TLS_REJECT_UNAUTHORIZED=0, with or without a CA file", () => {
    for (const caFile of [undefined, file("front-ca.crt")]) {
      expect(() => pinGatewayCa({ gatewayUrl: https, caFile, env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, setDefault: () => undefined }))
        .toThrow(ExecutorConfigError);
    }
  });

  it("leaves the default trust alone with no CA file, or for a plain-http (development) URL", () => {
    let calls = 0;
    const setDefault = () => void calls++;
    expect(pinGatewayCa({ gatewayUrl: https, caFile: undefined, env: {}, setDefault })).toBeNull();
    expect(pinGatewayCa({ gatewayUrl: "http://gateway:3000", caFile: file("front-ca.crt"), env: {}, setDefault })).toBeNull();
    expect(calls).toBe(0);
  });

  it("pins exactly the CA certificates in the file", () => {
    const seen: string[][] = [];
    const bundle = `junk before\n${readFileSync(file("front-ca.crt"), "utf8")}between\n${readFileSync(file("other-ca.crt"), "utf8")}`;
    writeFileSync(file("bundle.pem"), bundle);
    const pin = pinGatewayCa({ gatewayUrl: https, caFile: file("bundle.pem"), env: {}, setDefault: (c) => void seen.push(c) });
    expect(pin?.fingerprints).toHaveLength(2);
    expect(pin?.fingerprints[0]).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(splitPemCertificates(bundle));
    expect(seen[0]![0]).toContain("-----BEGIN CERTIFICATE-----");
  });

  it("refuses a missing file, a file with no certificate, a truncated block, a leaf and an expired CA", () => {
    const setDefault = () => {
      throw new Error("must not be reached");
    };
    writeFileSync(file("empty.pem"), "no certificate here\n");
    writeFileSync(file("truncated.pem"), readFileSync(file("front-ca.crt"), "utf8").replace("-----END CERTIFICATE-----", ""));
    for (const caFile of [file("missing.pem"), file("empty.pem"), file("truncated.pem"), file("leaf.crt"), dir]) {
      expect(() => pinGatewayCa({ gatewayUrl: https, caFile, env: {}, setDefault }), caFile).toThrow(ExecutorConfigError);
    }
    const later = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    expect(() => pinGatewayCa({ gatewayUrl: https, caFile: file("front-ca.crt"), env: {}, now: later, setDefault })).toThrow(/not valid now/);
  });
});

describe("pinGatewayCa against a real TLS server (process-wide default trust)", () => {
  let server: Server;
  let url: string;
  const bundled = tls.getCACertificates("default");

  beforeAll(async () => {
    server = createServer({ key: readFileSync(file("leaf.key")), cert: readFileSync(file("leaf.crt")) }, (_req, res) => {
      res.setHeader("connection", "close");
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `https://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    tls.setDefaultCACertificates(bundled);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // order matters: undici resumes cached TLS sessions per origin, so the refused handshake runs first
  it("a different pinned CA refuses the front's certificate", async () => {
    pinGatewayCa({ gatewayUrl: url, caFile: file("other-ca.crt"), env: {} });
    const reason = await probeGatewayReachable(url);
    expect(reason).toMatch(/not reachable over https/);
    expect(reason).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to verify/i);
  });

  it("the front's own pinned CA accepts it", async () => {
    pinGatewayCa({ gatewayUrl: url, caFile: file("front-ca.crt"), env: {} });
    expect(await probeGatewayReachable(url)).toBeNull();
  });
});
