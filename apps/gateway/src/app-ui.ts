/**
 * The end-user app (/app): playground, runs, workflows, inbox, projects.
 * Same contract as /admin (ADR-0012): one dependency-free file, strictly a
 * client of the public REST API. The API key lives in sessionStorage — this
 * tab only, gone when it closes — and every call is the same call a script
 * would make.
 */

import { UI_CSS, UI_DISPLAY_JS, UI_ERRORS_JS, UI_TABLE_JS } from "./ui-theme.js";

export const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RegulAIt</title>
<style>${UI_CSS}</style>
</head>
<body>
<div id="root"></div>
<div id="toast-region" aria-live="polite"></div>
<script>
"use strict";
${UI_ERRORS_JS}
${UI_DISPLAY_JS}
${UI_TABLE_JS}
const $ = (s, el) => (el ?? document).querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtUsd = (v) => v == null ? "—" : "$" + Number(v).toFixed(4).replace(/0+$/,"").replace(/\\.$/,"");
const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h ago";
  return Math.floor(s/86400) + "d ago";
};

let KEY = sessionStorage.getItem("regulait.key") ?? "";
let ME = null;
let AGENTS = [];        // my granted agents
let AGENT_NAMES = {};   // id -> name
let DEFAULT_AGENT_ID = null; // my policy's default agent (lead-agent preselect)
let PROJECTS = [];      // my member projects
let INBOX_COUNT = 0;
let MY_PROVIDERS = []; // providers I hold my own key for (never the key itself)
let PROVIDER_STATUS = {}; // provider kind -> { configured } platform-wide (stored cred OR env key), no secrets

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: "Bearer " + KEY, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) { signOut(); throw new Error("unauthenticated"); }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) { const e = new Error(errMessage(res.status, json)); e.payload = json; e.status = res.status; throw e; }
  return json;
}
const get = (p) => api("GET", p);
const post = (p, b) => api("POST", p, b ?? {});
const patch = (p, b) => api("PATCH", p, b ?? {});
// authed file download: fetch the CSV with our bearer, then trigger a browser
// save via a transient blob URL (the endpoint sets Content-Disposition too)
async function downloadCsv(path, filename) {
  const res = await fetch(path, { headers: { authorization: "Bearer " + KEY } });
  if (!res.ok) { toast("CSV download failed (" + res.status + ")"); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
const del = (p) => api("DELETE", p);

function toast(msg, ms) {
  // the region lives OUTSIDE #root (see the body markup) so a render() mid-flight
  // never wipes a toast; it carries aria-live=polite so AT announces it.
  const region = $("#toast-region") || document.body;
  const el = document.createElement("div");
  el.className = "toast"; el.textContent = msg;
  region.appendChild(el);
  setTimeout(() => el.remove(), ms ?? 3600);
}
function signOut() {
  sessionStorage.removeItem("regulait.key"); KEY = ""; ME = null; render();
}

const statusBadge = (s) => {
  const map = { completed: "ok", done: "ok", running: "info", in_progress: "info",
    planned: "", not_started: "", blocked_on_approval: "warn", blocked_on_artifact: "warn",
    awaiting_trigger: "warn", awaiting_execution: "info", in_review: "warn", blocked: "bad",
    blocked_on_check: "bad", failed: "bad", blocked_on_deploy: "warn", rolled_back: "bad",
    aborted: "bad", denied: "bad", pending: "warn", approved: "ok" };
  return '<span class="badge ' + (map[s] ?? "") + '">' + esc(String(s).replaceAll("_", " ")) + "</span>";
};

// duration from a millisecond span — for per-node and per-run elapsed times
const fmtDur = (ms) => {
  if (ms == null || !isFinite(ms) || ms < 0) return "—";
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + "s";
  if (s < 60) return Math.round(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.round((s % 3600) / 60) + "m";
};

// --- hand-rolled SVG charts (same pattern as /admin — no external assets) --
function barChart(items, valueKey, labelFn) {
  if (!items?.length) return "<div class='empty'>no data</div>";
  const max = Math.max(...items.map((i) => Number(i[valueKey]) || 0), 1e-9);
  const rowH = 26, w = 640;
  const short = (label) => {
    const s = String(label ?? "");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(s)) return s.slice(0, 8) + "…";
    return s.length > 24 ? s.slice(0, 23) + "…" : s;
  };
  const rows = items.slice(0, 10).map((item, i) => {
    const v = Number(item[valueKey]) || 0;
    const bw = Math.max(2, (v / max) * (w - 280));
    const y = i * rowH;
    return \`<text x="0" y="\${y + 16}" fill="var(--text-dim)" font-size="11.5" font-family="var(--mono)">\${esc(short(labelFn(item)))}</text>
      <rect x="200" y="\${y + 5}" width="\${bw}" height="14" rx="3" fill="var(--accent)" opacity="0.85"/>
      <text x="\${206 + bw}" y="\${y + 16}" fill="var(--text)" font-size="11.5" font-family="var(--mono)">\${fmtUsd(v)}</text>\`;
  }).join("");
  return \`<div class="chart"><svg viewBox="0 0 \${w} \${Math.min(items.length, 10) * rowH}" xmlns="http://www.w3.org/2000/svg">\${rows}</svg></div>\`;
}
function budgetGauge(spent, cap, overageApproved, opts) {
  if (cap == null) return "<span class='dim'>no budget set</span>";
  opts = opts || {};
  const pct = Math.min(100, (spent / cap) * 100);
  const over = spent > cap;
  const tPct = opts.alertThresholdPct;
  // amber threshold-crossed vs red over-budget: prefer the API's own flag, but
  // fall back to a local compute so the fleet-list mini-gauge works too
  const crossed = !over && (opts.thresholdCrossed ?? (tPct != null && tPct < 100 && opts.thresholdUsd != null && spent >= opts.thresholdUsd));
  const periodLabel = opts.period === "monthly" ? " this month" : "";
  const marker = (tPct != null && tPct < 100)
    ? '<span class="mark" style="left:' + tPct + '%" title="' + tPct + '% alert threshold"></span>'
    : "";
  const badge = over
    ? '<span class="badge ' + (overageApproved ? "warn" : "bad") + '">' + (overageApproved ? "overage approved" : "over budget") + "</span>"
    : crossed
    ? '<span class="badge warn">' + tPct + "% threshold crossed</span>"
    : "";
  const fill = over ? "over" : crossed ? "warn" : "";
  return \`<div class="row"><span class="num">\${fmtUsd(spent)}</span><span class="dim">of \${fmtUsd(cap)}\${periodLabel}</span>\${badge}</div>
    <div class="bar" style="margin-top:8px;position:relative"><i class="\${fill}" style="width:\${pct}%"></i>\${marker}</div>\`;
}
// §5.2 (B3): the effective transitive per-node budget ceiling — the MIN of a
// node's own budgetCapUsd and every lead ancestor's, mirroring the kernel's
// computeNodeBudgetCeiling. null = no per-node cap (only the run cap applies).
function effNodeCap(graph, id) {
  const byId = {};
  for (const n of graph.nodes) byId[n.id] = n;
  const start = byId[id];
  let cap = (start && start.budgetCapUsd != null) ? start.budgetCapUsd : null;
  const seen = {}; seen[id] = true;
  let cur = start && start.leadNodeId;
  while (cur && !seen[cur]) {
    seen[cur] = true;
    const lead = byId[cur];
    if (!lead) break;
    if (lead.budgetCapUsd != null) cap = (cap === null) ? lead.budgetCapUsd : Math.min(cap, lead.budgetCapUsd);
    cur = lead.leadNodeId;
  }
  return cap;
}
// §5.2 (B3): a "cap $X" chip for a node under a per-node ceiling — amber (warn)
// once measured (preferred) or estimated spend approaches (>=80% of) the cap,
// info otherwise. Reuses the existing badge classes.
function nodeCapChip(graph, id, budget) {
  const cap = effNodeCap(graph, id);
  if (cap == null) return "";
  const measured = (budget.measuredPerNodeUsd || {})[id];
  const est = (budget.perNodeUsd || {})[id];
  const spend = (measured != null) ? measured : (est != null ? est : 0);
  const near = spend >= cap * 0.8;
  return ' <span class="badge ' + (near ? "warn" : "info") + '" title="per-node budget ceiling (transitive MIN up the lead chain) — measured/estimated spend vs cap">cap ' + fmtUsd(cap) + "</span>";
}

// ---------------------------------------------------------------- shell --
const PAGES = [
  { id: "playground", label: "Playground" },
  { id: "runs", label: "Runs" },
  { id: "workflows", label: "Workflows" },
  { id: "inbox", label: "Inbox" },
  { id: "projects", label: "Projects" },
  { id: "context-graph", label: "Context Graph" },
  { id: "spend", label: "Spend & savings" },
  { id: "settings", label: "Settings" },
];

function route() {
  const h = location.hash.replace(/^#\\/?/, "");
  const [page, id] = h.split("/");
  return { page: page || "playground", id };
}
window.addEventListener("hashchange", () => render());

async function bootstrap() {
  ME = await get("/v1/me");
  if (!ME.userId) throw new Error("this key has no user identity");
  // ADR-0021: the composer's attachment clamps are org settings, not constants
  if (ME.limits) {
    if (ME.limits.maxAttachmentsPerDispatch) PG_MAX_ATTACH = ME.limits.maxAttachmentsPerDispatch;
    if (ME.limits.maxAttachmentBytes) PG_MAX_BYTES = ME.limits.maxAttachmentBytes;
  }
  const [mine, projects, creds, providerStatus] = await Promise.all([
    get("/v1/users/" + ME.userId + "/agents"),
    get("/v1/projects").catch(() => ({ projects: [] })),
    get("/v1/users/" + ME.userId + "/model-credentials").catch(() => ({ credentials: [] })),
    get("/v1/model-providers/status").catch(() => ({ providers: {} })),
  ]);
  // ADR-0019: an agent revoked for this user is denied by the kernel at invoke,
  // so offering it in the picker is a broken affordance. Display-only filtering
  // — the server default-denies regardless; this never confers anything.
  AGENTS = (mine.agents ?? []).filter((a) => !a.revoked);
  AGENT_NAMES = Object.fromEntries(AGENTS.map((a) => [a.agentId, a.name]));
  DEFAULT_AGENT_ID = mine.defaultAgentId ?? null;
  PROJECTS = projects.projects ?? [];
  MY_PROVIDERS = (creds.credentials ?? []).map((c) => c.provider);
  PROVIDER_STATUS = providerStatus.providers ?? {};
  const inbox = await get("/v1/approvals").catch(() => ({ approvals: [] }));
  INBOX_COUNT = (inbox.approvals ?? []).filter((a) => a.status === "pending").length;
}

function shell(content, active) {
  return \`
  <div class="shell">
    <aside class="side" id="side">
      <div class="brand"><span class="word">regul<em>ai</em>t</span><span class="tag">governed</span></div>
      <div class="sec">Workspace</div>
      \${PAGES.map((p) => \`
        <button class="nav-item \${p.id === active ? "active" : ""}" data-nav="\${p.id}">
          <span class="dot"></span>\${p.label}
          \${p.id === "inbox" && INBOX_COUNT ? '<span class="badge accent">' + INBOX_COUNT + "</span>" : ""}
        </button>\`).join("")}
      <div class="foot">
        <div class="who">\${esc(ME?.user?.displayName ?? "")}</div>
        <div class="who dim">\${esc(ME?.user?.email ?? "")}</div>
        <button class="ghost small" id="signout" style="margin-top:8px;padding-left:0">Sign out</button>
      </div>
    </aside>
    <main class="main">
      <button class="hamburger" id="navtoggle" aria-label="Toggle navigation" aria-expanded="false">☰ Menu</button>
      \${content}
    </main>
  </div>\`;
}

// ------------------------------------------------------------ playground --
// The Playground is a real multi-turn surface: threads live server-side
// (/v1/conversations, personal, admins included), the open thread's id lives
// in sessionStorage (tab-scoped, like the key), and chatHistory below is only
// the OPEN thread's render model — rebuilt from the server when a thread is
// opened, appended to live while one streams. Runs/workflows keep their
// single-turn invoke semantics untouched.
const chatHistory = []; // the open thread's exchanges — persists across renders within the tab
let PG_ABORT = null;    // AbortController while a stream is open — one at a time
let CONVO_ID = sessionStorage.getItem("regulait.convo") || null; // active thread — tab-scoped
let CONVOS = [];            // conversations rail cache (newest-updated first, from the server)
let PG_FRESH = false;       // the user explicitly asked for a fresh chat — don't auto-reopen
let CHAT_LOADED_FOR = null; // which conversation chatHistory mirrors (null = fresh unsaved chat)
let PG_PREFILL = null;      // agent/project selects to apply right after opening a thread

// ---- composer attachments (mimics Claude's native attach) ---------------
// Images/PDFs ride the dispatch as base64 attachments (a vision-capable
// agent sees the bytes); text/code files ride the referenceContent field where
// the pillar-6 preprocessor can shrink them. Both are bounded before they ever
// leave the browser: <= 8 files, <= 6 MB each.
let PG_ATTACH = [];         // pending attachments for the NEXT send — cleared after
let PG_ATTACH_SEQ = 0;      // stable local ids for tray remove buttons
const PG_IMG_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
// ADR-0021: the org-configured ceilings ride /v1/me (bootstrap() applies them);
// the literals here are only the pre-fetch fallback = the org defaults.
let PG_MAX_ATTACH = 8;
let PG_MAX_BYTES = 6 * 1024 * 1024;

function fmtBytes(n) {
  return n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB";
}
function readAs(file, how) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error || new Error("read failed"));
    if (how === "text") r.readAsText(file); else r.readAsDataURL(file);
  });
}
async function pgAddFiles(files) {
  for (const file of Array.from(files)) {
    if (PG_ATTACH.length >= PG_MAX_ATTACH) { toast("Up to " + PG_MAX_ATTACH + " files per message.", "err"); break; }
    if (file.size > PG_MAX_BYTES) { toast("\\u2717 " + file.name + " is over the " + fmtBytes(PG_MAX_BYTES) + " limit.", "err"); continue; }
    const isImg = PG_IMG_TYPES.includes(file.type);
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    try {
      if (isImg || isPdf) {
        const dataUrl = String(await readAs(file, "dataurl"));
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        PG_ATTACH.push({ id: ++PG_ATTACH_SEQ, mode: "attachment", kind: isImg ? "image" : "document",
          name: file.name, mediaType: isImg ? file.type : "application/pdf",
          dataBase64: base64, thumb: isImg ? dataUrl : null, size: file.size });
      } else {
        const text = String(await readAs(file, "text"));
        PG_ATTACH.push({ id: ++PG_ATTACH_SEQ, mode: "text", name: file.name, text: text, size: file.size });
      }
    } catch (e) { toast("\\u2717 couldn\\u2019t read " + file.name, "err"); }
  }
  renderAttachTray();
}
function pgRemoveAttach(id) { PG_ATTACH = PG_ATTACH.filter((a) => a.id !== Number(id)); renderAttachTray(); }
function renderAttachTray() {
  const tray = $("#pg-tray");
  if (!tray) return;
  if (!PG_ATTACH.length) { tray.style.display = "none"; tray.innerHTML = ""; return; }
  tray.style.display = "flex";
  tray.innerHTML = PG_ATTACH.map((a) => {
    const icon = a.mode === "attachment" && a.kind === "image"
      ? '<img class="thumb" src="' + a.thumb + '" alt="">'
      : '<span class="ico">' + (a.mode === "attachment" ? "\\uD83D\\uDCC4" : "\\uD83D\\uDCDD") + "</span>";
    const kindLabel = a.mode === "attachment" ? a.kind : "text \\u2192 reference";
    return '<div class="attach-chip">' + icon
      + '<div style="min-width:0"><div class="an">' + esc(a.name) + '</div><div class="as">' + esc(fmtBytes(a.size)) + " \\u00B7 " + kindLabel + "</div></div>"
      + '<button class="rm" data-rma="' + a.id + '" title="remove" aria-label="Remove ' + esc(a.name) + '">\\u00D7</button></div>';
  }).join("");
  tray.querySelectorAll("[data-rma]").forEach((b) => b.addEventListener("click", () => pgRemoveAttach(b.dataset.rma)));
}

function setConvo(id) {
  CONVO_ID = id;
  if (id) sessionStorage.setItem("regulait.convo", id);
  else sessionStorage.removeItem("regulait.convo");
}

// Server history -> the exact exchange shape renderExchange draws live, so a
// replayed thread wears the same bubbles and badges a live one does: the
// assistant detail carries the dispatch facts (modelUsed/costUsd/refusal/
// credentialSource), and a denied user turn carries detail.denied and gets
// its denial pill with no assistant bubble.
function exchangesFromMessages(v) {
  const out = [];
  for (const m of v.messages ?? []) {
    if (m.role === "user") {
      const x = { prompt: m.content, agentName: v.agentName ?? "agent", text: "", streaming: false };
      if (m.detail && m.detail.denied) { x.denied = m.detail; x.text = m.detail.reason ?? ""; }
      out.push(x);
    } else if (m.role === "assistant") {
      const x = out[out.length - 1];
      if (!x || x.denied || x.result) continue; // history is strict user/assistant pairs — be defensive anyway
      const d = m.detail ?? {};
      x.text = m.content;
      x.agentName = AGENT_NAMES[d.servedAgentId] ?? x.agentName;
      x.result = { dispatch: {
        model: d.modelUsed, costUsd: d.costUsd, refusal: d.refusal,
        credentialSource: d.credentialSource, stopReason: d.stopReason,
      } };
      if (d.compaction) x.result.compaction = d.compaction;
    }
    // pillar 6 compaction boundary: everything up to and including this stored
    // message is model-bound only via the summary — draw the divider after
    // the exchange this message belongs to (full history stays visible above)
    if (v.summaryThroughMessageId && m.id === v.summaryThroughMessageId && out.length) {
      out[out.length - 1].compactedBoundary = { summary: v.summary, summaryTokens: v.summaryTokens };
    }
  }
  return out;
}

// Whose key pays for this agent, said before the request rather than only
// after it. Routing can still move the request to another agent, so the
// dispatch badge on the reply stays the authoritative answer.
function keyHint(agent) {
  if (!agent) return "";
  if (agent.provider === "mock") {
    // When NO real provider is live platform-wide, say what that means and who
    // can fix it — a non-admin can't add a platform key, but their admin can.
    const anyReal = Object.keys(PROVIDER_STATUS).some((p) => p !== "mock" && PROVIDER_STATUS[p] && PROVIDER_STATUS[p].configured);
    return "Mock provider — runs with no credential at all."
      + (anyReal ? "" : " Replies are simulated and spend is $0; an admin can connect a real provider from the admin portal (Model Credentials).");
  }
  return MY_PROVIDERS.includes(agent.provider)
    ? "Runs on your own " + esc(agent.provider) + " key. <a href='#/settings'>Manage keys</a>"
    : "No " + esc(agent.provider) + " key of your own — this uses the platform credential if an admin has configured one. <a href='#/settings'>Add your key</a>";
}

// A provider is "live" platform-wide when a stored platform credential exists OR
// its platform-key env var is set — read from /v1/model-providers/status (never
// the key itself). Unknown providers read as not-configured; "mock" is always on.
function providerConfigured(provider) {
  if (provider === "mock") return true;
  return !!(PROVIDER_STATUS[provider] && PROVIDER_STATUS[provider].configured);
}

// Which agent a FRESH chat opens on: prefer a real, LIVE provider so the box
// defaults to Claude the moment an Anthropic key is configured — highest-tier
// configured non-mock agent, anthropic/Claude winning ties. Falls back to the
// user's policy default, then the first granted agent. (A thread opened from the
// rail still overrides this with its own stored agent via PG_PREFILL.)
function pickDefaultAgentId() {
  if (!AGENTS.length) return null;
  const live = AGENTS.filter((a) => a.provider !== "mock" && providerConfigured(a.provider));
  if (live.length) {
    const best = live.slice().sort((a, b) => {
      const ap = a.provider === "anthropic" ? 1 : 0;
      const bp = b.provider === "anthropic" ? 1 : 0;
      if (ap !== bp) return bp - ap;        // anthropic/Claude first
      return (b.tier ?? 0) - (a.tier ?? 0); // then highest tier
    })[0];
    return best.agentId;
  }
  if (DEFAULT_AGENT_ID && AGENTS.some((a) => a.agentId === DEFAULT_AGENT_ID)) return DEFAULT_AGENT_ID;
  return AGENTS[0].agentId;
}

// The credential banner above the composer: a clear warning when the selected
// agent's real provider isn't configured (it WILL error on send), a subtle
// "live" indicator when it is. Mock agents show nothing here (keyHint covers
// them). Dependency-free — inline styles on the theme's own vars.
function providerBanner(agent) {
  if (!agent || agent.provider === "mock") return "";
  const label = agent.provider.charAt(0).toUpperCase() + agent.provider.slice(1);
  if (providerConfigured(agent.provider)) {
    const model = agent.model ? " (" + esc(agent.model) + ")" : "";
    return '<div style="font-size:11.5px;color:var(--ok);margin-top:8px">● Live: ' + esc(agent.name) + model + "</div>";
  }
  return '<div style="font-size:12px;margin-top:8px;padding:8px 10px;border:1px solid #d9a44144;'
    + 'border-left:3px solid var(--warn);border-radius:6px;background:#d9a44114;color:var(--warn)">'
    + "\\u26A0\\uFE0E " + esc(label) + " isn\\u2019t configured yet — this agent will error on send. "
    + "Add a key in <a href='#/settings'>Settings</a> (your own) or ask an admin to configure it. "
    + "Pick a mock agent to try the flow now.</div>";
}

// The conversations rail: newest-updated first, active highlight, delete
// affordance. Rendered into #convo-rail so refreshRail() can update it after
// a turn lands without re-rendering the whole page (a stream may be open).
function railHtml() {
  const items = CONVOS.map((c) => {
    const n = c.messageCount ?? 0;
    return \`<div class="convo-item \${c.id === CONVO_ID ? "active" : ""}" data-convo="\${esc(c.id)}" title="\${esc(c.title ?? "Untitled")}">
      <div class="grow" style="min-width:0">
        <div class="t">\${esc(c.title ?? "Untitled")}</div>
        <div class="m">\${esc(c.agentName ?? "agent")} · \${ago(c.updatedAt)} · \${n} msg\${n === 1 ? "" : "s"}</div>
      </div>
      <button class="x" data-delconvo="\${esc(c.id)}" title="delete this conversation — its history is removed for good">×</button>
    </div>\`;
  }).join("");
  return \`
    <button class="small" id="convo-new" style="width:100%">+ New conversation</button>
    <div style="margin-top:8px">\${items || '<div class="faint" style="font-size:12px;padding:12px 4px;text-align:center">No conversations yet — send a message and a thread starts itself.</div>'}</div>\`;
}

async function refreshRail() {
  // called after a turn lands: title/updatedAt/messageCount move without a
  // full re-render (which would tear down an open stream's DOM)
  try { CONVOS = (await get("/v1/conversations")).conversations ?? []; } catch { return; }
  const rail = $("#convo-rail");
  if (!rail) return;
  rail.innerHTML = railHtml();
  wireRail();
}

function wireRail() {
  $("#convo-new")?.addEventListener("click", () => {
    if (PG_ABORT) { toast("A reply is still streaming — Stop it or let it finish first."); return; }
    PG_FRESH = true; // an explicit fresh chat beats the auto-open-newest default
    setConvo(null); chatHistory.length = 0; CHAT_LOADED_FOR = null; render();
  });
  document.querySelectorAll("[data-convo]").forEach((el) =>
    el.addEventListener("click", () => {
      if (PG_ABORT) { toast("A reply is still streaming — Stop it or let it finish first."); return; }
      if (el.dataset.convo === CONVO_ID) return;
      PG_FRESH = false;
      setConvo(el.dataset.convo); CHAT_LOADED_FOR = null; render();
    }));
  document.querySelectorAll("[data-delconvo]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation(); // the row click underneath would open the thread
      if (!confirmClick(b, "\u00D7?")) return;
      try {
        await del("/v1/conversations/" + b.dataset.delconvo);
        if (CONVO_ID === b.dataset.delconvo) { setConvo(null); chatHistory.length = 0; CHAT_LOADED_FOR = null; }
        toast("Conversation deleted");
        render();
      } catch (err) { toast("✗ " + err.message); }
    }));
}

async function playgroundPage() {
  try { CONVOS = (await get("/v1/conversations")).conversations ?? []; } catch { CONVOS = []; }
  // Fresh sign-in lands in the NEWEST thread, not an empty pane — unless the
  // user explicitly clicked "+ New conversation" (PG_FRESH), which always
  // wins. A stale stored id falls through to the same auto-open.
  if (!CONVO_ID && !PG_FRESH && !PG_ABORT && CONVOS.length) setConvo(CONVOS[0].id);
  // Restore the open thread (sessionStorage) or load a just-clicked one.
  // A stale id — deleted elsewhere, another account's — clears silently
  // instead of erroring the page. Never reload under an open stream.
  if (CONVO_ID && !PG_ABORT && CHAT_LOADED_FOR !== CONVO_ID) {
    try {
      const v = await get("/v1/conversations/" + CONVO_ID);
      chatHistory.length = 0;
      chatHistory.push(...exchangesFromMessages(v));
      CHAT_LOADED_FOR = CONVO_ID;
      // reflect the thread's own agent + bill-to defaults in the selects
      // (applied post-render); both stay fully switchable mid-conversation
      PG_PREFILL = { agentId: v.agentId, projectId: v.projectId };
    } catch { setConvo(null); chatHistory.length = 0; CHAT_LOADED_FOR = null; }
  }
  if (!CONVO_ID && CHAT_LOADED_FOR !== null && !PG_ABORT) { chatHistory.length = 0; CHAT_LOADED_FOR = null; }
  // No grants means no agent to invoke — without this guard the select is
  // empty, Send POSTs to /v1/agents//invoke, and the user gets Fastify's 404.
  const noAgents = AGENTS.length === 0;
  // Fresh chats open on the highest-tier LIVE real provider (Claude first) so a
  // configured Anthropic key defaults the box to Claude; a thread opened from
  // the rail overrides this post-render via PG_PREFILL.
  const preselectId = pickDefaultAgentId();
  const selAgent = AGENTS.find((a) => a.agentId === preselectId) ?? AGENTS[0];
  const agentOpts = AGENTS.map((a) =>
    \`<option value="\${a.agentId}"\${a.agentId === preselectId ? " selected" : ""}>\${esc(a.name)} · \${esc(a.provider)} · tier \${a.tier}</option>\`).join("");
  const agentField = noAgents
    ? '<div class="grow"><label class="f">Agent</label><div class="dim" style="font-size:12.5px">No agents are granted to your account — ask an admin to grant you one.</div></div>'
    : \`<div><label class="f">Agent</label><select id="pg-agent">\${agentOpts}</select></div>\`;
  const projectOpts = ['<option value="">no project</option>']
    .concat(PROJECTS.map((p) => \`<option value="\${p.id}">\${esc(p.name)}</option>\`)).join("");
  return \`
  <h1>Playground</h1>
  <p class="sub">Every message goes through governance, routing, and metered dispatch — the trace shows what actually happened. Conversations remember: each turn carries the whole thread.</p>
  <div class="pg-split">
    <aside class="card convo-rail" id="convo-rail">\${railHtml()}</aside>
    <div class="grow" style="min-width:0">
      <div class="card">
        <div class="row">
          \${agentField}
          <div><label class="f">Bill to</label><select id="pg-project">\${projectOpts}</select></div>
          <div><label class="f">Priority</label>
            <select id="pg-sens">
              <option value="standard">standard</option>
              <option value="cost-sensitive">cost-sensitive</option>
              <option value="quality-sensitive">quality-sensitive</option>
            </select>
          </div>
        </div>
        \${noAgents ? "" : '<hr class="hr"><div class="faint" style="font-size:11.5px" id="pg-key">' + keyHint(selAgent) + '</div><div id="pg-banner">' + providerBanner(selAgent) + "</div>"}
      </div>
      <div class="card" style="margin-top:12px">
        <div class="chat-log" id="chat-log">
          \${chatHistory.length ? "" : (noAgents
            ? '<div class="empty">Nothing to send to yet — an admin has to grant your account an agent first.</div>'
            : '<div class="empty">Pick an agent and say something — the first message starts a conversation. Mock agents reply instantly with no external keys; type «&lt;&lt;refuse&gt;&gt;» to see refusal handling.</div>')}
        </div>
        <hr class="hr">
        <div class="composer" id="pg-composer">
          <div class="attach-tray" id="pg-tray" style="display:none"></div>
          <div class="row">
            <input type="file" id="pg-file" multiple accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.markdown,.csv,.json,.yaml,.yml,.txt,.log,.ts,.tsx,.js,.jsx,.py,.go,.rb,.java,.rs,.c,.h,.cpp,.sql,.sh,.html,.css" style="display:none">
            <button class="attach-btn" id="pg-attach" title="Attach images, PDFs, or text/code files"\${noAgents ? " disabled" : ""} aria-label="Attach files">📎</button>
            <textarea id="pg-input" class="grow" rows="2" placeholder="\${noAgents ? "No agent granted to your account yet…" : (CONVO_ID ? "Continue the conversation…" : "Ask the agent to do something…")}"\${noAgents ? " disabled" : ""}></textarea>
            <button class="primary" id="pg-send"\${noAgents ? " disabled" : ""}>Send</button>
            <button id="pg-stop" style="display:none" title="close the stream — the dispatch already ran, anything streamed stays">Stop</button>
          </div>
          <div class="faint" style="font-size:11px;margin-top:6px">Attach images &amp; PDFs (a vision-capable agent like Claude reads them), or text/code files (fed as reference). Up to 8 files · 6 MB each.</div>
        </div>
      </div>
    </div>
  </div>\`;
}

// §8.4 PII badge — categories only (COUNTS in the tooltip), never content.
function piiCats(hits) { return (hits ?? []).map((h) => h.category).join(", "); }
function piiBadge(pii) {
  const cats = piiCats([...(pii.inputHits ?? []), ...(pii.outputHits ?? [])]);
  const tip = "compliance PII policy '" + esc(pii.mode) + "' — categories: " + esc(cats || "none")
    + (pii.withheld ? " · output withheld and billed" : "");
  if (pii.action === "block")
    return '<span class="badge bad" title="' + tip + '">PII blocked' + (pii.withheld ? " · output withheld" : "") + "</span>";
  if (pii.action === "warn")
    return '<span class="badge warn" title="' + tip + '">PII warning: ' + esc(cats) + "</span>";
  return '<span class="badge" title="' + tip + '">PII logged: ' + esc(cats) + "</span>";
}

function renderExchange(x, i) {
  const meta = [];
  if (x.result) {
    const r = x.result;
    if (r.routing && r.routing.effect === "routed") {
      meta.push('<span class="badge accent">routed → ' + esc(AGENT_NAMES[r.routing.selectedAgentId] ?? "?") + "</span>");
      if (r.routing.estimatedCostSavedUsd > 0) meta.push('<span class="badge ok">est. saved ' + fmtUsd(r.routing.estimatedCostSavedUsd) + "</span>");
    }
    if (r.dispatch) {
      if (r.dispatch.refusal) meta.push('<span class="badge bad">refused</span>');
      // replayed history carries cost/model but not token counts (the usage
      // detail stays in the ledgers) — the badge degrades instead of dying
      if (r.dispatch.costUsd != null) meta.push('<span class="badge">' + fmtUsd(r.dispatch.costUsd) + (r.dispatch.usage ? " · " + r.dispatch.usage.inputTokens + "→" + r.dispatch.usage.outputTokens + " tok" : "") + "</span>");
      if (r.dispatch.model) meta.push('<span class="badge">' + esc(r.dispatch.model) + "</span>");
      // whose credential actually paid for this call — the one thing a BYO-key
      // user cannot verify any other way
      if (r.dispatch.credentialSource === "user") meta.push('<span class="badge info">your key</span>');
      if (r.dispatch.credentialSource === "platform") meta.push('<span class="badge">platform key</span>');
      if (r.dispatch.projectBudgetAlerted) meta.push('<span class="badge warn">budget alert</span>');
    }
    // §8.4 PII enforcement — the compliance cascade's piiMode acting on this
    // dispatch. block (red) / warn (amber) / log (faint). Categories only,
    // never the matched content.
    const pii = r.dispatch && r.dispatch.pii;
    if (pii) meta.push(piiBadge(pii));
    // pillar 6 context compaction — what this turn's model actually saw
    if (r.compaction) {
      if (r.compaction.compacted) meta.push('<span class="badge accent" title="this turn pushed the thread past the compaction threshold — older turns were summarized by a governed, metered dispatch; stored history is untouched">history compacted</span>');
      if (r.compaction.active) meta.push('<span class="badge info" title="the model received a summary of the older turns plus the recent window — est. ' + (r.compaction.savedTokensEst ?? 0) + ' tokens saved">summary context · ~' + (r.compaction.savedTokensEst ?? 0) + ' tok saved</span>');
      if (r.compaction.failOpen) meta.push('<span class="badge warn" title="the compaction dispatch failed (' + esc(r.compaction.failOpen.error ?? "") + ') — this turn was sent with the full history instead (fail-open)">compaction failed open</span>');
    }
  }
  if (x.denied) {
    // a named rule ("agent-ceiling") reads as itself; a grant-row UUID truncates
    const rid = UUID_RE.test(x.denied.ruleId) ? shortId(x.denied.ruleId) : x.denied.ruleId;
    meta.push('<span class="badge bad" title="' + esc(x.denied.ruleId) + '">denied · ' + esc(rid) + "</span>");
  }
  if (x.error) meta.push('<span class="badge bad">' + esc(x.error) + "</span>");
  // §8.4 input-block: the pii ships on the error/denial payload, not on a
  // dispatch result — render it here if it wasn't already shown above
  if (x.pii && !(x.result && x.result.dispatch && x.result.dispatch.pii)) meta.push(piiBadge(x.pii));
  // replayed exchanges carry no decision/routing payload — no empty expander.
  // The trace now renders the policy Decision through the shared renderDecision()
  // (effect badge + rule-chain table + reason), with routing/compaction summarized
  // as a kvList and the full raw JSON kept behind a nested <details>.
  const dec = x.denied ?? (x.result && x.result.decision);
  const routing = x.result && x.result.routing;
  const compaction = x.result && x.result.compaction;
  const routeKv = {};
  if (routing) {
    if (routing.effect) routeKv.effect = routing.effect;
    if (routing.selectedAgentId) routeKv.routedTo = AGENT_NAMES[routing.selectedAgentId] ?? routing.selectedAgentId;
    if (routing.estimatedCostSavedUsd != null) routeKv.estSaved = fmtUsd(routing.estimatedCostSavedUsd);
  }
  if (compaction) {
    if (compaction.active) routeKv.contextCompaction = "active · ~" + (compaction.savedTokensEst ?? 0) + " tok saved";
    else if (compaction.compacted) routeKv.contextCompaction = "compacted this turn";
    if (compaction.failOpen) routeKv.compactionFailOpen = compaction.failOpen.error ?? "yes";
  }
  const traceObj = x.denied ?? { decision: x.result && x.result.decision, routing: routing, ...(compaction ? { compaction: compaction } : {}) };
  const trace = x.denied || (x.result && (x.result.decision || routing || compaction))
    ? \`<details style="margin-top:6px"><summary class="faint" style="cursor:pointer;font-size:11.5px">governance trace</summary>
       <div style="margin-top:8px">\${dec ? renderDecision(dec) : ""}\${Object.keys(routeKv).length ? "<h2>Routing & optimization</h2>" + kvList(routeKv) : ""}
       <details style="margin-top:10px"><summary class="faint" style="cursor:pointer;font-size:11.5px">raw JSON</summary><pre style="margin-top:6px">\${esc(JSON.stringify(traceObj, null, 2))}</pre></details></div></details>\`
    : "";
  // per-exchange handoffs: copy the reply, or carry the prompt into the New
  // Run form as the first node's work order (pillar 7 starts where the
  // conversation stopped scaling)
  const tools = x.streaming ? "" :
    \`<button class="ghost small" data-copy="\${i}" title="copy the reply text">copy</button>
     <button class="ghost small" data-torun="\${i}" title="plan a multi-agent run with this prompt as the first node's instruction">turn into a run</button>\`;
  // pillar 6: slim divider at the compaction boundary — the full history
  // above stays visible and stored; only the model-bound context shrank
  const divider = x.compactedBoundary
    ? \`<div class="compact-divider" style="margin:10px 0;padding:6px 12px;border:1px dashed var(--border-strong);border-radius:8px;font-size:11.5px">
        <details><summary class="faint" style="cursor:pointer">— older turns above are compacted into a summary — full history retained; the model sees the summary + recent turns\${x.compactedBoundary.summaryTokens ? " (~" + x.compactedBoundary.summaryTokens + " tok)" : ""} —</summary>
        <pre style="margin-top:6px;white-space:pre-wrap">\${esc(x.compactedBoundary.summary ?? "")}</pre></details>
      </div>\`
    : "";
  // attachments the user sent with this turn — thumbnails for images, a labelled
  // pill for PDFs/text files. Never renders base64: the render list carries only
  // name/kind/thumb (a live send has the thumb; a replayed thread shows the pill).
  const attRow = (x.attachments && x.attachments.length)
    ? '<div class="att-row">' + x.attachments.map((a) =>
        a.thumb
          ? '<span class="att-pill"><img src="' + a.thumb + '" alt="">' + esc(a.name) + "</span>"
          : '<span class="att-pill">' + (a.kind === "document" ? "\\uD83D\\uDCC4" : "\\uD83D\\uDCDD") + " " + esc(a.name) + "</span>",
      ).join("") + "</div>"
    : "";
  // a plain-language note about how this turn was handled (e.g. §8.4 streaming
  // suppressed on a block-mode project) — governance told honestly, in the flow
  const note = x.note
    ? \`<div class="faint" style="font-size:11.5px;margin-top:6px">\${esc(x.note)}</div>\`
    : "";
  const userBubble = x.prompt ? \`<div class="bubble">\${esc(x.prompt)}</div>\` : "";
  return \`
    <div class="msg user"><div class="who">\${esc(ME.user.displayName)}</div>\${attRow}\${userBubble}</div>
    <div class="msg agent">
      <div class="who">\${esc(x.agentName)}</div>
      <div class="bubble">\${esc(x.text)}\${x.streaming ? '<span class="caret"></span>' : ""}</div>\${note}
      <div class="meta">\${meta.join("")}\${tools}</div>\${trace}
    </div>\${divider}\`;
}

function drawChat() {
  const log = $("#chat-log");
  if (!log) return;
  log.innerHTML = chatHistory.map(renderExchange).join("") ||
    '<div class="empty">Pick an agent and say something.</div>';
  log.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      const x = chatHistory[Number(b.dataset.copy)];
      try { await navigator.clipboard.writeText(x.text || x.prompt); b.textContent = "copied"; }
      catch { b.textContent = "select it manually"; }
    }));
  log.querySelectorAll("[data-torun]").forEach((b) =>
    b.addEventListener("click", () => {
      NR_PREFILL = chatHistory[Number(b.dataset.torun)].prompt;
      location.hash = "#/runs";
      toast("Prompt carried into the New Run form — the first node runs with it as its instruction");
    }));
  log.parentElement.scrollIntoView(false);
}

function pgStreamUi(streaming) {
  const send = $("#pg-send"), stop = $("#pg-stop");
  if (send) send.disabled = streaming;
  if (stop) stop.style.display = streaming ? "" : "none";
}

async function sendPrompt() {
  if (PG_ABORT) return; // one stream at a time — Send is disabled anyway
  const input = $("#pg-input");
  const prompt = input.value.trim();
  // A message may be attachments-only (an image with no words), exactly like
  // Claude's composer — but never fully empty.
  if (!prompt && !PG_ATTACH.length) return;
  const agentId = $("#pg-agent")?.value;
  if (!agentId) { toast("No agents granted to your account — ask an admin."); return; }
  const projectId = $("#pg-project").value || undefined;
  const costSensitivity = $("#pg-sens").value;
  // MULTI-TURN: the first Send with no open thread creates one (with the
  // selected agent + bill-to as the thread's defaults), then every send
  // dispatches inside it. The invoke URL's agent stays the CURRENTLY selected
  // one — switching agents mid-thread just points later turns at the new
  // agent, which the backend allows.
  if (!CONVO_ID) {
    try {
      const row = await post("/v1/conversations", { agentId, ...(projectId ? { projectId } : {}) });
      PG_FRESH = false; // the fresh chat became a real thread
      setConvo(row.id);
      CHAT_LOADED_FOR = row.id; // what's on screen (nothing yet) IS this thread
    } catch (e) { toast("✗ couldn’t start a conversation — " + e.message); return; }
  }
  const conversationId = CONVO_ID;
  input.value = "";
  // Snapshot and clear the composer's attachments: the images/PDFs go up as
  // base64 attachments (the model sees the bytes), the text/code files are
  // concatenated into referenceContent (the pillar-6 preprocessor shrinks them
  // server-side). A small render list rides the user bubble so the thread shows
  // what was sent — never the base64.
  const pending = PG_ATTACH;
  PG_ATTACH = []; renderAttachTray();
  const attachments = pending
    .filter((a) => a.mode === "attachment")
    .map((a) => ({ kind: a.kind, name: a.name, mediaType: a.mediaType, dataBase64: a.dataBase64 }));
  const textFiles = pending.filter((a) => a.mode === "text");
  const referenceContent = textFiles.length
    ? textFiles.map((a) => "----- FILE: " + a.name + " -----\\n" + a.text).join("\\n\\n")
    : undefined;
  const attachViews = pending.map((a) => ({
    name: a.name, kind: a.mode === "attachment" ? a.kind : "text", thumb: a.thumb || null,
  }));
  const x = { prompt, agentName: AGENT_NAMES[agentId] ?? "agent", text: "", streaming: true, attachments: attachViews };
  chatHistory.push(x); drawChat();
  const ctrl = new AbortController();
  PG_ABORT = ctrl;
  pgStreamUi(true);

  try {
    const res = await fetch("/v1/agents/" + agentId + "/invoke", {
      method: "POST",
      headers: { authorization: "Bearer " + KEY, "content-type": "application/json" },
      body: JSON.stringify({ mode: "execute", input: prompt, dispatch: true, stream: true, costSensitivity, conversationId, ...(projectId ? { projectId } : {}), ...(attachments.length ? { attachments } : {}), ...(referenceContent ? { referenceContent } : {}) }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("event-stream")) {
      // fetch never throws on a 4xx — and neither may this branch: a denial
      // is an EXPECTED outcome that renders as its badge + trace, so the body
      // parse is guarded and nothing here can escape as an uncaught error.
      let j = null;
      try { j = await res.json(); } catch { j = null; }
      x.streaming = false;
      if (j && j.decision && j.decision.effect !== "allow") { x.denied = j.decision; x.text = j.decision.reason; }
      // ADR-0019 §8.4: a block-mode PII project SUPPRESSES streaming — the same
      // governed dispatch ran fully buffered and came back as ordinary JSON, so
      // this is a success, not an error. Render it exactly like a completed
      // stream and say plainly why nothing streamed.
      else if (res.ok && j && j.dispatch) {
        x.result = j;
        x.text = j.dispatch.refusal ? "The model declined this request." : (j.dispatch.outputText ?? "");
        if (j.dispatch.pii) x.pii = j.dispatch.pii;
        if (j.streamingSuppressed) {
          x.note = "Streaming is disabled for this project: its compliance classification sets PII mode to block, so output is checked in full before any of it is sent.";
        }
      }
      else { x.error = (j && j.error) ?? ("HTTP " + res.status); x.text = errMessage(res.status, j ?? {}); }
      if (j && j.pii) x.pii = j.pii;
      drawChat(); return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\\n\\n")) !== -1) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = /event: (.+)/.exec(chunk)?.[1];
        const data = /data: (.+)/.exec(chunk)?.[1];
        if (!ev || !data) continue;
        const payload = JSON.parse(data);
        if (ev === "delta") { x.text += payload.text; drawChat(); }
        if (ev === "result") {
          x.result = payload; x.streaming = false;
          // requested-vs-served: the bubble is labelled with the agent that
          // ACTUALLY served (routing may have moved the request); the
          // requested agent stays visible in the governance trace.
          const servedId = payload.routing?.selectedAgentId ?? payload.dispatch?.servedAgentId;
          if (servedId && AGENT_NAMES[servedId]) x.agentName = AGENT_NAMES[servedId];
          if (payload.dispatch?.refusal) x.text = "The model declined this request.";
          // §8.4 output bill-and-withhold: the model streamed deltas, but the
          // final output was withheld — replace the bubble with the marker so
          // the withheld content does not remain on screen
          if (payload.dispatch?.pii?.withheld) x.text = payload.dispatch.outputText;
          if (payload.dispatch?.pii) x.pii = payload.dispatch.pii;
          drawChat();
        }
        // the error event carries the same detail the JSON path does — losing
        // it leaves an empty bubble under a bare red slug. Anything already
        // streamed stays; the explanation is appended to it.
        if (ev === "error") {
          const msg = errMessage(res.status, payload);
          x.error = payload.error;
          x.text = x.text ? x.text + "\\n\\n" + msg : msg;
          // §8.4 input-block ships its pii summary on the error payload
          if (payload.pii) x.pii = payload.pii;
          // a failed dispatch still had a governance + routing decision — keep
          // it so the trace explains which agent was chosen and why
          if (payload.decision) x.result = { decision: payload.decision, routing: payload.routing };
          x.streaming = false; drawChat();
        }
      }
    }
    x.streaming = false; drawChat();
  } catch (e) {
    x.streaming = false;
    if (e.name === "AbortError") {
      // the dispatch already ran server-side (governance + cost included) —
      // only the stream was closed; whatever arrived stays on screen.
      x.error = "stopped";
      x.text = (x.text ? x.text + "\\n\\n" : "") + "(stream stopped — the dispatch itself already ran and was metered)";
    } else {
      x.error = "request_failed"; x.text = e.message;
    }
    drawChat();
  } finally {
    PG_ABORT = null;
    pgStreamUi(false);
    if (x.result && x.result.compaction && x.result.compaction.compacted) {
      // this turn compacted the thread — reload it from the server so the
      // divider (and the persisted summary behind it) appears in place
      CHAT_LOADED_FOR = null;
      render();
    } else {
      // the turn (or denial) just changed this thread's title/updatedAt/count —
      // move its rail entry without re-rendering the page
      refreshRail();
    }
  }
}

// ------------------------------------------------------------------ runs --
// Canned graph shapes for the New Run form. Every node carries a real
// multi-sentence instruction — the worker's actual work order — so a run
// planned straight from a template prompts its workers with more than a
// one-line title. The advanced JSON view exposes the same payload for
// hand-editing (ids, dependsOn, modes, estimates, the escalation approver).
const RUN_TEMPLATES = [
  { id: "feature", label: "Feature (design → implement → document)", nodes: [
    { id: "design", title: "Design the change", dependsOn: [], instruction:
      "Draft the technical design for the feature named in the run title. Cover the API surface or interfaces it adds or changes, the data it touches, and every error case you can foresee. Call out anything that needs a migration or a staged rollout, and end with a short list of open questions a reviewer should settle." },
    { id: "implement", title: "Implement the change", dependsOn: ["design"], instruction:
      "Implement the feature following the design produced by the design node. Describe the change file by file, keep it minimal and consistent with the surrounding code, and state explicitly how each error case from the design is handled. Flag any place where you had to deviate from the design and why." },
    { id: "document", title: "Document the change", dependsOn: ["implement"], instruction:
      "Write the user-facing documentation for the implemented feature: what it does, how to use it, and any limits or defaults worth knowing. Include a short changelog entry, and note anything an operator must do when rolling the change out." },
  ]},
  { id: "bugfix", label: "Bug fix (reproduce → fix → verify)", nodes: [
    { id: "reproduce", title: "Reproduce the bug", dependsOn: [], instruction:
      "Reproduce the bug named in the run title. State the exact steps, inputs, and environment that trigger it, the observed behavior versus the expected behavior, and your best hypothesis for the root cause with the evidence supporting it." },
    { id: "fix", title: "Fix the root cause", dependsOn: ["reproduce"], instruction:
      "Fix the root cause identified by the reproduce node — not just the symptom. Describe the change precisely, explain why it is the minimal correct fix, and list any related code paths that share the same flaw and should be checked while you are here." },
    { id: "verify", title: "Verify the fix", dependsOn: ["fix"], instruction:
      "Verify the fix: re-run the reproduction steps and confirm the expected behavior, then look for regressions in the surrounding behavior. List every check performed with its result, and state clearly whether the fix is safe to ship." },
  ]},
  { id: "analysis", label: "Analysis (gather → analyze → report)", nodes: [
    { id: "gather", title: "Gather the source material", dependsOn: [], instruction:
      "Gather the raw material needed for the analysis named in the run title. List every source consulted, quote or summarize the relevant parts, and flag the gaps where the available material is thin or contradictory." },
    { id: "analyze", title: "Analyze the findings", dependsOn: ["gather"], instruction:
      "Analyze the gathered material. Identify the patterns, trade-offs, and risks that matter for the question in the run title, compare the plausible options against each other, and rank them with an explicit rationale for the ordering." },
    { id: "report", title: "Write the report", dependsOn: ["analyze"], instruction:
      "Write the final report for a reader who has seen none of the earlier nodes: the question, the short answer up front, the supporting analysis, and a concrete recommendation with its main risks and mitigations. Keep it under a page." },
  ]},
];
// mock agents run with no external credential, so they are the default owner
const nrDefaultAgent = () => (AGENTS.find((a) => a.provider === "mock") ?? AGENTS[0])?.agentId ?? "";
// a playground prompt carried over by 'turn into a run' — becomes the first
// node's instruction until cleared or the run is planned
let NR_PREFILL = null;
// PILLAR 7 goal decomposition: the lead agent's drafted proposal, rendered
// into this same editor (title/instruction/agent editable, nodes deletable)
// until discarded or planned. NOTHING runs until Plan run is clicked — the
// plan gate stays human.
let NR_PROPOSAL = null; // {name, nodes:[{id,title,instruction,ownerAgentId,agentName,dependsOn,substituted?}], dispatch, retried, leadName}
let NR_GOAL = "";       // the goal textarea survives the re-render after a draft lands
const nrInstructionFor = (n, idx) => (idx === 0 && NR_PREFILL ? NR_PREFILL : n.instruction);
const nrAgentSel = (nid, selected) => '<select data-nagent="' + nid + '">' + AGENTS.map((a) =>
  '<option value="' + a.agentId + '"' + (a.agentId === (selected ?? nrDefaultAgent()) ? " selected" : "") + '>' + esc(a.name) + " · " + esc(a.provider) + "</option>").join("") + "</select>";
// PILLAR 7: per-node tool controls — MCP server id(s) the worker may draw
// tools from (comma-separated) and a tool-loop turn cap. Blank = no tools /
// default cap, so canned templates stay ordinary single-turn workers.
const nrToolsCtl = (id, servers, turns) => \`<div><label class="f">Max turns</label><input type="number" min="1" max="20" data-nturns="\${esc(id)}" value="\${turns ?? ""}" style="width:60px" title="pillar 7: tool-using loop turn cap for this worker — blank uses the default"></div>
  <div><label class="f">Tool servers</label><input data-ntools="\${esc(id)}" value="\${esc((servers ?? []).join(","))}" placeholder="MCP server id(s)" style="width:150px" title="pillar 7: comma-separated MCP server ids this worker may call tools from (governed per-call under your entitlements) — blank for none"></div>\`;
// §5.1 Team-Lead delegation controls: choose another node as THIS node's lead
// (its worker inherits — and can never exceed — that lead's ceiling), and, when
// this node is itself a lead, the agents/tools it allows its workers. Blank
// lead + empty allow-lists = a flat node, byte-identical to today.
const nrLeadOpts = (id, allIds, sel) => '<option value="">(no lead)</option>' +
  allIds.filter((x) => x !== id).map((x) => '<option value="' + esc(x) + '"' + (x === sel ? " selected" : "") + '>' + esc(x) + "</option>").join("");
const nrAllowAgentOpts = (selected) => AGENTS.map((a) =>
  '<option value="' + a.agentId + '"' + ((selected ?? []).includes(a.agentId) ? " selected" : "") + '>' + esc(a.name) + "</option>").join("");
const nrLeadCtl = (id, allIds, lead, aAgents, aTools) => \`<div><label class="f">Lead</label><select data-nlead="\${esc(id)}" title="§5.1: run this node under another node's delegation ceiling — its entitlements narrow this worker's">\${nrLeadOpts(id, allIds, lead)}</select></div>
  <div><label class="f">Allowed agents</label><select multiple data-nallowagents="\${esc(id)}" style="min-width:120px;height:44px" title="§5.1 ceiling: agents a worker under THIS node (as lead) may be owned by — none selected = no agent constraint">\${nrAllowAgentOpts(aAgents)}</select></div>
  <div><label class="f">Allowed tools</label><input data-nallowtools="\${esc(id)}" value="\${esc((aTools ?? []).join(","))}" placeholder="tool names" style="width:120px" title="§5.1 ceiling: comma-separated tool names a worker under THIS node may call — blank = no tool constraint"></div>\`;
const nrLead = (id) => { const v = $('[data-nlead="' + id + '"]')?.value ?? ""; return v || null; };
const nrAllowedAgents = (id) => Array.from($('[data-nallowagents="' + id + '"]')?.selectedOptions ?? []).map((o) => o.value);
const nrAllowedTools = (id) => (($('[data-nallowtools="' + id + '"]')?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const nrLeadLabelHtml = (lead) => lead ? ' <span class="badge info" data-leadbadge="1">under ' + esc(lead) + '</span>' : "";
const nrNodeRowsHtml = (t) => { const allIds = t.nodes.map((x) => x.id); return t.nodes.map((n, idx) => \`<div class="node-row">
  <span class="node-dot not_started"></span>
  <div class="grow"><label class="f">\${esc(n.id)}\${n.dependsOn.length ? " · after " + n.dependsOn.join(", ") : ""}\${idx === 0 && NR_PREFILL ? ' <span class="badge accent">instruction from playground</span>' : ""}<span data-leadlabel="\${esc(n.id)}"></span></label>
    <input data-ntitle="\${n.id}" value="\${esc(n.title)}" style="width:100%" title="\${esc(nrInstructionFor(n, idx))}"></div>
  <div><label class="f">Agent</label>\${nrAgentSel(n.id)}</div>
  \${nrToolsCtl(n.id, n.toolServers, n.maxTurns)}
  \${nrLeadCtl(n.id, allIds, undefined, undefined, undefined)}
</div>\`).join(""); };
// proposal rows: same editor shape as templates, plus an editable instruction
// textarea, a per-node delete, and substitution badges for agents the lead
// suggested but the caller isn't granted
const nrProposalRowsHtml = () => { const allIds = NR_PROPOSAL.nodes.map((x) => x.id); return NR_PROPOSAL.nodes.map((n) => \`<div class="node-row"\${n.leadNodeId ? ' style="margin-left:22px"' : ""}>
  <span class="node-dot not_started"></span>
  <div class="grow"><label class="f">\${esc(n.id)}\${n.dependsOn.length ? " · after " + n.dependsOn.join(", ") : ""}\${n.substituted ? ' <span class="badge warn" title="the lead suggested &#39;' + esc(n.substituted.requestedAgentName) + '&#39;, which is not granted to you — swapped to a granted agent">substituted</span>' : ""}\${(n.toolServers && n.toolServers.length) ? ' <span class="badge info" title="this worker is a tool-using loop — every tool call is governed per-call under your entitlements">tool-using</span>' : ""}\${(n.allowedAgentIds && n.allowedAgentIds.length) || (n.allowedToolRefs && n.allowedToolRefs.length) ? ' <span class="badge accent" title="this node is a Team-Lead — it caps the agents/tools its workers may use">lead</span>' : ""}<span data-leadlabel="\${esc(n.id)}">\${nrLeadLabelHtml(n.leadNodeId)}</span></label>
    <input data-ntitle="\${esc(n.id)}" value="\${esc(n.title)}" style="width:100%">
    <textarea data-ninstr="\${esc(n.id)}" rows="3" style="width:100%;margin-top:4px" spellcheck="false" title="this node's worker is prompted with exactly this instruction">\${esc(n.instruction)}</textarea></div>
  <div><label class="f">Agent</label>\${nrAgentSel(n.id, n.ownerAgentId)}</div>
  \${nrToolsCtl(n.id, n.toolServers, n.maxTurns)}
  <div><label class="f">Cap $</label><input type="number" min="0" step="0.01" data-ncap="\${esc(n.id)}" value="\${n.budgetCapUsd != null ? n.budgetCapUsd : ""}" style="width:70px" title="optional per-node budget ceiling (USD) — a suggestion only; your per-run budget still governs and can never be exceeded"></div>
  \${nrLeadCtl(n.id, allIds, n.leadNodeId, n.allowedAgentIds, n.allowedToolRefs)}
  <button class="ghost small" data-ndel="\${esc(n.id)}" title="drop this task from the plan">×</button>
</div>\`).join(""); };
// read a node's tool controls out of the DOM
const nrToolServers = (id) => (($('[data-ntools="' + id + '"]')?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const nrMaxTurns = (id) => { const v = parseInt($('[data-nturns="' + id + '"]')?.value ?? "", 10); return Number.isFinite(v) && v > 0 ? v : null; };
// §5.2 (B2): read a node's suggested per-node budget cap out of the DOM
const nrCap = (id) => { const v = parseFloat($('[data-ncap="' + id + '"]')?.value ?? ""); return Number.isFinite(v) && v > 0 ? v : null; };
// carry any in-DOM edits back into the proposal before a partial re-render
function nrSyncProposal() {
  if (!NR_PROPOSAL) return;
  for (const n of NR_PROPOSAL.nodes) {
    n.title = ($('[data-ntitle="' + n.id + '"]')?.value ?? n.title).trim() || n.title;
    n.instruction = ($('[data-ninstr="' + n.id + '"]')?.value ?? n.instruction).trim() || n.instruction;
    n.ownerAgentId = $('[data-nagent="' + n.id + '"]')?.value ?? n.ownerAgentId;
    n.toolServers = nrToolServers(n.id);
    const mt = nrMaxTurns(n.id);
    if (mt) n.maxTurns = mt; else delete n.maxTurns;
    const lead = nrLead(n.id);
    if (lead) n.leadNodeId = lead; else delete n.leadNodeId;
    const aAgents = nrAllowedAgents(n.id);
    if (aAgents.length) n.allowedAgentIds = aAgents; else delete n.allowedAgentIds;
    const aTools = nrAllowedTools(n.id);
    if (aTools.length) n.allowedToolRefs = aTools; else delete n.allowedToolRefs;
    const cap = nrCap(n.id);
    if (cap) n.budgetCapUsd = cap; else delete n.budgetCapUsd;
  }
}
function nrWireProposalRows() {
  document.querySelectorAll("[data-ndel]").forEach((b) =>
    b.addEventListener("click", () => {
      nrSyncProposal();
      const id = b.dataset.ndel;
      NR_PROPOSAL.nodes = NR_PROPOSAL.nodes.filter((n) => n.id !== id)
        .map((n) => ({ ...n, dependsOn: n.dependsOn.filter((d) => d !== id),
          leadNodeId: n.leadNodeId === id ? undefined : n.leadNodeId }));
      $("#nr-nodes").innerHTML = nrProposalRowsHtml();
      nrWireProposalRows();
      nrWireLeadRows();
      if ($("#nr-adv")?.open) $("#nr-json").value = JSON.stringify(nrGraph(), null, 2);
    }));
  nrWireLeadRows();
}
// §5.1: reflect a lead pick immediately — the row indents and shows an "under
// <lead>" badge so the two-level hierarchy is legible as you build it.
function nrWireLeadRows() {
  document.querySelectorAll("[data-nlead]").forEach((sel) =>
    sel.addEventListener("change", () => {
      const id = sel.dataset.nlead;
      const lead = sel.value;
      const row = sel.closest(".node-row");
      const label = row?.querySelector('[data-leadlabel="' + id + '"]');
      if (label) label.innerHTML = nrLeadLabelHtml(lead);
      if (row) row.style.marginLeft = lead ? "22px" : "";
      if ($("#nr-adv")?.open) $("#nr-json").value = JSON.stringify(nrGraph(), null, 2);
    }));
}
// the exact JSON the form POSTs — also what the advanced textarea pre-fills
function nrGraph() {
  if (NR_PROPOSAL) {
    return {
      run: ($("#nr-title")?.value ?? "").trim() || NR_PROPOSAL.name || "untitled run",
      escalationApproverUserId: ME.userId,
      nodes: NR_PROPOSAL.nodes.map((n) => {
        const servers = nrToolServers(n.id);
        const turns = nrMaxTurns(n.id);
        const lead = nrLead(n.id);
        const aAgents = nrAllowedAgents(n.id);
        const aTools = nrAllowedTools(n.id);
        return {
          id: n.id,
          title: ($('[data-ntitle="' + n.id + '"]')?.value ?? n.title).trim() || n.title,
          instruction: ($('[data-ninstr="' + n.id + '"]')?.value ?? n.instruction).trim() || n.instruction,
          ownerAgentId: $('[data-nagent="' + n.id + '"]')?.value ?? n.ownerAgentId,
          mode: "execute",
          dependsOn: n.dependsOn,
          ...(servers.length ? { toolServers: servers } : {}),
          ...(turns ? { maxTurns: turns } : {}),
          ...(lead ? { leadNodeId: lead } : {}),
          ...(aAgents.length ? { allowedAgentIds: aAgents } : {}),
          ...(aTools.length ? { allowedToolRefs: aTools } : {}),
          ...(nrCap(n.id) ? { budgetCapUsd: nrCap(n.id) } : {}),
        };
      }),
    };
  }
  const t = RUN_TEMPLATES.find((x) => x.id === $("#nr-template")?.value) ?? RUN_TEMPLATES[0];
  return {
    run: ($("#nr-title")?.value ?? "").trim() || "untitled run",
    // escalations land in the planner's own inbox unless the JSON names someone else
    escalationApproverUserId: ME.userId,
    nodes: t.nodes.map((n, idx) => {
      const servers = nrToolServers(n.id);
      const turns = nrMaxTurns(n.id);
      const lead = nrLead(n.id);
      const aAgents = nrAllowedAgents(n.id);
      const aTools = nrAllowedTools(n.id);
      return {
        id: n.id,
        title: ($('[data-ntitle="' + n.id + '"]')?.value ?? n.title).trim() || n.title,
        instruction: nrInstructionFor(n, idx),
        ownerAgentId: $('[data-nagent="' + n.id + '"]')?.value ?? nrDefaultAgent(),
        mode: "execute",
        dependsOn: n.dependsOn,
        ...(servers.length ? { toolServers: servers } : {}),
        ...(turns ? { maxTurns: turns } : {}),
        ...(lead ? { leadNodeId: lead } : {}),
        ...(aAgents.length ? { allowedAgentIds: aAgents } : {}),
        ...(aTools.length ? { allowedToolRefs: aTools } : {}),
      };
    }),
  };
}

async function runsPage() {
  const { runs } = await get("/v1/runs");
  const rows = runs.map((r) => {
    const st = r.state?.nodeStatuses ?? {};
    const total = Object.keys(st).length;
    const done = Object.values(st).filter((s) => s === "done").length;
    return \`<tr class="click" data-go="runs/\${r.id}">
      <td><span class="mono">\${esc(r.name)}</span></td>
      <td>\${statusBadge(r.status)}</td>
      <td class="num">\${done}/\${total} nodes</td>
      <td class="num dim">\${fmtUsd(r.budget?.measuredSpentUsd ?? 0)} spent</td>
      <td class="dim">\${ago(r.createdAt)}</td></tr>\`;
  }).join("");
  const projectOpts = ['<option value="">no project</option>']
    .concat(PROJECTS.map((p) => \`<option value="\${p.id}">\${esc(p.name)}</option>\`)).join("");
  const tplOpts = RUN_TEMPLATES.map((t) => \`<option value="\${t.id}">\${esc(t.label)}</option>\`).join("");
  const prefillNote = NR_PREFILL
    ? \`<div class="row" style="margin-bottom:8px"><span class="badge accent">from playground</span>
       <span class="dim" style="font-size:12.5px">the first node's instruction is your playground prompt — hover its title (or open Advanced) to read it</span>
       <button class="ghost small" id="nr-clearpre">clear</button></div>\`
    : "";
  // PILLAR 7: "Describe the goal" — a lead agent drafts the task graph, the
  // human reviews it in this very editor before anything is even planned.
  const leadDefault = AGENTS.some((a) => a.agentId === DEFAULT_AGENT_ID)
    ? DEFAULT_AGENT_ID
    : nrDefaultAgent();
  const leadOpts = AGENTS.map((a) =>
    \`<option value="\${a.agentId}"\${a.agentId === leadDefault ? " selected" : ""}>\${esc(a.name)} · \${esc(a.provider)} · tier \${a.tier}</option>\`).join("");
  const goalSection = \`
    <div class="row">
      <div class="grow"><label class="f">Describe the goal</label><textarea id="nr-goal" rows="2" style="width:100%" placeholder="What should this run achieve? A lead agent drafts the task graph — you review and edit it before anything runs.">\${esc(NR_GOAL)}</textarea></div>
      <div><label class="f">Lead agent</label><select id="nr-lead">\${leadOpts}</select></div>
      <div style="align-self:flex-end"><button id="nr-draft" title="one governed, metered lead dispatch drafts a proposal — it does NOT create a run">Draft plan with a lead agent</button></div>
    </div>
    <div class="err-line" id="nr-goalerr" style="margin-top:4px"></div>
    <hr class="hr">\`;
  const subNotes = NR_PROPOSAL ? NR_PROPOSAL.nodes.filter((n) => n.substituted).map((n) =>
    \`<div class="dim" style="font-size:12px;margin-bottom:4px">node \${esc(n.id)}: the lead suggested “\${esc(n.substituted.requestedAgentName)}”, which is not granted to you — swapped to \${esc(AGENT_NAMES[n.ownerAgentId] ?? "a granted agent")}.</div>\`).join("") : "";
  // §5.1: ceiling entries the lead named that fall outside your own entitlements
  // were dropped from the delegation ceiling (suggest, never grant) — surfaced
  // exactly like a substituted owner so nothing is silently widened.
  const dropNotes = NR_PROPOSAL ? NR_PROPOSAL.nodes.flatMap((n) => [
    ...((n.droppedAllowedAgents ?? []).length ? [\`<div class="dim" style="font-size:12px;margin-bottom:4px">node \${esc(n.id)}: lead ceiling dropped un-granted agent(s) \${esc(n.droppedAllowedAgents.join(", "))} — not in your entitlements.</div>\`] : []),
    ...((n.droppedAllowedTools ?? []).length ? [\`<div class="dim" style="font-size:12px;margin-bottom:4px">node \${esc(n.id)}: lead ceiling dropped un-entitled tool(s) \${esc(n.droppedAllowedTools.join(", "))}.</div>\`] : []),
  ]).join("") : "";
  const proposalNote = NR_PROPOSAL
    ? \`<div class="row" style="margin-bottom:8px">
        <span class="badge accent">plan drafted by \${esc(NR_PROPOSAL.leadName)}</span>
        <span class="badge">lead cost \${fmtUsd(NR_PROPOSAL.dispatch.costUsd)} · \${esc(NR_PROPOSAL.dispatch.modelUsed)}</span>
        \${NR_PROPOSAL.retried ? '<span class="badge warn" title="the first draft failed validation; the lead corrected it on one retry">retried once</span>' : ""}
        <span class="dim" style="font-size:12.5px">review before planning — nothing runs until you accept</span>
        <button class="ghost small" id="nr-clearprop">discard</button>
      </div>\${subNotes}\${dropNotes}\`
    : "";
  const newRun = AGENTS.length === 0
    ? '<div class="empty">No agents are granted to your account — ask an admin to grant you one before planning a run.</div>'
    : \`
    \${goalSection}
    \${proposalNote}
    \${prefillNote}
    <div class="row">
      <div class="grow"><label class="f">Title</label><input id="nr-title" placeholder="What is this run for?" value="\${esc(NR_PROPOSAL ? NR_PROPOSAL.name : (NR_PREFILL ? NR_PREFILL.split("\\n")[0].slice(0, 120) : ""))}" style="width:100%"></div>
      <div><label class="f">Bill to</label><select id="nr-project">\${projectOpts}</select></div>
      <div><label class="f">Template</label><select id="nr-template"\${NR_PROPOSAL ? ' title="picking a template discards the drafted proposal"' : ""}>\${tplOpts}</select></div>
    </div>
    <div id="nr-nodes" style="margin-top:6px">\${NR_PROPOSAL ? nrProposalRowsHtml() : nrNodeRowsHtml(RUN_TEMPLATES[0])}</div>
    <details id="nr-adv" style="margin-top:10px">
      <summary class="faint" style="cursor:pointer;font-size:11.5px">Advanced — edit the graph JSON directly (authoritative while open)</summary>
      <textarea id="nr-json" rows="16" style="width:100%;margin-top:8px" spellcheck="false"></textarea>
      <div class="faint" style="font-size:11.5px;margin-top:4px">Pre-filled from the form above; hand-edit ids, dependsOn, modes, per-node instructions, estimates, or escalationApproverUserId. Picking another template refills it.</div>
    </details>
    <div class="row" style="margin-top:10px"><button class="primary" id="nr-create">Plan run</button><span class="err-line" id="nr-err"></span></div>\`;
  return \`
  <h1>Runs</h1>
  <p class="sub">Multi-agent task graphs — planned, governed, metered.</p>
  <h2>New run</h2>
  <div class="card">\${newRun}</div>
  <h2>Your runs</h2>
  <div class="card" style="padding:0 18px">
    <table><tr><th>Run</th><th>Status</th><th>Progress</th><th>Measured spend</th><th>Created</th></tr>
    \${rows || '<tr><td colspan="5"><div class="empty">No runs yet — plan one above.</div></td></tr>'}</table>
  </div>\`;
}

function wireRuns() {
  $("#nr-clearpre")?.addEventListener("click", () => { NR_PREFILL = null; render(); });
  // PILLAR 7 goal → drafted proposal. The decompose call is a governed,
  // metered lead dispatch that returns a PROPOSAL only — it lands in this
  // editor for review; Plan run below is the unchanged human accept.
  $("#nr-goal")?.addEventListener("input", (e) => { NR_GOAL = e.target.value; });
  $("#nr-draft")?.addEventListener("click", async () => {
    const err = $("#nr-goalerr"); err.textContent = "";
    const goal = ($("#nr-goal")?.value ?? "").trim();
    NR_GOAL = goal;
    if (goal.length < 10) { err.textContent = "goal: describe it in at least 10 characters"; return; }
    const leadAgentId = $("#nr-lead")?.value;
    const projectId = $("#nr-project").value || undefined;
    const b = $("#nr-draft"); b.disabled = true; b.textContent = "Drafting…";
    try {
      const r = await post("/v1/runs/decompose", { goal, ...(leadAgentId ? { leadAgentId } : {}), ...(projectId ? { projectId } : {}) });
      NR_PROPOSAL = {
        name: r.proposal.name, nodes: r.proposal.nodes,
        dispatch: r.dispatch, retried: r.retried,
        leadName: AGENT_NAMES[r.dispatch.servedAgentId] ?? "lead agent",
      };
      render();
      toast("Plan drafted — review and adjust, then Plan run");
    } catch (e) {
      // 422 decomposition_invalid arrives with its detail via errMessage
      err.textContent = e.message;
      b.disabled = false; b.textContent = "Draft plan with a lead agent";
    }
  });
  $("#nr-clearprop")?.addEventListener("click", () => { NR_PROPOSAL = null; render(); });
  nrWireProposalRows();
  $("#nr-template")?.addEventListener("change", () => {
    NR_PROPOSAL = null; // a template pick replaces the drafted proposal
    const t = RUN_TEMPLATES.find((x) => x.id === $("#nr-template").value) ?? RUN_TEMPLATES[0];
    $("#nr-nodes").innerHTML = nrNodeRowsHtml(t);
    nrWireLeadRows();
    // a new template is a new base — refill the JSON even if it was edited
    if ($("#nr-adv").open) $("#nr-json").value = JSON.stringify(nrGraph(), null, 2);
  });
  $("#nr-adv")?.addEventListener("toggle", () => {
    const ta = $("#nr-json");
    if ($("#nr-adv").open && !ta.value.trim()) ta.value = JSON.stringify(nrGraph(), null, 2);
  });
  $("#nr-create")?.addEventListener("click", async () => {
    const err = $("#nr-err"); err.textContent = "";
    let graph;
    if ($("#nr-adv").open && $("#nr-json").value.trim()) {
      // client-side parse check first — a JSON typo never reaches the server
      try { graph = JSON.parse($("#nr-json").value); }
      catch (e) { err.textContent = "graph JSON does not parse — " + e.message; return; }
    } else {
      graph = nrGraph();
    }
    const projectId = $("#nr-project").value || undefined;
    try {
      const r = await post("/v1/runs", { graph, ...(projectId ? { projectId } : {}) });
      NR_PREFILL = null; // consumed by this run
      NR_PROPOSAL = null; NR_GOAL = ""; // the proposal was accepted into this run
      toast(r.budgetApprovalPending ? "Run planned — over your budget cap, approval requested" : "Run planned");
      location.hash = "#/runs/" + r.id;
    } catch (e) { err.textContent = e.message; } // zod issues arrive via errMessage
  });
}

// what an auto-advance pass actually stopped on — rendered, never discarded
const STOP_LABELS = {
  completed: "run completed",
  awaiting_review: "stopped: review required",
  blocked: "stopped: a node is blocked",
  budget_exceeded: "stopped: budget cap reached (estimated)",
  budget_exceeded_measured: "stopped: budget cap reached",
  max_nodes_reached: "stopped: pass node-cap reached",
  iteration_cap: "stopped: iteration cap reached",
  in_progress_elsewhere: "stopped: a node is still in progress",
  no_ready_nodes: "stopped: nothing is ready to dispatch",
  terminal: "stopped: run is terminal",
};

// Per-node execution windows from the timestamped event history: first
// node_started opens the window, the last node_submitted/node_failed closes
// it; a fresh start (retry) re-opens it. Open windows read as
// running-until-now. Overlapping windows = nodes that ran CONCURRENTLY.
function nodeTimings(events) {
  const w = {};
  for (const e of events) {
    const ev = e.event; if (!ev || !ev.nodeId) continue;
    const t = new Date(e.at).getTime();
    const win = w[ev.nodeId] ?? (w[ev.nodeId] = { start: null, end: null });
    if (ev.kind === "node_started") { if (win.start === null) win.start = t; win.end = null; }
    if (ev.kind === "node_submitted" || ev.kind === "node_failed") win.end = t;
  }
  return w;
}

// The dependency graph as a real graph: columns by dependency depth, curved
// edges from each dependency, nodes coloured exactly like the .node-dot
// status classes. Inline SVG, no library.
function dagSvg(graph, state) {
  const nodes = graph.nodes;
  const depth = {};
  const depthOf = (id) => {
    if (id in depth) return depth[id];
    depth[id] = 0; // cycle guard (the kernel already rejects cycles)
    const n = nodes.find((x) => x.id === id);
    depth[id] = (n?.dependsOn ?? []).reduce((m, dep) => Math.max(m, depthOf(dep) + 1), 0);
    return depth[id];
  };
  nodes.forEach((n) => depthOf(n.id));
  const rows = {}, pos = {};
  for (const n of nodes) {
    const c = depth[n.id];
    const r = rows[c] ?? 0;
    rows[c] = r + 1;
    pos[n.id] = { x: 70 + c * 170, y: 34 + r * 56 };
  }
  const maxC = Math.max(...nodes.map((n) => depth[n.id]), 0);
  const maxR = Math.max(...Object.values(rows), 1);
  const wpx = 70 + maxC * 170 + 110;
  const hpx = 34 + (maxR - 1) * 56 + 40;
  const color = { not_started: "var(--text-faint)", in_progress: "var(--info)", blocked: "var(--bad)", in_review: "var(--warn)", done: "var(--ok)" };
  const edges = nodes.flatMap((n) => (n.dependsOn ?? []).map((dep) => {
    const a = pos[dep], b = pos[n.id];
    if (!a || !b) return "";
    const mx = (a.x + b.x) / 2;
    return '<path d="M' + (a.x + 10) + " " + a.y + " C " + mx + " " + a.y + ", " + mx + " " + b.y + ", " + (b.x - 10) + " " + b.y + '" fill="none" stroke="var(--border-strong)" stroke-width="1.5"/>';
  }));
  const dots = nodes.map((n) => {
    const p = pos[n.id];
    const st = state.nodeStatuses[n.id];
    const short = n.id.length > 16 ? n.id.slice(0, 15) + "…" : n.id;
    return (st === "in_progress" ? '<circle cx="' + p.x + '" cy="' + p.y + '" r="12" fill="var(--info)" opacity="0.18"/>' : "")
      + '<circle cx="' + p.x + '" cy="' + p.y + '" r="7" fill="' + (color[st] ?? "var(--text-faint)") + '"/>'
      + '<text x="' + p.x + '" y="' + (p.y + 23) + '" text-anchor="middle" fill="var(--text-dim)" font-size="10.5" font-family="var(--mono)">' + esc(short) + "</text>";
  });
  return '<div class="chart"><svg viewBox="0 0 ' + wpx + " " + hpx + '" style="max-width:' + wpx + 'px" xmlns="http://www.w3.org/2000/svg">' + edges.join("") + dots.join("") + "</svg></div>";
}

// ---- pillar 8 strip: linked work items + decision records ---------------
// Shared by run detail and workflow detail. Rendered for the object's
// initiator (and admins) only: a cross-reading approver sees the object
// itself, not its PM strip — so this never fires the two reads the API
// would turn away, and their console stays clean of guaranteed 404s.
async function pmStripHtml(kind, id, ownerUserId) {
  if (ownerUserId && ME.userId !== ownerUserId && !ME.isAdmin) return "";
  const isRun = kind === "run";
  const [linksRes, decRes] = await Promise.all([
    get("/v1/pm/links?" + (isRun ? "runId=" : "instanceId=") + id).catch(() => null),
    get("/v1/decisions?objectType=" + (isRun ? "run" : "workflow_instance") + "&objectId=" + id).catch(() => null),
  ]);
  const links = (linksRes && linksRes.links) || [];
  const decisions = (decRes && decRes.decisions) || [];
  const linkRow = (l) => \`<div class="node-row">
    <div class="grow">
      <div><span class="mono">\${esc(l.externalId)}</span>
        \${l.nodeId ? ' <span class="faint mono" style="font-size:11px">node ' + esc(l.nodeId) + "</span>" : ' <span class="faint" style="font-size:11px">' + (isRun ? "run item" : "workflow item") + "</span>"}
        \${l.drift ? ' <span class="badge bad" title="the PM tool reports a different state than this node&#39;s status maps to — surfaced, never auto-fixed">drift</span>' : ""}
        \${l.orphanedAt ? ' <span class="badge warn">deleted in PM tool</span>' : ""}</div>
      <div class="dim" style="font-size:12px">\${esc(l.connectionName ?? "")} · reported state \${esc(l.inboundState ?? "—")} · synced \${l.lastSyncedAt ? ago(l.lastSyncedAt) : "never"}</div>
      \${l.externalUrl ? '<div class="faint mono" style="font-size:11px">' + esc(l.externalUrl) + "</div>" : ""}
    </div>
  </div>\`;
  const linksCard = links.length
    ? \`<h2>PM work items</h2><div class="card">
        <div class="row" style="margin-bottom:4px">
          <span class="dim" style="font-size:12.5px">The PM tool owns priority and description; RegulAIt mirrors status out and shows inbound drift instead of overwriting anything.</span>
          <span class="grow"></span>
          <button class="small" id="pm-sync-now" data-conn="\${esc(links[0].connectionName ?? "")}">Sync now</button>
        </div>
        \${links.map(linkRow).join("")}
      </div>\`
    : "";
  const decRow = (d) => \`<div class="node-row">
    <div class="grow">
      <div>\${esc(d.decision)}</div>
      <div class="dim" style="font-size:12px">by \${esc(d.decisionMakerName ?? "unknown")} · \${ago(d.createdAt)}\${d.rationale ? " · “" + esc(d.rationale) + "”" : ""}</div>
    </div>
    \${d.pmMirror ? '<span class="badge info" title="' + esc(d.pmMirror.externalUrl ?? "") + '">mirrored · ' + esc(d.pmMirror.externalId) + "</span>" : '<span class="badge">recorded</span>'}
  </div>\`;
  const decCard = decRes
    ? \`<h2>Decisions</h2><div class="card">
        \${decisions.map(decRow).join("") || '<div class="faint" style="font-size:12.5px">no decisions recorded yet</div>'}
        <div class="row" style="margin-top:10px">
          <input id="dec-new" class="grow" placeholder="Record a decision on this \${isRun ? "run" : "workflow"}…">
          <button class="small" id="dec-add">Record</button>
        </div>
        <div class="faint" style="font-size:11.5px;margin-top:4px">Recorded locally always; mirrored to the linked work item when one exists — as a Decision-typed item or a tagged comment, never silently dropped.</div>
      </div>\`
    : "";
  return linksCard + decCard;
}

function wirePmStrip(kind, id) {
  const isRun = kind === "run";
  $("#pm-sync-now")?.addEventListener("click", async () => {
    const conn = $("#pm-sync-now").dataset.conn;
    if (!conn) { toast("✗ the linked connection no longer exists"); return; }
    try {
      await post(isRun ? "/v1/runs/" + id + "/pm-sync" : "/v1/workflows/instances/" + id + "/pm-sync", { connectionName: conn });
      toast("Synced — unlinked nodes linked, timestamps refreshed"); render();
    } catch (e) { toast("✗ " + e.message); }
  });
  $("#dec-add")?.addEventListener("click", async () => {
    const text = ($("#dec-new")?.value ?? "").trim();
    if (!text) return;
    try {
      const r = await post("/v1/decisions", { objectType: isRun ? "run" : "workflow_instance", objectId: id, decision: text });
      toast(r.pmMirror
        ? (r.pmMirror.ok ? "Decision recorded — mirrored to the PM tool as " + r.pmMirror.action : "Decision recorded — PM mirror failed: " + r.pmMirror.error)
        : "Decision recorded");
      render();
    } catch (e) { toast("✗ " + e.message); }
  });
}

async function runDetailPage(id) {
  const v = await get("/v1/runs/" + id);
  const run = v.run, graph = run.graph, state = run.state, budget = run.budget ?? {};
  const outputs = {};
  for (const e of v.events) if (e.event?.kind === "node_dispatched") outputs[e.event.nodeId] = e.event;
  const now = Date.now();
  const timings = nodeTimings(v.events);
  const terminal = run.status === "completed" || run.status === "aborted";
  const overlapsAny = (nid) => {
    const a = timings[nid]; if (!a || a.start === null) return false;
    return Object.entries(timings).some(([oid, b]) =>
      oid !== nid && b.start !== null && a.start < (b.end ?? now) && b.start < (a.end ?? now));
  };
  let anyParallel = false;
  const reagentSel = (nid) => '<select data-reagent="' + nid + '">' + AGENTS.map((a) =>
    '<option value="' + a.agentId + '"' + (a.agentId === state.owners[nid] ? " selected" : "") + '>' + esc(a.name) + " · " + esc(a.provider) + "</option>").join("") + "</select>";
  const nodes = graph.nodes.map((n) => {
    const st = state.nodeStatuses[n.id];
    const out = outputs[n.id];
    // instruction edits only matter for a node that can still dispatch
    const editable = st === "not_started" || st === "in_progress" || st === "blocked";
    const instr = n.instruction ?? n.title;
    const w = timings[n.id];
    const elapsed = w && w.start !== null ? fmtDur((w.end ?? now) - w.start) : null;
    const parallel = overlapsAny(n.id);
    if (parallel) anyParallel = true;
    const editor = editable ? \`<div data-nedbox="\${n.id}" style="display:none;margin-top:6px">
        <textarea data-ninput="\${n.id}" data-def="\${esc(instr)}" rows="4" style="width:100%" spellcheck="false">\${esc(instr)}</textarea>
        <div class="faint" style="font-size:11.5px;margin-top:2px">Sent to this node's worker as its instructions on the next dispatch\${st === "in_progress" ? "" : " (auto-advance picks edits up)"}.</div>
        \${st === "in_progress" ? '<button class="small" data-dispatch="' + n.id + '" style="margin-top:6px">Dispatch with these instructions</button>' : ""}
      </div>\` : "";
    // §3's full verb set for a blocked node — retry as-is, reassign to
    // another entitled agent, or escalate to the run's named approver
    const blockedCtl = st === "blocked" ? \`<div class="row" style="margin-top:6px">
        <button class="small" data-retry="\${n.id}">Retry</button>
        \${reagentSel(n.id)}
        <button class="small" data-reassign="\${n.id}" title="re-checked against your entitlements — a run can never drift to an agent you couldn't use yourself">Reassign</button>
        <button class="small" data-escalate="\${n.id}" title="hand this failure to the run's escalation approver — it lands in their inbox">Escalate</button>
      </div>\` : "";
    return \`<div class="node-row">
      <span class="node-dot \${st}"></span>
      <div class="grow">
        <div>\${esc(n.title)} <span class="faint mono" style="font-size:11px">\${esc(n.id)}</span></div>
        <div class="dim" style="font-size:12px">\${esc(AGENT_NAMES[state.owners[n.id]] ?? "agent")}\${n.dependsOn?.length ? " · after " + n.dependsOn.join(", ") : ""}\${elapsed ? ' · <span class="num">' + elapsed + "</span>" : ""}\${nodeCapChip(graph, n.id, budget)}\${parallel ? ' <span class="badge info" title="its execution window overlapped another node&#39;s — they ran concurrently">∥ parallel</span>' : ""}</div>
        \${out ? \`<details style="margin-top:4px"><summary class="faint" style="cursor:pointer;font-size:11.5px">output · \${fmtUsd(out.costUsd)} · \${esc(out.model)}\${out.toolCalls ? ' · <span class="badge info" title="pillar 7: this worker ran a governed tool-using loop — each tool call was re-checked under your entitlements">' + out.turns + ' turn' + (out.turns === 1 ? "" : "s") + ' · ' + out.toolCalls + ' tool call' + (out.toolCalls === 1 ? "" : "s") + '</span>' : ""}\${out.toolApprovalPending ? ' <span class="badge warn" title="the loop paused on a tool approval now pending in the queue">tool approval pending</span>' : ""}</summary><pre style="margin-top:6px">\${esc(out.outputText)}</pre></details>\` : ""}
        \${state.lastError?.[n.id] ? '<div class="err-line">' + esc(state.lastError[n.id]) + "</div>" : ""}
        \${blockedCtl}
        \${editor}
      </div>
      \${editable ? '<button class="ghost small" data-nedit="' + n.id + '" title="adjust the instructions sent to this node&#39;s worker">✎</button>' : ""}
      <div>\${statusBadge(st)}</div>
      \${st === "in_review" ? '<button class="small" data-accept="' + n.id + '">Accept</button>' : ""}
    </div>\`;
  }).join("");
  const cap = budget.capUsd;
  const spent = budget.measuredSpentUsd ?? 0;
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
  // run elapsed: from the start event to the last event (terminal) or now
  const runElapsed = v.events.length
    ? fmtDur((terminal ? new Date(v.events[v.events.length - 1].at).getTime() : now) - new Date(v.events[0].at).getTime())
    : null;
  return \`
  <button class="ghost small" data-go="runs">← All runs</button>
  <h1 style="margin-top:8px">\${esc(run.name)}</h1>
  <p class="sub">\${statusBadge(run.status)} &nbsp; created \${ago(run.createdAt)}\${runElapsed ? ' · <span class="num">' + runElapsed + "</span> elapsed" : ""}\${run.projectId ? " · billed to " + esc((PROJECTS.find((p)=>p.id===run.projectId)||{}).name ?? "a project") : ""}</p>
  <div class="row" style="margin-bottom:12px">
    \${run.status === "planned" ? '<button class="primary" id="run-start">Start run</button>' : ""}
    \${run.status === "running" || run.status === "planned" ? '<button id="run-auto">Auto-advance</button><label class="dim" style="font-size:12.5px"><input type="checkbox" id="run-accept" checked style="vertical-align:-2px"> auto-accept reviews</label><button class="danger small" id="run-abort" title="stop this run for good — unfinished nodes stay where they are">Abort run</button>' : ""}
  </div>
  <div class="card">\${dagSvg(graph, state)}
    \${anyParallel ? '<div class="faint" style="font-size:11.5px;margin-top:4px">∥-marked nodes ran concurrently — independent branches dispatch as one wave, not one at a time.</div>' : ""}
  </div>
  <h2>Nodes</h2>
  <div class="card">\${nodes}</div>
  \${cap != null ? \`<h2>Budget</h2><div class="card">
    <div class="row"><span class="num">\${fmtUsd(spent)}</span><span class="dim">of \${fmtUsd(cap)} measured</span>
    \${budget.overageApproved ? '<span class="badge warn">overage approved</span>' : ""}</div>
    <div class="bar" style="margin-top:8px"><i class="\${spent > cap ? "over" : ""}" style="width:\${pct}%"></i></div>
  </div>\` : ""}
  \${v.pendingApprovals?.length ? '<h2>Waiting on approvals</h2><div class="card">' + v.pendingApprovals.map((a) => '<div class="row"><span class="mono">' + esc(approvalStageLabel(a) ?? a.stageId) + '</span><span class="dim" style="font-size:12px">awaiting ' + esc(a.approverName ?? "the named approver") + "</span>" + statusBadge(a.status) + "</div>").join("") + "</div>" : ""}
  \${await pmStripHtml("run", id, run.initiatingUserId)}\`;
}

async function wireRunDetail(id) {
  // fn may return a string to override the fixed label — the auto-advance
  // toast reports what the pass actually stopped on, not a blanket success
  const act = async (fn, label) => {
    try { const out = await fn(); toast(typeof out === "string" ? out : label); render(); }
    catch (e) { toast("✗ " + e.message); }
  };
  // --- live worker streaming (pillar 7) ----------------------------------
  // The dispatch/auto endpoints accept stream:true and reply as SSE — the
  // node route with the invoke framing (delta/result/error), the auto route
  // with a MULTIPLEXED per-node envelope: node_start {nodeId, agent},
  // node_delta {nodeId, text}, node_complete {nodeId, status[, usage,
  // costUsd]}, run_complete {status, stoppedReason, dispatched,
  // measuredSpentUsd}. Every event is keyed by nodeId, so parallel-wave
  // deltas interleave safely into one pane per active node. A non-SSE reply
  // (block-mode PII project suppresses streaming — disclosed via
  // streamingSuppressed — or any error) degrades to the buffered JSON flow.
  const ssePost = (path, payload) => fetch(path, {
    method: "POST",
    headers: { authorization: "Bearer " + KEY, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const readSse = async (res, onEvent) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\\n\\n")) !== -1) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (.+)/.exec(chunk)?.[1];
        const data = /data: (.+)/.exec(chunk)?.[1];
        if (ev && data) onEvent(ev, JSON.parse(data));
      }
    }
  };
  // one live pane per actively-streaming node — created on node_start (or
  // first delta), appended in place, badge finalized on completion; the
  // post-stream render() replaces panes with the recorded node output
  const livePane = (host, nodeId, agentName) => {
    let pane = $('[data-nlive="' + nodeId + '"]');
    if (pane || !host) return pane;
    const wrap = document.createElement("div");
    wrap.style.marginTop = "6px";
    wrap.innerHTML = '<div class="dim" style="font-size:11.5px"><span class="badge info" data-nlivebadge="' + esc(nodeId) + '">streaming</span> <span class="mono">' + esc(nodeId) + "</span>" + (agentName ? " · " + esc(agentName) : "") + '</div><pre data-nlive="' + esc(nodeId) + '" style="margin-top:4px;max-height:200px;overflow:auto;white-space:pre-wrap"></pre>';
    host.appendChild(wrap);
    return $('[data-nlive="' + nodeId + '"]');
  };
  const liveAppend = (host, nodeId, text) => {
    const pane = livePane(host, nodeId);
    if (!pane) return;
    pane.textContent += text;
    pane.scrollTop = pane.scrollHeight;
  };
  const liveDone = (nodeId, status) => {
    const b = $('[data-nlivebadge="' + nodeId + '"]');
    if (b) { b.textContent = status; b.className = "badge" + (status === "failed" || status === "refused" ? " bad" : ""); }
  };
  $("#run-start")?.addEventListener("click", () =>
    act(() => post("/v1/runs/" + id + "/events", { kind: "start" }), "Run started"));
  $("#run-abort")?.addEventListener("click", (e) => {
    if (!confirmClick(e.currentTarget, "Abort for good?")) return;
    act(() => post("/v1/runs/" + id + "/events", { kind: "abort" }), "Run aborted");
  });
  $("#run-auto")?.addEventListener("click", async () => {
    const btn = $("#run-auto");
    // any edited per-node instruction rides along as that node's input
    const inputs = {};
    document.querySelectorAll("[data-ninput]").forEach((t) => {
      const v = t.value.trim();
      if (v && v !== t.dataset.def) inputs[t.dataset.ninput] = v;
    });
    const payload = {
      stream: true,
      acceptReviews: $("#run-accept")?.checked ?? true,
      ...(Object.keys(inputs).length ? { inputs } : {}),
    };
    if (btn) btn.disabled = true;
    try {
      const res = await ssePost("/v1/runs/" + id + "/auto", payload);
      if (res.ok && res.headers.get("content-type")?.includes("event-stream")) {
        // live panel: one pane per active node — parallel-wave nodes stream
        // together, each delta appended to ITS node's pane by nodeId
        let panel = $("#auto-live");
        if (!panel) {
          panel = document.createElement("div");
          panel.id = "auto-live";
          panel.className = "card";
          panel.innerHTML = '<div class="dim" style="font-size:12px">Live worker output — one pane per active node; ∥ nodes stream together.</div>';
          (btn?.closest(".row") ?? $("#root"))?.insertAdjacentElement("afterend", panel);
        }
        let final = null;
        await readSse(res, (ev, data) => {
          if (ev === "node_start") livePane(panel, data.nodeId, AGENT_NAMES[data.agent] ?? "worker");
          if (ev === "node_delta") liveAppend(panel, data.nodeId, data.text);
          if (ev === "node_complete") liveDone(data.nodeId, data.status);
          if (ev === "run_complete") final = data;
        });
        // honest completion: say WHY the pass stopped, not just that it ran
        const label = final
          ? (STOP_LABELS[final.stoppedReason] ?? ("stopped: " + String(final.stoppedReason).replaceAll("_", " ")))
          : "stream ended early";
        toast("Auto-advance — " + label);
        render();
        return;
      }
      // graceful degrade: the buffered JSON pass (block-mode PII projects
      // suppress streaming — the server disclosed it; or an HTTP error)
      let j = null;
      try { j = await res.json(); } catch { j = null; }
      if (!res.ok) { toast("✗ " + errMessage(res.status, j ?? {})); render(); return; }
      if (j?.streamingSuppressed) toast("Streaming is disabled for this project: its PII mode is block, so worker output is checked in full before it is shown.");
      const label = STOP_LABELS[j.stoppedReason] ?? ("stopped: " + String(j.stoppedReason).replaceAll("_", " "));
      toast("Auto-advance took " + j.steps.length + " step" + (j.steps.length === 1 ? "" : "s") + " — " + label);
      render();
    } catch (e) { toast("✗ " + e.message); render(); }
  });
  document.querySelectorAll("[data-nedit]").forEach((b) =>
    b.addEventListener("click", () => {
      const box = $('[data-nedbox="' + b.dataset.nedit + '"]');
      if (box) box.style.display = box.style.display === "none" ? "" : "none";
    }));
  // manual dispatch of an in_progress node (e.g. one a failed pass stranded):
  // dispatch with the adjusted instructions — live-streaming the worker's
  // tokens into a pane under the editor — then submit the output for review,
  // the same two steps an auto-advance pass takes.
  document.querySelectorAll("[data-dispatch]").forEach((b) =>
    b.addEventListener("click", async () => {
      const nodeId = b.dataset.dispatch;
      const t = $('[data-ninput="' + nodeId + '"]');
      const v = (t?.value ?? "").trim();
      const host = $('[data-nedbox="' + nodeId + '"]') ?? b.parentElement;
      b.disabled = true;
      try {
        const res = await ssePost("/v1/runs/" + id + "/nodes/" + nodeId + "/dispatch",
          { stream: true, ...(v && v !== t.dataset.def ? { input: v } : {}) });
        if (res.ok && res.headers.get("content-type")?.includes("event-stream")) {
          let failed = null;
          await readSse(res, (ev, data) => {
            if (ev === "delta") liveAppend(host, nodeId, data.text);
            if (ev === "error") failed = data;
          });
          liveDone(nodeId, failed ? "failed" : "done");
          if (failed) { toast("✗ " + (failed.detail ?? failed.error ?? "dispatch failed")); render(); return; }
        } else {
          // graceful degrade: buffered JSON (block-mode PII projects suppress
          // streaming — the server disclosed it; or an HTTP error)
          let j = null;
          try { j = await res.json(); } catch { j = null; }
          if (!res.ok) { toast("✗ " + errMessage(res.status, j ?? {})); render(); return; }
          if (j?.streamingSuppressed) toast("Streaming is disabled for this project: its PII mode is block, so worker output is checked in full before it is shown.");
        }
        await post("/v1/runs/" + id + "/events", { kind: "node_submitted", nodeId });
        toast("Node dispatched — output submitted for review");
        render();
      } catch (e) { toast("✗ " + e.message); render(); }
    }));
  document.querySelectorAll("[data-accept]").forEach((b) =>
    b.addEventListener("click", () =>
      act(() => post("/v1/runs/" + id + "/events", { kind: "node_accepted", nodeId: b.dataset.accept }), "Accepted")));
  document.querySelectorAll("[data-retry]").forEach((b) =>
    b.addEventListener("click", () =>
      act(() => post("/v1/runs/" + id + "/events", { kind: "retry_node", nodeId: b.dataset.retry }), "Node re-opened")));
  // §3's remaining verbs, first-class in the kernel but so far API-only:
  // reassign re-checks the new owner against YOUR entitlements server-side;
  // escalate parks the failure in the named approver's inbox.
  document.querySelectorAll("[data-reassign]").forEach((b) =>
    b.addEventListener("click", () =>
      act(() => post("/v1/runs/" + id + "/events", {
        kind: "reassign_node",
        nodeId: b.dataset.reassign,
        ownerAgentId: $('[data-reagent="' + b.dataset.reassign + '"]')?.value,
      }), "Node reassigned and re-opened")));
  document.querySelectorAll("[data-escalate]").forEach((b) =>
    b.addEventListener("click", () =>
      act(() => post("/v1/runs/" + id + "/events", { kind: "escalate_node", nodeId: b.dataset.escalate }),
        "Escalated — waiting in the approver's inbox")));
  wirePmStrip("run", id);
}

// -------------------------------------------------------------- workflows --
let WF_ROUTES = {}; // changeType -> [template names] (names only, from the API)
async function workflowsPage() {
  const { instances, changeTypes, routes } = await get("/v1/workflows/instances");
  WF_ROUTES = {};
  for (const r of routes ?? []) WF_ROUTES[r.changeType] = r.templates ?? [];
  const rows = instances.map((i) => \`<tr class="click" data-go="workflows/\${i.id}">
    <td>\${esc(i.change?.description ?? "")}</td>
    <td>\${statusBadge(i.status)}</td>
    <td class="dim mono" style="font-size:11.5px">\${esc(i.change?.changeType ?? "")}</td>
    <td class="dim">\${ago(i.createdAt)}</td></tr>\`).join("");
  const projectOpts = ['<option value="">no project</option>']
    .concat(PROJECTS.map((p) => \`<option value="\${p.id}">\${esc(p.name)}</option>\`)).join("");
  // Only changeTypes an assignment rule actually routes are offered — a
  // free-text type was a guaranteed no_workflow_matches_change dead end.
  const typeField = (changeTypes ?? []).length
    ? \`<div><label class="f">Type</label><select id="wf-type">\${(changeTypes ?? []).map((t) => \`<option value="\${esc(t)}">\${esc(t)}</option>\`).join("")}</select>
       <div class="faint" style="font-size:11px;margin-top:3px;max-width:230px" id="wf-route" aria-live="polite"></div></div>\`
    : '<div><label class="f">Type</label><div class="dim" style="font-size:12.5px;padding-top:8px">no routable change types — an admin must add an assignment rule</div></div>';
  return \`
  <h1>Workflows</h1>
  <p class="sub">Governed change requests — intake to sign-off to build, checks, PR and merge.</p>
  <div class="card">
    <div class="row">
      <div class="grow"><label class="f">Describe the change</label><input id="wf-desc" placeholder="Add rate limiting to the public API" style="width:100%"></div>
      \${typeField}
      <div><label class="f">Target system</label><input id="wf-target" placeholder="optional" style="width:130px" title="ADR-0018 §4: the target system this change lands on — an assignment rule can route on it"></div>
      <div><label class="f">Bill to</label><select id="wf-project">\${projectOpts}</select></div>
      <div style="align-self:flex-end"><button class="primary" id="wf-new"\${(changeTypes ?? []).length ? "" : " disabled"}>Start workflow</button></div>
    </div>
    <div class="err-line" id="wf-err" style="margin-top:6px"></div>
  </div>
  <div class="card" style="padding:0 18px;margin-top:12px">
    <table><tr><th>Change</th><th>Status</th><th>Type</th><th>Created</th></tr>
    \${rows || '<tr><td colspan="4"><div class="empty">No workflow instances yet.</div></td></tr>'}</table>
  </div>\`;
}

async function workflowDetailPage(id) {
  const v = await get("/v1/workflows/instances/" + id);
  const inst = v.instance, def = inst.definition, state = inst.state;
  const rail = def.stages.map((s, i) => {
    const st = state.stageStatuses[i];
    const cls = i === state.currentStageIndex && !["completed","denied","aborted"].includes(inst.status) ? "active" : st;
    return '<span class="stage ' + cls + '">' + esc(s.id) + '<span class="faint" style="font-size:10px">' + esc(s.type) + "</span></span>";
  }).join("");
  const current = def.stages[state.currentStageIndex];
  let action = "";
  if (inst.status === "blocked_on_artifact" && current) {
    action = \`<h2>Submit \${esc(current.output ?? "artifact")}</h2><div class="card">
      <textarea id="wf-artifact" rows="6" style="width:100%" placeholder="Write the \${esc(current.output ?? "artifact")} content…"></textarea>
      <div class="row" style="margin-top:10px"><button class="primary" id="wf-submit">Submit for sign-off</button><span class="err-line" id="wf-derr"></span></div>
    </div>\`;
  } else if (inst.status === "blocked_on_approval") {
    const awaiting = [...new Set((v.pendingApprovals ?? []).map((a) => a.approverName ?? "the named approver"))];
    action = '<div class="card"><span class="badge warn">waiting for sign-off</span> <span class="dim">awaiting ' + esc(awaiting.join(", ") || "the named approver") + " — it is in their inbox</span></div>";
  } else if (inst.status === "awaiting_trigger" && current) {
    action = \`<div class="card"><div class="row"><button class="primary" id="wf-advance">Run \${esc(current.id)}</button><span class="err-line" id="wf-derr"></span></div></div>\`;
  } else if (inst.status === "awaiting_execution") {
    action = '<div class="card"><span class="badge info">executing</span> <span class="dim">a nested run or git operation is in flight' + (inst.context?.["runId:" + (current?.id ?? "")] ? ' — <a href="#/runs/' + inst.context["runId:" + current.id] + '">watch the run</a>' : "") + "</span>" + (inst.context?.lastError ? '<div class="err-line" style="margin-top:6px">' + esc(inst.context.lastError) + "</div>" : "") + "</div>";
  } else if (inst.status === "blocked_on_check" && current) {
    // §2 a required check failed — the pipeline is parked here. Name the
    // failing checks, let the initiator mark one remediated (report a pass),
    // and re-run the stage. A real CI would POST the results instead.
    const failed = (inst.context?.["checks:" + current.id] ?? []).filter((c) => c.status === "failed");
    action = \`<div class="card">
      <div class="row" style="align-items:center"><span class="badge bad">checks failed</span>
        <span class="dim">\${failed.map((c) => esc(c.check)).join(", ") || "a required check"} must pass before this can proceed.</span></div>
      \${failed.map((c) => \`<div class="row" style="margin-top:8px"><span class="mono">\${esc(c.check)}</span>\${c.severity ? ' <span class="badge warn">' + esc(c.severity) + "</span>" : ""}
        <button class="small" data-passcheck="\${esc(c.check)}" data-stage="\${esc(current.id)}" title="record this check as remediated (reports a passing result)">mark passing</button></div>\`).join("")}
      <div class="row" style="margin-top:12px"><button class="primary" id="wf-recheck" data-stage="\${esc(current.id)}">Re-run checks</button>
        <span class="err-line" id="wf-derr"></span></div>
    </div>\`;
  } else if (inst.status === "blocked_on_deploy" && current) {
    // §2 the deploy couldn't proceed (no target, or its condition wasn't met) —
    // a manual handoff. Name the reason; let the operator confirm and advance.
    action = \`<div class="card">
      <div class="row" style="align-items:center"><span class="badge warn">deploy on hold</span>
        <span class="dim">\${esc(inst.context?.lastError ?? "this deploy needs a manual handoff before it can proceed.")}</span></div>
      <div class="row" style="margin-top:12px"><button class="primary" id="wf-deployoverride" data-stage="\${esc(current.id)}" title="confirm the deploy was handled out-of-band (or the condition is acceptable) and advance">Mark deployed &amp; continue</button>
        <span class="err-line" id="wf-derr"></span></div>
    </div>\`;
  } else if (inst.status === "rolled_back") {
    const rb = Object.keys(inst.context ?? {}).filter((k) => k.startsWith("rollback:")).map((k) => inst.context[k])[0];
    action = '<div class="card"><span class="badge bad">rolled back</span> <span class="dim">a post-deploy check failed and the deployment was reversed' + (rb?.reverted ? " (" + esc(rb.reverted) + ")" : "") + ". This run is closed.</span></div>";
  }
  // §9.4: an artifact of a project-billed instance can be promoted into that
  // project's shared context — opt-in, by the artifact's own initiator only
  // (the server rejects anyone else; the click handler says so gracefully).
  const projName = inst.projectId
    ? ((PROJECTS.find((p) => p.id === inst.projectId) || {}).name ?? "the project")
    : null;
  const artifacts = (v.artifacts ?? []).map((a) =>
    \`<details style="margin-bottom:8px"><summary class="dim" style="cursor:pointer">\${esc(a.output)} v\${a.version}</summary><pre style="margin-top:6px">\${esc(a.content)}</pre>
      \${inst.projectId ? \`<div class="row" style="margin-top:6px"><button class="small" data-promote="\${a.id}" data-pid="\${inst.projectId}">Promote to shared context</button><span class="faint" style="font-size:11.5px">copies this version into \${esc(projName)}’s shared context with provenance — initiator only</span></div>\` : ""}
    </details>\`).join("");
  // The check executor records what it ran into context under "checks:<stage>"
  // — surface every named check with its pass result, not just "advanced".
  const checkCards = def.stages
    .filter((s) => s.type === "automated_check" && inst.context?.["checks:" + s.id])
    .map((s) => {
      const results = inst.context["checks:" + s.id];
      return \`<h2>Checks · \${esc(s.id)}</h2><div class="card">\`
        + results.map((c) => \`<div class="node-row">
            <div class="grow"><span class="mono">\${esc(c.check)}</span>
              \${c.severity ? '<span class="badge warn" style="margin-left:6px">' + esc(c.severity) + "</span>" : ""}
              <span class="dim" style="font-size:12px"> · \${esc(c.detail ?? "")}</span></div>
            \${c.status === "passed" ? '<span class="badge ok">passed</span>' : statusBadge(c.status)}
          </div>\`).join("")
        + "</div>";
    }).join("");
  // Delivery: everything the git stages produced — branch, PR, merge sha.
  const ctx2 = inst.context ?? {};
  // §2 the deployment(s) this run produced, newest first, with any rollback.
  const deployRow = Object.keys(ctx2).filter((k) => k.startsWith("deploy:")).map((k) => ctx2[k])[0];
  const rollbackRow = Object.keys(ctx2).filter((k) => k.startsWith("rollback:")).map((k) => ctx2[k])[0];
  const delivery = ctx2.branch || ctx2.prUrl || ctx2.mergeSha || deployRow
    ? '<h2>Delivery</h2><div class="card">'
      + (ctx2.branch ? '<div class="row"><span class="faint" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em">branch</span><span class="mono">' + esc(ctx2.branch) + "</span></div>" : "")
      + (ctx2.prUrl ? '<div class="row" style="margin-top:6px"><span class="faint" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em">pull request</span><a href="' + esc(ctx2.prUrl) + '" class="mono">' + esc(ctx2.prUrl) + "</a>" + (ctx2.prId ? ' <span class="badge">#' + esc(ctx2.prId) + "</span>" : "") + "</div>" : "")
      + (ctx2.mergeSha ? '<div class="row" style="margin-top:6px"><span class="faint" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em">merged</span><span class="mono">' + esc(ctx2.mergeSha) + '</span><span class="badge ok">merged</span></div>' : "")
      + (deployRow ? '<div class="row" style="margin-top:6px"><span class="faint" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em">deployed</span><span class="mono">' + esc(deployRow.target) + (deployRow.environment ? " · " + esc(deployRow.environment) : "") + "</span>"
          + (deployRow.dryRun ? '<span class="badge warn" title="#79c honesty: the deploy adapter ran in dry-run mode — nothing was actually mutated on the target. A dry-run never satisfies a production deploy gate.">dry-run</span>' : "")
          + (rollbackRow ? '<span class="badge bad">rolled back</span>' : (deployRow.dryRun ? "" : '<span class="badge ok">live</span>')) + "</div>" : "")
      + "</div>"
    : "";
  return \`
  <button class="ghost small" data-go="workflows">← All workflows</button>
  <h1 style="margin-top:8px">\${esc(inst.change?.description ?? "")}</h1>
  <p class="sub">\${statusBadge(inst.status)} &nbsp; \${esc(inst.change?.changeType ?? "")} · \${esc(inst.change?.environment ?? "")} · created \${ago(inst.createdAt)}</p>
  <div class="card"><div class="stage-rail">\${rail}</div></div>
  \${action}
  \${artifacts ? "<h2>Artifacts</h2><div class=card>" + artifacts + "</div>" : ""}
  \${checkCards}
  \${delivery}
  \${await pmStripHtml("workflow_instance", id, inst.initiatorUserId)}\`;
}

function wireWorkflows() {
  // the resolved template(s) are shown LIVE beside the Type select — never a
  // silent route to whatever happens to match first
  const showRoute = () => {
    const out = $("#wf-route");
    if (!out) return;
    const tpls = WF_ROUTES[$("#wf-type")?.value] ?? [];
    out.textContent = tpls.length
      ? "\\u2192 runs the \\u201C" + tpls.join("\\u201D + \\u201C") + "\\u201D workflow" + (tpls.length > 1 ? "s (merged)" : "")
      : "";
  };
  showRoute();
  $("#wf-type")?.addEventListener("change", showRoute);
  $("#wf-new")?.addEventListener("click", async () => {
    try {
      const projectId = $("#wf-project").value || undefined;
      const targetSystem = ($("#wf-target")?.value || "").trim() || undefined;
      const r = await post("/v1/workflows/instances", {
        ...(projectId ? { projectId } : {}),
        change: {
          description: $("#wf-desc").value || "untitled change",
          paths: ["src/"],
          changeType: $("#wf-type")?.value || "feature",
          environment: "staging",
          ...(targetSystem ? { targetSystem } : {}),
        },
      });
      location.hash = "#/workflows/" + r.id;
    } catch (e) { $("#wf-err").textContent = e.message + (e.payload?.error === "no_workflow_matches_change" ? " — no assignment rule matches this change type" : ""); }
  });
}
function wireWorkflowDetail(id, inst) {
  $("#wf-submit")?.addEventListener("click", async () => {
    try {
      const v = await get("/v1/workflows/instances/" + id);
      const current = v.instance.definition.stages[v.instance.state.currentStageIndex];
      await post("/v1/workflows/instances/" + id + "/artifacts", { stageId: current.id, content: $("#wf-artifact").value });
      toast("Artifact submitted — sign-off requested"); render();
    } catch (e) { $("#wf-derr").textContent = e.message; }
  });
  $("#wf-advance")?.addEventListener("click", async () => {
    try {
      const v = await get("/v1/workflows/instances/" + id);
      const current = v.instance.definition.stages[v.instance.state.currentStageIndex];
      await post("/v1/workflows/instances/" + id + "/advance", { stageId: current.id });
      toast("Stage advanced"); render();
    } catch (e) { $("#wf-derr").textContent = e.message; }
  });
  document.querySelectorAll("[data-promote]").forEach((b) =>
    b.addEventListener("click", () => promoteArtifact(b.dataset.pid, b.dataset.promote)));
  // §2 remediate a failing check: report it as passing (a real CI would POST
  // the passing result instead), then Re-run checks resumes the pipeline.
  document.querySelectorAll("[data-passcheck]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await post("/v1/workflows/instances/" + id + "/checks", {
          stageId: b.dataset.stage,
          results: [{ check: b.dataset.passcheck, status: "passed", detail: "remediated" }],
        });
        toast("Marked " + b.dataset.passcheck + " passing — re-run checks to proceed");
      } catch (e) { toast("✗ " + e.message); }
    }));
  $("#wf-recheck")?.addEventListener("click", async () => {
    try {
      await post("/v1/workflows/instances/" + id + "/recheck", { stageId: $("#wf-recheck").dataset.stage });
      toast("Re-ran checks"); render();
    } catch (e) { $("#wf-derr").textContent = e.message; }
  });
  $("#wf-deployoverride")?.addEventListener("click", async () => {
    try {
      await post("/v1/workflows/instances/" + id + "/deploy-override", { stageId: $("#wf-deployoverride").dataset.stage });
      toast("Deploy handed off — continuing"); render();
    } catch (e) { $("#wf-derr").textContent = e.message; }
  });
  wirePmStrip("workflow_instance", id);
}

// ------------------------------------------------------------------ inbox --
const approvalLabel = (a) => {
  // sentinel stages share one mapping with /admin's queue (ui-theme.ts) so
  // the two surfaces can never label the same approval differently
  const sentinel = approvalStageLabel(a);
  if (sentinel) return sentinel;
  if (a.objectType === "infra_operation") return "Infra remediation" + (a.objectLabel ? " · " + a.objectLabel : "");
  return (a.objectType === "workflow" ? "Sign-off · " : a.objectType === "run" ? "Run escalation · " : "") + (a.stageId ?? "");
};
// where the governed object lives in this app — the row must let the
// approver walk to the thing itself, not just name it
const approvalTarget = (a) => {
  if (a.instanceId) return "workflows/" + a.instanceId;
  if (a.runId) return "runs/" + a.runId;
  if (a.projectId) return "projects";
  return null;
};
async function inboxPage() {
  const { approvals } = await get("/v1/approvals");
  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending").slice(0, 12);
  // Workflow sign-offs decide on an ARTIFACT — fetch each governed instance
  // once (the read endpoint admits the named approver) so the submitted
  // requirements sit inside the row, collapsed until wanted.
  const instances = {};
  await Promise.all([...new Set(pending.filter((a) => a.objectType === "workflow" && a.instanceId).map((a) => a.instanceId))]
    .map(async (id) => { try { instances[id] = await get("/v1/workflows/instances/" + id); } catch {} }));
  const preview = (a) => {
    const v = a.instanceId && instances[a.instanceId];
    if (!v) return "";
    let h = "";
    const latest = {};
    for (const art of v.artifacts ?? []) if (!latest[art.output] || art.version > latest[art.output].version) latest[art.output] = art;
    h += Object.values(latest).map((art) =>
      \`<details style="margin-top:6px"><summary class="faint" style="cursor:pointer;font-size:11.5px">submitted \${esc(art.output)} v\${art.version}</summary><pre style="margin-top:6px">\${esc(art.content)}</pre></details>\`).join("");
    // MERGE-GATE context: the approver decides on the CHANGE, so the change's
    // evidence sits in the row — the PR link and the recorded check results
    // from the stage context (fresher data would need git credentials the
    // approver may not hold; the stage context is what the pipeline saw).
    const ctx = v.instance?.context ?? {};
    if (ctx.prUrl || ctx.branch) {
      h += '<div class="row" style="margin-top:6px;font-size:12px">'
        + (ctx.prUrl ? '<a href="' + esc(ctx.prUrl) + '" class="mono" target="_blank" rel="noopener">' + esc(ctx.prUrl) + "</a>" + (ctx.prId ? ' <span class="badge">#' + esc(ctx.prId) + "</span>" : "") : "")
        + (ctx.branch ? '<span class="mono dim">' + esc(ctx.branch) + "</span>" : "")
        + "</div>";
    }
    const checkRows = Object.keys(ctx).filter((k) => k.indexOf("checks:") === 0)
      .flatMap((k) => Array.isArray(ctx[k]) ? ctx[k] : []);
    if (checkRows.length) {
      h += '<div class="row" style="margin-top:6px;flex-wrap:wrap">'
        + checkRows.map((c) => '<span class="badge ' + (c.status === "passed" ? "ok" : "bad") + '" title="' + esc(c.detail ?? "") + '">' + esc(c.check) + " \\u00B7 " + esc(c.status) + "</span>").join(" ")
        + "</div>";
    }
    const deploys = Object.keys(ctx).filter((k) => k.indexOf("deploy:") === 0).map((k) => ctx[k]);
    if (deploys.some((d) => d && d.dryRun)) {
      h += '<div class="row" style="margin-top:6px"><span class="badge warn" title="#79c: the recorded deploy was a dry-run — nothing was actually mutated">deploy was a dry-run</span></div>';
    }
    return h;
  };
  // §9 arbitration is a choice between two TEXTS — both sides sit in the row,
  // visible, so the arbiter never decides blind.
  const conflictPreview = (a) => {
    const c = a.contextConflict;
    if (!c) return "";
    const side = (label, s) => \`<div><label class="f">\${label}</label><pre>\${esc(s ? s.content : "(none)")}</pre></div>\`;
    return \`<div class="grid2" style="margin-top:8px">
      \${side("currently accepted · rev " + (c.current ? c.current.revision : "—") + (c.current && c.current.byName ? " · " + esc(c.current.byName) : ""), c.current)}
      \${side("proposed · rev " + c.conflicting.revision + (c.conflicting.baseRevision != null ? " (based on rev " + c.conflicting.baseRevision + ")" : "") + (c.conflicting.byName ? " · " + esc(c.conflicting.byName) : ""), c.conflicting)}
    </div>
    <div class="faint" style="font-size:11.5px;margin-top:4px">Approve makes the proposed revision the current value; deny keeps it retained in history, never current.</div>\`;
  };
  // decide controls: the named approver decides; an admin may override with a
  // MANDATORY reason (recorded + audit-marked server-side); anyone else sees
  // who the decision is waiting on.
  const controls = (a) => {
    const named = ME.userId === a.approverUserId;
    // ADR-0022: a row that reached this inbox via an active delegation is
    // decidable by the delegate — recorded as them, on-behalf-of the named
    // approver, both audited.
    const delegated = Boolean(a.delegatedFrom);
    if (!named && !delegated && !ME.isAdmin) return '<span class="dim" style="font-size:12px">awaiting ' + esc(a.approverName ?? "the named approver") + "</span>";
    const badge = named ? ""
      : delegated ? '<span class="badge info" title="delegated to you — your decision is recorded on behalf of ' + esc(a.delegatedFrom) + '">for ' + esc(a.delegatedFrom) + "</span>"
      : '<span class="badge warn" title="you are not the named approver — a reason is required">override</span>';
    const ph = named || delegated ? "reason (optional)" : "reason (required — admin override)";
    return badge
      + \`<input data-reason="\${a.id}" placeholder="\${ph}" style="font-size:12px;max-width:\${named ? 170 : 210}px">
      <button class="small primary" data-decide="approved" data-id="\${a.id}">Approve</button>
      <button class="small danger" data-decide="denied" data-id="\${a.id}">Deny</button>\`;
  };
  const pendingRow = (a) => {
    const target = approvalTarget(a);
    const what = a.objectLabel
      ? (target ? \`<a href="#/\${target}">\${esc(a.objectLabel)}</a>\` : esc(a.objectLabel))
      : (target ? \`<a href="#/\${target}">view \${esc(a.objectType)}</a>\` : "");
    return \`<div class="node-row">
    <div class="grow">
      <div>\${esc(approvalLabel(a))}\${what ? " · " + what : ""}</div>
      <div class="dim" style="font-size:12px">\${esc(a.objectType)} · requested by \${esc(a.requestedByName ?? "unknown")} · \${ago(a.requestedAt)}</div>
      \${preview(a)}\${conflictPreview(a)}
    </div>
    \${controls(a)}
  </div>\`;
  };
  const decidedRow = (a) => \`<div class="node-row">
    <div class="grow">
      <div>\${esc(approvalLabel(a))}\${a.objectLabel ? ' · <span class="dim">' + esc(a.objectLabel) + "</span>" : ""}</div>
      <div class="dim" style="font-size:12px">requested by \${esc(a.requestedByName ?? "unknown")} · decided by \${esc(a.decidedByName ?? "—")}\${a.decidedAt ? " " + ago(a.decidedAt) : ""}</div>
      \${a.decisionReason ? '<div class="faint" style="font-size:12px">“' + esc(a.decisionReason) + '”</div>' : ""}
    </div>
    \${statusBadge(a.status)}
  </div>\`;
  return \`
  <h1>Inbox</h1>
  <p class="sub">Everything that pauses for you: sign-offs, escalations, budget overages, context conflicts.</p>
  <div class="card">\${pending.map(pendingRow).join("") || '<div class="empty">Nothing waiting on you.</div>'}</div>
  \${decided.length ? "<h2>Recently decided</h2><div class=card>" + decided.map(decidedRow).join("") + "</div>" : ""}\`;
}
function wireInbox() {
  document.querySelectorAll("[data-decide]").forEach((b) =>
    b.addEventListener("click", async () => {
      const reason = ($('[data-reason="' + b.dataset.id + '"]')?.value ?? "").trim();
      try {
        await post("/v1/approvals/" + b.dataset.id + "/decide", { decision: b.dataset.decide, ...(reason ? { reason } : {}) });
        toast(b.dataset.decide === "approved" ? "Approved" : "Denied");
        const inbox = await get("/v1/approvals");
        INBOX_COUNT = inbox.approvals.filter((a) => a.status === "pending").length;
        render();
      } catch (e) { toast("✗ " + e.message); }
    }));
}

// --------------------------------------------------------------- projects --
// The pillar-4 write surface. The context editor follows §9.2's
// read-before-write contract to the letter: it fetches the current accepted
// revision when it opens, re-checks it before submitting, and when the key
// moved underneath the edit it never submits silently — the member sees both
// texts and chooses a fresh base or a deliberate stale-base submit that goes
// to the named arbiter.
let CTXED = null;            // the one open context editor
const HIST_OPEN = new Set(); // open history drawers, "projectId\\u0000key"
let DIRECTORY = [];          // names-only user directory (never emails/keys)

async function openCtxEditor(projectId, key) {
  if (key) {
    // (a) fetch the current revision FIRST — the edit is based on something real
    try {
      const cur = await get("/v1/projects/" + projectId + "/context?key=" + encodeURIComponent(key));
      const item = (cur.context ?? [])[0];
      CTXED = { projectId, key, base: item ? item.revision : undefined, draft: item ? item.content : "", conflict: null };
    } catch (e) { toast("✗ " + e.message); return; }
  } else {
    CTXED = { projectId, key: null, newKey: "", base: undefined, draft: "", conflict: null };
  }
  render();
}

async function submitCtx(mode) { // "auto" | "fresh" (rebase) | "stale" (to arbiter)
  const c = CTXED; if (!c) return;
  const key = c.key ?? ($("#ctx-newkey")?.value ?? c.newKey ?? "").trim();
  const draft = $("#ctx-draft") ? $("#ctx-draft").value : c.draft;
  c.draft = draft; if (c.key === null) c.newKey = key;
  const err = $("#ctx-err");
  if (err) err.textContent = "";
  if (!key) { if (err) err.textContent = "key: a key is required"; return; }
  if (!draft.trim()) { if (err) err.textContent = "content: nothing to save"; return; }
  const payload = { key, content: draft };
  if (mode === "stale" && c.base !== undefined) {
    payload.baseRevision = c.base; // deliberately against the stale base → arbiter
  } else if (mode === "fresh" && c.conflict) {
    payload.baseRevision = c.conflict.revision; // rebase on what is accepted now
  } else {
    // (b) read-before-write: re-check the accepted revision at submit time
    let latest = null;
    try {
      const cur = await get("/v1/projects/" + c.projectId + "/context?key=" + encodeURIComponent(key));
      latest = (cur.context ?? [])[0] ?? null;
    } catch (e) { if (err) err.textContent = e.message; return; }
    if (latest && c.base !== undefined && latest.revision === c.base) {
      payload.baseRevision = c.base;
    } else if (latest) {
      // (c) it moved while editing — show both texts, never submit silently
      c.conflict = { revision: latest.revision, content: latest.content, byName: latest.provenance?.userName ?? null };
      render(); return;
    }
    // no accepted revision at all → genuinely new key, no baseRevision
  }
  try {
    const r = await post("/v1/projects/" + c.projectId + "/context", payload);
    CTXED = null;
    toast(r.conflict
      ? "Saved as revision " + r.revision + " — the conflict was sent to the arbiter to resolve"
      : "Revision " + r.revision + " accepted");
    render();
  } catch (e) {
    if (e.status === 409 && e.payload && e.payload.error === "base_revision_required") {
      // the key existed after all (e.g. someone created it first) — same conflict UI
      try {
        const cur = await get("/v1/projects/" + c.projectId + "/context?key=" + encodeURIComponent(key));
        const latest = (cur.context ?? [])[0];
        if (latest) {
          c.key = key;
          c.conflict = { revision: latest.revision, content: latest.content, byName: latest.provenance?.userName ?? null };
          render(); return;
        }
      } catch {}
    }
    if ($("#ctx-err")) $("#ctx-err").textContent = e.message; else toast("✗ " + e.message);
  }
}

async function promoteArtifact(projectId, artifactId) {
  try {
    const r = await post("/v1/projects/" + projectId + "/context/promote", { artifactId });
    toast(r.conflict
      ? "Promoted as revision " + r.revision + " — the conflict was sent to the arbiter"
      : "Promoted into shared context as '" + r.key + "' revision " + r.revision);
    render();
  } catch (e) {
    if (e.status === 403 && e.payload && e.payload.error === "not_the_artifact_owner") {
      toast("Only the workflow's initiator can promote its artifacts — this one isn't yours to share.");
    } else { toast("✗ " + e.message); }
  }
}

function ctxEditorHtml(ctx) {
  const c = CTXED;
  const arbName = ctx.arbiter?.name ?? "the project arbiter";
  if (c.conflict) {
    const k = c.key ?? c.newKey;
    return \`<div class="card" style="margin:8px 0 4px;border-color:#d9a44166">
      <div class="row"><span class="badge warn">changed while you were editing</span>
        <span class="dim" style="font-size:12.5px">'\${esc(k)}' is now at rev \${c.conflict.revision}\${c.conflict.byName ? " by " + esc(c.conflict.byName) : ""}\${c.base !== undefined ? " — your edit was based on rev " + c.base : ""}.</span></div>
      <div class="grid2" style="margin-top:10px">
        <div><label class="f">Now accepted · rev \${c.conflict.revision}</label><pre>\${esc(c.conflict.content)}</pre></div>
        <div><label class="f">Your text</label><pre>\${esc(c.draft)}</pre></div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="primary small" data-ctxfresh>Rebase on rev \${c.conflict.revision} and submit</button>
        \${c.base !== undefined ? '<button class="small" data-ctxstale>Submit against my stale base</button>' : ""}
        <button class="ghost small" data-ctxcancel>Cancel</button>
      </div>
      \${c.base !== undefined ? '<div class="faint" style="font-size:11.5px;margin-top:6px">Submitting against the stale base keeps your text as a retained revision — this will be sent to ' + esc(arbName) + " to resolve. Nothing is overwritten either way.</div>" : ""}
    </div>\`;
  }
  return \`<div style="margin:8px 0 4px">
    \${c.key === null ? \`<div><label class="f">Key</label><input id="ctx-newkey" value="\${esc(c.newKey ?? "")}" placeholder="e.g. coding-standards"></div>\` : ""}
    <textarea id="ctx-draft" rows="5" style="width:100%;margin-top:6px" spellcheck="false">\${esc(c.draft)}</textarea>
    <div class="faint" style="font-size:11.5px;margin-top:4px">\${c.base !== undefined
      ? "Editing from accepted rev " + c.base + " — the write names its base revision, so nothing is silently overwritten. A write against a stale base would be sent to " + esc(arbName) + " to resolve."
      : "First revision of a new key."}</div>
    <div class="row" style="margin-top:8px">
      <button class="primary small" data-ctxsave>Save revision</button>
      <button class="ghost small" data-ctxcancel>Cancel</button>
      <span class="err-line" id="ctx-err"></span>
    </div>
  </div>\`;
}

const ctxHistHtml = (rows) => \`<div style="margin-top:8px;border-left:2px solid var(--border-strong);padding-left:10px">\` +
  rows.slice().reverse().map((r) => {
    const state = r.accepted ? '<span class="badge ok">accepted</span>'
      : r.pendingApprovalId ? '<span class="badge warn">awaiting arbiter</span>'
      : '<span class="badge bad">rejected</span>';
    return \`<div style="padding:4px 0">
      <span class="mono" style="font-size:11.5px">rev \${r.revision}</span> \${state}
      \${r.sourceArtifactId ? '<span class="badge info">from artifact</span>' : ""}
      <span class="dim" style="font-size:12px">by \${esc(r.byName ?? "unknown")}\${r.teamName ? " · " + esc(r.teamName) : ""}\${r.baseRevision ? " · based on rev " + r.baseRevision : ""} · \${ago(r.createdAt)}</span>
      <details><summary class="faint" style="cursor:pointer;font-size:11px">text</summary><pre style="margin-top:4px">\${esc(r.content)}</pre></details>
    </div>\`;
  }).join("") + "</div>";

const teamOptsFor = (u) => '<option value="">no team</option>' +
  ((u && u.teams) ?? []).map((t) => \`<option value="\${t.id}">\${esc(t.name)}</option>\`).join("");

async function projectCard(p, instances) {
  const [ctx, membersRes] = await Promise.all([
    get("/v1/projects/" + p.id + "/context").catch(() => ({ context: [], pending: [], arbiter: null })),
    get("/v1/projects/" + p.id + "/members").catch(() => ({ members: [] })),
  ]);
  const members = membersRes.members ?? [];
  const myRole = ME.isAdmin ? "owner" : ((members.find((m) => m.userId === ME.userId) || {}).role ?? "viewer");
  const canWrite = myRole === "owner" || myRole === "contributor";
  const pending = ctx.pending ?? [];
  const pendingByKey = {};
  for (const pd of pending) (pendingByKey[pd.key] = pendingByKey[pd.key] ?? []).push(pd);

  // open history drawers fetch on render — the drawer always shows the truth
  const histFor = {};
  for (const c of ctx.context ?? []) {
    if (HIST_OPEN.has(p.id + "\\u0000" + c.key)) {
      histFor[c.key] = (await get("/v1/projects/" + p.id + "/context?key=" + encodeURIComponent(c.key) + "&history=true").catch(() => ({ history: [] }))).history ?? [];
    }
  }

  const itemHtml = (c) => {
    const prov = c.provenance ?? {};
    const pk = pendingByKey[c.key] ?? [];
    const editing = CTXED && CTXED.projectId === p.id && CTXED.key === c.key;
    const histOpen = HIST_OPEN.has(p.id + "\\u0000" + c.key);
    return \`<div class="node-row" style="align-items:flex-start">
      <div class="grow">
        <div><span class="mono">\${esc(c.key)}</span> <span class="badge">rev \${c.revision}</span>
          \${prov.sourceArtifactId ? '<span class="badge info" title="promoted from a signed-off workflow artifact">from artifact</span>' : ""}
          \${pk.length ? '<span class="badge warn" title="a conflicting revision is with the arbiter">' + pk.length + " awaiting arbiter</span>" : ""}</div>
        <div class="dim" style="font-size:12px">by \${esc(prov.userName ?? "unknown")}\${prov.teamName ? " · " + esc(prov.teamName) : ""} · \${ago(prov.at)}</div>
        <details style="margin-top:4px"><summary class="faint" style="cursor:pointer;font-size:11.5px">current text</summary><pre style="margin-top:6px">\${esc(c.content)}</pre></details>
        \${histOpen && histFor[c.key] ? ctxHistHtml(histFor[c.key]) : ""}
        \${editing ? ctxEditorHtml(ctx) : ""}
      </div>
      <button class="ghost small" data-hist="\${esc(c.key)}" data-pid="\${p.id}">\${histOpen ? "hide history" : "history"}</button>
      \${canWrite && !editing ? \`<button class="ghost small" data-ctxedit="\${esc(c.key)}" data-pid="\${p.id}" title="edit — fetches the current revision first">✎</button>\` : ""}
    </div>\`;
  };
  const addingNew = CTXED && CTXED.projectId === p.id && CTXED.key === null;
  const arbLine = ctx.arbiter
    ? \`<span class="dim" style="font-size:12.5px">\${esc(ctx.arbiter.name ?? "the arbiter")} decides in \${ctx.arbiter.userId === ME.userId ? '<a href="#/inbox">your Inbox</a>' : "their Inbox"}</span>\`
    : "";
  const pendingBanner = pending.length
    ? \`<div class="row" style="margin-top:10px"><span class="badge warn">\${pending.length} revision\${pending.length > 1 ? "s" : ""} awaiting arbiter</span>\${arbLine}</div>\`
    : "";

  const ownerCount = members.filter((m) => m.role === "owner").length;
  const memberRows = members.map((m) => {
    const soleOwner = m.role === "owner" && ownerCount <= 1;
    const badge = \`<span class="badge \${m.role === "owner" ? "accent" : m.role === "contributor" ? "info" : ""}">\${m.role}</span>\`;
    const roleSel = \`<select class="small" data-mrole="\${m.userId}" data-pid="\${p.id}"\${soleOwner ? ' disabled title="promote another owner before changing the sole owner"' : ""}>\${["owner", "contributor", "viewer"].map((r) => \`<option value="\${r}"\${r === m.role ? " selected" : ""}>\${r}</option>\`).join("")}</select>\`;
    const rmBtn = \`<button class="ghost small" data-mremove="\${m.userId}" data-pid="\${p.id}"\${soleOwner ? ' disabled title="promote another owner before removing the sole owner"' : ""}>Remove</button>\`;
    return \`<div class="node-row">
    <div class="grow">
      <div>\${esc(m.userName ?? "unknown")}\${m.userId === ME.userId ? ' <span class="faint">(you)</span>' : ""}</div>
      <div class="dim" style="font-size:12px">\${m.teamName ? esc(m.teamName) : "no team"} · joined \${ago(m.createdAt)}</div>
    </div>
    \${myRole === "owner" ? roleSel + " " + rmBtn : badge}
  </div>\`;
  }).join("");
  const memberErr = myRole === "owner"
    ? \`<div class="err-line" data-merr="\${p.id}" style="margin-top:4px"></div>\`
    : "";
  const nonMembers = DIRECTORY.filter((u) => !members.some((m) => m.userId === u.id));
  const addMemberForm = myRole !== "owner" ? "" : nonMembers.length === 0
    ? '<div class="faint" style="font-size:12px;margin-top:8px">everyone in the directory is already a member</div>'
    : \`<div class="row" style="margin-top:10px">
        <div><label class="f">User</label><select data-pmuser="\${p.id}">\${nonMembers.map((u) => \`<option value="\${u.id}">\${esc(u.name)}</option>\`).join("")}</select></div>
        <div><label class="f">Role</label><select data-pmrole="\${p.id}"><option value="viewer">viewer</option><option value="contributor" selected>contributor</option><option value="owner">owner</option></select></div>
        <div><label class="f">Team (provenance)</label><select data-pmteam="\${p.id}">\${teamOptsFor(nonMembers[0])}</select></div>
        <div style="align-self:flex-end"><button class="small" data-pmadd="\${p.id}">Add member</button></div>
      </div>
      <div class="err-line" data-pmerr="\${p.id}" style="margin-top:4px"></div>\`;

  // signed-off (completed) workflow instances of THIS project the caller can
  // see — their artifacts are promotable into the shared store (§9.4)
  const done = instances.filter((i) => i.projectId === p.id && i.status === "completed").slice(0, 5);
  const promotable = [];
  for (const i of done) {
    try {
      const v = await get("/v1/workflows/instances/" + i.id);
      const latest = {};
      for (const a of v.artifacts ?? []) if (!latest[a.output] || a.version > latest[a.output].version) latest[a.output] = a;
      for (const a of Object.values(latest)) promotable.push({ ...a, desc: v.instance.change?.description ?? "" });
    } catch {}
  }
  const promoteRows = promotable.map((a) => \`<div class="node-row">
    <div class="grow">
      <div><span class="mono">\${esc(a.output)}</span> <span class="badge">v\${a.version}</span></div>
      <div class="dim" style="font-size:12px">signed-off artifact of “\${esc(a.desc)}”</div>
    </div>
    <button class="small" data-promote="\${a.id}" data-pid="\${p.id}">Promote to shared context</button>
  </div>\`).join("");

  const cap = p.budgetUsd, spent = p.spentUsd ?? 0;
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
  return \`<div class="card">
    <div class="row"><strong>\${esc(p.name)}</strong>
      \${(p.classifications ?? []).map((c) => '<span class="badge info">' + esc(c) + "</span>").join("")}
      <span class="badge">\${myRole}</span>
      <span class="grow"></span>
      <span class="num dim">\${fmtUsd(spent)}\${cap ? " / " + fmtUsd(cap) : ""}</span></div>
    \${cap ? '<div class="bar" style="margin-top:8px"><i class="' + (spent > cap ? "over" : "") + '" style="width:' + pct + '%"></i></div>' : ""}
    \${pendingBanner}
    <h2 style="margin-top:14px">Shared context</h2>
    \${(ctx.context ?? []).map(itemHtml).join("") || '<div class="faint" style="font-size:12.5px">no shared context yet</div>'}
    \${addingNew ? ctxEditorHtml(ctx) : canWrite ? \`<div style="margin-top:8px"><button class="ghost small" data-ctxnew="\${p.id}">+ add context</button></div>\` : ""}
    \${promotable.length ? '<h2 style="margin-top:14px">Promote a signed-off artifact</h2>' + promoteRows : ""}
    <h2 style="margin-top:14px">Members</h2>
    \${memberRows || '<div class="faint" style="font-size:12.5px">no members — this project is an open cost bucket</div>'}
    \${memberErr}
    \${addMemberForm}
  </div>\`;
}

async function projectsPage() {
  if (!PROJECTS.length) return '<h1>Projects</h1><p class="sub">Shared, governed workspaces.</p><div class="empty">You are not a member of any project yet.</div>';
  const [dirRes, instRes] = await Promise.all([
    get("/v1/users/directory").catch(() => ({ users: [] })),
    get("/v1/workflows/instances").catch(() => ({ instances: [] })),
  ]);
  DIRECTORY = dirRes.users ?? [];
  const instances = instRes.instances ?? [];
  const cards = await Promise.all(PROJECTS.map((p) => projectCard(p, instances)));
  return \`<h1>Projects</h1><p class="sub">Shared, governed workspaces — context every member sees, spend every member shares.</p>\${cards.join("")}\`;
}

function wireProjects() {
  document.querySelectorAll("[data-hist]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.pid + "\\u0000" + b.dataset.hist;
      if (HIST_OPEN.has(k)) HIST_OPEN.delete(k); else HIST_OPEN.add(k);
      render();
    }));
  document.querySelectorAll("[data-ctxedit]").forEach((b) =>
    b.addEventListener("click", () => openCtxEditor(b.dataset.pid, b.dataset.ctxedit)));
  document.querySelectorAll("[data-ctxnew]").forEach((b) =>
    b.addEventListener("click", () => openCtxEditor(b.dataset.ctxnew, null)));
  $("[data-ctxsave]")?.addEventListener("click", () => submitCtx("auto"));
  $("[data-ctxfresh]")?.addEventListener("click", () => submitCtx("fresh"));
  $("[data-ctxstale]")?.addEventListener("click", () => submitCtx("stale"));
  $("[data-ctxcancel]")?.addEventListener("click", () => { CTXED = null; render(); });
  // keep the draft across re-renders without re-rendering per keystroke
  $("#ctx-draft")?.addEventListener("input", (e) => { if (CTXED) CTXED.draft = e.target.value; });
  $("#ctx-newkey")?.addEventListener("input", (e) => { if (CTXED) CTXED.newKey = e.target.value; });
  document.querySelectorAll("[data-pmuser]").forEach((sel) =>
    sel.addEventListener("change", () => {
      const u = DIRECTORY.find((x) => x.id === sel.value);
      const teamSel = $('[data-pmteam="' + sel.dataset.pmuser + '"]');
      if (teamSel) teamSel.innerHTML = teamOptsFor(u);
    }));
  document.querySelectorAll("[data-pmadd]").forEach((b) =>
    b.addEventListener("click", async () => {
      const pid = b.dataset.pmadd;
      const userId = $('[data-pmuser="' + pid + '"]')?.value;
      const role = $('[data-pmrole="' + pid + '"]')?.value;
      const teamId = $('[data-pmteam="' + pid + '"]')?.value;
      const err = $('[data-pmerr="' + pid + '"]');
      if (!userId) return;
      try {
        await post("/v1/projects/" + pid + "/members", { userId, role, ...(teamId ? { teamId } : {}) });
        toast("Member added"); render();
      } catch (e) { if (err) err.textContent = e.message; }
    }));
  document.querySelectorAll("[data-mrole]").forEach((sel) =>
    sel.addEventListener("change", async () => {
      const pid = sel.dataset.pid, userId = sel.dataset.mrole;
      const err = $('[data-merr="' + pid + '"]');
      if (err) err.textContent = "";
      try {
        await patch("/v1/projects/" + pid + "/members/" + userId, { role: sel.value });
        toast("Role updated"); render();
      } catch (e) {
        // last-owner block and any other rejection surface on the error line;
        // re-render so the dropdown snaps back to the persisted role
        if (err) err.textContent = e.status === 409 && e.payload?.error === "last_owner"
          ? "Can't demote the sole owner — promote another owner first."
          : e.message;
        render();
      }
    }));
  document.querySelectorAll("[data-mremove]").forEach((b) =>
    b.addEventListener("click", async () => {
      const pid = b.dataset.pid, userId = b.dataset.mremove;
      if (!confirmClick(b, "Remove?")) return;
      const err = $('[data-merr="' + pid + '"]');
      if (err) err.textContent = "";
      try {
        await del("/v1/projects/" + pid + "/members/" + userId);
        toast("Member removed"); render();
      } catch (e) {
        if (err) err.textContent = e.status === 409 && e.payload?.error === "last_owner"
          ? "Can't remove the sole owner — promote another owner first."
          : e.message;
      }
    }));
  document.querySelectorAll("[data-promote]").forEach((b) =>
    b.addEventListener("click", () => promoteArtifact(b.dataset.pid, b.dataset.promote)));
}

// ------------------------------------------------------- context graph --
// Pillar 4 made visual: the whole project's shared-context store as a version
// graph from GET /v1/projects/:id/context/graph — one COLUMN per key, revisions
// stacked top→bottom, an edge from each revision's baseRevision to it (version
// lineage), conflicts (accepted=false) forking off into an amber side-lane.
// Dependency-free: inline SVG + vanilla DOM, deterministic column/row math (no
// physics). The graph card scrolls (overflow:auto) so a big graph never breaks
// the page layout.
let CG_DATA = null; // the loaded { project, nodes, keys } for the open project
let CG_SEL = null;  // the selected node id (drives the detail panel)

const cgClip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "\\u2026" : s; };
const cgShort = (name) => name ? cgClip(name, 18) : "unknown";

async function contextGraphPage() {
  if (!PROJECTS.length)
    return '<h1>Context Graph</h1><p class="sub">The shared-project context store, drawn as a version graph.</p><div class="empty">You are not a member of any project yet.</div>';
  const picker = PROJECTS.map((p) => \`<button class="small" data-cgproj="\${p.id}">\${esc(p.name)}</button>\`).join("");
  return \`
  <h1>Context Graph</h1>
  <p class="sub">The shared-project context store as a version graph — one column per key, revisions top-to-bottom, version lineage as edges, and conflict forks in amber. Pick a project you're a member of.</p>
  <div class="card"><div class="row">\${picker}</div></div>
  <div id="cg-out" style="margin-top:14px"></div>\`;
}

// One small legend swatch — a themed box + label. Amber/dashed for conflicts.
function cgLegendItem(fill, fillOp, stroke, dashed, label) {
  return \`<span style="display:inline-flex;align-items:center;gap:6px;color:var(--text-dim)">
    <span style="width:16px;height:12px;border-radius:3px;background:\${fill};opacity:\${fillOp};border:1.5px \${dashed ? "dashed" : "solid"} \${stroke}"></span>\${esc(label)}</span>\`;
}

// The detail side-panel for the selected node — key, revision, state,
// contributor (user + team), based-on revision, timestamp, content preview.
function cgDetailHtml(n) {
  if (!n) return '<div class="faint" style="font-size:12.5px">Select a node to see its revision detail. Nodes are keyboard-focusable — Tab to a node and press Enter.</div>';
  const state = n.accepted
    ? (n.isHead
        ? '<span class="badge accent">accepted · current head</span>'
        : '<span class="badge ok">accepted · prior revision</span>')
    : (n.pending
        ? '<span class="badge warn">conflict · awaiting arbiter \\u23F3</span>'
        : '<span class="badge bad">conflict · retained (never current)</span>');
  const c = n.contributor ?? {};
  return \`<div style="font-size:12.5px;line-height:1.7">
    <div><span class="mono">\${esc(n.key)}</span> <span class="badge">rev \${n.revision}</span></div>
    <div style="margin:6px 0">\${state}</div>
    <div class="dim">by \${esc(c.name ?? "unknown")}\${c.teamName ? " · " + esc(c.teamName) : " · no team"}</div>
    <div class="dim">based on \${n.baseRevision != null ? "rev " + n.baseRevision : "— (first write of this key)"}</div>
    <div class="dim">\${ago(n.at)}</div>
    <details style="margin-top:8px" open><summary class="faint" style="cursor:pointer;font-size:11.5px">content preview</summary><pre style="margin-top:6px;white-space:pre-wrap">\${esc(n.content)}</pre></details>
  </div>\`;
}

// Pure column/row layout → SVG. Columns = keys (order of first appearance),
// rows = revisions ascending within a key. Accepted revisions sit in the
// column's mainline lane; conflicts shift into an amber side-lane so a fork off
// a shared baseRevision is visually distinct. Edges run baseRevision→revision.
function cgViewHtml(data) {
  const NODE_W = 172, NODE_H = 56, ROW_H = 88, COL_W = 236, LANE_SHIFT = 30, HEADER_H = 30, PAD = 24;
  // group nodes into ordered columns by key (nodes arrive ordered key,revision)
  const cols = [];
  const colIndex = {};
  for (const nd of data.nodes) {
    if (colIndex[nd.key] === undefined) { colIndex[nd.key] = cols.length; cols.push({ key: nd.key, nodes: [] }); }
    cols[colIndex[nd.key]].nodes.push(nd);
  }
  let maxRows = 1;
  const geo = {};      // id -> geometry
  const revIndex = {}; // key -> { revision -> nodeId }
  cols.forEach((col, c) => {
    if (col.nodes.length > maxRows) maxRows = col.nodes.length;
    revIndex[col.key] = {};
    const baseX = PAD + c * COL_W;
    col.nodes.forEach((nd, r) => {
      const x = baseX + (nd.accepted ? 0 : LANE_SHIFT);
      const y = HEADER_H + PAD + r * ROW_H;
      geo[nd.id] = { x, y, cx: x + NODE_W / 2, topY: y, botY: y + NODE_H };
      revIndex[col.key][nd.revision] = nd.id;
    });
  });
  const width = PAD * 2 + cols.length * COL_W;
  const height = HEADER_H + PAD + maxRows * ROW_H + PAD;

  // edges: baseRevision node (same key) -> this node, as a soft vertical bezier
  const edges = data.nodes.map((nd) => {
    if (nd.baseRevision == null) return "";
    const baseId = revIndex[nd.key][nd.baseRevision];
    if (!baseId || !geo[baseId] || !geo[nd.id]) return "";
    const b = geo[baseId], g = geo[nd.id];
    const dy = Math.max(18, (g.topY - b.botY) / 2);
    const stroke = nd.accepted ? "var(--border-strong)" : "var(--warn)";
    const dash = nd.accepted ? "" : ' stroke-dasharray="4 3"';
    return \`<path d="M \${b.cx} \${b.botY} C \${b.cx} \${b.botY + dy} \${g.cx} \${g.topY - dy} \${g.cx} \${g.topY}" fill="none" stroke="\${stroke}" stroke-width="1.5"\${dash} opacity="0.85"/>\`;
  }).join("");

  // column headers (the key labels)
  const headers = cols.map((col, c) =>
    \`<text x="\${PAD + c * COL_W}" y="20" font-family="var(--mono)" font-size="12" font-weight="600" fill="var(--text-dim)">\${esc(cgClip(col.key, 24))}</text>\`
  ).join("");

  // nodes
  const nodesM = data.nodes.map((nd) => {
    const g = geo[nd.id];
    let fill, fillOp, stroke, dash, tcol, tdim;
    if (nd.accepted && nd.isHead) {
      fill = "var(--accent)"; fillOp = "1"; stroke = "var(--accent)"; dash = ""; tcol = "#1b120d"; tdim = "#1b120dcc";
    } else if (nd.accepted) {
      fill = "var(--bg-inset)"; fillOp = "1"; stroke = "var(--border-strong)"; dash = ""; tcol = "var(--text)"; tdim = "var(--text-dim)";
    } else {
      fill = "var(--warn)"; fillOp = "0.15"; stroke = "var(--warn)"; dash = ' stroke-dasharray="5 3"'; tcol = "var(--text)"; tdim = "var(--text-dim)";
    }
    const marker = nd.pending ? " \\u23F3" : "";
    const aria = esc(nd.key) + " revision " + nd.revision + (nd.accepted ? (nd.isHead ? " current head" : " accepted") : (nd.pending ? " conflict awaiting arbiter" : " conflict retained")) + " by " + esc(cgShort(nd.contributor && nd.contributor.name));
    return \`<g class="cg-node" data-node="\${esc(nd.id)}" tabindex="0" role="button" aria-label="\${aria}" style="cursor:pointer;outline:none">
      <rect data-nrect="\${esc(nd.id)}" x="\${g.x}" y="\${g.y}" width="\${NODE_W}" height="\${NODE_H}" rx="9" fill="\${fill}" fill-opacity="\${fillOp}" stroke="\${stroke}" stroke-width="1.5"\${dash}/>
      <text x="\${g.x + 12}" y="\${g.y + 23}" font-family="var(--mono)" font-size="12" font-weight="600" fill="\${tcol}">\${esc(cgClip(nd.key, 15))}@\${nd.revision}\${marker}</text>
      <text x="\${g.x + 12}" y="\${g.y + 41}" font-size="11" fill="\${tdim}">\${esc(cgShort(nd.contributor && nd.contributor.name))}</text>
    </g>\`;
  }).join("");

  const legend = \`<div class="row" style="gap:16px;font-size:11.5px;flex-wrap:wrap;margin-bottom:10px">
    \${cgLegendItem("var(--accent)", "1", "var(--accent)", false, "accepted head")}
    \${cgLegendItem("var(--bg-inset)", "1", "var(--border-strong)", false, "prior revision")}
    \${cgLegendItem("var(--warn)", "0.15", "var(--warn)", true, "conflict / retained")}
    \${cgLegendItem("var(--warn)", "0.15", "var(--warn)", true, "pending arbiter \\u23F3")}
  </div>\`;

  return \`
  <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
    <div style="flex:1 1 520px;min-width:0">
      <div class="row" style="margin-bottom:8px"><strong>\${esc(data.project.name)}</strong><span class="dim" style="font-size:12px">\${data.nodes.length} revision\${data.nodes.length === 1 ? "" : "s"} across \${cols.length} key\${cols.length === 1 ? "" : "s"}</span></div>
      \${legend}
      <div class="card" style="overflow:auto;max-height:72vh;padding:12px">
        <svg width="\${width}" height="\${height}" viewBox="0 0 \${width} \${height}" xmlns="http://www.w3.org/2000/svg" style="display:block">
          \${headers}\${edges}\${nodesM}
        </svg>
      </div>
    </div>
    <div class="card" style="flex:0 0 280px;max-width:100%;align-self:stretch">
      <h2 style="margin-top:0">Revision detail</h2>
      <div id="cg-detail">\${cgDetailHtml(null)}</div>
    </div>
  </div>\`;
}

function cgSelect(id) {
  CG_SEL = id;
  document.querySelectorAll("[data-nrect]").forEach((r) => r.setAttribute("stroke-width", r.dataset.nrect === id ? "3" : "1.5"));
  const n = (CG_DATA && CG_DATA.nodes || []).find((x) => x.id === id);
  const d = $("#cg-detail");
  if (d) d.innerHTML = cgDetailHtml(n);
}

async function cgRender(pid) {
  const out = $("#cg-out");
  if (!out) return;
  out.innerHTML = '<div class="empty">loading…</div>';
  document.querySelectorAll("[data-cgproj]").forEach((b) =>
    b.classList.toggle("primary", b.dataset.cgproj === pid));
  try {
    const data = await get("/v1/projects/" + pid + "/context/graph");
    const head = {};
    for (const k of data.keys || []) head[k.key] = k.currentRevision;
    for (const nd of data.nodes || []) nd.isHead = nd.accepted && nd.revision === head[nd.key];
    CG_DATA = data; CG_SEL = null;
    if (!(data.nodes || []).length) {
      out.innerHTML = '<div class="empty">No shared context yet for this project — contribute context to see the graph.</div>';
      return;
    }
    out.innerHTML = cgViewHtml(data);
    out.querySelectorAll("[data-node]").forEach((g) => {
      const id = g.dataset.node;
      g.addEventListener("click", () => cgSelect(id));
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cgSelect(id); }
      });
    });
  } catch (e) { out.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; }
}

function wireContextGraph() {
  document.querySelectorAll("[data-cgproj]").forEach((b) =>
    b.addEventListener("click", () => cgRender(b.dataset.cgproj)));
  // deep-link / preselect: #/context-graph/<projectId> auto-loads that project
  const { id } = route();
  if (id && PROJECTS.some((p) => p.id === id)) cgRender(id);
}

// ------------------------------------------------------------------ spend --
// Pillars 5 + 6 where the work happens: the SAME self-scoped ledgers the
// admin dashboard rolls up — measured actuals from usage_events, estimated
// savings from cost_events — plus a drill-down into any project the user is
// a member of (the /costs endpoint admits members, not only admins).
async function spendPage() {
  const [usage, costs, dir, conns] = await Promise.all([
    get("/v1/usage-events?limit=100"),
    get("/v1/cost-events?limit=200"),
    get("/v1/users/directory").catch(() => ({ users: [] })),
    // the caller's OWN granted connectors (non-admin-safe) — carries names for
    // the Spend-by-connector labels without touching the admin-only catalog
    ME.userId ? get("/v1/users/" + ME.userId + "/connectors").catch(() => ({ connectors: [] })) : Promise.resolve({ connectors: [] }),
  ]);
  DIRECTORY = dir.users ?? [];
  const CONNECTOR_NAMES = Object.fromEntries((conns.connectors ?? []).map((c) => [c.connectorId, c.name]));
  const t = usage.totals ?? {};
  const events = usage.events ?? [];
  const estSaved = (costs.totals ?? []).reduce((s, x) => s + (Number(x.estimatedCostSavedUsd) || 0), 0);
  // one ledger, two object types: agent rows drive Spend by agent, connector
  // rows drive Spend by connector — split so neither shows as the other.
  const byAgent = {};
  const byConnector = {};
  for (const e of events) {
    if (e.objectType === "connector") {
      const key = (e.connectorId ?? "?") + ":" + (e.operation ?? "");
      const cur = byConnector[key] ?? (byConnector[key] = {
        label: (CONNECTOR_NAMES[e.connectorId] ?? "connector") + " · " + (e.operation ?? ""),
        costUsd: 0, events: 0,
      });
      cur.costUsd += e.costUsd ?? 0; cur.events++;
      continue;
    }
    const cur = byAgent[e.agentId] ?? (byAgent[e.agentId] = { label: AGENT_NAMES[e.agentId] ?? e.model, costUsd: 0, events: 0 });
    cur.costUsd += e.costUsd ?? 0; cur.events++;
  }
  const agentItems = Object.values(byAgent).sort((a, b) => b.costUsd - a.costUsd);
  const connectorItems = Object.values(byConnector).sort((a, b) => b.costUsd - a.costUsd);
  const projName = (pid) => pid ? ((PROJECTS.find((p) => p.id === pid) || {}).name ?? pid.slice(0, 8) + "…") : "—";
  const rows = events.filter((e) => e.objectType !== "connector").slice(0, 30).map((e) => \`<tr>
    <td class="dim">\${ago(e.at)}</td>
    <td>\${esc(AGENT_NAMES[e.agentId] ?? "agent")}</td>
    <td class="mono" style="font-size:11.5px">\${esc(e.model)}\${e.refusal ? ' <span class="badge bad">refused</span>' : ""}</td>
    <td class="num">\${e.inputTokens}→\${e.outputTokens}</td>
    <td class="num">\${fmtUsd(e.costUsd)}</td>
    <td class="num">\${e.measuredCostSavedUsd ? fmtUsd(e.measuredCostSavedUsd) : "—"}</td>
    <td class="dim">\${esc(projName(e.projectId))}</td></tr>\`).join("");
  const drill = PROJECTS.length
    ? \`<h2>Per-project drill-down — projects you are a member of</h2><div class="card">
        <div class="row">\${PROJECTS.map((p) => \`<button class="small" data-spendproj="\${p.id}">\${esc(p.name)}</button>\`).join("")}</div>
        <div id="spend-proj"></div>
      </div>\`
    : "";
  return \`
  <h1>Spend & savings</h1>
  <p class="sub">Your own measured spend, and what the optimization layer saved on your behalf — the same ledgers the admin dashboard rolls up, scoped to you.</p>
  <div class="grid2">
    <div class="card stat"><div class="v">\${fmtUsd(t.costUsd)}</div><div class="l">measured spend · \${t.events ?? 0} calls</div></div>
    <div class="card stat"><div class="v">\${t.inputTokens ?? 0} → \${t.outputTokens ?? 0}</div><div class="l">tokens in → out</div></div>
    <div class="card stat"><div class="v">\${fmtUsd(t.measuredCostSavedUsd)}</div><div class="l">measured savings — routing actuals</div></div>
    <div class="card stat"><div class="v">\${fmtUsd(estSaved)}</div><div class="l">estimated savings — all techniques</div></div>
  </div>
  <h2>Savings by technique — estimated, full history</h2><div class="card">\${barChart(costs.totals ?? [], "estimatedCostSavedUsd", (i) => i.technique)}</div>
  <h2>Spend by agent — last \${events.length} invocation\${events.length === 1 ? "" : "s"}</h2><div class="card">\${barChart(agentItems, "costUsd", (i) => i.label)}</div>
  <h2>Spend by connector</h2><div class="card">\${connectorItems.length ? barChart(connectorItems, "costUsd", (i) => i.label) : '<div class="empty">No metered connector calls yet — invoke a connector with a provider adapter.</div>'}</div>
  <h2>Recent invocations</h2>
  <div class="card" style="padding:0 18px">
    <table><tr><th>When</th><th>Agent</th><th>Model served</th><th>Tokens</th><th>Cost</th><th>Saved</th><th>Project</th></tr>
    \${rows || '<tr><td colspan="7"><div class="empty">No metered invocations yet — say something in the Playground.</div></td></tr>'}</table>
  </div>
  \${drill}\`;
}

function wireSpend() {
  document.querySelectorAll("[data-spendproj]").forEach((b) =>
    b.addEventListener("click", async () => {
      const out = $("#spend-proj");
      out.innerHTML = '<div class="empty">loading…</div>';
      try {
        const pid = b.dataset.spendproj;
        const c = await get("/v1/projects/" + pid + "/costs");
        const m = c.measured ?? {};
        const bg = c.budget ?? {};
        const userName = (uid) => (DIRECTORY.find((u) => u.id === uid) || {}).name ?? uid;
        const periodNote = bg.period === "monthly"
          ? '<span class="dim" style="font-size:12px">budget window: this calendar month (' + esc(bg.periodKey ?? "") + ")</span>"
          : '<span class="dim" style="font-size:12px">budget window: lifetime</span>';
        out.innerHTML =
          (c.initiative ? '<p class="sub" style="margin:12px 0 0">Initiative: ' + esc(c.initiative.name) + "</p>" : "")
          + '<div class="grid2" style="margin-top:12px">'
          + '<div class="card stat"><div class="v">' + fmtUsd(m.costUsd) + '</div><div class="l">project measured spend · ' + (m.events ?? 0) + " calls</div></div>"
          + '<div class="card stat"><div class="v">' + fmtUsd(c.forecast?.projectedEomUsd) + '</div><div class="l">projected month-end · ' + esc(c.forecast?.basis ?? "") + "</div></div>"
          + "</div>"
          + '<div class="row" style="margin-top:14px"><h2 style="margin:0">Budget vs actual</h2><span class="grow"></span><button class="small" data-csv="' + esc(pid) + '">Download CSV</button></div>'
          + '<div class="card">' + budgetGauge(bg.spentUsd, bg.budgetUsd, bg.overageApproved, bg) + '<div class="row" style="margin-top:8px">' + periodNote + "</div></div>"
          + '<h2>Showback by member</h2><div class="card">' + barChart(c.byUser, "costUsd", (i) => userName(i.userId)) + "</div>"
          + '<h2>Showback by team</h2><div class="card">' + barChart(c.byTeam ?? [], "costUsd", (i) => i.name ?? "(no team)") + "</div>"
          + '<h2>By agent / model</h2><div class="card">' + barChart(c.byAgent, "costUsd", (i) => AGENT_NAMES[i.agentId] ?? i.model) + "</div>"
          + '<h2>Spend by connector</h2><div class="card">' + ((c.byConnector ?? []).length ? barChart(c.byConnector, "costUsd", (i) => (i.name ?? "connector") + " · " + (i.operation ?? "")) : '<div class="empty">No metered connector calls for this project.</div>') + "</div>"
          // ADR-0019: MCP tool spend rides the same ledger, so it is already
          // inside the measured total — named here so it is not an unexplained gap
          + '<h2>Spend by MCP tool</h2><div class="card">' + ((c.byMcpTool ?? []).length ? barChart(c.byMcpTool, "costUsd", (i) => i.toolName ?? "tool") : '<div class="empty">No project-attributed MCP tool calls for this project.</div>') + "</div>"
          + '<h2>Estimated savings by technique</h2><div class="card">' + barChart(c.estimatedSavings, "estimatedCostSavedUsd", (i) => i.technique) + "</div>";
        const csvBtn = out.querySelector("[data-csv]");
        if (csvBtn) csvBtn.addEventListener("click", () =>
          downloadCsv("/v1/projects/" + pid + "/costs.csv", (c.project?.name ?? "project") + "-costs.csv"));
      } catch (e) { out.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; }
    }));
}

// --------------------------------------------------------------- settings --
// BYO keys, self-service. The write is the same POST an admin would make on
// your behalf; the read never returns a key, only which providers you have
// one for — so nothing on this page can leak a secret back out.
const PROVIDERS = ["anthropic", "openai", "google", "xai"];

async function settingsPage() {
  const { credentials } = await get("/v1/users/" + ME.userId + "/model-credentials");
  const rows = credentials.map((c) => \`<div class="node-row">
    <div class="grow">
      <div>\${esc(c.provider)} <span class="badge info">your key</span></div>
      <div class="dim" style="font-size:12px">\${esc(c.baseUrl ?? "provider default endpoint")} · added \${ago(c.createdAt)}</div>
    </div>
    <button class="small danger" data-rmcred="\${esc(c.provider)}">Remove</button>
  </div>\`).join("");
  const providerOpts = PROVIDERS.map((p) => \`<option value="\${p}">\${p}</option>\`).join("");
  return \`
  <h1>Settings</h1>
  <p class="sub">Your identity, and the provider keys your own requests run on.</p>
  <h2>My model keys</h2>
  <div class="card">\${rows || '<div class="empty">No keys of your own yet — your requests use the platform credential when one is configured.</div>'}</div>
  <div class="card" style="margin-top:12px">
    <div class="row">
      <div><label class="f">Provider</label><select id="sk-provider">\${providerOpts}</select></div>
      <div class="grow"><label class="f">API key</label><input id="sk-key" type="password" placeholder="sk-…" style="width:100%"></div>
      <div><label class="f">Base URL</label><input id="sk-base" placeholder="optional override"></div>
      <div style="align-self:flex-end"><button class="primary" id="sk-add">Save key</button></div>
    </div>
    <div class="err-line" id="sk-err" style="margin-top:6px"></div>
    <p class="faint" style="font-size:11.5px;margin:8px 0 0">Encrypted at rest and never shown again — not to you, not to an admin. Saving the same provider twice replaces the stored key. Your own key takes precedence over the platform's for every request you make.</p>
  </div>
  <h2>Identity</h2>
  <div class="card"><div class="kv">
    <span class="k">name</span><span>\${esc(ME.user?.displayName ?? "")}</span>
    <span class="k">email</span><span>\${esc(ME.user?.email ?? "")}</span>
    <span class="k">user id</span><span>\${idChip(ME.userId)}</span>
    <span class="k">role</span><span>\${ME.isAdmin ? '<span class="badge accent">admin</span>' : "member"}</span>
  </div></div>\`;
}

function wireSettings() {
  $("#sk-add")?.addEventListener("click", async () => {
    const key = $("#sk-key").value.trim();
    if (!key) { $("#sk-err").textContent = "apiKey: a key is required"; return; }
    const baseUrl = $("#sk-base").value.trim();
    try {
      await post("/v1/users/" + ME.userId + "/model-credentials", {
        provider: $("#sk-provider").value, apiKey: key, ...(baseUrl ? { baseUrl } : {}),
      });
      $("#sk-key").value = "";
      MY_PROVIDERS = [...new Set([...MY_PROVIDERS, $("#sk-provider").value])];
      toast("Key saved — stored encrypted, never shown again");
      render();
    } catch (e) { $("#sk-err").textContent = e.message; }
  });
  document.querySelectorAll("[data-rmcred]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await del("/v1/users/" + ME.userId + "/model-credentials/" + encodeURIComponent(b.dataset.rmcred));
        MY_PROVIDERS = MY_PROVIDERS.filter((p) => p !== b.dataset.rmcred);
        toast("Key removed"); render();
      } catch (e) { toast("✗ " + e.message); }
    }));
}

// ----------------------------------------------------------------- render --
async function render() {
  const root = $("#root");
  if (!KEY) {
    root.innerHTML = \`
    <div class="gate"><div class="card">
      <div class="brand"><span class="word">regul<em>ai</em>t</span></div>
      <p>Sign in with your API key. It stays in this browser tab and is sent only to this server.</p>
      <input id="gate-key" type="password" placeholder="rgl_…" style="width:100%" autofocus>
      <div class="err-line" id="gate-err" style="margin:6px 0"></div>
      <button class="primary" id="gate-go" style="width:100%;margin-top:6px">Continue</button>
    </div></div>\`;
    const go = async () => {
      KEY = $("#gate-key").value.trim();
      try { await bootstrap(); sessionStorage.setItem("regulait.key", KEY); render(); }
      catch (e) { KEY = ""; $("#gate-err").textContent = "That key didn’t work: " + e.message; }
    };
    $("#gate-go").addEventListener("click", go);
    $("#gate-key").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    return;
  }
  if (!ME) { try { await bootstrap(); } catch { signOut(); return; } }

  const { page, id } = route();
  let content = "";
  try {
    if (page === "playground") content = await playgroundPage();
    else if (page === "runs" && id) content = await runDetailPage(id);
    else if (page === "runs") content = await runsPage();
    else if (page === "workflows" && id) content = await workflowDetailPage(id);
    else if (page === "workflows") content = await workflowsPage();
    else if (page === "inbox") content = await inboxPage();
    else if (page === "projects") content = await projectsPage();
    else if (page === "context-graph") content = await contextGraphPage();
    else if (page === "spend") content = await spendPage();
    else if (page === "settings") content = await settingsPage();
    else content = await playgroundPage();
  } catch (e) {
    // a 403 is an ACCESS answer, not an outage — say so in access words
    content = e.status === 403
      ? '<div class="empty">You don’t have access to this view — ' + esc(e.message) + "</div>"
      : '<div class="empty">Couldn’t load this view — ' + esc(e.message) + "</div>";
  }
  root.innerHTML = shell(content, page);

  document.querySelectorAll("[data-nav]").forEach((b) =>
    b.addEventListener("click", () => { location.hash = "#/" + b.dataset.nav; }));
  document.querySelectorAll("[data-go]").forEach((el) =>
    el.addEventListener("click", () => { location.hash = "#/" + el.dataset.go; }));
  $("#signout")?.addEventListener("click", signOut);
  // mobile nav: the hamburger opens the off-canvas .side and flips aria-expanded
  const navtoggle = $("#navtoggle");
  if (navtoggle) navtoggle.addEventListener("click", () => {
    const side = $("#side");
    if (!side) return;
    const open = side.classList.toggle("open");
    navtoggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  if (page === "playground") {
    // a thread was just opened — reflect its own defaults in the selects once
    if (PG_PREFILL) {
      const ag = $("#pg-agent");
      if (ag && PG_PREFILL.agentId && AGENTS.some((a) => a.agentId === PG_PREFILL.agentId)) {
        ag.value = PG_PREFILL.agentId;
        const pa = AGENTS.find((a) => a.agentId === PG_PREFILL.agentId);
        if ($("#pg-key")) $("#pg-key").innerHTML = keyHint(pa);
        if ($("#pg-banner")) $("#pg-banner").innerHTML = providerBanner(pa);
      }
      const pr = $("#pg-project");
      if (pr) pr.value = PG_PREFILL.projectId && PROJECTS.some((p) => p.id === PG_PREFILL.projectId) ? PG_PREFILL.projectId : "";
      PG_PREFILL = null;
    }
    wireRail();
    drawChat();
    pgStreamUi(Boolean(PG_ABORT)); // a stream may still be open across renders
    $("#pg-send")?.addEventListener("click", sendPrompt);
    $("#pg-stop")?.addEventListener("click", () => { PG_ABORT?.abort(); });
    $("#pg-agent")?.addEventListener("change", (e) => {
      const a = AGENTS.find((x) => x.agentId === e.target.value);
      if ($("#pg-key")) $("#pg-key").innerHTML = keyHint(a);
      if ($("#pg-banner")) $("#pg-banner").innerHTML = providerBanner(a);
    });
    $("#pg-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
    });
    // ---- attachments: click-to-pick, drag-and-drop, paste-image ----
    renderAttachTray();
    const fileEl = $("#pg-file");
    $("#pg-attach")?.addEventListener("click", () => fileEl?.click());
    fileEl?.addEventListener("change", (e) => {
      if (e.target.files?.length) pgAddFiles(e.target.files);
      e.target.value = ""; // let the same file be re-picked after removal
    });
    const composer = $("#pg-composer");
    if (composer) {
      // dragover/leave toggle the drop affordance; drop reads the files
      ["dragenter", "dragover"].forEach((ev) => composer.addEventListener(ev, (e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault(); composer.classList.add("dragover");
      }));
      ["dragleave", "dragend"].forEach((ev) => composer.addEventListener(ev, (e) => {
        if (e.target === composer) composer.classList.remove("dragover");
      }));
      composer.addEventListener("drop", (e) => {
        composer.classList.remove("dragover");
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault(); pgAddFiles(e.dataTransfer.files);
      });
    }
    // paste an image straight from the clipboard (screenshot workflow)
    $("#pg-input")?.addEventListener("paste", (e) => {
      const files = Array.from(e.clipboardData?.items || [])
        .filter((it) => it.kind === "file")
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (files.length) { e.preventDefault(); pgAddFiles(files); }
    });
  }
  if (page === "spend") wireSpend();
  if (page === "settings") wireSettings();
  if (page === "runs" && !id) wireRuns();
  if (page === "runs" && id) wireRunDetail(id);
  if (page === "workflows" && !id) wireWorkflows();
  if (page === "workflows" && id) wireWorkflowDetail(id);
  if (page === "inbox") wireInbox();
  if (page === "projects") wireProjects();
  if (page === "context-graph") wireContextGraph();
  // move keyboard focus to the panel heading after a (re)render so a nav switch
  // doesn't dump keyboard/AT users back at <body> (mirrors /admin). Each page's
  // first <h1> is made programmatically focusable; CSS suppresses its ring.
  const h1 = $(".main h1");
  if (h1) { h1.setAttribute("tabindex", "-1"); h1.focus({ preventScroll: false }); }
}
render();
</script>
</body>
</html>
`;
