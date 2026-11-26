/**
 * ADR-0351 slice 1 — the RFC 5424 / RFC 5425 format of the syslog SIEM destination, without a database.
 */
import { describe, expect, it } from "vitest";
import { makeCert } from "./testing/x509-fixtures.js";
import {
  canonicalSyslogUrl,
  caPemProblem,
  formatSyslogMessage,
  frameOctetCounted,
  parseSyslogUrl,
  syslogErrorCode,
  syslogHostname,
  syslogMessagesForBatch,
} from "./siem-syslog.js";
import type { SiemEvent } from "./siem-delivery.js";

const event = (over: Partial<SiemEvent> = {}): SiemEvent => ({
  id: "11111111-1111-4111-8111-111111111111",
  seq: 7,
  at: "2026-11-17T10:00:00.123Z",
  scope: { deployMode: null },
  effect: "deny",
  ruleId: "rule-é",
  object: { type: "project", id: null },
  chain: { prevHash: "a".repeat(64), rowHash: "b".repeat(64), version: 1 },
  ...over,
});

describe("RFC 5424 message", () => {
  it("has the header fields in order, PRI from facility 13, and the event as JSON", () => {
    const m = formatSyslogMessage({ msgId: "audit", severity: 4, at: "2026-11-17T10:00:00.123Z", hostname: "gw-1", msg: { schema: "s", a: 1 } });
    expect(m).toBe('<108>1 2026-11-17T10:00:00.123Z gw-1 regulait - audit - {"schema":"s","a":1}');
  });

  it("severity is 4 for deny and 6 otherwise; the gap notice comes first", () => {
    const out = syslogMessagesForBatch("regulait.siem.audit.v1", [event(), event({ effect: "allow", seq: 8 })], { afterSeq: 3, fromSeq: 7, gap: true }, "gw");
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^<108>1 \S+ gw regulait - audit-gap - /);
    expect(JSON.parse(out[0]!.slice(out[0]!.indexOf("{")))).toEqual({ schema: "regulait.siem.audit.v1", gap: { afterSeq: 3, fromSeq: 7 } });
    expect(out[1]).toMatch(/^<108>1 /);
    expect(out[2]).toMatch(/^<110>1 /);
    const body = JSON.parse(out[2]!.slice(out[2]!.indexOf("{")));
    expect(body).toEqual({ schema: "regulait.siem.audit.v1", ...event({ effect: "allow", seq: 8 }) });
  });

  it("HOSTNAME is PRINTUSASCII only, at most 255, and NILVALUE when empty", () => {
    expect(syslogHostname("gw 1é\n")).toBe("gw1");
    expect(syslogHostname("")).toBe("-");
    expect(syslogHostname("x".repeat(300))).toHaveLength(255);
  });
});

describe("RFC 5425 octet counting", () => {
  it("counts UTF-8 octets, not characters", () => {
    const f = frameOctetCounted("é");
    expect(f.toString("utf8")).toBe("2 é");
  });
});

describe("syslog url", () => {
  it("accepts syslog+tls://host[:port] and defaults the port to 6514", () => {
    expect(parseSyslogUrl("syslog+tls://Logs.Example.com")).toEqual({ ok: true, host: "logs.example.com", port: 6514 });
    expect(parseSyslogUrl("syslog+tls://logs.example.com:10514/")).toEqual({ ok: true, host: "logs.example.com", port: 10514 });
    expect(canonicalSyslogUrl({ host: "logs.example.com", port: 6514 })).toBe("syslog+tls://logs.example.com:6514");
  });

  it.each([
    ["syslog://h", "syslog+tls"],
    ["udp://h:514", "syslog+tls"],
    ["https://h", "syslog+tls"],
    ["syslog+tls://u:p@h", "credentials"],
    ["syslog+tls://h/path", "no path"],
    ["syslog+tls://h?x=1", "no path"],
    ["syslog+tls://h#f", "no path"],
    ["not a url", "not a URL"],
  ])("refuses %s", (raw, why) => {
    const r = parseSyslogUrl(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain(why);
  });
});

describe("CA bundle", () => {
  it("accepts CA certificates and refuses a leaf, junk, a key or an empty bundle", async () => {
    const root = await makeCert({ isCA: true, name: "syslog-test-root" });
    const leaf = await makeCert({ issuer: root, name: "leaf", dnsNames: ["logs.example.com"] });
    expect(caPemProblem(root.pem)).toBeNull();
    expect(caPemProblem(root.pem + root.pem)).toBeNull();
    expect(caPemProblem(leaf.pem)).toContain("CA certificate");
    expect(caPemProblem("hello")).toContain("no PEM");
    expect(caPemProblem("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n")).toContain("does not parse");
    expect(caPemProblem(`${root.pem}-----BEGIN ${["PRIVATE", "KEY"].join(" ")}-----\nAAAA\n-----END ${["PRIVATE", "KEY"].join(" ")}-----\n`)).toContain("private key");
  });
});

describe("error codes", () => {
  it("a certificate or handshake failure is tls_handshake; anything else is a fixed code", () => {
    expect(syslogErrorCode(Object.assign(new Error("x"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }))).toBe("tls_handshake");
    expect(syslogErrorCode(Object.assign(new Error("x"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }))).toBe("tls_handshake");
    expect(syslogErrorCode(Object.assign(new Error("x"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }))).toBe("tls_handshake");
    expect(syslogErrorCode(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("timeout");
    expect(syslogErrorCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("network");
    expect(syslogErrorCode("weird")).toBe("network");
  });
});
