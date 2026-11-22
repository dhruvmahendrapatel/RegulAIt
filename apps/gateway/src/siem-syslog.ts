/**
 * ADR-0351 slice 1 — the syslog destination of ADR-0303's SIEM delivery: RFC 5424 messages over TLS, framed by
 * octet counting (RFC 5425 §4.3), one message per audit-chain event.
 *
 * THE SAME CONTRACT AS THE WEBHOOK. The cursor, lease, ordering, backoff, dead-letter and audit of ADR-0303 apply
 * unchanged (`siem-delivery.ts` owns them and calls `sendSyslogBatch` in place of the signed POST). What leaves is the
 * same scrubbed `regulait.siem.audit.v1` event (`siemEventFromAuditRow`, the one allow-list), as the JSON MSG of each
 * syslog message. Nothing else of the audit row is read, so no detail, reason, user id or payload reaches a receiver.
 *
 * MESSAGE (RFC 5424 §6). `<PRI>1 TIMESTAMP HOSTNAME regulait - MSGID - MSG`:
 *  - PRI: facility 13 ("log audit") × 8 + severity, 4 (warning) for a deny row, 6 (informational) otherwise;
 *  - TIMESTAMP: the audit row's time, RFC 3339 in UTC with milliseconds;
 *  - HOSTNAME: this gateway's host name reduced to PRINTUSASCII (`-` when empty);
 *  - MSGID: `audit` for an event, `audit-gap` for the one notice that rows were pruned before delivery;
 *  - STRUCTURED-DATA: `-`. RFC 5424 SD-IDs of our own need an IANA private enterprise number we do not hold, so every
 *    field is in the MSG, which is JSON (`{"schema":"regulait.siem.audit.v1",...event}`), not the BOM-prefixed form.
 *
 * TRANSPORT (RFC 5425). TLS 1.2 or later, the receiver's certificate always verified against the system trust store or
 * the destination's own CA bundle (`tls_ca_pem`), never switched off. There is no plaintext, UDP or plain-TCP mode
 * (ADR-0180): audit metadata leaves only over an authenticated, encrypted channel. The host goes through the same
 * egress allow-list as the webhook (`checkEgress`, default-deny, blocked ranges), and the socket connects to the
 * address that check resolved and accepted (pinned, so a DNS answer cannot change between check and connect), with SNI
 * and the certificate check on the host name.
 *
 * WHAT "DELIVERED" MEANS. RFC 5425 has no application acknowledgement. A batch counts as delivered when every byte was
 * written to the verified TLS session and the session then closed without an error; the cursor moves only then. Any
 * error first resends the whole batch, so delivery is at least once and receivers deduplicate on the event id, as
 * with the webhook.
 *
 * LIBRARIES (ADR-0176). `syslog-client` (MIT) last released in 2017 and has no TLS; `pino-syslog` (MIT, maintained)
 * formats pino log lines, not our events, and its transport (`pino-socket`) connects by host name, which would bypass
 * the pinned-address egress guard. The format is three lines of RFC 5424 and the transport is `node:tls`.
 */
import os from "node:os";
import net from "node:net";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import type { Db } from "@regulait/db";
import { loadEgressAllowList } from "./custom-providers.js";
import { checkEgress, type EgressResolver } from "./egress-guard.js";
import type { SiemErrorCode, SiemEvent } from "./siem-delivery.js";

export const SYSLOG_SCHEME = "syslog+tls:";
/** RFC 5425 §4.1: the port assigned to syslog over TLS */
export const SYSLOG_TLS_DEFAULT_PORT = 6514;
/** RFC 5424 facility 13, "log audit" */
export const SYSLOG_FACILITY_LOG_AUDIT = 13;
export const SYSLOG_APP_NAME = "regulait";
export const SYSLOG_LIMITS = {
  timeoutMs: 10_000,
  /** after the last byte is written, how long the receiver may take to close the session before we close it */
  closeGraceMs: 2_000,
  /** RFC 5425 §4.3.1: receivers SHOULD accept 8192 octets; an event is far smaller, a larger one is refused */
  maxMessageOctets: 8192,
  caPemMaxChars: 65_536,
  caPemMaxCerts: 20,
} as const;

/** RFC 5424 §6.2.4: HOSTNAME is 1*255 PRINTUSASCII (33..126); anything else is dropped, empty becomes NILVALUE */
export function syslogHostname(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    if (c >= 33 && c <= 126) out += ch;
    if (out.length >= 255) break;
  }
  return out.length > 0 ? out : "-";
}

