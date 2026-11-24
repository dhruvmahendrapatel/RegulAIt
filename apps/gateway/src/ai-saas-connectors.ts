/**
 * ADR-0361 §2 — THE VENDOR-NEUTRAL CONNECTOR CONTRACT for reading a sanctioned AI SaaS tenant's compliance export, and
 * the first connector (§3): the Microsoft 365 Copilot interaction export on Microsoft Graph.
 *
 * WHAT A CONNECTOR MAY DO, EXHAUSTIVELY
 *  - read its validated public configuration and its decrypted credential (never logged, never returned);
 *  - call out ONLY through `ctx.fetch`, the egress-guarded fetch (ADR-0034: allow list, DNS pinning, no redirects, a
 *    response cap), wrapped by `connectorFetch` so every request waits on the rate limiter and a 429/503 backs off.
 *    The one exception is `ctx.downloadFetch`, given only to a connector that declares `signedRedirectDownload`: the
 *    same guard, but a 3xx is handed back (never followed) so the connector can re-request a signed URL itself;
 *  - hand every short-lived token it obtains to `ctx.registerSecret`, so no error text can carry it;
 *  - yield pages of `MonitoredInteraction`s. It never writes to the database and never decides a finding: the engine
 *    (`ai-saas-monitor.ts`) records evidence and runs the detectors.
 *
 * WHAT A CONNECTOR MUST NEVER DO: write to, change or delete anything in the vendor tenant (remediation is slice 3's,
 * behind its own approval); follow a link to another origin; keep conversation text anywhere but the page it yields.
 *
 * Open source first (ADR-0176, compared in the PR body): the token comes from `@azure/identity` through
 * `@regulait/cloud-discovery`'s `azureCredential` (the `idp_entra` discovery source's path), the role check is
 * `entraWriteScope`, and the throttle/backoff wrapper is the discovery worker's `scannerFetch`. The one Graph GET with
 * `@odata.nextLink` paging is called with the guarded fetch directly, as `idp_entra` does.
 */
import { azureCredential } from "@regulait/cloud-discovery";
import {
  AI_SAAS_MONITOR_MAX_PAGES_PER_USER,
  AI_SAAS_MONITOR_MAX_USERS,
  AI_SAAS_MONITOR_SETTLE_MS,
  chatGptConversationMessageSchema,
  chatGptEnterpriseConfigSchema,
  chatGptLogFileListSchema,
  claudeChatListSchema,
  claudeChatMessagesSchema,
  claudeEnterpriseConfigSchema,
  graphAiInteractionPageSchema,
  graphUserPageSchema,
  m365CopilotConfigSchema,
  normalizeChatGptMessage,
  normalizeClaudeMessages,
  normalizeGraphInteraction,
  type AiSaasMonitorErrorCode,
  type AiSaasMonitorVendor,
  type M365CopilotConfig,
  type MonitoredInteraction,
} from "@regulait/shared";
import { dedupedSecretSink, scannerFetch } from "./discovery-cloud-scanners.js";
import { entraWriteScope } from "./discovery-wider-scanners.js";
import { createHash } from "node:crypto";
import { EgressBlockedError, egressRefusal } from "./egress-guard.js";
import { errMessage } from "./err-serializer.js";
import { isUsableVendorRef, type ConnectorRemediation, type RemediationTarget } from "./ai-saas-remediation-contract.js";

/** a stored credential, decrypted for one run */
export interface ConnectorCredential {
  /** the vendor secret (an Entra client secret, a compliance API key) */
  secret: string;
}

export interface ConnectorContext {
  config: Readonly<Record<string, unknown>>;
  credential: ConnectorCredential;
  /** the ONLY network access a connector gets: the egress-guarded fetch. It refuses every redirect. */
  fetch: typeof fetch;
  /**
   * Only for a connector that declares `signedRedirectDownload`: a second guarded fetch whose 3xx comes back to the
   * connector (never followed by the guard), with that connector's larger per-file body cap. Every other request,
   * a token request included, goes through `fetch` (review #985 R2 [1], S4 [2]; ADR-0180).
   */
  downloadFetch?: typeof fetch;
  /** await before every outbound request (the per-connector spacing limiter) */
  throttle: () => Promise<void>;
  /** on 429/503: waits the bounded Retry-After and answers true to retry, false to give up */
  backoff: (res: Response) => Promise<boolean>;
  registerSecret: (value: string) => void;
  signal: AbortSignal;
}

