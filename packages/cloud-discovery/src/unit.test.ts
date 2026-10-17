import { describe, expect, it } from "vitest";
import {
  awsCredentialSchema,
  azureCredentialSchema,
  federationSubject,
  gcpCredentialSchema,
  generateExternalId,
  isStaticCredential,
  parseServiceAccountKey,
} from "./credentials.js";
import { classifyError, digestObservations, redact } from "./report.js";
import { CLOUD_AI_SERVICE_SEED } from "./seed.js";
import { assertHttpsAuthority } from "./azure.js";
import { fakeCloud } from "./test-cloud.js";
import { BodyTooLargeError, GuardedAzureHttpClient, readBodyCapped, requestAwareFetch } from "./transport.js";
import { createHttpHeaders, createPipelineRequest } from "@azure/core-rest-pipeline";

describe("requestAwareFetch", () => {
  it("unpacks a Request so method and body reach the guard (a bare Request would otherwise lose them)", async () => {
    const cloud = fakeCloud([() => new Response("ok")]);
    const f = requestAwareFetch(cloud.fetch);
    await f(new Request("https://api.example.test/x", { method: "POST", body: "a=1", headers: { "x-k": "v" } }));
    expect(cloud.calls[0]).toMatchObject({ method: "POST", body: "a=1" });
    expect(cloud.calls[0]!.headers.get("x-k")).toBe("v");
    expect(cloud.calls[0]!.url.href).toBe("https://api.example.test/x");
  });
});

describe("Azure authorityHost", () => {
  it("accepts only a plain https origin", () => {
    expect(() => assertHttpsAuthority("https://login.microsoftonline.us")).not.toThrow();
    for (const bad of ["http://login.example", "https://u:p@login.example", "https://login.example/x", "https://login.example/?a=1", "not a url"]) {
      expect(() => assertHttpsAuthority(bad)).toThrow();
    }
  });
});

describe("readBodyCapped", () => {
  it("returns a body under the cap and stops a body over it, whatever the headers say", async () => {
    expect(new TextDecoder().decode(await readBodyCapped(new Response("hello").body, 10))).toBe("hello");
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(4));
      },
    });
    await expect(readBodyCapped(endless, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled).toBeLessThan(10);
  });
});

describe("GuardedAzureHttpClient", () => {
  it("sends method, headers and body through the injected fetch and returns the response", async () => {
    const cloud = fakeCloud([() => new Response('{"a":1}', { status: 201, headers: { "x-r": "1" } })]);
    const client = new GuardedAzureHttpClient(cloud.fetch);
    const req = createPipelineRequest({ url: "https://management.azure.com/x", method: "PUT", headers: createHttpHeaders({ "x-h": "h" }), body: '{"b":2}' });
    const res = await client.sendRequest(req);
    expect(res.status).toBe(201);
    expect(res.bodyAsText).toBe('{"a":1}');
    expect(res.headers.get("x-r")).toBe("1");
    expect(cloud.calls[0]).toMatchObject({ method: "PUT", body: '{"b":2}' });
    expect(cloud.calls[0]!.headers.get("x-h")).toBe("h");
  });

  it("refuses stream bodies instead of guessing", async () => {
    const cloud = fakeCloud([() => new Response("")]);
    const client = new GuardedAzureHttpClient(cloud.fetch);
    const req = createPipelineRequest({ url: "https://management.azure.com/x", method: "POST", body: () => new ReadableStream() });
    await expect(client.sendRequest(req)).rejects.toThrow("unsupported Azure request body type");
    expect(cloud.calls).toHaveLength(0);
  });
});

