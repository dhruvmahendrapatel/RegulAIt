/**
 * ADR-0334: the extension's service worker. It holds the device key, registers once, fetches and verifies the signed
 * policy, turns it into blocking rules, and relays breach events and (only when capture is on) prompts.
 *
 * Fail closed, in this order of defence:
 *  1. the manifest's `fail_closed` ruleset blocks every governed site from install, before this code ever runs;
 *  2. it is switched off only after a verified, unexpired policy's own rules are in place, and switched back on
 *     BEFORE those rules are removed (no window in which nothing blocks);
 *  3. any error on the way (no managed config, no key, registration refused, policy refused or expired, the gateway
 *     unreachable past `notAfter`) leaves or puts the ruleset back on.
 * The browser profile's signed-in account is the only identity read (`chrome.identity.getProfileUserInfo`).
 */
import {
  BROWSER_EVENT_CODES,
  BROWSER_SITE_CATALOGUE_IDS,
  BROWSER_EVENTS_PER_REQUEST,
  BROWSER_EXTENSION_PATHS,
  BROWSER_PROMPT_CAPTURE_MAX_CHARS,
  browserEventSchema,
  browserRegisterResponseSchema,
  siteForHost,
  siteVerdict,
  type BrowserEvent,
  type BrowserManagedConfig,
  type BrowserPolicy,
} from "@regulait/shared/browser-governance";
import { BLOCK_PAGE, FAIL_CLOSED_RULESET_ID } from "./manifest.js";
import { dynamicRulesFor, parseManagedConfig, verifyPolicy } from "./policy.js";
import { GatewayClient } from "./oauth.js";
import { generateDeviceKey, loadDeviceKey, publicJwkOf, saveDeviceKey } from "./proof.js";
import type { ContentRequest, VerdictReply } from "./messages.js";

const REFRESH_ALARM = "policy-refresh";
const EXPIRY_ALARM = "policy-expiry";
const REFRESH_MINUTES = 30;
const MAX_QUEUED_EVENTS = 500;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

let policy: BrowserPolicy | null = null;
let queue: BrowserEvent[] = [];
let refreshing: Promise<void> | null = null;

const now = () => Math.floor(Date.now() / 1000);

/** trailing slashes off with a bounded loop (never a repeating regex: CodeQL js/polynomial-redos) */
function trimTrailingSlashes(u: string): string {
  let end = u.length;
  while (end > 0 && u[end - 1] === "/") end--;
  return u.slice(0, end);
}

async function profileEmail(): Promise<string> {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" as chrome.identity.AccountStatus });
    return (info.email ?? "").toLowerCase();
  } catch {
    return "";
  }
}

async function managedConfig(): Promise<BrowserManagedConfig | null> {
  try {
    return parseManagedConfig(await chrome.storage.managed.get(null));
  } catch {
    return null;
  }
}

// ---- rules -------------------------------------------------------------------------------------------------------

async function failClosed(): Promise<void> {
  policy = null;
  await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [FAIL_CLOSED_RULESET_ID] });
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id) });
}

async function apply(next: BrowserPolicy, email: string): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: dynamicRulesFor(next, email, now()) });
  policy = next;
  await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [FAIL_CLOSED_RULESET_ID] });
  await chrome.alarms.create(EXPIRY_ALARM, { when: next.notAfter * 1000 });
}

// ---- the gateway ---------------------------------------------------------------------------------------------------

/** the registered device: its id, and the gateway client its key authenticates (one per config and key) */
interface Registered {
  deviceId: string;
  client: GatewayClient;
}
let registered: { gatewayUrl: string; reg: Registered } | null = null;

/**
 * The device, registering the install's key the first time (the private key never leaves WebCrypto). The gateway
 * makes the key a `browser_extension` workload identity and answers its OAuth client id.
 */