export interface ConnectorAuthorisation {
  /** `write` refuses the credential before anything is read; `unverified` = the vendor offers no probe */
  scope: "read_only" | "unverified" | "write";
  /** the permissions the vendor reported, for the run's audit row (names only, never a token) */
  permissions: string[];
  /** the bearer header for the read requests; already registered for scrubbing */
  headers: Record<string, string>;
}

export interface InteractionPage {
  interactions: MonitoredInteraction[];
  /** the vendor-side unit the page belongs to (a user id), for run counters */
  unit: string;
}

export interface ComplianceConnector {
  vendor: AiSaasMonitorVendor;
  /** the least spacing between two requests, set under the vendor's documented rate limit */
  minSpacingMs: number;
  /** shape-check the public configuration: null when acceptable, else the problem */
  validateConfig: (config: unknown) => string | null;
  /**
   * Does a configuration change make the connector read MORE than before (more people, a wider tenant scope, a longer
   * backfill)? Required of every connector, so a new one cannot forget its own scope fields (review #985 S4 [1]): on an
   * enabled connector a widening needs a `settings_relax` step-up and is audited as `widened: true`.
   */
  configWidens: (before: unknown, after: unknown) => boolean;
  /** declared by a connector whose export answers with a 3xx to a signed URL: the per-file body cap for `downloadFetch` */
  signedRedirectDownload?: { maxBytes: number };
  authorise: (ctx: ConnectorContext) => Promise<ConnectorAuthorisation>;
  listInteractions: (ctx: ConnectorContext, auth: ConnectorAuthorisation, window: { start: Date; end: Date }) => AsyncIterable<InteractionPage>;
  /** ADR-0361 slice 3: the vendor's documented delete, called only by the approved remediation flow; absent = none */
  remediation?: ConnectorRemediation;
}

/** a delete or read whose answer is 200 (done), 404 (already gone) or a fixed error code */
/** refuse an id that cannot be sent as one exact path segment (#991 S3 [3]); nothing is sent */
function assertUsableTarget(target: RemediationTarget): void {
  if (!isUsableVendorRef(target.conversationRef, "conversation") || !isUsableVendorRef(target.actorRef, "actor")) {
    throw new ConnectorError("bad_response", "the stored conversation or user id is not a usable vendor id; nothing was sent");
  }
}

async function vendorDelete(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ outcome: "deleted" | "absent"; vendorStatus: number }> {
  const res = await fetchImpl(url, { method: "DELETE", headers: { ...headers, accept: "application/json" }, signal });
  await res.arrayBuffer().catch(() => undefined);
  if (res.ok) return { outcome: "deleted", vendorStatus: res.status };
  if (res.status === 404) return { outcome: "absent", vendorStatus: 404 };
  throw statusError(res.status, "the conversation delete");
}

/**
 * A failure a connector reports: a fixed code and a sentence RegulAIt wrote. The vendor's response body never goes
 * in `detail`, so an error that echoes a key cannot reach a run row, a log or a response.
 */
export class ConnectorError extends Error {
  constructor(
    readonly code: AiSaasMonitorErrorCode,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "ConnectorError";
  }
}

/** a connector's `validateConfig`: the schema's first problem, bounded, or null */
function zodValidator(schema: { safeParse: (v: unknown) => { success: true } | { success: false; error: { issues: { message: string }[] } } }) {
  return (config: unknown): string | null => {
    const parsed = schema.safeParse(config);
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? "invalid configuration").slice(0, 200);
  };
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const backfillWidens = (b: Record<string, unknown>, a: Record<string, unknown>) => Number(a.backfillDays ?? 0) > Number(b.backfillDays ?? 0);

/** the discovery worker's throttle-and-backoff wrapper around the guarded fetch; token responses are never digested */
export function connectorFetch(ctx: ConnectorContext): typeof fetch {
  return scannerFetch({ fetch: ctx.fetch, throttle: ctx.throttle, backoff: ctx.backoff, recordRaw: () => undefined }, { digest: false });
}

