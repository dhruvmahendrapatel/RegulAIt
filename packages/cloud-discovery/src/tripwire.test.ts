/**
 * Review of #404, finding 7: the network tripwire the adapter tests rely on must itself be shown to trip. A client
 * on each SDK's DEFAULT transport (no guarded handler) is recorded; so are raw net, tls and http2 connects.
 */
import net from "node:net";
import tls from "node:tls";
import http2 from "node:http2";
import { BedrockClient, ListCustomModelsCommand } from "@aws-sdk/client-bedrock";
import { ResourceGraphClient } from "@azure/arm-resourcegraph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installNetworkTripwire, synthetic } from "./test-cloud.js";

describe("the network tripwire trips (positive control)", () => {
  let wire: Awaited<ReturnType<typeof installNetworkTripwire>>;
  beforeAll(async () => {
    wire = await installNetworkTripwire();
  });
  afterAll(() => wire.restore());

  it("an AWS client on its default handler is recorded", async () => {
    const client = new BedrockClient({ region: "us-east-1", credentials: { accessKeyId: synthetic("a"), secretAccessKey: synthetic("s") }, maxAttempts: 1 });
    await expect(client.send(new ListCustomModelsCommand({}))).rejects.toThrow();
    expect(wire.escaped.splice(0).some((e) => e.includes("bedrock.us-east-1.amazonaws.com"))).toBe(true);
  });

  it("an Azure client on its default HttpClient is recorded", async () => {
    const credential = { getToken: async () => ({ token: synthetic("t"), expiresOnTimestamp: Date.now() + 3_600_000 }) };
    const client = new ResourceGraphClient(credential, { retryOptions: { maxRetries: 0 } });
    await expect(client.resources({ subscriptions: ["s"], query: "resources | take 1" })).rejects.toThrow();
    expect(wire.escaped.splice(0).length).toBeGreaterThan(0);
  });

  it("raw net, tls and http2 connects are recorded", () => {
    expect(() => net.connect({ host: "example.test", port: 443 })).toThrow(/tripwire/);
    expect(() => tls.connect({ host: "example.test", port: 443 })).toThrow(/tripwire/);
    expect(() => http2.connect("https://example.test")).toThrow(/tripwire/);
    expect(wire.escaped.splice(0)).toEqual(["net.connect example.test:443", "tls.connect example.test:443", "http2.connect https://example.test"]);
  });
});
