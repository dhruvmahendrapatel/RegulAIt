/**
 * ADR-0333 — the deterministic evaluator and the rule pack contract (pure, no database).
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { episodeKey, evaluateDetections, raisedKey, type DetectionEvent } from "./engine.js";
import {
  DEFAULT_DETECTION_PACK,
  packChangeIsRelaxation,
  packDigest,
  parseDetectionPack,
  signDetectionPack,
  verifyDetectionPack,
  type DetectionPack,
} from "./pack.js";

const U = "11111111-1111-4111-8111-111111111111";
const S1 = "22222222-2222-4222-8222-222222222222";
const S2 = "33333333-3333-4333-8333-333333333333";
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);

let seq = 0;
function ev(over: Partial<DetectionEvent> & { at: number }): DetectionEvent {
  seq++;
  return {
    auditId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    seq,
    group: `user:${U}`,
    userId: U,
    objectType: "mcp_tool",
    effect: "allow",
    ruleId: "allow-list",
    toolName: "noop",
    serverId: S1,
    phase: null,
    dataScoped: false,
    addonSeverity: null,
    delegationGrantId: null,
    actorIdentityId: null,
    actorChain: null,
    ...over,
  };
}
const all = (events: DetectionEvent[]) => new Set(events.map((e) => e.seq));
const ids = (pack: DetectionPack, events: DetectionEvent[], fresh = all(events)) =>
  evaluateDetections(pack, events, fresh).map((m) => m.rule.id);

describe("ADR-0333 default rules", () => {
  it("secret read then egress within ten minutes fires, with both rows as evidence", () => {
    const events = [ev({ at: T0, toolName: "vault_read_secret" }), ev({ at: T0 + 60_000, toolName: "http_fetch" })];
    const m = evaluateDetections(DEFAULT_DETECTION_PACK, events, all(events));
    expect(m.map((x) => x.rule.id)).toEqual(["secret-read-then-egress"]);
    expect(m[0]!.evidence.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
    expect(m[0]!.trigger.seq).toBe(events[1]!.seq);
  });

  it("does not fire outside the window, in the wrong order, across groups or when the read was denied", () => {
    expect(ids(DEFAULT_DETECTION_PACK, [ev({ at: T0, toolName: "get_secret" }), ev({ at: T0 + 601_000, toolName: "http_fetch" })])).toEqual([]);
    expect(ids(DEFAULT_DETECTION_PACK, [ev({ at: T0, toolName: "http_fetch" }), ev({ at: T0 + 1000, toolName: "get_secret" })])).toEqual([]);
    expect(
      ids(DEFAULT_DETECTION_PACK, [ev({ at: T0, toolName: "get_secret" }), ev({ at: T0 + 1000, toolName: "http_fetch", group: `user:${S2}` })]),
    ).toEqual([]);
    expect(ids(DEFAULT_DETECTION_PACK, [ev({ at: T0, toolName: "get_secret", effect: "deny" }), ev({ at: T0 + 1000, toolName: "http_fetch" })])).toEqual([]);
  });

  it("only a fresh event can trigger; history is look-back only", () => {
    const events = [ev({ at: T0, toolName: "get_secret" }), ev({ at: T0 + 1000, toolName: "http_fetch" })];
    expect(ids(DEFAULT_DETECTION_PACK, events, new Set([events[0]!.seq]))).toEqual([]);
  });

  it("one opening event raises a sequence rule once, even across later egress calls", () => {
    const events = [ev({ at: T0, toolName: "get_secret" }), ev({ at: T0 + 1000, toolName: "http_fetch" }), ev({ at: T0 + 2000, toolName: "send_email" })];
    expect(ids(DEFAULT_DETECTION_PACK, events)).toEqual(["secret-read-then-egress"]);
    const raised = new Set([raisedKey("secret-read-then-egress", events[0]!.seq)]);
    expect(evaluateDetections(DEFAULT_DETECTION_PACK, events, all(events), raised)).toEqual([]);
  });

  it("a data-scoped call then a write to a different server fires; a write to the same server does not", () => {
    const scoped = { dataScoped: true, toolName: "query_customers" };
    expect(ids(DEFAULT_DETECTION_PACK, [ev({ at: T0, ...scoped }), ev({ at: T0 + 1000, toolName: "create_issue", serverId: S2 })])).toEqual([
      "sensitive-scope-then-unapproved-write",
    ]);
    expect(ids(DEFAULT_DETECTION_PACK, [ev({ at: T0, ...scoped }), ev({ at: T0 + 1000, toolName: "create_issue", serverId: S1 })])).toEqual([]);
  });

  it("a call to an add-on rated High or Critical fires; Medium does not", () => {
    expect(ids(DEFAULT_DETECTION_PACK, [ev({ at: T0, addonSeverity: "critical" })])).toEqual(["high-risk-addon-call"]);
    expect(ids(DEFAULT_DETECTION_PACK, [ev({ at: T0, addonSeverity: "high" })])).toEqual(["high-risk-addon-call"]);
    expect(ids(DEFAULT_DETECTION_PACK, [ev({ at: T0, addonSeverity: "medium" })])).toEqual([]);
  });

  it("a delegation refusal beyond the sponsor's entitlements fires", () => {
    expect(ids(DEFAULT_DETECTION_PACK, [ev({ at: T0, effect: "deny", ruleId: "delegation-scope" })])).toEqual(["delegation-escalation"]);
    expect(ids(DEFAULT_DETECTION_PACK, [ev({ at: T0, effect: "deny", ruleId: "delegation-budget" })])).toEqual([]);
  });

  it("ten denied calls in five minutes fire once, at the threshold", () => {
    const events = Array.from({ length: 14 }, (_, i) => ev({ at: T0 + i * 1000, effect: "deny", ruleId: "default-deny" }));
    const m = evaluateDetections(DEFAULT_DETECTION_PACK, events, all(events));
    expect(m.map((x) => x.rule.id)).toEqual(["denied-call-burst"]);
    expect(m[0]!.evidence).toHaveLength(10);
    expect(m[0]!.trigger.seq).toBe(events[9]!.seq);
    const spread = Array.from({ length: 12 }, (_, i) => ev({ at: T0 + i * 60_000, effect: "deny", ruleId: "default-deny" }));
    expect(ids(DEFAULT_DETECTION_PACK, spread)).toEqual([]);
  });

  it("a steady probe raises one denied-call-burst per window, not one per denied call (review of #865)", () => {
    // one denied call every 10 s for 20 minutes: the 5-minute count stays at or above 10 the whole time
    const events = Array.from({ length: 120 }, (_, i) => ev({ at: T0 + i * 10_000, effect: "deny", ruleId: "default-deny" }));
    const m = evaluateDetections(DEFAULT_DETECTION_PACK, events, all(events)).filter((x) => x.rule.id === "denied-call-burst");
    expect(m).toHaveLength(4);
    for (let i = 1; i < m.length; i++) expect(m[i]!.trigger.at - m[i - 1]!.trigger.at).toBeGreaterThanOrEqual(300_000);
    expect(m.every((x) => x.evidence.length === 10)).toBe(true);
  });

  it("an open incident from an earlier batch suppresses the same burst in the next batch", () => {
    const events = Array.from({ length: 12 }, (_, i) => ev({ at: T0 + i * 1000, effect: "deny", ruleId: "default-deny" }));
    const episodes = new Map([[episodeKey("denied-call-burst", `user:${U}`), T0]]);
    const m = evaluateDetections(DEFAULT_DETECTION_PACK, events, all(events), new Set(), undefined, episodes);
    expect(m.filter((x) => x.rule.id === "denied-call-burst")).toEqual([]);
  });

  it("is deterministic: the same input gives the same output", () => {
    const events = [ev({ at: T0, toolName: "read_env" }), ev({ at: T0 + 5, toolName: "post_message", addonSeverity: "high" })];
    const a = evaluateDetections(DEFAULT_DETECTION_PACK, events, all(events));
    const b = evaluateDetections(DEFAULT_DETECTION_PACK, events, all(events));
    expect(a).toEqual(b);
    expect(a.map((m) => m.rule.id)).toEqual(["secret-read-then-egress", "high-risk-addon-call"]);
  });

  it("a disabled rule never fires", () => {
    const pack = parseDetectionPack({ ...DEFAULT_DETECTION_PACK, rules: DEFAULT_DETECTION_PACK.rules.map((r) => ({ ...r, enabled: false })) });
    expect(ids(pack, [ev({ at: T0, addonSeverity: "critical" })])).toEqual([]);
  });
});

describe("ADR-0333 pack contract", () => {
  it("the default pack parses", () => {
    expect(parseDetectionPack(structuredClone(DEFAULT_DETECTION_PACK))).toEqual(DEFAULT_DETECTION_PACK);
  });

  it("refuses unknown members, unknown classes, duplicate ids, unbounded windows and regex-like globs", () => {
    const base = structuredClone(DEFAULT_DETECTION_PACK) as unknown as Record<string, unknown>;
    expect(() => parseDetectionPack({ ...base, extra: 1 })).toThrow();
    const rule = (r: Record<string, unknown>) => ({ ...base, rules: [r] });
    const single = { id: "x", title: "x", severity: "low", enabled: true, type: "single", selector: { effect: ["deny"] } };
    expect(() => parseDetectionPack(rule({ ...single, selector: { toolClass: "nope" } }))).toThrow();
    expect(() => parseDetectionPack(rule({ ...single, selector: { code: "1" } }))).toThrow();
    expect(() => parseDetectionPack({ ...base, rules: [single, single] })).toThrow();
    expect(() =>
      parseDetectionPack(rule({ ...single, type: "event_count", threshold: 5, timespanSeconds: 7200 })),
    ).toThrow();
    expect(() => parseDetectionPack({ ...base, toolClasses: { a: ["(.*)+"] } })).toThrow();
  });

  it("only additions are not a relaxation; removing, disabling or changing a rule or class is", () => {
    const d = DEFAULT_DETECTION_PACK;
    const added = parseDetectionPack({
      ...d,
      rules: [...d.rules, { id: "extra", title: "x", severity: "low", enabled: true, type: "single", selector: { effect: ["deny"] } }],
    });
    expect(packChangeIsRelaxation(d, added)).toBe(false);
    expect(packChangeIsRelaxation(d, parseDetectionPack({ ...d, rules: d.rules.slice(1) }))).toBe(true);
    expect(packChangeIsRelaxation(d, parseDetectionPack({ ...d, rules: d.rules.map((r, i) => (i === 0 ? { ...r, enabled: false } : r)) }))).toBe(true);
    expect(packChangeIsRelaxation(d, parseDetectionPack({ ...d, toolClasses: { ...d.toolClasses, write: ["*write*"] } }))).toBe(true);
    expect(
      packChangeIsRelaxation(d, parseDetectionPack({ ...d, rules: d.rules.map((r, i) => (i === 0 ? { ...r, response: "suspend_grant" } : r)) })),
    ).toBe(true);
  });

  it("a signature verifies only over the exact pack and key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
    const sig = signDetectionPack(DEFAULT_DETECTION_PACK, privateKey);
    expect(verifyDetectionPack(DEFAULT_DETECTION_PACK, sig, jwk)).toBe(true);
    const tampered = parseDetectionPack({ ...DEFAULT_DETECTION_PACK, rules: DEFAULT_DETECTION_PACK.rules.slice(1) });
    expect(verifyDetectionPack(tampered, sig, jwk)).toBe(false);
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
    expect(verifyDetectionPack(DEFAULT_DETECTION_PACK, sig, other)).toBe(false);
    expect(verifyDetectionPack(DEFAULT_DETECTION_PACK, "not-a-signature", jwk)).toBe(false);
    expect(packDigest(DEFAULT_DETECTION_PACK)).toMatch(/^[0-9a-f]{64}$/);
  });

});