function statusError(status: number, what: string): ConnectorError {
  if (status === 401) return new ConnectorError("unauthorized", `the vendor refused the credential (HTTP 401) reading ${what}`);
  if (status === 403) return new ConnectorError("forbidden", `the vendor refused access (HTTP 403) reading ${what}; check the app's consented permissions and licences`);
  if (status === 429 || status === 503) return new ConnectorError("rate_limited", `the vendor kept throttling (HTTP ${status}) reading ${what}`);
  return new ConnectorError("http_error", `the vendor answered HTTP ${status} reading ${what}`);
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, signal: AbortSignal, what: string): Promise<unknown> {
  const res = await fetchImpl(url, { method: "GET", headers: { ...headers, accept: "application/json" }, signal });
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    throw statusError(res.status, what);
  }
  try {
    return await res.json();
  } catch {
    throw new ConnectorError("bad_response", `the vendor's answer reading ${what} was not JSON`);
  }
}

/** a `@odata.nextLink` is followed only on the same https origin (ADR-0361 §9: no SSRF through a link) */
export function sameOriginNext(origin: string, next: unknown): string | null {
  if (typeof next !== "string" || next.length === 0) return null;
  let u: URL;
  try {
    u = new URL(next);
  } catch {
    throw new ConnectorError("bad_response", "the vendor's next-page link was not a URL; nothing more was read");
  }
  if (u.origin !== origin || u.protocol !== "https:" || u.username || u.password) {
    throw new ConnectorError("bad_response", "the vendor's next-page link pointed at another origin; it was not followed");
  }
  return u.toString();
}

// --------------------------------------------------------------------------------------------------------------------
// Microsoft 365 Copilot (Graph aiInteractionHistory, v1.0)
// --------------------------------------------------------------------------------------------------------------------

export const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
export const M365_INTERACTION_PERMISSION = "AiEnterpriseInteraction.Read.All";
export const M365_USER_LIST_PERMISSION = "User.Read.All";

function m365Config(raw: unknown): M365CopilotConfig {
  const parsed = m365CopilotConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConnectorError("internal", "the connector's stored configuration no longer matches its schema");
  return parsed.data;
}

/** OData string literal: single quotes doubled (the value is from the documented app-class enum anyway) */
const odataString = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** the documented filter: both createdDateTime bounds (Microsoft requires both), plus optional app classes */
export function m365InteractionsUrl(userId: string, window: { start: Date; end: Date }, appClasses: readonly string[]): string {
  const clauses = [`createdDateTime gt ${window.start.toISOString()} and createdDateTime lt ${window.end.toISOString()}`];
  if (appClasses.length) clauses.push(`(${appClasses.map((c) => `appClass eq ${odataString(c)}`).join(" or ")})`);
  const u = new URL(`${GRAPH_ORIGIN}/v1.0/copilot/users/${encodeURIComponent(userId)}/interactionHistory/getAllEnterpriseInteractions`);
  u.searchParams.set("$filter", clauses.join(" and "));
  u.searchParams.set("$top", "100");
  return u.toString();
}

async function m365Authorise(ctx: ConnectorContext): Promise<ConnectorAuthorisation> {
  const cfg = m365Config(ctx.config);
  const onSecret = dedupedSecretSink(ctx.registerSecret);
  const tokenSource = azureCredential({
    fetch: connectorFetch(ctx),
    credentialFetch: connectorFetch(ctx),
    onSecret,
    credential: { mode: "azure_client_secret", tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecret: ctx.credential.secret },
  });
  let token: string;
  try {
    const tok = await tokenSource.getToken(GRAPH_SCOPE, { abortSignal: ctx.signal });
    if (!tok?.token) throw new Error("no token");
    token = tok.token;
  } catch (err) {
    // only the AADSTS code is kept from the error text (as idp_entra does); the guard's refusal is named
    const msg = errMessage(err);
    if (egressRefusal(err) !== null || /egress/i.test(msg.slice(0, 2000))) throw new ConnectorError("egress_refused", "the egress guard refused login.microsoftonline.com: add it to the egress allow-list");
    const code = /AADSTS[0-9]{5,7}/.exec(msg.slice(0, 2000))?.[0];
    throw new ConnectorError("token_failed", `the Entra token request failed${code ? ` (${code})` : ""}`);
  }
  onSecret(token);
  const write = entraWriteScope(token);
  const permissions = write.roles;
  if (write.scope === "write") return { scope: "write", permissions, headers: {} };
  if (!permissions.includes(M365_INTERACTION_PERMISSION)) {
    throw new ConnectorError("missing_permission", `the app has not been granted ${M365_INTERACTION_PERMISSION} (application) with admin consent`);
  }
  if (cfg.users.mode === "all" && !permissions.includes(M365_USER_LIST_PERMISSION)) {
    throw new ConnectorError("missing_permission", `every user is in scope, which needs ${M365_USER_LIST_PERMISSION} (application) to list them`);
  }
  return { scope: write.scope, permissions, headers: { authorization: `Bearer ${token}` } };
}

