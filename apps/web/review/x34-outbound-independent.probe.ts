/** X34 independent append-only probes. Append to a temporary copy of
 * gateway src/zz-b4o-outbound-audience.test.ts; all names are that fixture's
 * real PostgreSQL/app/upstream helpers. Never append to the product file. */
describe("X34 independent caller-carrier and boundary probes", () => {
  const carriers: Array<[string, Record<string, unknown>]> = [
    ["percent-encoded URL query", { url: "https://example.test/path?access_token=" + GH_TOKEN.replace("ghp_", "ghp%5f") }],
    ["malformed escape beside valid credential escape", { text: "%ZZ token=" + GH_TOKEN.replace("ghp_", "ghp%5F") }],
    ["encoded object key", { [GH_TOKEN.replace("ghp_", "ghp%5F")]: { safe: "value" } }],
    ["nested caller header carrier", { request: { headers: { Authorization: "Bearer " + GH_TOKEN } } }],
    ["deep array value", { nested: [[[{ value: GH_TOKEN }]]] }],
  ];
  for (const [label, payload] of carriers) it("refuses " + label + " without sending or retaining credential content", async () => {
    const since = await mark(), hits = collectorHits.length;
    const result = await invoke(webhookId, "events", payload);
    expect(result.statusCode, result.body).toBe(403);
    expect(result.json().error).toBe("credential_audience_violation");
    expect(collectorHits.length).toBe(hits);
    const rows = await audienceRows(since);
    expect(rows).toHaveLength(1);
    expectNoSecret(await userRows(since), GH_TOKEN);
    expect(JSON.stringify(rows)).not.toContain("ghp%5");
  });
  it("does not exempt caller content equal to the gateway-injected key", async () => {
    const hits = collectorHits.length;
    const result = await invoke(injectedId, "events", { token: GH_TOKEN });
    expect(result.statusCode, result.body).toBe(403);
    expect(result.json().error).toBe("credential_audience_violation");
    expect(collectorHits.length).toBe(hits);
  });
  it("an encoded protocol carrier is refused before upstream prompt execution", async () => {
    const client = await mcpClient(serverId), before = upstreamSeen.length;
    try {
      await expect(client.getPrompt({ name: "greet", arguments: { who: GH_TOKEN.replace("ghp_", "ghp%5f") } })).rejects.toThrow(/credential_audience_violation/);
      expect(upstreamSeen.length).toBe(before);
    } finally { await client.close(); }
  });
  it("an ordinary entitled caller cannot disable the organisation floor", async () => {
    const result = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: userKey, payload: { outboundCredentialAudience: "off" } });
    expect(result.statusCode, result.body).toBe(403);
    expect(await loadSetting()).toBe("enforce");
  });
  it("caller traversal is bounded by visited objects rather than recursive stack depth", () => {
    const cycle: Record<string, unknown> = { token: GH_TOKEN };
    cycle.self = cycle;
    let deep: unknown = cycle;
    for (let i = 0; i < 12000; i++) deep = [deep];
    expect(audienceViolations(callerSuppliedText(deep), ["https://example.test/"])).toEqual([{ rule: GH_RULE, count: 1 }]);
  });
  it("host-spelling and scheme tricks do not acquire an audience exemption", () => {
    for (const target of ["https://api.fireworks.ai@outside.example/", "https://api.fireworks.ai.outside.example/", "http://api.fireworks.ai/", "file://api.fireworks.ai/", "https://fireworks.ai.invalid/"]) {
      expect(audienceViolations(FW_KEY, [target]), target).toEqual([{ rule: FW_RULE, count: 1 }]);
    }
    expect(audienceViolations(FW_KEY, ["https://API.FIREWORKS.AI:443/path"])).toEqual([]);
  });
});
