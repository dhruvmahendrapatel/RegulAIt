/**
 * ADR-0360 §6 — THE VENDOR-NEUTRAL EDR ADAPTER: Microsoft Defender for Endpoint, CrowdStrike Falcon and SentinelOne
 * behind one interface. Each adapter only maps the vendor's REST API onto RegulAIt's normalised shapes; it holds no
 * state, opens no socket of its own and never sees a database:
 *
 *  - every HTTP call goes through the `fetch` it is given, which the caller builds as the gateway's guarded fetch (DNS
 *    pinned, SSRF blocked, no redirects, the egress allow-list re-checked per request);
 *  - the credential is handed in per call from the sealed connection row and never returned, logged or echoed;
 *  - every vendor answer is validated (zod) and reduced to fixed enums and counts before anything is stored;
 *  - a failure is an `EdrError` with a fixed code, never the vendor's body.
 *
 * Open source first (ADR-0176): no maintained JavaScript SDK covers these APIs (MDE has none; CrowdStrike ships
 * Python and Go SDKs; SentinelOne ships none), so each adapter is a thin client. The OAuth 2.0 client-credentials grant
 * (MDE, Falcon) is `oauth4webapi`, already pinned in the gateway; webhook HMACs are `node:crypto` compared with the shared
 * `constantTimeEqual`.
 */
import { createHmac } from "node:crypto";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { constantTimeEqual } from "@regulait/shared";

export const EDR_VENDORS = ["defender", "falcon", "sentinelone"] as const;
export type EdrVendor = (typeof EDR_VENDORS)[number];
export const EDR_RISK_LEVELS = ["none", "low", "medium", "high", "critical"] as const;
export type EdrRisk = (typeof EDR_RISK_LEVELS)[number];
export const EDR_ALERT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type EdrSeverity = (typeof EDR_ALERT_SEVERITIES)[number];

/** bounds (secure by default, ADR-0180: compiled in) */
export const EDR_PAGE_SIZE = 500;
export const EDR_MAX_DEVICES_PER_SYNC = 10_000;
export const EDR_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const EDR_WEBHOOK_MAX_AGE_SECONDS = 300;
export const EDR_WEBHOOK_MAX_FUTURE_SECONDS = 30;

export type EdrErrorCode =
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "vendor_error"
  | "bad_response"
  | "too_large"
  | "already_in_progress"
  | "unsupported";

export class EdrError extends Error {
  constructor(readonly code: EdrErrorCode) {
    super(`edr: ${code}`);
    this.name = "EdrError";
  }
}

/** what a connection hands an adapter per call; the secret comes from the sealed row and goes nowhere else */
export interface EdrCredential {
  /** the vendor API origin, e.g. https://api.security.microsoft.com (already egress-checked by the caller) */
  baseUrl: string;
  /** MDE: the Entra tenant id; unused by the others */
  tenantId?: string | null;
  /** MDE, Falcon: the OAuth client id; SentinelOne: unused */
  clientId?: string | null;
  /** MDE, Falcon: the client secret; SentinelOne: the API token */
  secret: string;
  /** MDE only: the Entra authority origin (default https://login.microsoftonline.com) */
  authority?: string | null;
}

/** one device as the EDR sees it, normalised */
export interface EdrDevice {
  /** the vendor's own device id (needed to ask it to isolate) */
  vendorDeviceId: string;
  /** the host name the EDR reports; the caller keyed-hashes it and never stores it */
  hostname: string;
  risk: EdrRisk;
  isolated: boolean;
}

export interface EdrAlertCount {
  vendorDeviceId: string;
  severity: EdrSeverity;
}

export type EdrActionStatus = "pending" | "succeeded" | "failed";
export interface EdrAction {
  actionId: string;
  status: EdrActionStatus;
}

export interface EdrWebhookEvent {
  /** the vendor's event id: the replay table's key */
  eventId: string;
  /** when the vendor says the event happened (seconds since the epoch), checked against the freshness window */
  occurredAt: number;
  vendorDeviceId: string | null;
  severity: EdrSeverity | null;
}