async function m365Users(ctx: ConnectorContext, cfg: M365CopilotConfig, headers: Record<string, string>): Promise<string[]> {
  if (cfg.users.mode === "listed") return [...new Set(cfg.users.ids)];
  const fetchImpl = connectorFetch(ctx);
  const ids: string[] = [];
  let url: string | null = `${GRAPH_ORIGIN}/v1.0/users?$select=id&$top=999`;
  for (let page = 1; url; page++) {
    if (page > 20) throw new ConnectorError("page_limit", "listing the tenant's users needed more than 20 pages; list the users in scope instead");
    const parsed = graphUserPageSchema.safeParse(await getJson(fetchImpl, url, headers, ctx.signal, "the user list"));
    if (!parsed.success) throw new ConnectorError("bad_response", "the user list did not match the vendor's documented shape");
    for (const u of parsed.data.value) ids.push(u.id);
    if (ids.length > AI_SAAS_MONITOR_MAX_USERS) {
      throw new ConnectorError("interaction_limit", `the tenant has more than ${AI_SAAS_MONITOR_MAX_USERS} users; list the users in scope instead`);
    }
    url = sameOriginNext(GRAPH_ORIGIN, parsed.data["@odata.nextLink"]);
  }
  return ids;
}

async function* m365ListInteractions(ctx: ConnectorContext, auth: ConnectorAuthorisation, window: { start: Date; end: Date }): AsyncIterable<InteractionPage> {
  const cfg = m365Config(ctx.config);
  const users = await m365Users(ctx, cfg, auth.headers);
  const fetchImpl = connectorFetch(ctx);
  for (const userId of users) {
    let url: string | null = m365InteractionsUrl(userId, window, cfg.appClasses);
    const seenLinks = new Set<string>();
    for (let page = 1; url; page++) {
      if (page > AI_SAAS_MONITOR_MAX_PAGES_PER_USER) {
        throw new ConnectorError("page_limit", `one user had more than ${AI_SAAS_MONITOR_MAX_PAGES_PER_USER} pages in the window; nothing past them was read, the window was not advanced, and the next run asks for half as long`);
      }
      const body = await getJson(fetchImpl, url, auth.headers, ctx.signal, "a user's Copilot interactions");
      const parsed = graphAiInteractionPageSchema.safeParse(body);
      if (!parsed.success) throw new ConnectorError("bad_response", "a Copilot interaction page did not match the vendor's documented shape");
      yield { unit: userId, interactions: parsed.data.value.map(normalizeGraphInteraction) };
      const next = sameOriginNext(GRAPH_ORIGIN, parsed.data["@odata.nextLink"]);
      if (next && seenLinks.has(next)) throw new ConnectorError("bad_response", "the vendor returned a next-page link it had already returned");
      if (next) seenLinks.add(next);
      url = next;
    }
  }
}

/** M365: every user, an added listed user, a dropped app-class filter, or a longer backfill */
export function m365ConfigWidens(before: unknown, after: unknown): boolean {
  const b = asRecord(before) as { users?: { mode?: string; ids?: string[] }; appClasses?: string[] };
  const a = asRecord(after) as typeof b;
  if (a.users?.mode === "all" && b.users?.mode !== "all") return true;
  if (a.users?.mode === "listed" && b.users?.mode === "listed") {
    const prev = new Set(b.users.ids ?? []);
    if ((a.users.ids ?? []).some((id) => !prev.has(id))) return true;
  }
  const bc = b.appClasses ?? [];
  const ac = a.appClasses ?? [];
  if (bc.length > 0 && (ac.length === 0 || ac.some((c) => !bc.includes(c)))) return true;
  return backfillWidens(asRecord(before), asRecord(after));
}

export const M365_COPILOT_CONNECTOR: ComplianceConnector = {
  vendor: "m365_copilot",
  minSpacingMs: 250,
  validateConfig: zodValidator(m365CopilotConfigSchema),
  configWidens: m365ConfigWidens,
  authorise: m365Authorise,
  listInteractions: m365ListInteractions,
};

// --------------------------------------------------------------------------------------------------------------------
// ChatGPT Enterprise: the Compliance Logs Platform (OpenAPI 2.5.42). Read-only: the list and download GETs only.
// --------------------------------------------------------------------------------------------------------------------