async function ensureRegistered(config: BrowserManagedConfig): Promise<Registered | null> {
  const origin = trimTrailingSlashes(config.gatewayUrl);
  if (registered && registered.gatewayUrl === origin) return registered.reg;
  let key = await loadDeviceKey();
  if (!key) {
    key = await generateDeviceKey();
    await saveDeviceKey(key);
  }
  const publicJwk = await publicJwkOf(key);
  let stored = (await chrome.storage.local.get(["deviceId", "clientId"])) as { deviceId?: string; clientId?: string };
  if (!stored.deviceId || !stored.clientId) {
    const platform = await chrome.runtime.getPlatformInfo();
    const os = ({ mac: "mac", win: "win", linux: "linux", cros: "cros" } as Record<string, string>)[platform.os] ?? "other";
    const major = Number(/Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent)?.[1] ?? "1");
    const res = await fetch(origin + BROWSER_EXTENSION_PATHS.register, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.enrolmentToken}` },
      body: JSON.stringify({ publicJwk, os, browserMajor: major, extensionVersion: EXTENSION_VERSION }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    if (res.status !== 200 && res.status !== 201) return null;
    const body = browserRegisterResponseSchema.safeParse(await res.json().catch(() => null));
    if (!body.success) return null;
    stored = { deviceId: body.data.deviceId, clientId: body.data.clientId };
    await chrome.storage.local.set(stored);
  }
  const reg = { deviceId: stored.deviceId!, client: new GatewayClient(origin, { privateKey: key.privateKey, publicJwk, clientId: stored.clientId! }) };
  registered = { gatewayUrl: origin, reg };
  return reg;
}

async function refreshOnce(): Promise<void> {
  const config = await managedConfig();
  if (!config) return failClosed();
  const reg = await ensureRegistered(config);
  if (!reg) return failClosed();
  const email = await profileEmail();
  const res = await reg.client.post(BROWSER_EXTENSION_PATHS.policy, { profileEmail: email });
  if (!res || res.status === 401 || res.status === 403 || res.status === 409) {
    // refused (a revoked device, governance turned off, no token, or a profile account other than the one this device
    // is bound to): closed until a later refresh succeeds
    return failClosed();
  }
  if (res.status !== 200) {
    // unreachable or failing: keep a still-valid policy until its own notAfter, never past it
    if (!policy || now() >= policy.notAfter) return failClosed();
    return;
  }
  const body = (await res.json().catch(() => ({}))) as { policy?: unknown };
  const v = await verifyPolicy(body.policy, config, reg.deviceId, now());
  if (!v.ok) return failClosed();
  await apply(v.policy, email);
  await flushEvents(reg);
}

async function refresh(): Promise<void> {
  if (!refreshing) {
    refreshing = refreshOnce()
      .catch(async () => {
        if (!policy || now() >= policy.notAfter) await failClosed();
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

// ---- events and capture --------------------------------------------------------------------------------------------

async function flushEvents(reg: Registered): Promise<void> {
  while (queue.length > 0) {
    const batch = queue.slice(0, BROWSER_EVENTS_PER_REQUEST);
    const res = await reg.client.post(BROWSER_EXTENSION_PATHS.events, { profileEmail: await profileEmail(), events: batch });
    // a 400 can never succeed on retry (a timestamp outside the gateway's window): drop it rather than wedge the queue
    if (res?.status !== 202 && res?.status !== 400) break;
    queue = queue.slice(batch.length);
    await chrome.storage.session.set({ queue });
  }
}

async function enqueue(event: BrowserEvent): Promise<void> {
  if (!browserEventSchema.safeParse(event).success) return;
  queue = [...queue, event].slice(-MAX_QUEUED_EVENTS);
  await chrome.storage.session.set({ queue });
  const config = await managedConfig();
  const reg = config ? await ensureRegistered(config).catch(() => null) : null;
  if (reg) await flushEvents(reg).catch(() => undefined);
}

async function capture(siteId: BrowserEvent["siteId"], path: string, text: string): Promise<void> {
  if (!policy?.promptCapture.enabled) return;
  const config = await managedConfig();
  const reg = config ? await ensureRegistered(config).catch(() => null) : null;
  if (!reg) return;
  await reg.client.post(BROWSER_EXTENSION_PATHS.promptCaptures, {
    captureId: crypto.randomUUID(),
    profileEmail: await profileEmail(),
    siteId,
    path,
    text: text.slice(0, BROWSER_PROMPT_CAPTURE_MAX_CHARS),
    capturedAt: now(),
  }).catch(() => undefined);
}

// ---- messages from the content script ------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: ContentRequest, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  // the block page (an extension page): one event per redirected navigation, with no path (the URL never reaches it)
  if (msg.type === "blocked" && sender.url.startsWith(chrome.runtime.getURL(BLOCK_PAGE))) {
    const siteId = BROWSER_SITE_CATALOGUE_IDS.find((s) => s === msg.siteId);
    const code = BROWSER_EVENT_CODES.find((c) => c === msg.code);
    if (siteId && code && code !== "dlp_match") {
      const kind = code === "account_not_allowed" || code === "account_signed_out" ? "account_blocked" : "site_blocked";
      void enqueue({ eventId: crypto.randomUUID(), kind, outcome: "blocked", code, siteId, ruleIds: [], path: null, occurredAt: now() }).finally(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  }
  // otherwise only this extension's own content script, on a governed site; the site is taken from the sender
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }
  const siteId = url.protocol === "https:" ? siteForHost(url.hostname) : null;
  if (!siteId) return false;
  void (async () => {
    if (msg.type === "verdict") {
      const email = await profileEmail();
      const v = siteVerdict(policy, siteId, email, now());
      const reply: VerdictReply = {
        siteId,
        mode: policy?.mode ?? "enforce",
        verdict: v,
        dlpRuleIds: policy ? policy.dlp.ruleIds : null,
        promptCapture: Boolean(policy?.promptCapture.enabled),
      };
      sendResponse(reply);
      return;
    }
    if (msg.type === "event") {
      await enqueue({ ...msg.event, siteId, path: url.pathname.slice(0, 512) || "/", occurredAt: now() });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "capture") {
      await capture(siteId, url.pathname.slice(0, 512) || "/", msg.text);
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false });
  })();
  return true;
});

// ---- lifecycle -----------------------------------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => void refresh());
chrome.runtime.onStartup.addListener(() => void refresh());
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "managed") {
    registered = null;
    void refresh();
  }
});
chrome.identity.onSignInChanged.addListener(() => void refresh());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === EXPIRY_ALARM) {
    if (!policy || now() >= policy.notAfter) void failClosed().then(refresh);
    return;
  }
  if (alarm.name === REFRESH_ALARM) void refresh();
});
void chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_MINUTES });
void (async () => {
  const saved = (await chrome.storage.session.get("queue")) as { queue?: BrowserEvent[] };
  queue = Array.isArray(saved.queue) ? saved.queue.slice(-MAX_QUEUED_EVENTS) : [];
  await refresh();
})();