export interface EdrAdapter {
  readonly vendor: EdrVendor;
  /** does this vendor push webhooks RegulAIt can verify? (MDE has none: it is polled) */
  readonly webhooks: boolean;
  listDevices(f: typeof fetch, c: EdrCredential): Promise<EdrDevice[]>;
  /** alerts updated since `since`, open ones only */
  listAlerts(f: typeof fetch, c: EdrCredential, since: Date): Promise<EdrAlertCount[]>;
  requestIsolation(f: typeof fetch, c: EdrCredential, vendorDeviceId: string, comment: string): Promise<EdrAction>;
  releaseIsolation(f: typeof fetch, c: EdrCredential, vendorDeviceId: string, comment: string): Promise<EdrAction>;
  actionStatus(f: typeof fetch, c: EdrCredential, action: { actionId: string; vendorDeviceId: string; kind: "isolate" | "release" }): Promise<EdrAction>;
  /** verify a webhook's authenticity (signature or shared header) over the exact raw body; parse it on success */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, webhookSecret: string, nowSeconds: number): EdrWebhookEvent | null;
}

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

const header = (h: Record<string, string | string[] | undefined>, name: string): string | null => {
  const v = h[name.toLowerCase()];
  return typeof v === "string" ? v : null;
};

/** constant-time equality: the shared helper (HKDF of both sides, so lengths may differ) */
export const safeEqual = (a: string, b: string): boolean => constantTimeEqual(a, b);

function statusError(status: number): EdrError {
  if (status === 401) return new EdrError("auth_failed");
  if (status === 403) return new EdrError("forbidden");
  if (status === 404) return new EdrError("not_found");
  if (status === 429) return new EdrError("rate_limited");
  return new EdrError("vendor_error");
}