export const CHATGPT_ORIGIN = "https://api.chatgpt.com";
const CHATGPT_MAX_LIST_PAGES = 50;
/**
 * One compliance log file, read whole (its SHA-256 is checked before anything in it is written). The vendor decides a
 * file's size and a narrower window cannot split it, so this cap sits well above the 16 MiB per-response cap that
 * applies to every other request (review #985 R2 [2]).
 */
export const CHATGPT_MAX_LOG_FILE_BYTES = 128 * 1024 * 1024;

function chatGptLogsBase(raw: unknown): string {
  const parsed = chatGptEnterpriseConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConnectorError("internal", "the connector's stored configuration no longer matches its schema");
  const seg = parsed.data.principal === "organization" ? "organizations" : "workspaces";
  return `${CHATGPT_ORIGIN}/v1/compliance/${seg}/${encodeURIComponent(parsed.data.principalId)}/logs`;
}

async function chatGptAuthorise(ctx: ConnectorContext): Promise<ConnectorAuthorisation> {
  const headers = { authorization: `Bearer ${ctx.credential.secret}` };
  // a one-item list proves the key reaches the conversation logs; OpenAI documents no probe of its scopes
  const u = new URL(chatGptLogsBase(ctx.config));
  u.searchParams.set("event_type", "CONVERSATION_MESSAGE");
  u.searchParams.set("limit", "1");
  const parsed = chatGptLogFileListSchema.safeParse(await getJson(connectorFetch(ctx), u.toString(), headers, ctx.signal, "the compliance log list"));
  if (!parsed.success) throw new ConnectorError("bad_response", "the compliance log list did not match the vendor's documented shape");
  return { scope: "unverified", permissions: [], headers };
}

/**
 * The log file's bytes: a 307 to a signed URL (re-requested through the guard, without our key), or the body itself.
 * Only this function uses `ctx.downloadFetch`, the one fetch that hands a 3xx back.
 */
async function chatGptDownload(ctx: ConnectorContext, url: string, headers: Record<string, string>): Promise<Uint8Array> {
  if (!ctx.downloadFetch) throw new ConnectorError("internal", "the log download fetch was not provided to this connector");
  const fetchImpl = scannerFetch({ fetch: ctx.downloadFetch, throttle: ctx.throttle, backoff: ctx.backoff, recordRaw: () => undefined }, { digest: false });
  const first = await fetchImpl(url, { method: "GET", headers, signal: ctx.signal });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    let target: URL;
    try {
      target = new URL(location ?? "", url);
    } catch {
      throw new ConnectorError("bad_response", "the log download redirect was not a URL");
    }
    if (target.protocol !== "https:" || target.username || target.password) {
      throw new ConnectorError("bad_response", "the log download redirect was not a plain https URL; it was not followed");
    }
    // a signed URL is a bearer credential: scrubbed from anything stored, and our key is not sent to that host
    ctx.registerSecret(target.toString());
    try {
      res = await fetchImpl(target.toString(), { method: "GET", headers: { accept: "application/jsonl, application/json, */*" }, signal: ctx.signal });
    } catch (err) {
      for (let e: unknown = err, i = 0; e && i < 8; e = (e as { cause?: unknown }).cause, i++) {
        if (e instanceof EgressBlockedError) {
          throw new ConnectorError("egress_refused", `the log download redirected to ${target.hostname}, which is not on the egress allow-list: add it to read the compliance logs`);
        }
      }
      throw err;
    }
    if (res.status >= 300 && res.status < 400) throw new ConnectorError("bad_response", "the signed log URL redirected again; it was not followed");
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    throw statusError(res.status, "a compliance log file");
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function* chatGptListInteractions(ctx: ConnectorContext, auth: ConnectorAuthorisation, window: { start: Date; end: Date }): AsyncIterable<InteractionPage> {
  const base = chatGptLogsBase(ctx.config);
  const fetchImpl = connectorFetch(ctx);
  let after = window.start.toISOString();
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    if (page > CHATGPT_MAX_LIST_PAGES) throw new ConnectorError("page_limit", `the log list had more than ${CHATGPT_MAX_LIST_PAGES} pages in the window; the window was not advanced`);
    const u = new URL(base);
    u.searchParams.set("event_type", "CONVERSATION_MESSAGE");
    u.searchParams.set("after", after);
    u.searchParams.set("before", window.end.toISOString());
    u.searchParams.set("limit", "100");
    const list = chatGptLogFileListSchema.safeParse(await getJson(fetchImpl, u.toString(), auth.headers, ctx.signal, "the compliance log list"));
    if (!list.success) throw new ConnectorError("bad_response", "the compliance log list did not match the vendor's documented shape");
    for (const file of list.data.data) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      if ((file.file_size ?? 0) > CHATGPT_MAX_LOG_FILE_BYTES) {
        throw new ConnectorError(
          "response_too_large",
          `compliance log file ${file.id} is ${Math.ceil((file.file_size ?? 0) / 1048576)} MiB, over the ${CHATGPT_MAX_LOG_FILE_BYTES / 1048576} MiB per-file limit; a shorter window cannot split a vendor file, so ask the vendor to split it and run again`,
        );
      }
      const bytes = await chatGptDownload(ctx, `${base}/${encodeURIComponent(file.id)}`, auth.headers);
      // the hash is over the bytes as sent: decoding first would drop a BOM or replace invalid bytes (review #985 R2 [4])
      if (file.file_sha256 && createHash("sha256").update(bytes).digest("hex") !== file.file_sha256.toLowerCase()) {
        throw new ConnectorError("bad_response", "a compliance log file did not match the SHA-256 the vendor listed for it; nothing from it was written");
      }
      const body = new TextDecoder("utf-8").decode(bytes);
      const interactions = [];
      for (const line of body.split("\n")) {
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          throw new ConnectorError("bad_response", "a compliance log file held a line that was not JSON");
        }
        // only conversation messages are read; any other record type in the file is not ours to keep
        if ((raw as { type?: unknown })?.type !== "CONVERSATION_MESSAGE") continue;
        const rec = chatGptConversationMessageSchema.safeParse(raw);
        if (!rec.success) throw new ConnectorError("bad_response", "a conversation message did not match the vendor's documented shape");
        interactions.push(normalizeChatGptMessage(rec.data));
      }
      yield { unit: file.id, interactions };
    }
    if (!list.data.has_more) return;
    const next = list.data.last_end_time;
    if (!next || next === after) throw new ConnectorError("bad_response", "the log list said it had more but gave no new cursor");
    after = next;
  }
}