export interface SyslogMessageInput {
  msgId: "audit" | "audit-gap";
  severity: number;
  at: string;
  hostname: string;
  msg: Record<string, unknown>;
}

/** one RFC 5424 SYSLOG-MSG (no framing) */
export function formatSyslogMessage(m: SyslogMessageInput): string {
  const pri = SYSLOG_FACILITY_LOG_AUDIT * 8 + m.severity;
  return `<${pri}>1 ${m.at} ${syslogHostname(m.hostname)} ${SYSLOG_APP_NAME} - ${m.msgId} - ${JSON.stringify(m.msg)}`;
}

/** RFC 5425 §4.3 octet counting: `MSG-LEN SP SYSLOG-MSG`, the length in octets of the UTF-8 bytes */
export function frameOctetCounted(message: string): Buffer {
  const body = Buffer.from(message, "utf8");
  return Buffer.concat([Buffer.from(`${body.length} `, "ascii"), body]);
}

/** the syslog messages for one batch, in chain order: the gap notice (if any) first, then one per event */
export function syslogMessagesForBatch(
  schema: string,
  events: SiemEvent[],
  batch: { afterSeq: number; fromSeq: number; gap: boolean },
  hostname: string,
): string[] {
  const out: string[] = [];
  if (batch.gap && events.length > 0) {
    out.push(
      formatSyslogMessage({
        msgId: "audit-gap",
        severity: 4,
        at: events[0]!.at,
        hostname,
        msg: { schema, gap: { afterSeq: batch.afterSeq, fromSeq: batch.fromSeq } },
      }),
    );
  }
  for (const e of events) {
    out.push(formatSyslogMessage({ msgId: "audit", severity: e.effect === "deny" ? 4 : 6, at: e.at, hostname, msg: { schema, ...e } }));
  }
  return out;
}

export type SyslogTarget = { ok: true; host: string; port: number } | { ok: false; problem: string };

/**
 * `syslog+tls://host[:port]`, nothing else: no credentials, path, query or fragment. The host is returned in the form
 * an https URL would carry it (the egress check normalises it), the port defaults to 6514.
 */
export function parseSyslogUrl(raw: string): SyslogTarget {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, problem: "url is not a URL" };
  }
  if (u.protocol !== SYSLOG_SCHEME) return { ok: false, problem: "a syslog destination's url is syslog+tls://host[:port]" };
  if (u.username || u.password) return { ok: false, problem: "url must not carry credentials" };
  if ((u.pathname !== "" && u.pathname !== "/") || u.search || u.hash) {
    return { ok: false, problem: "a syslog url is syslog+tls://host[:port], with no path, query or fragment" };
  }
  if (!u.hostname) return { ok: false, problem: "url has no host" };
  // a non-special scheme keeps the host opaque: re-parse it as https so the WHATWG host rules (IDNA, IPv6) apply
  let asHttps: URL;
  try {
    asHttps = new URL(`https://${u.host}/`);
  } catch {
    return { ok: false, problem: "url host is not a valid host" };
  }
  const port = asHttps.port ? Number(asHttps.port) : SYSLOG_TLS_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, problem: "url port is out of range" };
  return { ok: true, host: asHttps.hostname, port };
}

/** the canonical stored form */
export function canonicalSyslogUrl(t: { host: string; port: number }): string {
  return `syslog+tls://${t.host}:${t.port}`;
}

/** a PEM bundle of 1..20 certificates, each of which parses; returns the problem or null. Linear scan, no regex. */
export function caPemProblem(pem: string): string | null {
  if (pem.length < 1 || pem.length > SYSLOG_LIMITS.caPemMaxChars) return `tlsCaPem must be 1 to ${SYSLOG_LIMITS.caPemMaxChars} characters`;
  const BEGIN = "-----BEGIN CERTIFICATE-----";
  const END = "-----END CERTIFICATE-----";
  let count = 0;
  let at = 0;
  for (;;) {
    const b = pem.indexOf(BEGIN, at);
    if (b < 0) break;
    const e = pem.indexOf(END, b);
    if (e < 0) return "tlsCaPem has a certificate with no END line";
    try {
      const cert = new X509Certificate(pem.slice(b, e + END.length));
      if (!cert.ca) return "every certificate in tlsCaPem must be a CA certificate";
    } catch {
      return "tlsCaPem holds a certificate that does not parse";
    }
    count += 1;
    if (count > SYSLOG_LIMITS.caPemMaxCerts) return `tlsCaPem may hold at most ${SYSLOG_LIMITS.caPemMaxCerts} certificates`;
    at = e + END.length;
  }
  if (count === 0) return "tlsCaPem holds no PEM certificate";
  if (pem.includes("PRIVATE KEY")) return "tlsCaPem must not contain a private key";
  return null;
}