/** read a JSON body under the size bound and validate it; the vendor's text is never surfaced */
async function json<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  if (!res.ok) throw statusError(res.status);
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > EDR_RESPONSE_MAX_BYTES) throw new EdrError("too_large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > EDR_RESPONSE_MAX_BYTES) throw new EdrError("too_large");
  let body: unknown;
  try {
    body = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new EdrError("bad_response");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new EdrError("bad_response");
  return parsed.data;
}

/** the OAuth 2.0 client-credentials grant through the guarded fetch (oauth4webapi), for MDE and Falcon */
async function clientCredentialsToken(f: typeof fetch, tokenEndpoint: string, clientId: string, secret: string, params: Record<string, string>): Promise<string> {
  const as: oauth.AuthorizationServer = { issuer: new URL(tokenEndpoint).origin, token_endpoint: tokenEndpoint };
  const client: oauth.Client = { client_id: clientId };
  try {
    const res = await oauth.clientCredentialsGrantRequest(as, client, oauth.ClientSecretPost(secret), new URLSearchParams(params), {
      [oauth.customFetch]: f,
    });
    const out = await oauth.processClientCredentialsResponse(as, client, res);
    return out.access_token;
  } catch (err) {
    if (err instanceof EdrError) throw err;
    throw new EdrError("auth_failed");
  }
}

const severityOf = (s: string): EdrSeverity | null => {
  const v = s.toLowerCase();
  if (v === "low") return "low";
  if (v === "medium") return "medium";
  if (v === "high") return "high";
  if (v === "critical") return "critical";
  return null; // informational, unknown: not counted
};

// ---------------------------------------------------------------------------
// Microsoft Defender for Endpoint (polled; no outbound webhooks)
// ---------------------------------------------------------------------------

const mdeMachines = z.object({
  value: z.array(
    z.object({
      id: z.string().min(1).max(128),
      computerDnsName: z.string().max(253).nullable().optional(),
      riskScore: z.string().max(32).nullable().optional(),
      isolated: z.boolean().optional(),
    }).passthrough(),
  ),
  "@odata.nextLink": z.string().url().optional(),
});
const mdeAlerts = z.object({
  value: z.array(z.object({ machineId: z.string().max(128).nullable().optional(), severity: z.string().max(32), status: z.string().max(32) }).passthrough()),
  "@odata.nextLink": z.string().url().optional(),
});
const mdeAction = z.object({ id: z.string().min(1).max(128), status: z.string().max(32) }).passthrough();

const mdeRisk = (s: string | null | undefined): EdrRisk => {
  // MDE riskScore: None, Informational, Low, Medium, High
  switch ((s ?? "").toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "none";
  }
};
const mdeStatus = (s: string): EdrActionStatus => (s === "Succeeded" ? "succeeded" : s === "Failed" || s === "TimeOut" || s === "Cancelled" ? "failed" : "pending");

export const defenderAdapter: EdrAdapter = {
  vendor: "defender",
  webhooks: false,
  async listDevices(f, c) {
    const token = await mdeToken(f, c);
    const out: EdrDevice[] = [];
    let url: string | undefined = `${c.baseUrl}/api/machines?$top=${EDR_PAGE_SIZE}`;
    while (url && out.length < EDR_MAX_DEVICES_PER_SYNC) {
      const page: z.infer<typeof mdeMachines> = await json(await f(sameOrigin(url, c.baseUrl), { headers: { authorization: `Bearer ${token}` } }), mdeMachines);
      for (const m of page.value) if (m.computerDnsName) out.push({ vendorDeviceId: m.id, hostname: m.computerDnsName, risk: mdeRisk(m.riskScore), isolated: m.isolated === true });
      url = page["@odata.nextLink"];
    }
    return out.slice(0, EDR_MAX_DEVICES_PER_SYNC);
  },
  async listAlerts(f, c, since) {
    const token = await mdeToken(f, c);
    const out: EdrAlertCount[] = [];
    let url: string | undefined = `${c.baseUrl}/api/alerts?$top=${EDR_PAGE_SIZE}&$filter=${encodeURIComponent(`lastUpdateTime ge ${since.toISOString()}`)}`;
    while (url && out.length < EDR_MAX_DEVICES_PER_SYNC) {
      const page: z.infer<typeof mdeAlerts> = await json(await f(sameOrigin(url, c.baseUrl), { headers: { authorization: `Bearer ${token}` } }), mdeAlerts);
      for (const a of page.value) {
        const sev = severityOf(a.severity);
        if (a.machineId && sev && a.status !== "Resolved") out.push({ vendorDeviceId: a.machineId, severity: sev });
      }
      url = page["@odata.nextLink"];
    }
    return out;
  },
  async requestIsolation(f, c, id, comment) {
    return mdeMachineAction(f, c, id, "isolate", { Comment: comment, IsolationType: "Full" });
  },
  async releaseIsolation(f, c, id, comment) {
    return mdeMachineAction(f, c, id, "unisolate", { Comment: comment });
  },
  async actionStatus(f, c, a) {
    const token = await mdeToken(f, c);
    const res = await json(await f(`${c.baseUrl}/api/machineactions/${encodeURIComponent(a.actionId)}`, { headers: { authorization: `Bearer ${token}` } }), mdeAction);
    return { actionId: res.id, status: mdeStatus(res.status) };
  },
  verifyWebhook() {
    // MDE pushes no webhooks (it streams to Event Hubs); a webhook claiming to be MDE is never accepted
    return null;
  },
};

async function mdeToken(f: typeof fetch, c: EdrCredential): Promise<string> {
  if (!c.tenantId || !c.clientId) throw new EdrError("auth_failed");
  const authority = c.authority ?? "https://login.microsoftonline.com";
  return clientCredentialsToken(f, `${authority}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, c.clientId, c.secret, {
    scope: `${new URL(c.baseUrl).origin}/.default`,
  });
}

async function mdeMachineAction(f: typeof fetch, c: EdrCredential, id: string, verb: "isolate" | "unisolate", body: Record<string, string>): Promise<EdrAction> {
  const token = await mdeToken(f, c);
  const res = await f(`${c.baseUrl}/api/machines/${encodeURIComponent(id)}/${verb}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // a second request for a device already being acted on answers 400 "Action is already in progress"
  if (res.status === 400) throw new EdrError("already_in_progress");
  const a = await json(res, mdeAction);
  return { actionId: a.id, status: mdeStatus(a.status) };
}

/** a vendor's next-page link is followed only on the connection's own origin */
function sameOrigin(url: string, base: string): string {
  if (new URL(url).origin !== new URL(base).origin) throw new EdrError("bad_response");
  return url;
}

// ---------------------------------------------------------------------------
// CrowdStrike Falcon (polled, plus signed webhooks)
// ---------------------------------------------------------------------------

const falconIds = z.object({ resources: z.array(z.string().min(1).max(128)).nullable(), meta: z.object({ pagination: z.object({ offset: z.union([z.string(), z.number()]).optional(), total: z.number().optional() }).passthrough().optional() }).passthrough() }).passthrough();
const falconHosts = z.object({
  resources: z.array(z.object({ device_id: z.string().min(1).max(128), hostname: z.string().max(253).nullable().optional(), status: z.string().max(64).optional() }).passthrough()).nullable(),
}).passthrough();
const falconAlerts = z.object({
  resources: z.array(z.object({ device: z.object({ device_id: z.string().max(128) }).passthrough().optional(), severity_name: z.string().max(32).optional(), status: z.string().max(32).optional() }).passthrough()).nullable(),
}).passthrough();
const falconAction = z.object({ resources: z.array(z.object({ id: z.string().min(1).max(128) }).passthrough()).nullable() }).passthrough();

async function falconToken(f: typeof fetch, c: EdrCredential): Promise<string> {
  if (!c.clientId) throw new EdrError("auth_failed");
  return clientCredentialsToken(f, `${c.baseUrl}/oauth2/token`, c.clientId, c.secret, {});
}

/** Falcon reports risk per alert, not per host: the host's risk is its worst open alert's severity */
const worst = (a: EdrRisk, b: EdrRisk): EdrRisk => (EDR_RISK_LEVELS.indexOf(a) >= EDR_RISK_LEVELS.indexOf(b) ? a : b);

export const falconAdapter: EdrAdapter = {
  vendor: "falcon",
  webhooks: true,
  async listDevices(f, c) {
    const token = await falconToken(f, c);
    const auth = { authorization: `Bearer ${token}` };
    const out: EdrDevice[] = [];
    let offset = "";
    for (;;) {
      const ids = await json(await f(`${c.baseUrl}/devices/queries/devices-scroll/v1?limit=${EDR_PAGE_SIZE}${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`, { headers: auth }), falconIds);
      const page = ids.resources ?? [];
      if (page.length === 0) break;
      const hosts = await json(await f(`${c.baseUrl}/devices/entities/devices/v2`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ ids: page }) }), falconHosts);
      for (const h of hosts.resources ?? []) {
        if (h.hostname) out.push({ vendorDeviceId: h.device_id, hostname: h.hostname, risk: "none", isolated: h.status === "contained" || h.status === "containment_pending" });
      }
      const next = ids.meta.pagination?.offset;
      if (next === undefined || next === "" || out.length >= EDR_MAX_DEVICES_PER_SYNC) break;
      offset = String(next);
    }
    return out.slice(0, EDR_MAX_DEVICES_PER_SYNC);
  },
  async listAlerts(f, c, since) {
    const token = await falconToken(f, c);
    const auth = { authorization: `Bearer ${token}` };
    const filter = encodeURIComponent(`updated_timestamp:>='${since.toISOString()}'+status:!'closed'`);
    const ids = await json(await f(`${c.baseUrl}/alerts/queries/alerts/v2?limit=${EDR_PAGE_SIZE}&filter=${filter}`, { headers: auth }), falconIds);
    const page = ids.resources ?? [];
    if (page.length === 0) return [];
    const alerts = await json(await f(`${c.baseUrl}/alerts/entities/alerts/v2`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ composite_ids: page }) }), falconAlerts);
    const out: EdrAlertCount[] = [];
    for (const a of alerts.resources ?? []) {
      const sev = a.severity_name ? severityOf(a.severity_name) : null;
      if (a.device?.device_id && sev) out.push({ vendorDeviceId: a.device.device_id, severity: sev });
    }
    return out;
  },
  async requestIsolation(f, c, id) {
    return falconContain(f, c, id, "contain");
  },
  async releaseIsolation(f, c, id) {
    return falconContain(f, c, id, "lift_containment");
  },
  async actionStatus(f, c, a) {
    const token = await falconToken(f, c);
    const hosts = await json(await f(`${c.baseUrl}/devices/entities/devices/v2`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ids: [a.vendorDeviceId] }) }), falconHosts);
    const status = hosts.resources?.[0]?.status ?? "";
    // Falcon has no action object: the host's containment status is the answer
    if (a.kind === "isolate") return { actionId: a.actionId, status: status === "contained" ? "succeeded" : status === "containment_pending" ? "pending" : "failed" };
    return { actionId: a.actionId, status: status === "normal" ? "succeeded" : status === "lift_containment_pending" ? "pending" : "failed" };
  },
  verifyWebhook(headers, rawBody, secret, now) {
    // Falcon webhooks: X-Cs-Primary-Signature = base64(HMAC-SHA256(secret, body + X-Cs-Delivery-Timestamp))
    const sig = header(headers, "x-cs-primary-signature");
    const ts = header(headers, "x-cs-delivery-timestamp");
    if (!sig || !ts || ts.length > 40) return null;
    const expected = createHmac("sha256", secret).update(Buffer.concat([rawBody, Buffer.from(ts, "utf8")])).digest("base64");
    if (!safeEqual(sig, expected)) return null;
    const at = /^\d{1,12}$/.test(ts) ? Number(ts) : Math.floor(Date.parse(ts) / 1000);
    if (!Number.isFinite(at) || now - at > EDR_WEBHOOK_MAX_AGE_SECONDS || at - now > EDR_WEBHOOK_MAX_FUTURE_SECONDS) return null;
    const body = parseBody(rawBody, falconWebhook);
    if (!body) return null;
    const meta = body.meta ?? body;
    const eventId = String(meta.eventid ?? meta.event_id ?? body.data?.detections?.id ?? "");
    if (!/^[A-Za-z0-9:._-]{1,200}$/.test(eventId)) return null;
    return { eventId, occurredAt: at, vendorDeviceId: body.data?.device?.device_id ?? null, severity: body.data?.detections?.severity_name ? severityOf(body.data.detections.severity_name) : null };
  },
};