/**
 * `DELETE …/users/{user_id}/conversations/{conversation_id}` (the documented, user-scoped route; the workspace-wide
 * legacy route only when the record carried no user). It needs a key with the compliance_export delete scope: the
 * connector's separate `remediate` credential, never the read key.
 */
const CHATGPT_REMEDIATION: ConnectorRemediation = {
  kind: "vendor",
  deleteConversation: async (ctx, target) => {
    assertUsableTarget(target);
    const base = chatGptLogsBase(ctx.config).replace(/\/logs$/, "");
    const url = target.actorRef
      ? `${base}/users/${encodeURIComponent(target.actorRef)}/conversations/${encodeURIComponent(target.conversationRef)}`
      : `${base}/conversations/${encodeURIComponent(target.conversationRef)}`;
    return vendorDelete(connectorFetch(ctx), url, { authorization: `Bearer ${ctx.credential.secret}` }, ctx.signal);
  },
};

/**
 * ChatGPT: any change of principal is a different population (another workspace, or a workspace to the whole API
 * Platform organization), so it is a widening, as is a longer backfill. Defaults apply as the schema applies them.
 */
export function chatGptConfigWidens(before: unknown, after: unknown): boolean {
  const b = asRecord(before);
  const a = asRecord(after);
  if ((a.principal ?? "workspace") !== (b.principal ?? "workspace")) return true;
  if (a.principalId !== b.principalId) return true;
  return backfillWidens(b, a);
}

export const CHATGPT_ENTERPRISE_CONNECTOR: ComplianceConnector = {
  vendor: "chatgpt_enterprise",
  remediation: CHATGPT_REMEDIATION,
  // 100 requests a minute per workspace per route (OpenAPI info): one request every 700 ms stays under it
  minSpacingMs: 700,
  validateConfig: zodValidator(chatGptEnterpriseConfigSchema),
  configWidens: chatGptConfigWidens,
  signedRedirectDownload: { maxBytes: CHATGPT_MAX_LOG_FILE_BYTES },
  authorise: chatGptAuthorise,
  listInteractions: chatGptListInteractions,
};