export interface SyslogSendDeps {
  resolve?: EgressResolver | undefined;
  hostname?: string | undefined;
  /** test seam over `tls.connect` */
  tlsConnect?: typeof tls.connect | undefined;
}

export type SyslogSendResult = { ok: true } | { ok: false; code: SiemErrorCode; retryAfter: null };

const TLS_ERROR_PREFIXES = ["ERR_TLS_", "ERR_SSL_", "CERT_", "UNABLE_TO_"];
const TLS_ERROR_CODES = new Set(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "HOSTNAME_MISMATCH"]);

/** a fixed code for a socket error; never the error's text */
export function syslogErrorCode(err: unknown): SiemErrorCode {
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
  if (TLS_ERROR_CODES.has(code) || TLS_ERROR_PREFIXES.some((p) => code.startsWith(p))) return "tls_handshake";
  const lib = (err as { library?: unknown })?.library;
  if (typeof lib === "string" && lib.toLowerCase().includes("ssl")) return "tls_handshake";
  if (code === "ETIMEDOUT") return "timeout";
  return "network";
}

export function localSyslogHostname(): string {
  return syslogHostname(os.hostname());
}

/**
 * Send one batch of messages over one verified TLS session. Resolves, never rejects. `messages` are unframed
 * SYSLOG-MSGs; each is framed here.
 */
export async function sendSyslogBatch(
  db: Db,
  dest: { url: string; tlsCaPem: string | null },
  messages: string[],
  deps: SyslogSendDeps = {},
): Promise<SyslogSendResult> {
  const target = parseSyslogUrl(dest.url);
  if (!target.ok) return { ok: false, code: "egress_blocked", retryAfter: null };
  const frames: Buffer[] = [];
  for (const m of messages) {
    const f = frameOctetCounted(m);
    // an allow-listed event is a few hundred octets; a larger one means the allow-list changed, so stop, never cut
    if (f.length > SYSLOG_LIMITS.maxMessageOctets) return { ok: false, code: "network", retryAfter: null };
    frames.push(f);
  }
  const decision = await checkEgress(`https://${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}/`, {
    allowList: await loadEgressAllowList(db),
    providerAllowsPlaintextHttp: false,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
  if (!decision.ok || decision.addresses.length === 0) return { ok: false, code: "egress_blocked", retryAfter: null };
  const host = decision.host.startsWith("[") && decision.host.endsWith("]") ? decision.host.slice(1, -1) : decision.host;
  const address = decision.addresses[0]!;
  const connect = deps.tlsConnect ?? tls.connect;
  const payload = Buffer.concat(frames);

  return new Promise<SyslogSendResult>((resolveSend) => {
    let settled = false;
    let written = false;
    let grace: NodeJS.Timeout | undefined;
    let socket: tls.TLSSocket | undefined;
    const finish = (r: SyslogSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      socket?.destroy();
      resolveSend(r);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout", retryAfter: null }), SYSLOG_LIMITS.timeoutMs);
    try {
      socket = connect({
        host: address,
        port: target.port,
        ...(net.isIP(host) === 0 ? { servername: host } : {}),
        ...(dest.tlsCaPem ? { ca: dest.tlsCaPem } : {}),
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        // the identity is the destination's host name, never the pinned address we dialled
        checkServerIdentity: (_dialled: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(host, cert),
      });
    } catch (err) {
      finish({ ok: false, code: syslogErrorCode(err), retryAfter: null });
      return;
    }
    socket.once("error", (err) => finish({ ok: false, code: syslogErrorCode(err), retryAfter: null }));
    socket.once("close", () => {
      if (written) finish({ ok: true });
      else finish({ ok: false, code: "network", retryAfter: null });
    });
    socket.once("secureConnect", () => {
      if (!socket!.authorized) {
        finish({ ok: false, code: "tls_handshake", retryAfter: null });
        return;
      }
      socket!.end(payload, () => {
        written = true;
        // the receiver normally closes on our FIN; if it keeps the session open, close it ourselves after a grace
        grace = setTimeout(() => finish({ ok: true }), SYSLOG_LIMITS.closeGraceMs);
      });
    });
  });
}