async function falconContain(f: typeof fetch, c: EdrCredential, id: string, action: "contain" | "lift_containment"): Promise<EdrAction> {
  const token = await falconToken(f, c);
  const res = await f(`${c.baseUrl}/devices/entities/devices-actions/v2?action_name=${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  });
  if (res.status === 409) throw new EdrError("already_in_progress");
  const out = await json(res, falconAction);
  const got = out.resources?.[0]?.id;
  if (!got) throw new EdrError("bad_response");
  return { actionId: `${action}:${got}`, status: "pending" };
}

const falconWebhook = z
  .object({
    meta: z.object({ eventid: z.union([z.string(), z.number()]).optional(), event_id: z.union([z.string(), z.number()]).optional() }).passthrough().optional(),
    eventid: z.union([z.string(), z.number()]).optional(),
    event_id: z.union([z.string(), z.number()]).optional(),
    data: z
      .object({
        device: z.object({ device_id: z.string().max(128) }).passthrough().optional(),
        detections: z.object({ id: z.string().max(200).optional(), severity_name: z.string().max(32).optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function parseBody<T>(raw: Buffer, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(raw.toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SentinelOne (polled, plus webhooks with a shared authentication header)
// ---------------------------------------------------------------------------

const s1Agents = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(128), computerName: z.string().max(253).nullable().optional(), networkStatus: z.string().max(32).optional(), activeThreats: z.number().int().min(0).optional() }).passthrough()),
  pagination: z.object({ nextCursor: z.string().max(2048).nullable().optional() }).passthrough().optional(),
});
const s1Threats = z.object({
  data: z.array(z.object({ agentRealtimeInfo: z.object({ agentId: z.string().max(128) }).passthrough().optional(), threatInfo: z.object({ confidenceLevel: z.string().max(32).optional(), incidentStatus: z.string().max(32).optional() }).passthrough().optional() }).passthrough()),
});
const s1Action = z.object({ data: z.object({ affected: z.number().int().min(0) }).passthrough() });

const s1Webhook = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    eventId: z.union([z.string(), z.number()]).optional(),
    createdAt: z.string().max(64).optional(),
    agentId: z.string().max(128).optional(),
    agentRealtimeInfo: z.object({ agentId: z.string().max(128) }).passthrough().optional(),
    threatInfo: z.object({ confidenceLevel: z.string().max(32).optional() }).passthrough().optional(),
  })
  .passthrough();

/** S1 grades a threat by confidence: malicious is high, suspicious is medium */
const s1Severity = (confidence: string | undefined): EdrSeverity | null => (confidence === "malicious" ? "high" : confidence === "suspicious" ? "medium" : null);

export const S1_WEBHOOK_AUTH_HEADER = "x-regulait-webhook-token";

export const sentinelOneAdapter: EdrAdapter = {
  vendor: "sentinelone",
  webhooks: true,
  async listDevices(f, c) {
    const auth = { authorization: `ApiToken ${c.secret}` };
    const out: EdrDevice[] = [];
    let cursor: string | null | undefined = null;
    do {
      const page: z.infer<typeof s1Agents> = await json(await f(`${c.baseUrl}/web/api/v2.1/agents?limit=${EDR_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: auth }), s1Agents);
      for (const a of page.data) {
        if (!a.computerName) continue;
        const threats = a.activeThreats ?? 0;
        out.push({ vendorDeviceId: a.id, hostname: a.computerName, risk: threats > 0 ? "high" : "none", isolated: a.networkStatus === "disconnected" || a.networkStatus === "disconnecting" });
      }
      cursor = page.pagination?.nextCursor;
    } while (cursor && out.length < EDR_MAX_DEVICES_PER_SYNC);
    return out.slice(0, EDR_MAX_DEVICES_PER_SYNC);
  },
  async listAlerts(f, c, since) {
    const page = await json(
      await f(`${c.baseUrl}/web/api/v2.1/threats?limit=${EDR_PAGE_SIZE}&resolved=false&updatedAt__gte=${encodeURIComponent(since.toISOString())}`, { headers: { authorization: `ApiToken ${c.secret}` } }),
      s1Threats,
    );
    const out: EdrAlertCount[] = [];
    for (const t of page.data) {
      const sev = s1Severity(t.threatInfo?.confidenceLevel);
      if (t.agentRealtimeInfo?.agentId && sev) out.push({ vendorDeviceId: t.agentRealtimeInfo.agentId, severity: sev });
    }
    return out;
  },
  async requestIsolation(f, c, id) {
    return s1Network(f, c, id, "disconnect");
  },
  async releaseIsolation(f, c, id) {
    return s1Network(f, c, id, "connect");
  },
  async actionStatus(f, c, a) {
    const page = await json(await f(`${c.baseUrl}/web/api/v2.1/agents?ids=${encodeURIComponent(a.vendorDeviceId)}`, { headers: { authorization: `ApiToken ${c.secret}` } }), s1Agents);
    const status = page.data[0]?.networkStatus ?? "";
    if (a.kind === "isolate") return { actionId: a.actionId, status: status === "disconnected" ? "succeeded" : status === "disconnecting" ? "pending" : "failed" };
    return { actionId: a.actionId, status: status === "connected" ? "succeeded" : status === "connecting" ? "pending" : "failed" };
  },
  verifyWebhook(headers, rawBody, secret, now) {
    // S1 webhooks carry no signature; the console sends the shared token RegulAIt generated in a custom header, which
    // is compared in constant time. Freshness and the replay table then hold on the event's own id and time.
    const token = header(headers, S1_WEBHOOK_AUTH_HEADER);
    if (!token || !safeEqual(token, secret)) return null;
    const body = parseBody(rawBody, s1Webhook);
    if (!body) return null;
    const at = body.createdAt ? Math.floor(Date.parse(body.createdAt) / 1000) : NaN;
    if (!Number.isFinite(at) || now - at > EDR_WEBHOOK_MAX_AGE_SECONDS || at - now > EDR_WEBHOOK_MAX_FUTURE_SECONDS) return null;
    const eventId = String(body.id ?? body.eventId ?? "");
    if (!/^[A-Za-z0-9:._-]{1,200}$/.test(eventId)) return null;
    return { eventId, occurredAt: at, vendorDeviceId: body.agentRealtimeInfo?.agentId ?? body.agentId ?? null, severity: s1Severity(body.threatInfo?.confidenceLevel) };
  },
};

async function s1Network(f: typeof fetch, c: EdrCredential, id: string, verb: "disconnect" | "connect"): Promise<EdrAction> {
  const res = await f(`${c.baseUrl}/web/api/v2.1/agents/actions/${verb}`, {
    method: "POST",
    headers: { authorization: `ApiToken ${c.secret}`, "content-type": "application/json" },
    body: JSON.stringify({ filter: { ids: [id] } }),
  });
  const out = await json(res, s1Action);
  if (out.data.affected !== 1) throw new EdrError("not_found");
  return { actionId: `${verb}:${id}`, status: "pending" };
}

export const EDR_ADAPTERS: Readonly<Record<EdrVendor, EdrAdapter>> = Object.freeze({
  defender: defenderAdapter,
  falcon: falconAdapter,
  sentinelone: sentinelOneAdapter,
});

/** fold one device's open alerts into its normalised risk: the worse of the vendor's own grade and its worst alert */
export function deviceRisk(base: EdrRisk, severities: readonly EdrSeverity[]): EdrRisk {
  return severities.reduce<EdrRisk>((r, s) => worst(r, s), base);
}
