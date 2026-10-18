/**
 * ADR-0188 S9 follow-up — the SPIFFE bundle endpoint, offline (no database):
 *  - the pure rules: what a fetched body must be (the SPIFFE JSON format, the
 *    upload's checks, `spiffe_sequence` and `spiffe_refresh_hint`), the refresh
 *    interval clamp and the failure retry, the endpoint URL rules;
 *  - the TRANSPORT, end to end on loopback through the egress guard's pinned
 *    fetch (`createGuardedFetch`, the function `guardConnectionCall` hands
 *    back): `https_spiffe` accepts a server whose X.509-SVID is the configured
 *    endpoint ID under the domain's bundle, and refuses another ID, a CA
 *    certificate as the leaf, and a chain the bundle does not anchor; Web PKI
 *    (`https_web`, no override) still refuses a certificate the system store
 *    does not trust; a redirect is refused, never followed;
 *  - `fetchBundleText` itself (with a stub database that answers only the
 *    allow-list and the domain's authorities): the 256 KiB cap, by declared
 *    length and by what actually streams, and a redirect, each as its code.
 *
 * The refresh itself (write on change, keep the last good bundle on failure,
 * rotation, the trust window, the step-up and audit of the admin route) needs
 * the database: `zz-adr0188-s9b-spiffe-fetch-jwt-svid.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { exportJWK } from "jose";
import { egressAllowHosts, type Db } from "@regulait/db";
import { SPIFFE_BUNDLE_MAX_BYTES } from "@regulait/shared";
import { createGuardedFetch, EgressRedirectError, type EgressResolver } from "../egress-guard.js";
import { bundleEndpointServer, type BundleEndpointFixture } from "../testing/spiffe-endpoint-fixture.js";
import { makeCert, type TestCert } from "../testing/x509-fixtures.js";
import { IdentityAdminError } from "./identity-admin.js";
import {
  BundleFetchError,
  endpointUrlProblem,
  fetchBundleText,
  parseFetchedBundle,
  refreshIntervalSeconds,
  retryDelaySeconds,
  spiffeEndpointTls,
  spiffeServerIdentityProblem,
} from "./spiffe-bundle-endpoint.js";

const TD = "fetch.example.org";
const ENDPOINT_ID = `spiffe://${TD}/spire/server`;
const HOST = "bundle.fetch.example.test";

let ca: TestCert;
let otherCa: TestCert;
let serverSvid: TestCert;
let server: BundleEndpointFixture;

const x509Key = async (c: TestCert) => ({ use: "x509-svid", ...(await exportJWK(new X509Certificate(c.der).publicKey)), x5c: [c.der.toString("base64")] });
const bundleDoc = async (cas: TestCert[], extra: Record<string, unknown> = {}) => JSON.stringify({ keys: await Promise.all(cas.map(x509Key)), ...extra });

// the guard resolves the synthetic host to loopback, which only an allow entry with private ranges permits
const resolve: EgressResolver = async () => [{ address: "127.0.0.1", family: 4 }];
const allowList = [{ host: HOST, allowPrivateRanges: true, allowPlaintextHttp: false }];
const guarded = (tls?: ReturnType<typeof spiffeEndpointTls>) => createGuardedFetch({ allowList, resolve, ...(tls ? { tls } : {}) });
const url = (fixture: BundleEndpointFixture, path = "/bundle") => `https://${HOST}:${fixture.port}${path}`;

beforeAll(async () => {
  ca = await makeCert({ isCA: true, name: "fetch-root" });
  otherCa = await makeCert({ isCA: true, name: "fetch-other-root" });
  serverSvid = await makeCert({ issuer: ca, uris: [ENDPOINT_ID] });
  server = await bundleEndpointServer(serverSvid);
  server.set(await bundleDoc([ca], { spiffe_sequence: 7, spiffe_refresh_hint: 600 }));
});

afterAll(async () => {
  await server?.close();
});

describe("a fetched bundle", () => {
  it("is the SPIFFE JSON format, with its sequence and refresh hint", async () => {
    const out = parseFetchedBundle(await bundleDoc([ca], { spiffe_sequence: 3, spiffe_refresh_hint: 900 }), new Date());
    if (out instanceof IdentityAdminError) throw out;
    expect([out.sequence, out.refreshHintSeconds, out.parsed.views.length]).toEqual([3, 900, 1]);
    const bare = parseFetchedBundle(await bundleDoc([ca]), new Date());
    if (bare instanceof IdentityAdminError) throw bare;
    expect([bare.sequence, bare.refreshHintSeconds]).toEqual([null, null]);
  });

  it("refused: PEM (an endpoint serves JSON), a bad sequence or hint, anything an upload refuses", async () => {
    const codeOf = (o: unknown) => (o instanceof IdentityAdminError ? o.code : "accepted");
    expect(codeOf(parseFetchedBundle(ca.pem, new Date()))).toBe("spiffe_bundle_fetch_format");
    expect(codeOf(parseFetchedBundle(await bundleDoc([ca], { spiffe_sequence: -1 }), new Date()))).toBe("spiffe_bundle_invalid");
    expect(codeOf(parseFetchedBundle(await bundleDoc([ca], { spiffe_sequence: "7" }), new Date()))).toBe("spiffe_bundle_invalid");
    expect(codeOf(parseFetchedBundle(await bundleDoc([ca], { spiffe_refresh_hint: 0 }), new Date()))).toBe("spiffe_bundle_invalid");
    expect(codeOf(parseFetchedBundle(await bundleDoc([ca], { spiffe_refresh_hint: 1.5 }), new Date()))).toBe("spiffe_bundle_invalid");
    expect(codeOf(parseFetchedBundle("{not json", new Date()))).toBe("spiffe_bundle_invalid");
    // the upload's own checks: a leaf is never a trust anchor
    expect(codeOf(parseFetchedBundle(await bundleDoc([serverSvid]), new Date()))).toBe("spiffe_bundle_authority_not_ca");
  });

  it("the refresh interval follows the hint inside [60 s, 24 h], five minutes without one; a failure retries within five minutes", () => {
    expect([refreshIntervalSeconds(null), refreshIntervalSeconds(10), refreshIntervalSeconds(600), refreshIntervalSeconds(2_419_200)]).toEqual([300, 60, 600, 86_400]);
    expect([retryDelaySeconds(60), retryDelaySeconds(600), retryDelaySeconds(86_400)]).toEqual([60, 300, 300]);
  });

  it("an endpoint URL is https, with a host, no userinfo and no fragment", () => {
    expect(endpointUrlProblem("https://bundle.example.test/td")).toBeNull();
    expect(endpointUrlProblem("http://bundle.example.test/td")).toMatch(/https/);
    expect(endpointUrlProblem("https://user:pw@bundle.example.test/td")).toMatch(/userinfo/);
    expect(endpointUrlProblem("https://bundle.example.test/td#x")).toMatch(/fragment/);
    expect(endpointUrlProblem("not a url")).toMatch(/parse/);
  });
});

describe("https_spiffe: the server's X.509-SVID is the endpoint ID under the domain's bundle", () => {
  it("accepted: the configured ID, chained to the bundle (positive control)", async () => {
    const res = await guarded(spiffeEndpointTls(ENDPOINT_ID, [ca.der]))(url(server));
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).spiffe_sequence).toBe(7);
  });

  it("refused: an SVID for another SPIFFE ID", async () => {
    const err = await guarded(spiffeEndpointTls(`spiffe://${TD}/someone/else`, [ca.der]))(url(server)).catch((e: unknown) => e);
    expect((err as { cause?: Error }).cause?.message).toBe("spiffe_endpoint_id_mismatch");
  });

  it("refused: a server chain the bundle does not anchor (another CA), even with the right ID", async () => {
    const err = await guarded(spiffeEndpointTls(ENDPOINT_ID, [otherCa.der]))(url(server)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(String((err as { cause?: { code?: string } }).cause?.code)).toMatch(/CERT|SIGNATURE|UNABLE/);
  });

  it("the leaf profile: one URI SAN, the endpoint ID, never a CA", async () => {
    expect(spiffeServerIdentityProblem(ENDPOINT_ID, serverSvid.der)).toBeUndefined();
    const two = await makeCert({ issuer: ca, uris: [ENDPOINT_ID, `spiffe://${TD}/x`] });
    expect(spiffeServerIdentityProblem(ENDPOINT_ID, two.der)?.message).toBe("spiffe_endpoint_id_mismatch");
    const caLeaf = await makeCert({ issuer: ca, isCA: true, uris: [ENDPOINT_ID] });
    expect(spiffeServerIdentityProblem(ENDPOINT_ID, caLeaf.der)?.message).toBe("spiffe_endpoint_certificate_is_ca");
    expect(spiffeServerIdentityProblem(ENDPOINT_ID, undefined)?.message).toBe("spiffe_endpoint_no_certificate");
  });
});

describe("https_web and the guard itself", () => {
  it("Web PKI is unchanged without an override: the system store does not trust the synthetic CA, so the fetch fails", async () => {
    const err = await guarded()(url(server)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(String((err as { cause?: { code?: string } }).cause?.code)).toMatch(/CERT|SELF_SIGNED|UNABLE|ALTNAME/);
  });

  it("a redirect is refused, never followed", async () => {
    const redirecting = await bundleEndpointServer(serverSvid);
    try {
      redirecting.set("", 302);
      const err = await guarded(spiffeEndpointTls(ENDPOINT_ID, [ca.der]))(url(redirecting)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EgressRedirectError);
      expect(redirecting.requests).toBe(1);
    } finally {
      await redirecting.close();
    }
  });

  it("a host outside the allow-list is refused before any connection", async () => {
    const before = server.requests;
    const err = await createGuardedFetch({ allowList: [], resolve, tls: spiffeEndpointTls(ENDPOINT_ID, [ca.der]) })(url(server)).catch((e: unknown) => e);
    expect((err as Error).name).toBe("EgressBlockedError");
    expect(server.requests).toBe(before);
  });
});

describe("fetchBundleText: the size cap and the redirect, each as its code", () => {
  // the two reads the fetch makes (the egress allow-list, the domain's authorities); audit inserts are kept
  const audits: unknown[] = [];
  const stubDb = () =>
    ({
      select: () => ({
        from: (t: unknown) => {
          const rows = t === egressAllowHosts ? allowList : [{ authoritiesPem: ca.pem }];
          return Object.assign(Promise.resolve(rows), { where: async () => rows });
        },
      }),
      insert: () => ({ values: async (v: unknown) => void audits.push(v) }),
    }) as unknown as Db;
  const fetchFrom = (fixture: BundleEndpointFixture) =>
    fetchBundleText(stubDb(), { trustDomain: TD, url: url(fixture), profile: "https_spiffe", endpointSpiffeId: ENDPOINT_ID }, { resolve });
  const codeOf = (e: unknown) => (e instanceof BundleFetchError ? e.code : `not a BundleFetchError: ${String(e)}`);
  const oversize = `{"keys":[],"pad":"${"x".repeat(SPIFFE_BUNDLE_MAX_BYTES)}"}`;
  let big: BundleEndpointFixture;

  beforeAll(async () => {
    big = await bundleEndpointServer(serverSvid);
  });
  afterAll(async () => {
    await big?.close();
  });

  it("positive control: a bundle under the cap is returned as its text", async () => {
    const doc = await bundleDoc([ca], { spiffe_sequence: 1 });
    big.set(doc, 200, { chunked: true });
    expect(await fetchFrom(big)).toBe(doc);
  });

  it("refused by its declared content-length, before the body is read (the response here never ends)", async () => {
    big.set("{", 200, { declaredLength: SPIFFE_BUNDLE_MAX_BYTES + 1 });
    expect(codeOf(await fetchFrom(big).catch((e: unknown) => e))).toBe("spiffe_bundle_fetch_too_large");
  });

  it("refused by what actually streams: a chunked body with no content-length past the cap", async () => {
    big.set(oversize, 200, { chunked: true });
    // the case is the streamed one: no declared length reaches the reader
    const raw = await guarded(spiffeEndpointTls(ENDPOINT_ID, [ca.der]))(url(big));
    expect([raw.headers.get("content-length"), raw.headers.get("transfer-encoding")]).toEqual([null, "chunked"]);
    await raw.body?.cancel();
    expect(codeOf(await fetchFrom(big).catch((e: unknown) => e))).toBe("spiffe_bundle_fetch_too_large");
  });

  it("a redirect is spiffe_bundle_fetch_redirect, and not followed", async () => {
    big.set("", 302);
    const before = big.requests;
    expect(codeOf(await fetchFrom(big).catch((e: unknown) => e))).toBe("spiffe_bundle_fetch_redirect");
    expect(big.requests).toBe(before + 1);
  });
});
