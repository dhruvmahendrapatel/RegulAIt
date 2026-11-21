/**
 * ADR-0334: the content script, on governed AI sites only (the manifest's matches are the catalogue).
 *
 * It reads one thing from the page: the text of the prompt composer at the moment the person sends it (a send key or
 * a send button), and checks it against the shared credential rules before the page's own handlers run (capture
 * phase). A match stops the send and says why on screen; the worker records the breach with the rule ids, never the
 * text. It shows a persistent notice while prompt capture is on. It never reads page content otherwise, never reads
 * cookies or storage, and never changes the page beyond its own notice.
 *
 * Honest limits (ADR-0334): a prompt sent by script without a key press or button click, voice input, pasted files
 * and drag-and-drop uploads are not checked by this slice.
 */
import { siteForHost } from "@regulait/shared/browser-governance/constants";
import { blockPath } from "./manifest.js";
import { decideSend, isSendKey, looksLikeSendButton } from "./composer.js";
import type { ContentEvent, ContentRequest, VerdictReply } from "./messages.js";
import tokensCss from "../../../apps/web/src/theme/tokens.css";
import uiCss from "../static/ui.css";

let reply: VerdictReply | null = null;
let composer: HTMLElement | null = null;
let lastCaptured = { text: "", at: 0 };

const send = <T>(msg: ContentRequest): Promise<T | null> =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r: T | undefined) => resolve(chrome.runtime.lastError ? null : (r ?? null)));
    } catch {
      resolve(null);
    }
  });

const report = (event: Omit<ContentEvent, "eventId">) => void send({ type: "event", event: { ...event, eventId: crypto.randomUUID() } });

// ---- the extension's own UI, in a closed shadow root (the page cannot style or read it) ---------------------------

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;

function ui(): ShadowRoot {
  if (root) return root;
  host = document.createElement("regulait-notice");
  root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(tokensCss.replace(/:root/g, ":host") + uiCss);
  root.adoptedStyleSheets = [sheet];
  (document.body ?? document.documentElement).appendChild(host);
  return root;
}

function showNotice(id: string, title: string, body: string, tone: "critical" | "info", dismissible: boolean): void {
  const r = ui();
  r.getElementById(id)?.remove();
  const box = document.createElement("div");
  box.id = id;
  box.className = `rg-notice rg-notice-${tone}`;
  box.setAttribute("role", tone === "critical" ? "alert" : "status");
  const h = document.createElement("p");
  h.className = "rg-notice-title";
  h.textContent = title;
  const p = document.createElement("p");
  p.className = "rg-notice-body";
  p.textContent = body;
  box.append(h, p);
  if (dismissible) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rg-button";
    b.textContent = "Dismiss";
    b.addEventListener("click", () => box.remove());
    box.append(b);
  }
  r.append(box);
}

// ---- the composer and the send ------------------------------------------------------------------------------------

function isComposer(el: EventTarget | null): el is HTMLElement {
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
}

function composerText(): string {
  const el = composer && composer.isConnected ? composer : isComposer(document.activeElement) ? document.activeElement : null;
  if (!el) return "";
  return el instanceof HTMLTextAreaElement ? el.value : (el.innerText ?? "");
}

/** true when the send must stop */
function checkSend(): boolean {
  const text = composerText();
  if (!text.trim()) return false;
  const d = decideSend(text, reply);
  if (d.action === "block") {
    report({ kind: "dlp_blocked", outcome: "blocked", code: "dlp_match", ruleIds: d.ruleIds });
    showNotice(
      "rg-dlp",
      "This prompt was not sent",
      "It contains what looks like a password, key or token. Remove it and send again. Your organisation has been notified that a prompt was stopped, without its text.",
      "critical",
      true,
    );
    return true;
  }
  if (d.recordWouldBlock) report({ kind: "dlp_blocked", outcome: "would_block", code: "dlp_match", ruleIds: d.ruleIds });
  if (d.capture) {
    const t = Date.now();
    if (text !== lastCaptured.text || t - lastCaptured.at > 2000) {
      lastCaptured = { text, at: t };
      void send({ type: "capture", text });
    }
  }
  return false;
}

function stop(e: Event): void {
  e.preventDefault();
  e.stopImmediatePropagation();
}

document.addEventListener("focusin", (e) => {
  if (isComposer(e.target)) composer = e.target;
}, true);

document.addEventListener("keydown", (e) => {
  if (!isComposer(e.target) || !isSendKey(e)) return;
  composer = e.target;
  if (checkSend()) stop(e);
}, true);

document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest("button, [role='button']") : null;
  if (!btn) return;
  const label = btn.getAttribute("aria-label") ?? btn.textContent ?? "";
  if (!looksLikeSendButton(label, btn.getAttribute("type"))) return;
  if (checkSend()) stop(e);
}, true);

document.addEventListener("submit", (e) => {
  if (checkSend()) stop(e);
}, true);

// ---- on load: the site verdict, a second layer behind the network rules -------------------------------------------

void (async () => {
  reply = await send<VerdictReply>({ type: "verdict" });
  if (!reply) {
    location.replace(chrome.runtime.getURL(blockPath("no_valid_policy", siteForHost(location.hostname) ?? "unknown")));
    return;
  }
  if (reply.verdict.effect === "block") {
    const kind = reply.verdict.code === "account_not_allowed" || reply.verdict.code === "account_signed_out" ? "account_blocked" : "site_blocked";
    if (reply.mode === "audit" && reply.verdict.code !== "no_valid_policy" && reply.verdict.code !== "site_not_in_policy") {
      report({ kind, outcome: "would_block", code: reply.verdict.code, ruleIds: [] });
    } else {
      // the network rule should have redirected already; a single-page app or a rule update race lands here. The
      // block page records the event, as it does for every network-rule redirect.
      location.replace(chrome.runtime.getURL(blockPath(reply.verdict.code, reply.siteId)));
      return;
    }
  }
  if (reply.promptCapture) {
    const show = () =>
      showNotice(
        "rg-capture",
        "Your organisation records prompts on this site",
        "Prompts you send here are saved for review under your organisation's AI use policy.",
        "info",
        false,
      );
    if (document.body) show();
    else document.addEventListener("DOMContentLoaded", show, { once: true });
  }
})();