// --------------------------------------------------------------------------------------------------------------------
// Claude Enterprise: the Compliance API (anthropic-version 2026-10-21). Read-only: the chat list and message GETs.
// --------------------------------------------------------------------------------------------------------------------

export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
export const ANTHROPIC_COMPLIANCE_VERSION = "2026-10-21";
const CLAUDE_MAX_CHAT_PAGES = 50;
/** message pages that held a message inside the window, per chat */
const CLAUDE_MAX_MESSAGE_PAGES = 50;
/**
 * message pages wholly outside the window, per chat: a long-lived chat updated in the window still pages through its
 * older history to reach the new messages, and those pages must not exhaust the in-window cap on every run, which a
 * shorter window cannot fix (review #985 R2 [3]). Bounded separately, and higher, because each such page is cheap.
 */
const CLAUDE_MAX_SKIPPED_MESSAGE_PAGES = 500;
/** a message this far before the window start is still read: the export settles behind real time (the evidence key dedupes) */
const CLAUDE_WINDOW_SLACK_MS = AI_SAAS_MONITOR_SETTLE_MS;

function claudeConfig(raw: unknown) {
  const parsed = claudeEnterpriseConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConnectorError("internal", "the connector's stored configuration no longer matches its schema");
  return parsed.data;
}

async function claudeAuthorise(ctx: ConnectorContext): Promise<ConnectorAuthorisation> {
  claudeConfig(ctx.config);
  const headers = { "x-api-key": ctx.credential.secret, "anthropic-version": ANTHROPIC_COMPLIANCE_VERSION };
  const parsed = claudeChatListSchema.safeParse(await getJson(connectorFetch(ctx), `${ANTHROPIC_ORIGIN}/v1/compliance/apps/chats?limit=1`, headers, ctx.signal, "the chat list"));
  if (!parsed.success) throw new ConnectorError("bad_response", "the chat list did not match the vendor's documented shape");
  return { scope: "unverified", permissions: [], headers };
}

async function* claudeListInteractions(ctx: ConnectorContext, auth: ConnectorAuthorisation, window: { start: Date; end: Date }): AsyncIterable<InteractionPage> {
  const cfg = claudeConfig(ctx.config);
  const fetchImpl = connectorFetch(ctx);
  let afterId: string | null = null;
  const cursors = new Set<string>();
  for (let page = 1; ; page++) {
    if (page > CLAUDE_MAX_CHAT_PAGES) throw new ConnectorError("page_limit", `the chat list had more than ${CLAUDE_MAX_CHAT_PAGES} pages in the window; the window was not advanced`);
    // org-wide incremental polling, as Anthropic documents it: order_by=updated_at, an updated_at window, after_id paging
    const u = new URL(`${ANTHROPIC_ORIGIN}/v1/compliance/apps/chats`);
    u.searchParams.set("order_by", "updated_at");
    u.searchParams.set("updated_at.gte", window.start.toISOString());
    u.searchParams.set("updated_at.lt", window.end.toISOString());
    u.searchParams.set("limit", "100");
    for (const org of cfg.organizationIds) u.searchParams.append("organization_ids[]", org);
    if (afterId) u.searchParams.set("after_id", afterId);
    const chats = claudeChatListSchema.safeParse(await getJson(fetchImpl, u.toString(), auth.headers, ctx.signal, "the chat list"));
    if (!chats.success) throw new ConnectorError("bad_response", "the chat list did not match the vendor's documented shape");
    const from = window.start.getTime() - CLAUDE_WINDOW_SLACK_MS;
    for (const chat of chats.data.data) {
      let msgAfter: string | null = null;
      const msgCursors = new Set<string>();
      let inWindowPages = 0;
      let skippedPages = 0;
      for (;;) {
        const mu = new URL(`${ANTHROPIC_ORIGIN}/v1/compliance/apps/chats/${encodeURIComponent(chat.id)}/messages`);
        if (msgAfter) mu.searchParams.set("after_id", msgAfter);
        const msgs = claudeChatMessagesSchema.safeParse(await getJson(fetchImpl, mu.toString(), auth.headers, ctx.signal, "a chat's messages"));
        if (!msgs.success) throw new ConnectorError("bad_response", "a chat's messages did not match the vendor's documented shape");
        // only the window's messages are yielded: one after it belongs to the next run, one before it to an earlier run
        const all = normalizeClaudeMessages(msgs.data);
        const inWindow = all.filter((i) => i.occurredAt.getTime() >= from && i.occurredAt < window.end);
        if (inWindow.length > 0) {
          if (++inWindowPages > CLAUDE_MAX_MESSAGE_PAGES) {
            throw new ConnectorError("page_limit", `one chat had more than ${CLAUDE_MAX_MESSAGE_PAGES} message pages in the window; the window was not advanced, and the next run asks for half as long`);
          }
          yield { unit: chat.id, interactions: inWindow };
        } else if (++skippedPages > CLAUDE_MAX_SKIPPED_MESSAGE_PAGES) {
          throw new ConnectorError("page_limit", `one chat had more than ${CLAUDE_MAX_SKIPPED_MESSAGE_PAGES} message pages outside the window; the window was not advanced`);
        }
        // newest-first paging: once a page reaches back before the window, every later page is older still
        const times = msgs.data.chat_messages.map((m) => Date.parse(m.created_at));
        const newestFirst = times.length > 1 && times[0]! > times[times.length - 1]!;
        if (newestFirst && Math.min(...times) < from) break;
        if (!msgs.data.has_more || !msgs.data.last_id) break;
        if (msgCursors.has(msgs.data.last_id)) throw new ConnectorError("bad_response", "the vendor returned a message cursor it had already returned");
        msgCursors.add(msgs.data.last_id);
        msgAfter = msgs.data.last_id;
      }
    }
    if (!chats.data.has_more || !chats.data.last_id) return;
    if (cursors.has(chats.data.last_id)) throw new ConnectorError("bad_response", "the vendor returned a chat cursor it had already returned");
    cursors.add(chats.data.last_id);
    afterId = chats.data.last_id;
  }
}