describe("credentials", () => {
  it("defaults the web-identity audience and refuses a non-role ARN", () => {
    const ok = awsCredentialSchema.parse({ mode: "aws_web_identity", roleArn: "arn:aws:iam::111122223333:role/r" });
    expect(ok.mode === "aws_web_identity" && ok.audience).toBe("sts.amazonaws.com");
    expect(awsCredentialSchema.safeParse({ mode: "aws_web_identity", roleArn: "arn:aws:iam::111122223333:user/u" }).success).toBe(false);
    expect(awsCredentialSchema.safeParse({ mode: "aws_web_identity", roleArn: "not-an-arn" }).success).toBe(false);
  });

  it("refuses a GCP audience that is not a workload identity provider", () => {
    expect(gcpCredentialSchema.safeParse({ mode: "gcp_workload_identity", audience: "https://example.test" }).success).toBe(false);
  });

  it("marks exactly the three static modes as static (each an ADR-0180 relaxation)", () => {
    expect(["aws_static", "gcp_service_account_key", "azure_client_secret"].every((m) => isStaticCredential(m as never))).toBe(true);
    expect(["aws_web_identity", "aws_assume_role", "gcp_workload_identity", "azure_federated"].some((m) => isStaticCredential(m as never))).toBe(false);
    expect(azureCredentialSchema.safeParse({ mode: "azure_federated", tenantId: "t", clientId: "c" }).success).toBe(true);
  });

  it("generates a fresh, unguessable external id per source", () => {
    const a = generateExternalId();
    const b = generateExternalId();
    expect(a).not.toBe(b);
    expect(a.startsWith("regulait-")).toBe(true);
    expect(a.length).toBeGreaterThan(40);
    expect(federationSubject("s1")).toBe("regulait:discovery-source:s1");
  });

  it("keeps only client_email and private_key from a key file and rejects anything else", () => {
    expect(() => parseServiceAccountKey("{")).toThrow("not valid JSON");
    expect(() => parseServiceAccountKey(JSON.stringify({ type: "authorized_user" }))).toThrow("missing");
  });
});

describe("classifyError", () => {
  it("maps an egress refusal wrapped by an SDK to unreachable", () => {
    const egress = Object.assign(new Error("egress blocked (host_not_allowed): x"), { name: "EgressBlockedError" });
    expect(classifyError(new Error("wrapped", { cause: egress })).status).toBe("unreachable");
  });
  it("maps cloud permission errors to denied", () => {
    expect(classifyError(Object.assign(new Error("no"), { name: "AccessDeniedException" })).status).toBe("denied");
    expect(classifyError(Object.assign(new Error("no"), { code: 7 })).status).toBe("denied");
    expect(classifyError(Object.assign(new Error("no"), { code: "AuthorizationFailed", statusCode: 403 })).status).toBe("denied");
  });
  it("redacts key=, token=, signature= and similar parameter values (finding 5)", () => {
    const k = `k${"1".repeat(20)}`;
    const msg = `GET https://x.example/?api_key=${k}&X-Amz-Signature=abc123&access_token=tok.en&region=us-east-1 client_secret='${k}' failed`;
    const out = redact(msg);
    expect(out).not.toContain(k);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("tok.en");
    expect(out).toContain("region=us-east-1");
    expect(out).toContain("api_key=[redacted]&X-Amz-Signature=[redacted]&access_token=[redacted]");
    expect(redact("x".repeat(195) + `key=${k}`)).not.toContain(k.slice(0, 5));
  });

  it("redacts JSON- and YAML-style secrets too (recheck finding 4)", () => {
    const k = `k${"2".repeat(20)}`;
    const out = redact(`token exchange failed: {"access_token":"${k}","token_type":"Bearer"} client_secret: ${k} at https://login.example/x`);
    expect(out).not.toContain(k);
    expect(out).toContain('"access_token":"[redacted]"');
    expect(out).toContain("client_secret: [redacted]");
    expect(out).toContain("https://login.example/x");
    expect(redact(`{"accessToken" : '${k}'}`)).not.toContain(k);
  });

  it("never echoes a bearer token", () => {
    expect(classifyError(new Error("failed with Bearer abc.def")).detail).not.toContain("abc.def");
  });
});

describe("seed and digest", () => {
  it("seed rows are exact service keys, unique and enabled", () => {
    const values = CLOUD_AI_SERVICE_SEED.map((r) => r.value);
    expect(new Set(values).size).toBe(values.length);
    expect(CLOUD_AI_SERVICE_SEED.every((r) => r.kind === "cloud_ai_service" && r.matchType === "identifier" && r.enabled)).toBe(true);
  });
  it("digest is stable under key order", () => {
    const a = digestObservations([{ provider: "aws", subjectKind: "cloud_resource", subject: "s", serviceKey: "k", signalSource: "cloud_inventory", resourceType: "t", location: null, container: "c" }]);
    const b = digestObservations([{ container: "c", location: null, resourceType: "t", signalSource: "cloud_inventory", serviceKey: "k", subject: "s", subjectKind: "cloud_resource", provider: "aws" }]);
    expect(a).toBe(b);
  });
});