/** `DELETE /v1/compliance/apps/chats/{id}` with a `delete:compliance_user_data` key; deletes are permanent */
const CLAUDE_REMEDIATION: ConnectorRemediation = {
  kind: "vendor",
  deleteConversation: async (ctx, target) => {
    assertUsableTarget(target);
    return vendorDelete(
      connectorFetch(ctx),
      `${ANTHROPIC_ORIGIN}/v1/compliance/apps/chats/${encodeURIComponent(target.conversationRef)}`,
      { "x-api-key": ctx.credential.secret, "anthropic-version": ANTHROPIC_COMPLIANCE_VERSION },
      ctx.signal,
    );
  },
  conversationGone: async (ctx, target) => {
    assertUsableTarget(target);
    const res = await connectorFetch(ctx)(`${ANTHROPIC_ORIGIN}/v1/compliance/apps/chats/${encodeURIComponent(target.conversationRef)}/messages`, {
      method: "GET",
      headers: { "x-api-key": ctx.credential.secret, "anthropic-version": ANTHROPIC_COMPLIANCE_VERSION, accept: "application/json" },
      signal: ctx.signal,
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 404) return true;
    if (res.ok) return false;
    throw statusError(res.status, "the chat's messages");
  },
};

/** Claude: an empty organization list is org-wide, so narrowed → org-wide or an added organization widens; so does a longer backfill */
export function claudeConfigWidens(before: unknown, after: unknown): boolean {
  const b = asRecord(before);
  const a = asRecord(after);
  const bo = Array.isArray(b.organizationIds) ? (b.organizationIds as unknown[]) : [];
  const ao = Array.isArray(a.organizationIds) ? (a.organizationIds as unknown[]) : [];
  if (bo.length > 0 && ao.length === 0) return true;
  if (bo.length > 0 && ao.some((o) => !bo.includes(o))) return true;
  return backfillWidens(b, a);
}

export const CLAUDE_ENTERPRISE_CONNECTOR: ComplianceConnector = {
  vendor: "claude_enterprise",
  remediation: CLAUDE_REMEDIATION,
  // 600 requests a minute per parent organization, shared by every key: one every 150 ms leaves room for others
  minSpacingMs: 150,
  validateConfig: zodValidator(claudeEnterpriseConfigSchema),
  configWidens: claudeConfigWidens,
  authorise: claudeAuthorise,
  listInteractions: claudeListInteractions,
};

/** THE PRODUCTION REGISTRY: one line per connector */
export const AI_SAAS_CONNECTORS: ReadonlyMap<AiSaasMonitorVendor, ComplianceConnector> = new Map(
  [M365_COPILOT_CONNECTOR, CHATGPT_ENTERPRISE_CONNECTOR, CLAUDE_ENTERPRISE_CONNECTOR].map((c) => [c.vendor, c] as const),
);
