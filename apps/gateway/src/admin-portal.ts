/**
 * ADR-0012: the admin portal — one dependency-free HTML+JS page, served as a
 * static shell at GET /admin. Strictly a client of the public REST API.
 * ADR-0025: the admin signs in with email + password (plus a TOTP step when
 * enabled) or SSO; the credential is a HttpOnly session cookie the page never
 * reads, every state-changing call carries the x-regulait-csrf header, and a
 * details-toggled API-key fallback exchanges a key for the same cookie.
 * Panels use §6's names verbatim, plus the §10.4-mandated cost surface with
 * hand-rolled SVG charts (strict self-containment — no external assets).
 */

import { UI_CSS, UI_DISPLAY_JS, UI_ERRORS_JS, UI_LOGIN_JS, UI_TABLE_JS } from "./ui-theme.js";

export const ADMIN_PORTAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RegulAIt Admin</title>
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
${UI_LOGIN_JS}
const $ = (s, el) => (el ?? document).querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtUsd = (v) => v == null ? "—" : "$" + Number(v).toFixed(4).replace(/0+$/,"").replace(/\\.$/,"");
// ADR-0025: AUTHED holds the last /auth/me snapshot (session-cookie auth);
// no credential ever lives in this page.
let AUTHED = null;

// Transient feedback that survives a render(): the region lives OUTSIDE #root
// (see the body markup) so re-rendering the shell never wipes a toast mid-flight.
// kind "ok" | "err" tints the left border; auto-hides after ~3s.
function toast(msg, kind) {
  const region = $("#toast-region");
  if (!region) return;
  const t = document.createElement("div");
  t.className = "toast " + (kind === "err" ? "err" : "ok");
  t.textContent = msg;
  region.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

async function api(method, path, body) {
  // cookie-session auth (ADR-0025): the browser attaches the HttpOnly cookie
  // itself; the custom header is the CSRF wall on every state-changing call.
  const res = await fetch(path, {
    method,
    headers: { "x-regulait-csrf": "1", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) { AUTHED = null; render(); throw new Error("unauthenticated"); }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  // A write form is useless if it only ever says "400 validation" — carry the
  // field-level reason (zod issues, detail, Fastify's message) to the caller.
  if (!res.ok) { const e = new Error(errMessage(res.status, json)); e.status = res.status; e.payload = json; throw e; }
  return json;
}
const get = (p) => api("GET", p);
const post = (p, b) => api("POST", p, b);
const patch = (p, b) => api("PATCH", p, b);
const del = (p) => api("DELETE", p);

// An option is either a bare string (value === label) or {v,l} — the second
// form is what lets every id field become a name the operator recognizes
// instead of a UUID they have to copy in from somewhere else.
let fieldSeq = 0;
function field(f) {
  // a unique id per field wires <label for> to its control, so the label is
  // programmatically associated and clickable (name stays for FormData/query)
  const fid = "fld-" + f.name + "-" + (++fieldSeq);
  const lbl = "<label class='f' for='" + fid + "'>" + esc(f.label ?? f.name) + "</label>";
  if (f.options) {
    // multi:true renders a multiple select; leaving it empty just omits the
    // field, so it never needs the "— none —" placeholder row
    const opts = (f.req === false && !f.multi ? [{ v: "", l: f.ph ?? "— none —" }] : [])
      .concat(f.options.map((o) => (typeof o === "object" ? o : { v: o, l: o })));
    if (opts.length === 0) opts.push({ v: "", l: "— none available —" });
    return "<div>" + lbl + "<select id='" + fid + "' name='" + f.name + "'"
      + (f.multi ? " multiple size='" + Math.min(4, Math.max(2, opts.length)) + "'" : "")
      + (f.req === false ? " data-optional='true'" : " required")
      + ">" + opts.map((o) => "<option value='" + esc(o.v) + "'>" + esc(o.l) + "</option>").join("")
      + "</select></div>";
  }
  // type:"textarea" renders a real <textarea> (multi-line prose like an
  // agent's system prompt); FormData picks it up by name exactly like an input
  if (f.type === "textarea") {
    return "<div" + (f.grow ? " class='grow'" : "") + ">" + lbl
      + "<textarea id='" + fid + "' name='" + f.name + "' rows='" + (f.rows ?? 4) + "'"
      + " placeholder='" + esc(f.ph ?? f.name) + "'" + (f.req === false ? "" : " required")
      + " style='width:100%;resize:vertical'></textarea></div>";
  }
  return "<div" + (f.grow ? " class='grow'" : "") + ">" + lbl
    + "<input id='" + fid + "' name='" + f.name + "' type='" + esc(f.type ?? "text") + "'"
    + (f.type === "number" ? " step='any'" : "")
    + " placeholder='" + esc(f.ph ?? f.name) + "'" + (f.req === false ? "" : " required") + "></div>";
}
function form(id, fields, label) {
  return "<form class='row' id='" + id + "' style='margin:10px 0;align-items:flex-end'>"
    + fields.map(field).join("")
    + "<button class='small primary'>" + esc(label) + "</button> <span class='err-line'></span></form>";
}
// Selects that name things, built from what the panel already fetched.
const userOpts = (rows) => rows.map((u) => ({ v: u.id, l: (u.displayName || u.email) + " · " + u.email }));
const agentOpts = (rows) => rows.map((a) => ({ v: a.id, l: a.name + " · " + a.provider + " · tier " + a.tier }));
const serverOpts = (rows) => rows.map((s) => ({ v: s.id, l: s.name }));
const connectorOpts = (rows) => rows.map((c) => ({ v: c.id, l: c.name + " · " + c.kind }));
const roleOpts = (rows) => rows.map((r) => ({ v: r.id, l: r.name }));

// A tool name only means anything next to the server it lives on, so fetch
// the whole inventory once per panel and repopulate the toolName select
// whenever the serverId select beside it changes.
async function toolIndex(servers) {
  const lists = await Promise.all(servers.map((s) =>
    get("/v1/servers/" + s.id + "/tools").catch(() => ({ tools: [] }))));
  return Object.fromEntries(servers.map((s, i) => [s.id, (lists[i].tools ?? []).map((t) => t.name)]));
}
function linkTools(id, index) {
  const f = $("#" + id); if (!f) return;
  const srv = f.querySelector("[name=serverId]"), tool = f.querySelector("[name=toolName]");
  if (!srv || !tool) return;
  const optional = tool.dataset.optional === "true";
  const fill = () => {
    const names = index[srv.value] ?? [];
    tool.innerHTML = (optional ? "<option value=''>— any tool —</option>" : "")
      + names.map((n) => "<option value='" + esc(n) + "'>" + esc(n) + "</option>").join("")
      + (names.length || optional ? "" : "<option value=''>— none registered —</option>");
  };
  srv.addEventListener("change", fill);
  fill();
}
// PILLAR 1 rule scoping: the scope/serverScope selects drive which target
// select is live. Only the target matching the chosen scope is shown+enabled
// (fleet shows none); the hidden ones are DISABLED so the browser never
// submits them — a role rule posts only roleId, a fleet rule posts none.
// serverScope 'all' hides+disables serverId and toolName, so the rule binds to
// every server. Disabled controls are excluded from FormData, so this is the
// single point that keeps the posted body matching the chosen discriminant.
function linkScope(id) {
  const f = $("#" + id); if (!f) return;
  const scope = f.querySelector("[name=scope]");
  const sscope = f.querySelector("[name=serverScope]");
  if (!scope || !sscope) return;
  const targets = {
    user: f.querySelector("[name=userId]"),
    role: f.querySelector("[name=roleId]"),
    team: f.querySelector("[name=teamId]"),
  };
  const srv = f.querySelector("[name=serverId]");
  const tool = f.querySelector("[name=toolName]");
  const setShown = (elm, shown) => {
    if (!elm) return;
    elm.disabled = !shown;
    const wrap = elm.closest("div");
    if (wrap) wrap.style.display = shown ? "" : "none";
  };
  const applyScope = () => {
    for (const k of ["user", "role", "team"]) setShown(targets[k], scope.value === k);
  };
  const applyServerScope = () => {
    const all = sscope.value === "all";
    setShown(srv, !all);
    setShown(tool, !all);
  };
  scope.addEventListener("change", applyScope);
  sscope.addEventListener("change", applyServerScope);
  applyScope();
  applyServerScope();
}
// The one-time reveal: an API key's plaintext exists for exactly one HTTP
// response and is sha256 at rest, so this panel is the only chance to copy
// it. Never re-readable, by design — there is no endpoint that could.
function revealSecret(where, title, secret, note) {
  const el = $(where); if (!el) return;
  el.innerHTML = "<div class='card reveal'><div class='row'><strong>" + esc(title) + "</strong>"
    + "<span class='badge warn'>shown once</span></div>"
    + "<div class='secret' style='margin-top:10px'><code>" + esc(secret) + "</code>"
    + "<button class='small' id='sec-copy'>Copy</button></div>"
    + "<p class='dim' style='font-size:12px;margin:8px 0 0'>This will not be shown again — the server keeps only a hash of it. "
    + esc(note ?? "") + "</p></div>";
  $("#sec-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(secret); $("#sec-copy").textContent = "Copied"; }
    catch { $("#sec-copy").textContent = "Select it manually"; }
  });
}
// Every form() must have a wire() — without one the browser GET-submits it
// natively and the SPA silently reboots. Read-only "view" forms pass
// keep=true so their result survives instead of being re-rendered away.
function wire(id, fn, keep) {
  $("#" + id)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = e.target.querySelector(".err-line"); err.textContent = "";
    // duplicate names (a multiple select) accumulate into an array; empty
    // values are dropped, exactly as the fromEntries version dropped them
    const data = {};
    for (const [k, v] of new FormData(e.target).entries()) {
      if (v === "") continue;
      data[k] = k in data ? [].concat(data[k], v) : v;
    }
    // disable the submit button for the duration of the request so a slow POST
    // can't be double-submitted; re-enable in finally (harmless if the form was
    // re-rendered away by then — it's a detached node)
    const btn = e.target.querySelector("button");
    if (btn) btn.disabled = true;
    try {
      await fn(data);
      // "view" forms (keep=true) are reads — a "Saved" toast would be a lie, so
      // only write forms announce success; errors always toast.
      if (!keep) { toast("Saved", "ok"); render(); }
    } catch (ex) {
      err.textContent = ex.message;
      toast(ex.message, "err");
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

// --- hand-rolled SVG charts (no external assets) -------------------------
function barChart(items, valueKey, labelFn) {
  if (!items?.length) return "<div class='empty'>no data</div>";
  const max = Math.max(...items.map((i) => Number(i[valueKey]) || 0), 1e-9);
  const rowH = 26, w = 640;
  const short = (label) => {
    const s = String(label ?? "");
    // UUIDs read as noise in a chart — show a recognizable prefix
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
// authed CSV download via a transient blob URL (endpoint sets Content-Disposition)
async function downloadCsv(path, filename) {
  const res = await fetch(path); // session cookie rides along automatically
  if (!res.ok) { toast("CSV download failed (" + res.status + ")", "err"); return; }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// --- §6's eight functional surfaces + the §10.4 cost surface -------------
const TABS = [
// Getting started — the guided "connect your first real provider" journey.
// FIRST tab deliberately: the portal has no home/overview page, tabFromHash()
// falls back to index 0, so a fresh admin lands here. Status-driven, never a
// static tutorial: every row is computed server-side from the real tables by
// /v1/setup/status, and each pending step deep-links to the exact tab + form
// that completes it. Once every step is done the whole card collapses to one
// line (dismiss state in localStorage — no schema).
["Getting started", async (el) => {
  const DISMISS_KEY = "regulait.setup.dismissed";
  const status = await get("/v1/setup/status");
  // per-step: one-line WHY + the deep link (tab slug + a CSS selector to
  // scroll/flash) to the existing surface that completes it. app:true opens
  // /app instead (the last step is completed by a developer dispatching).
  const META = {
    model_provider: {
      why: "Until a real key is configured every dispatch runs on the MOCK provider — answers are simulated and spend is $0. This is the step that makes RegulAIt real.",
      hash: "model-credentials", sel: "#f-mcred", cta: "Add a credential",
    },
    git_connection: {
      why: "Workflow build/PR stages need a real git provider. A mock connection exercises the flow but touches no repository.",
      hash: "workflows", sel: "#f-git", cta: "Connect git",
    },
    pm_connection: {
      why: "Pillar 8: work items stay the source of truth — decisions and sign-offs mirror into your own PM tool instead of a shadow copy.",
      hash: "pm-connections", sel: "#f-pmconn", cta: "Connect a PM tool",
    },
    mcp_server: {
      why: "Registering an MCP server gives the governance layer tools to allow-list — default-deny has nothing to govern until a server exists.",
      hash: "mcp-servers", sel: "#f-srv", cta: "Register a server",
    },
    non_admin_user: {
      why: "Governance is per-user. Create the first developer account and hand them an API key — admin-only orgs govern no one.",
      hash: "users", sel: "#f-user", cta: "Create a user",
    },
    project: {
      why: "Budgets and cost attribution hang off projects; calls without one land in the Unattributed bucket.",
      hash: "cost-projects", sel: "#f-proj", cta: "Create a project",
    },
    compliance_profile: {
      why: "A classification tag cascades required workflows, PII mode and retention onto everything the project governs.",
      hash: "cost-projects", sel: "#f-proj", cta: "Classify a project",
    },
    interception_surface: {
      why: "The provider-shaped compat surfaces let existing IDE/agent traffic arrive governed — both are OFF by default; the MCP proxy counts once it is actually used.",
      hash: "client-access", sel: "#f-intercept", cta: "Open Client Access",
    },
    first_real_dispatch: {
      why: "The end-to-end proof: one governed call served by a real provider, metered, attributed and audited.",
      app: true, cta: "Open /app",
    },
  };
  // evidence -> one honest dim line (mock objects are always labeled mock)
  const evLine = (s) => {
    const e = s.evidence || {};
    if (s.key === "model_provider") {
      if ((e.providers || []).length) return "Configured: " + e.providers.map((p) => p.provider + " (" + (p.source === "env" ? "env var" : "platform credential") + ")").join(", ");
      return e.note ? e.note : "No real provider configured — only mock is live.";
    }
    if (s.key === "git_connection" || s.key === "pm_connection") {
      if ((e.real || []).length) return "Connected: " + e.real.map((c) => c.name + " (" + c.provider + ")").join(", ");
      return e.mockCount > 0 ? e.mockCount + " mock connection(s) only — labeled mock; they exercise the flow but touch nothing real." : "None yet.";
    }
    if (s.key === "mcp_server") return (e.servers || []).length ? "Registered: " + e.servers.map((x) => x.name).join(", ") : "None registered.";
    if (s.key === "non_admin_user") return e.activeNonAdminUsers > 0 ? e.activeNonAdminUsers + " active non-admin user(s)." : "Only admin accounts exist so far.";
    if (s.key === "project") return (e.projects || []).length ? "Projects: " + e.projects.join(", ") : "No project yet.";
    if (s.key === "compliance_profile") {
      if ((e.classifiedProjects || []).length) return "Classified: " + e.classifiedProjects.map((p) => p.name + " [" + p.tags.join(", ") + "]").join("; ");
      return e.profilesDefined > 0 ? e.profilesDefined + " profile(s) defined but not assigned to any project." : "No compliance profile defined yet (POST /v1/compliance/profiles).";
    }
    if (s.key === "interception_surface") {
      const on = [];
      if (e.anthropicCompatEnabled) on.push("Anthropic compat on");
      if (e.openaiCompatEnabled) on.push("OpenAI compat on");
      if (e.scopeRulesExist) on.push("scope rules set");
      if (e.mcpProxyCalls > 0) on.push(e.mcpProxyCalls + " MCP proxy call(s)");
      return on.length ? on.join(" · ") : "Both compat surfaces off, MCP proxy unused.";
    }
    if (s.key === "first_real_dispatch") {
      if (e.realDispatches > 0) return e.realDispatches + " real dispatch(es) served (" + e.mockDispatches + " mock).";
      return e.mockDispatches > 0 ? e.mockDispatches + " MOCK dispatch(es) so far — the flow works, but no real model has answered yet." : "No dispatch yet.";
    }
    return "";
  };
  const dismissed = localStorage.getItem(DISMISS_KEY) === "1";
  if (status.complete && dismissed) {
    el.innerHTML = "<div class='card'><div class='row'>"
      + badge("setup complete", "ok")
      + "<span class='dim' style='font-size:13px'>All " + status.totalCount + " getting-started steps are done.</span>"
      + "<span class='grow'></span><button class='ghost small' id='setup-undismiss'>Show details</button>"
      + "</div></div>";
    $("#setup-undismiss").addEventListener("click", () => { localStorage.removeItem(DISMISS_KEY); render(); });
    return;
  }
  const pct = Math.round((status.doneCount / status.totalCount) * 100);
  const stepRow = (s) => {
    const m = META[s.key] || { why: "", cta: "Open" };
    const blocked = (s.blockedBy || []).length > 0;
    const blockedNames = (s.blockedBy || []).map((k) => (META[k] ? k.replace(/_/g, " ") : k)).join(", ");
    const action = s.done ? ""
      : m.app
        ? "<button class='small' data-setup-app='1'" + (blocked ? " disabled" : "") + ">" + esc(m.cta) + "</button>"
        : "<button class='small' data-setup-go='" + esc(m.hash) + "' data-setup-sel='" + esc(m.sel) + "'>" + esc(m.cta) + "</button>";
    return "<div class='node-row' style='align-items:flex-start" + (blocked ? ";opacity:.6" : "") + "'>"
      + "<span class='node-dot " + (s.done ? "done" : blocked ? "blocked" : "not_started") + "' style='margin-top:6px'></span>"
      + "<div class='grow'><div class='row'>"
      + "<strong>" + esc(s.title) + "</strong>"
      + (s.done ? badge("done", "ok") : blocked ? badge("blocked", "bad") : badge("pending", "warn"))
      + "</div>"
      + "<div class='dim' style='font-size:12.5px;margin-top:2px'>" + esc(m.why) + "</div>"
      + "<div class='faint' style='font-size:12px;margin-top:3px'>" + esc(evLine(s)) + "</div>"
      + (blocked ? "<div class='faint' style='font-size:12px;margin-top:2px'>Blocked by: " + esc(blockedNames) + "</div>" : "")
      + "</div>"
      + "<div style='flex:none'>" + action + "</div>"
      + "</div>";
  };
  el.innerHTML = "<p class='sub'>A live checklist, recomputed from the real objects on every load (and whenever this tab regains focus) — never a tutorial that can drift. Each pending step links to the exact form that completes it.</p>"
    + (status.complete
        ? "<div class='card' style='border-color:#7fa65066'><div class='row'>" + badge("setup complete", "ok")
          + "<span class='dim'>All " + status.totalCount + " steps are done — this page collapses to one line once dismissed.</span>"
          + "<span class='grow'></span><button class='small primary' id='setup-dismiss'>Dismiss</button></div></div>"
        : "")
    + "<div class='card'>"
    + "<div class='row'><span class='num'>" + status.doneCount + " / " + status.totalCount + "</span>"
    + "<span class='dim' style='font-size:12.5px'>steps done</span><span class='grow'></span>"
    + "<button class='ghost small' id='setup-refresh'>Re-check</button></div>"
    + "<div class='bar' style='margin:10px 0 14px'><i style='width:" + pct + "%'></i></div>"
    + status.steps.map(stepRow).join("")
    + "</div>"
    + "<p class='dim' style='font-size:12px'>Honest by design: mock providers/connections are labeled mock everywhere — a green flow on mock objects proves the plumbing, not production readiness. The dispatch step only turns done when a REAL (non-mock) provider serves a governed call.</p>";
  const dis = $("#setup-dismiss");
  if (dis) dis.addEventListener("click", () => { localStorage.setItem(DISMISS_KEY, "1"); render(); });
  $("#setup-refresh").addEventListener("click", () => render());
  el.addEventListener("click", (e) => {
    const go = e.target.closest("[data-setup-go]");
    if (go) {
      // hand the selector to render() via SETUP_FOCUS; the hashchange listener
      // renders the target tab, then render() scrolls to + flashes the form.
      SETUP_FOCUS = go.dataset.setupSel || null;
      location.hash = go.dataset.setupGo;
      return;
    }
    if (e.target.closest("[data-setup-app]")) window.open("/app", "_blank", "noopener");
  });
}],
["Users", async (el) => {
  const [u, rev, srv, k, ag, cn, oidcp, rolesRes] = await Promise.all([
    get("/v1/users"), get("/v1/revocations"), get("/v1/servers"), get("/v1/keys"),
    // ADR-0019: the agent/connector catalogs, so the two new revocation forms
    // name objects instead of asking for UUIDs (like every other grant form).
    get("/v1/agents"), get("/v1/connectors"),
    // ADR-0025: SSO providers + the role catalog for JIT default roles
    get("/v1/auth/oidc-providers").catch(() => ({ providers: [] })),
    get("/v1/roles").catch(() => ({ roles: [] })),
  ]);
  const tools = await toolIndex(srv.servers);
  const uOpts = userOpts(u.users), sOpts = serverOpts(srv.servers);
  const aOpts = agentOpts(ag.agents), cOpts = connectorOpts(cn.connectors);
  const email = Object.fromEntries(u.users.map((x) => [x.id, x.email]));
  const uname = Object.fromEntries(u.users.map((x) => [x.id, x.displayName || x.email]));
  const sname = Object.fromEntries(srv.servers.map((x) => [x.id, x.name]));
  const activeAdmins = u.users.filter((x) => x.isAdmin && !x.disabledAt).length;
  // ADR-0022 lifecycle: greyed disabled rows, reactivate control, guarded
  // admin promote/demote — the last active admin's demote/deactivate buttons
  // are pre-disabled with the reason in the tooltip (the server enforces it
  // regardless).
  const userRow = (x) => ({
    id: x.id,
    name: x.displayName,
    email: x.email,
    role: x.isAdmin ? "admin" : "member",
    // ADR-0025: how (whether) this human can sign in today
    signIn: x.hasPassword ? (x.mustChangePassword ? "one-time pw" : "password") : "no password",
    mfa: x.totpEnabled ? "TOTP" : "—",
    status: x.disabledAt ? "disabled" : "active",
    created: x.createdAt,
  });
  const userActions = (row) => {
    const x = u.users.find((usr) => usr.id === row.id);
    if (!x) return "";
    const lastAdmin = x.isAdmin && !x.disabledAt && activeAdmins <= 1;
    const guard = lastAdmin ? " disabled title='last active admin — promote another admin first'" : "";
    if (x.disabledAt) return "<button class='small primary' data-uact='reactivate' data-uid='" + x.id + "'>reactivate</button>";
    return "<button class='small' data-key='" + x.id + "'>issue key</button> "
      + "<button class='small' data-uact='setpw' data-uid='" + x.id + "'"
      + (x.hasPassword ? " title='overwrites their password with a fresh one-time one (audited reset)'" : "")
      + ">" + (x.hasPassword ? "reset pw" : "set one-time pw") + "</button> "
      + (x.totpEnabled ? "<button class='small' data-uact='clearmfa' data-uid='" + x.id + "'>clear MFA</button> " : "")
      + (x.isAdmin
          ? "<button class='small' data-uact='demote' data-uid='" + x.id + "'" + guard + ">demote</button> "
          : "<button class='small' data-uact='promote' data-uid='" + x.id + "'>make admin</button> ")
      + "<button class='small danger' data-uact='deactivate' data-uid='" + x.id + "'" + guard + ">deactivate</button>";
  };
  el.innerHTML = "<h2>Users</h2><div class='card'>"
    + form("f-user", [{name:"email"},{name:"displayName"},{name:"isAdmin",label:"admin",options:["false","true"]}], "Create user")
    + form("f-rename", [{name:"userId",label:"user",options:uOpts},{name:"displayName",label:"new display name",grow:true}], "Rename")
    + dataTable(u.users.map(userRow), {
        cells: {
          status: (v) => "<span class='badge " + (v === "disabled" ? "bad" : "ok") + "'>" + esc(v) + "</span>",
          role: (v) => v === "admin" ? "<span class='badge accent'>admin</span>" : "<span class='badge'>member</span>",
          name: (v, row) => "<span" + (row.status === "disabled" ? " class='faint'" : "") + ">" + esc(v) + "</span>",
        },
        actions: userActions,
      })
    + "<p class='dim' style='font-size:12px'>Deactivate is not delete: the account's audit history, grants and keys all survive; its keys and browser sessions just stop authenticating (a distinct 401) until an admin reactivates. You cannot deactivate yourself, and the last active admin can be neither deactivated nor demoted. 'Set one-time pw' issues a generated password shown ONCE — the user must replace it at first sign-in; 'clear MFA' is the recovery path for a user who lost their authenticator (reason required, audited).</p></div>"
    + "<div id='keyreveal'></div>"
    // ADR-0025: the signed-in admin's own password / MFA self-service
    + "<h2>Your account — sign-in security</h2>" + accountSecurityHtml(AUTHED)
    // ADR-0025: OIDC SSO provider CRUD (secrets write-only, JIT default-deny)
    + "<h2>Single sign-on — OIDC providers</h2><div class='card'>"
    + form("f-oidc", [
        {name:"name",ph:"okta-prod"},
        {name:"issuerUrl",label:"issuer URL",ph:"https://idp.example.com",grow:true},
        {name:"clientId",label:"client id"},
        {name:"clientSecret",label:"client secret",type:"password"},
        {name:"allowedEmailDomains",label:"allowed email domains (comma, empty = any)",req:false,ph:"example.com, corp.example.com"},
        {name:"defaultRoleId",label:"JIT default role",options:roleOpts(rolesRes.roles || []),req:false,ph:"— none —"},
        {name:"jitProvisioning",label:"JIT provisioning",options:[{v:"false",l:"off — unknown users are refused (default)"},{v:"true",l:"on — first login creates the user (never admin)"}]},
      ], "Add provider")
    + dataTable((oidcp.providers || []).map((p) => ({
        id: p.id, name: p.name, issuer: p.issuerUrl, clientId: p.clientId,
        domains: (p.allowedEmailDomains || []).join(", ") || "any",
        jit: p.jitProvisioning ? "on" : "off",
        status: p.enabled ? "enabled" : "disabled",
      })), {
        cells: { status: (v) => "<span class='badge " + (v === "enabled" ? "ok" : "") + "'>" + esc(v) + "</span>" },
        actions: (row) => "<button class='small' data-oidc-toggle='" + row.id + "' data-oidc-on='" + (row.status === "enabled" ? "0" : "1") + "'>" + (row.status === "enabled" ? "disable" : "enable") + "</button> "
          + "<button class='small danger' data-oidc-del='" + row.id + "'>delete</button>",
      })
    + "<p class='dim' style='font-size:12px'>Authorization-code + PKCE; state and nonce are validated server-side and the client secret is stored encrypted, write-only — it is never returned by any endpoint. Sign-in maps the VERIFIED email claim to an existing user; with JIT off (the default-deny default) an unknown identity is refused and audited. JIT-provisioned users are never admins and get at most the default role picked here. The org 'SSO only' switch lives in Org Settings and refuses to engage while no provider here is enabled.</p></div>"
    // A user with no API key cannot sign in to anything — issuing one is part
    // of creating them, not a separate API-only chore.
    + "<h2>API keys — plaintext returned exactly once, sha256 at rest</h2><div class='card'><div id='keyscard'>"
    + "</div></div>"
    + "<h2>Per-user overrides — revocations, visibly flagged deviations</h2><div class='card'>"
    + form("f-revoke", [{name:"userId",label:"user",options:uOpts},{name:"serverId",label:"server",options:sOpts},{name:"toolName",label:"tool",options:[],req:false}], "Add revocation")
    + table(rev.revocations.map((x) => ({
        id: x.id, user: uname[x.userId] ?? x.userId, server: sname[x.serverId] ?? x.serverId,
        tool: x.toolName ?? "— all role-derived —", created: x.createdAt,
      }))) + "</div>"
    // ADR-0019: the AGENT/CONNECTOR half of "role builder + per-user override".
    // Role-bundled agent/connector grants compose additively (ADR-0014), so
    // without these an admin could only take an object away by unassigning the
    // whole role. A revocation here is total for that (user, object) and beats
    // both the direct and the role grant — and it can only ever DENY.
    + "<h2>Per-user overrides — agent &amp; connector revocations</h2><div class='card'>"
    + form("f-revpick", [{name:"userId",label:"user",options:uOpts,req:false,ph:"— select a user —"}], "Load revocations")
    + "<div class='grid2' style='margin-top:10px'>"
    + "<div>" + form("f-arevoke", [
        {name:"agentId",label:"agent",options:aOpts},
        {name:"reason",req:false,ph:"why (optional, recorded)"},
      ], "Revoke agent") + "</div>"
    + "<div>" + form("f-crevoke", [
        {name:"connectorId",label:"connector",options:cOpts},
        {name:"reason",req:false,ph:"why (optional, recorded)"},
      ], "Revoke connector") + "</div>"
    + "</div>"
    + "<div id='objrevs'><div class='empty'>Select a user to view and edit their agent/connector revocations</div></div>"
    + "<p class='dim' style='font-size:12px'>A revocation takes ONE agent or connector away from ONE user without touching their roles — it beats both a direct grant and every role-derived grant, and it applies everywhere that user's entitlements are evaluated (direct invoke, decomposition, and every orchestration worker). It can only ever deny: revoking something the user was never granted changes nothing. Lifting the revocation restores whatever the grants already said.</p></div>";
  linkTools("f-revoke", tools);
  // The keys table renders (and REFRESHES) from its own fetch, so issuing a
  // key updates it immediately without a full tab re-render — which would
  // wipe the one-time key reveal.
  const renderKeys = async () => {
    const host = $("#keyscard");
    if (!host) return;
    const fresh = await get("/v1/keys");
    host.innerHTML = dataTable(fresh.keys.map((x) => ({
      id: x.id, name: x.name, user: email[x.userId] ?? x.userId, created: x.createdAt,
      lastUsed: x.lastUsedAt ?? "never", status: x.revokedAt ? "revoked" : "active",
    })), {
      cells: { status: (v) => "<span class='badge " + (v === "revoked" ? "bad" : "ok") + "'>" + esc(v) + "</span>" },
      actions: (row) => row.status === "active"
        ? "<button class='small danger' data-revoke='" + row.id + "'>revoke</button>" : "",
    });
  };
  void k; // initial payload superseded by renderKeys' own fetch (kept for the email map's Promise.all)
  await renderKeys();
  // delegate on el (stable during the tab's life) so the handlers survive a
  // dataTable sort/filter/paginate re-render, which rebuilds the button nodes.
  el.addEventListener("click", async (e) => {
    const keyBtn = e.target.closest("[data-key]");
    if (keyBtn) {
      try {
        const issued = await post("/v1/users/" + keyBtn.dataset.key + "/keys", { name: "portal" });
        revealSecret("#keyreveal", "API key for " + (email[keyBtn.dataset.key] ?? "this user"), issued.token,
          "Hand it to them over a channel you trust; if it is lost, revoke it and issue another.");
        $("#keyreveal").scrollIntoView({ block: "nearest" });
        await renderKeys(); // the new key appears in the table immediately
      } catch (ex) { toast(ex.message, "err"); }
      return;
    }
    const revBtn = e.target.closest("[data-revoke]");
    if (revBtn) {
      if (!confirmClick(revBtn, "Revoke for good?")) return;
      try { await post("/v1/keys/" + revBtn.dataset.revoke + "/revoke", {}); toast("Key revoked — the holder can no longer authenticate with it", "ok"); await renderKeys(); }
      catch (ex) { toast(ex.message, "err"); }
      return;
    }
    // ADR-0022 lifecycle actions — deactivate is confirm-armed (destructive
    // for the holder's access), the rest act immediately with a toast.
    const uBtn = e.target.closest("[data-uact]");
    if (uBtn) {
      const act = uBtn.dataset.uact, uid = uBtn.dataset.uid;
      try {
        if (act === "deactivate") {
          if (!confirmClick(uBtn, "Deactivate?")) return;
          await post("/v1/users/" + uid + "/deactivate", {});
          toast("User deactivated — their keys stop authenticating until reactivated", "ok");
        } else if (act === "reactivate") {
          await post("/v1/users/" + uid + "/reactivate", {});
          toast("User reactivated — their existing keys work again", "ok");
        } else if (act === "promote") {
          await post("/v1/users/" + uid + "/admin", { isAdmin: true });
          toast("Promoted to admin", "ok");
        } else if (act === "demote") {
          if (!confirmClick(uBtn, "Demote?")) return;
          await post("/v1/users/" + uid + "/admin", { isAdmin: false });
          toast("Demoted to member", "ok");
        } else if (act === "setpw") {
          // ADR-0025: generated server-side, revealed ONCE, must-change on use
          const hasPw = uBtn.textContent.indexOf("reset") !== -1;
          if (hasPw && !confirmClick(uBtn, "Overwrite their password?")) return;
          const issued = await post("/v1/users/" + uid + "/set-initial-password", hasPw ? { force: true } : {});
          revealSecret("#keyreveal", "One-time password for " + (email[uid] ?? "this user"), issued.password,
            "Hand it to them over a channel you trust. They must replace it at first sign-in; every prior session was signed out.");
          $("#keyreveal").scrollIntoView({ block: "nearest" });
          return; // no full re-render — it would wipe the one-time reveal
        } else if (act === "clearmfa") {
          const reason = prompt("Clearing MFA is the lost-authenticator recovery path and is audited.\\nReason:");
          if (!reason || !reason.trim()) return;
          await post("/v1/users/" + uid + "/mfa/clear", { reason: reason.trim() });
          toast("MFA cleared — they can sign in with just their password and re-enroll", "ok");
        }
        render();
      } catch (ex) { toast(ex.message, "err"); }
      return;
    }
    // ADR-0025 SSO provider actions
    const oidcToggle = e.target.closest("[data-oidc-toggle]");
    if (oidcToggle) {
      try {
        await api("PATCH", "/v1/auth/oidc-providers/" + oidcToggle.dataset.oidcToggle,
          { enabled: oidcToggle.dataset.oidcOn === "1" });
        toast("Provider " + (oidcToggle.dataset.oidcOn === "1" ? "enabled" : "disabled"), "ok");
        render();
      } catch (ex) { toast(ex.message, "err"); }
      return;
    }
    const oidcDel = e.target.closest("[data-oidc-del]");
    if (oidcDel) {
      if (!confirmClick(oidcDel, "Delete provider?")) return;
      try { await del("/v1/auth/oidc-providers/" + oidcDel.dataset.oidcDel); toast("Provider deleted", "ok"); render(); }
      catch (ex) { toast(ex.message, "err"); }
      return;
    }
    // ADR-0019: lifting an agent/connector revocation — the override is
    // independently reversible, exactly like the MCP one.
    const aLift = e.target.closest("[data-arev]");
    if (aLift) {
      try {
        await del("/v1/users/" + revUserId + "/revocations/agents/" + aLift.dataset.arev);
        toast("Agent revocation lifted", "ok"); await renderObjRevs();
      } catch (ex) { toast(ex.message, "err"); }
      return;
    }
    const cLift = e.target.closest("[data-crev]");
    if (cLift) {
      try {
        await del("/v1/users/" + revUserId + "/revocations/connectors/" + cLift.dataset.crev);
        toast("Connector revocation lifted", "ok"); await renderObjRevs();
      } catch (ex) { toast(ex.message, "err"); }
    }
  });
  wire("f-user", (d) => post("/v1/users", { ...d, isAdmin: d.isAdmin === "true" }));
  wire("f-rename", (d) => api("PATCH", "/v1/users/" + d.userId, { displayName: d.displayName }));
  wire("f-revoke", (d) => post("/v1/revocations", { ...d, toolName: d.toolName ?? null }));
  // ADR-0025: the admin's own password/MFA card + SSO provider create
  wireAccountSecurity(() => { AUTHED = null; render(); });
  wire("f-oidc", (d) => post("/v1/auth/oidc-providers", {
    name: d.name,
    issuerUrl: d.issuerUrl,
    clientId: d.clientId,
    clientSecret: d.clientSecret,
    jitProvisioning: d.jitProvisioning === "true",
    ...(d.allowedEmailDomains
      ? { allowedEmailDomains: d.allowedEmailDomains.split(",").map((s) => s.trim()).filter(Boolean) }
      : {}),
    ...(d.defaultRoleId ? { defaultRoleId: d.defaultRoleId } : {}),
  }));

  // ADR-0019 per-user agent/connector revocation editor. The picked user is
  // held in a closure (not the URL) exactly like the Roles tab's active role,
  // so the two revoke forms and the listing all act on one subject.
  let revUserId = "";
  const renderObjRevs = async () => {
    const host = $("#objrevs");
    if (!host) return;
    if (!revUserId) {
      host.innerHTML = "<div class='empty'>Select a user to view and edit their agent/connector revocations</div>";
      return;
    }
    const [ar, cr] = await Promise.all([
      get("/v1/users/" + revUserId + "/revocations/agents"),
      get("/v1/users/" + revUserId + "/revocations/connectors"),
    ]);
    host.innerHTML =
      "<h2>Revoked agents</h2>"
      + dataTable((ar.revocations ?? []).map((x) => ({
          id: x.id, agent: x.agentName, reason: x.reason ?? "—", created: x.createdAt,
        })), { actions: (row) => "<button class='small' data-arev='" + row.id + "'>lift</button>" })
      + "<h2>Revoked connectors</h2>"
      + dataTable((cr.revocations ?? []).map((x) => ({
          id: x.id, connector: x.connectorName, reason: x.reason ?? "—", created: x.createdAt,
        })), { actions: (row) => "<button class='small' data-crev='" + row.id + "'>lift</button>" });
  };
  wire("f-revpick", async (d) => { revUserId = d.userId ?? ""; await renderObjRevs(); }, true);
  wire("f-arevoke", async (d) => {
    if (!revUserId) throw new Error("select a user above first");
    await post("/v1/users/" + revUserId + "/revocations/agents",
      { agentId: d.agentId, ...(d.reason ? { reason: d.reason } : {}) });
    toast("Agent revoked for this user", "ok");
    await renderObjRevs();
  }, true);
  wire("f-crevoke", async (d) => {
    if (!revUserId) throw new Error("select a user above first");
    await post("/v1/users/" + revUserId + "/revocations/connectors",
      { connectorId: d.connectorId, ...(d.reason ? { reason: d.reason } : {}) });
    toast("Connector revoked for this user", "ok");
    await renderObjRevs();
  }, true);
}],
["Roles", async (el) => {
  // The Roles page owns the whole role lifecycle: create, assign to users, and
  // — the point of a role — define WHAT it grants. Fetch the four grantable
  // object catalogs so the grant sub-forms can name things, not show UUIDs.
  const [u, r, a, c, s] = await Promise.all([
    get("/v1/users"), get("/v1/roles"), get("/v1/agents"), get("/v1/connectors"), get("/v1/servers"),
  ]);
  const tools = await toolIndex(s.servers);
  const uOpts = userOpts(u.users), rOpts = roleOpts(r.roles);
  const aOpts = agentOpts(a.agents), cOpts = connectorOpts(c.connectors), sOpts = serverOpts(s.servers);
  el.innerHTML = "<h2>Roles</h2><div class='card'>"
    + form("f-role", [{name:"name"},{name:"description",req:false}], "Create role")
    + form("f-assign", [{name:"userId",label:"user",options:uOpts},{name:"roleId",label:"role",options:rOpts}], "Assign role")
    + table(r.roles, (row) => "<button class='small danger' data-roledel='" + row.id + "'>delete</button>")
    + "<div id='roledel-force'></div>"
    + "<p class='dim' style='font-size:12px'>Deleting a role that is still held is refused with the holders named; force-deleting it (with a recorded, audited reason) unassigns everyone and removes its bundled grants.</p></div>"
    // §5 (ADR-0014): a role is a provisioning bundle. Pick a role, see what it
    // grants and who holds it, add/adjust/remove grants, unassign holders —
    // all against the ROLE endpoints (roleId in the path).
    + "<h2>Role grants &amp; holders — what this role provisions, and for whom</h2><div class='card'>"
    + form("f-rolepick", [{name:"roleId",label:"active role",options:rOpts,req:false,ph:"— select a role —"}], "Load grants")
    + "<div id='rolegrants'><div class='empty'>Select a role to view and edit its grants and holders</div></div>"
    + "</div>";
  wire("f-role", (d) => post("/v1/roles", d));
  wire("f-assign", (d) => post("/v1/users/" + d.userId + "/roles", { roleId: d.roleId }));

  // ADR-0022: delete role — refused when held (409 names the holders), then
  // the inline force-with-reason card appears; force posts the audited reason.
  el.addEventListener("click", async (e) => {
    const delBtn = e.target.closest("[data-roledel]");
    if (!delBtn) return;
    if (!confirmClick(delBtn, "Delete role?")) return;
    const roleId = delBtn.dataset.roledel;
    try {
      await del("/v1/roles/" + roleId);
      toast("Role deleted", "ok"); render();
    } catch (ex) {
      if (ex.status === 409 && ex.payload && ex.payload.error === "role_held") {
        const host = $("#roledel-force");
        host.innerHTML = "<div class='card' style='margin-top:10px;border-color:#cd5b5266'>"
          + "<div class='row'><span class='badge bad'>role held</span><span class='dim' style='font-size:12.5px'>held by " + esc((ex.payload.holders || []).join(", ")) + " — unassign them, or force-delete with a recorded reason.</span></div>"
          + "<div class='row' style='margin-top:8px'><input id='roledel-reason' class='grow' placeholder='reason (required, audited)'>"
          + "<button class='small danger' id='roledel-go' data-rid='" + esc(roleId) + "'>Force delete</button>"
          + "<button class='ghost small' id='roledel-cancel'>Cancel</button></div></div>";
        $("#roledel-cancel").addEventListener("click", () => { host.innerHTML = ""; });
        $("#roledel-go").addEventListener("click", async () => {
          const reason = ($("#roledel-reason")?.value ?? "").trim();
          if (!reason) { toast("A reason is required to force-delete a held role.", "err"); return; }
          try {
            await api("DELETE", "/v1/roles/" + roleId, { force: true, reason });
            toast("Role force-deleted — holders unassigned, reason audited", "ok"); render();
          } catch (e2) { toast(e2.message, "err"); }
        });
      } else { toast(ex.message, "err"); }
    }
  });

  let activeRoleId = "";
  const renderGrants = async () => {
    const host = $("#rolegrants");
    if (!host) return;
    if (!activeRoleId) { host.innerHTML = "<div class='empty'>Select a role to view and edit its grants and holders</div>"; return; }
    const [g, asg] = await Promise.all([
      get("/v1/roles/" + activeRoleId + "/grants"),
      get("/v1/roles/" + activeRoleId + "/assignments").catch(() => ({ assignments: [] })),
    ]);
    const rmBtn = (kind, id) => "<button class='ghost small' data-grantdel='" + kind + ":" + id + "' title='remove this grant from the role'>remove</button>";
    host.innerHTML =
      "<h2>Held by</h2>"
      + table((asg.assignments ?? []).map((x) => ({
          user: (x.displayName || x.email) + (x.disabledAt ? " (disabled)" : ""),
          email: x.email, assigned: x.assignedAt,
        })), (row) => {
          const a = (asg.assignments ?? []).find((x) => x.email === row.email);
          return a ? "<button class='small' data-unassign='" + a.userId + "'>unassign</button>" : "";
        })
      + "<div class='grid2' style='margin-top:14px'>"
      + "<div>" + form("f-r-agrant", [{name:"agentId",label:"agent",options:aOpts}], "Grant agent") + "</div>"
      + "<div>" + form("f-r-cgrant", [
          {name:"connectorId",label:"connector",options:cOpts},
          {name:"mode",options:["read","readwrite"]},
          {name:"allowedObjects",label:"object scope",req:false,ph:"comma,separated (blank = all)"},
        ], "Grant connector") + "</div>"
      + "<div>" + form("f-r-tgrant", [{name:"serverId",label:"server",options:sOpts},{name:"toolName",label:"tool",options:[]}], "Grant MCP tool") + "</div>"
      + "<div>" + form("f-r-sgrant", [{name:"serverId",label:"server",options:sOpts},{name:"readOnlyAll",label:"read-only all",options:["true","false"]}], "Grant MCP server") + "</div>"
      + "</div>"
      + "<h2>Agents</h2>" + table((g.agents ?? []).map((x) => ({ agent: x.agentName ?? x.agentId, modes: (x.allowedModes ?? []).join(", ") || "all", id: x.grantId })), (row) => rmBtn("agents", row.id))
      + "<h2>Connectors</h2>" + table((g.connectors ?? []).map((x) => ({ connector: x.connectorName ?? x.connectorId, mode: x.mode, objects: (x.allowedObjects ?? []).join(", ") || "all", id: x.grantId })), (row) => rmBtn("connectors", row.id))
      + "<h2>MCP servers</h2>" + table((g.servers ?? []).map((x) => ({ server: x.serverName ?? x.serverId, readOnlyAll: x.readOnlyAll, id: x.grantId })), (row) => rmBtn("servers", row.id))
      + "<h2>MCP tools</h2>" + table((g.tools ?? []).map((x) => ({ server: x.serverName ?? x.serverId, tool: x.toolName, id: x.grantId })), (row) => rmBtn("tools", row.id));
    linkTools("f-r-tgrant", tools);
    host.querySelectorAll("[data-unassign]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirmClick(b, "Unassign?")) return;
      try {
        await del("/v1/users/" + b.dataset.unassign + "/roles/" + activeRoleId);
        toast("Role unassigned", "ok"); await renderGrants();
      } catch (ex) { toast(ex.message, "err"); }
    }));
    host.querySelectorAll("[data-grantdel]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirmClick(b, "Remove?")) return;
      const sep = b.dataset.grantdel.indexOf(":");
      const kind = b.dataset.grantdel.slice(0, sep), gid = b.dataset.grantdel.slice(sep + 1);
      try {
        await del("/v1/roles/" + activeRoleId + "/grants/" + kind + "/" + gid);
        toast("Grant removed from the role", "ok"); await renderGrants();
      } catch (ex) { toast(ex.message, "err"); }
    }));
    // keep=true: don't re-render the whole tab (that would drop the picker) —
    // refresh only the bundle and toast success ourselves.
    wire("f-r-agrant", async (d) => { await post("/v1/roles/" + activeRoleId + "/grants/agents", { agentId: d.agentId }); toast("Agent granted", "ok"); await renderGrants(); }, true);
    wire("f-r-cgrant", async (d) => {
      await post("/v1/roles/" + activeRoleId + "/grants/connectors", {
        connectorId: d.connectorId, mode: d.mode,
        ...(d.allowedObjects ? { allowedObjects: String(d.allowedObjects).split(",").map((x) => x.trim()).filter(Boolean) } : {}),
      });
      toast("Connector granted", "ok"); await renderGrants();
    }, true);
    wire("f-r-tgrant", async (d) => { await post("/v1/roles/" + activeRoleId + "/grants/tools", { serverId: d.serverId, toolName: d.toolName }); toast("Tool granted", "ok"); await renderGrants(); }, true);
    wire("f-r-sgrant", async (d) => { await post("/v1/roles/" + activeRoleId + "/grants/servers", { serverId: d.serverId, readOnlyAll: d.readOnlyAll === "true" }); toast("Server granted", "ok"); await renderGrants(); }, true);
  };
  // the picker is a live control; wire it so Enter doesn't GET-submit + reboot,
  // and react to change immediately.
  wire("f-rolepick", async (d) => { activeRoleId = d.roleId ?? ""; await renderGrants(); }, true);
  const pick = $("#f-rolepick [name=roleId]");
  if (pick) pick.addEventListener("change", async () => { activeRoleId = pick.value; await renderGrants(); });
}],
["Teams", async (el) => {
  const [u, t, cp] = await Promise.all([
    get("/v1/users"), get("/v1/teams"), get("/v1/compliance/profiles"),
  ]);
  const uOpts = userOpts(u.users);
  const teamOpts = t.teams.map((x) => ({ v: x.id, l: x.name }));
  const tagOpts = cp.profiles.map((x) => x.tag);
  el.innerHTML = "<h2>Teams</h2><div class='card'>"
    + form("f-team", [
        {name:"name",ph:"team name"},
        {name:"defaultClassifications",label:"default classifications",options:tagOpts,req:false,multi:true},
      ], "Create team")
    + form("f-tmadd", [
        {name:"teamId",label:"team",options:teamOpts},
        {name:"userId",label:"user",options:uOpts},
      ], "Add member")
    + t.teams.map((x) => "<div class='node-row' style='align-items:flex-start'><div class='grow'>"
        + "<div><strong>" + esc(x.name) + "</strong> "
        + (x.defaultClassifications ?? []).map((c) => "<span class='badge info'>" + esc(c) + "</span>").join(" ")
        + "</div>"
        + "<div class='row' style='margin-top:6px'>"
        + ((x.members ?? []).map((m) => "<span class='att-pill'>" + esc(m.name)
            + " <button class='ghost small' style='padding:0 4px' data-tmrm='" + x.id + ":" + m.userId + "' title='remove " + esc(m.name) + " from " + esc(x.name) + "' aria-label='Remove member'>×</button></span>").join("")
          || "<span class='faint' style='font-size:12px'>no members</span>")
        + "</div></div>"
        + "<button class='small danger' data-teamdel='" + x.id + "'>delete team</button>"
        + "</div>").join("")
    + "<div id='teamdel-force'></div>"
    + "<p class='dim' style='font-size:12px'>Team membership is flat — per-user roles (owner/contributor/viewer) live on Shared-Project membership, not here. A team's default classifications are surfaced (never silently resolved) when a member joins a project whose tags don't cover them. Deleting a team that is the recorded contributor of shared context is refused with what blocks; provenance history survives even a forced deletion.</p></div>";
  wire("f-team", (d) => post("/v1/teams", {
    name: d.name,
    ...(d.defaultClassifications ? { defaultClassifications: [].concat(d.defaultClassifications) } : {}),
  }));
  wire("f-tmadd", (d) => post("/v1/teams/" + d.teamId + "/members", { userId: d.userId }));
  el.addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-tmrm]");
    if (rm) {
      if (!confirmClick(rm, "×?")) return;
      const sep = rm.dataset.tmrm.indexOf(":");
      try {
        await del("/v1/teams/" + rm.dataset.tmrm.slice(0, sep) + "/members/" + rm.dataset.tmrm.slice(sep + 1));
        toast("Member removed from the team", "ok"); render();
      } catch (ex) { toast(ex.message, "err"); }
      return;
    }
    const td = e.target.closest("[data-teamdel]");
    if (td) {
      if (!confirmClick(td, "Delete team?")) return;
      const teamId = td.dataset.teamdel;
      try {
        await del("/v1/teams/" + teamId);
        toast("Team deleted", "ok"); render();
      } catch (ex) {
        if (ex.status === 409 && ex.payload && ex.payload.error === "team_owns_shared_context") {
          const host = $("#teamdel-force");
          host.innerHTML = "<div class='card' style='margin-top:10px;border-color:#d9a44166'>"
            + "<div class='row'><span class='badge warn'>owns shared context</span>"
            + "<span class='dim' style='font-size:12.5px'>" + ex.payload.contextItems + " context revision(s) in " + esc((ex.payload.projects || []).join(", ")) + " name this team as contributor. Provenance survives deletion, but confirm deliberately.</span></div>"
            + "<div class='row' style='margin-top:8px'><input id='teamdel-reason' class='grow' placeholder='reason (required, audited)'>"
            + "<button class='small danger' id='teamdel-go'>Force delete</button>"
            + "<button class='ghost small' id='teamdel-cancel'>Cancel</button></div></div>";
          $("#teamdel-cancel").addEventListener("click", () => { host.innerHTML = ""; });
          $("#teamdel-go").addEventListener("click", async () => {
            const reason = ($("#teamdel-reason")?.value ?? "").trim();
            if (!reason) { toast("A reason is required to force-delete this team.", "err"); return; }
            try {
              await api("DELETE", "/v1/teams/" + teamId, { force: true, reason });
              toast("Team force-deleted — reason audited; context provenance retained", "ok"); render();
            } catch (e2) { toast(e2.message, "err"); }
          });
        } else { toast(ex.message, "err"); }
      }
    }
  });
}],
["Agents", async (el) => {
  const [a, u] = await Promise.all([get("/v1/agents"), get("/v1/users")]);
  const uOpts = userOpts(u.users), aOpts = agentOpts(a.agents);
  const agentName = Object.fromEntries(a.agents.map((x) => [x.id, x.name]));
  // "leave unchanged" is the endpoint's own semantics (an omitted field is
  // untouched); "clear" is the only way to actually null one out, so it has
  // to be a distinct choice rather than an empty box.
  const KEEP = { v: "", l: "— leave unchanged —" }, CLEAR = { v: "__clear__", l: "— clear —" };
  // the catalog stays scannable: a stored system prompt shows as a compact
  // "set (n chars)" marker (the full text is edited via the form below, and
  // its current value is what you last saved — there is no partial view)
  const catalogRows = a.agents.map((x) => Object.assign({}, x, {
    systemPrompt: x.systemPrompt ? "set (" + x.systemPrompt.length + " chars)" : "—",
  }));
  el.innerHTML = "<h2>Agent catalog</h2><div class='card'>"
    + table(catalogRows, (r) => "<button class='small' data-agent='" + r.id + "' data-en='" + !r.enabled + "'>" + (r.enabled ? "disable" : "enable") + "</button>") + "</div>"
    + "<h2>Grant an agent</h2><div class='card'>"
    + form("f-agrant", [{name:"userId",label:"user",options:uOpts},{name:"agentId",label:"agent",options:aOpts}], "Grant") + "</div>"
    // ADR-0023: the admin-authored BASE system prompt — a governance artifact
    // applied on every dispatch of the agent; a caller-supplied system is
    // appended after it, never replacing it. Leaving the textarea empty clears.
    + "<h2>System prompt — admin base (governance artifact)</h2><div class='card'>"
    + form("f-asys", [
        {name:"agentId",label:"agent",options:aOpts},
        {name:"systemPrompt",label:"system prompt",type:"textarea",req:false,grow:true,
         ph:"e.g. You are the billing-support agent. Never quote raw account numbers. (empty = clear)"},
      ], "Save prompt")
    + "<p class='dim' style='font-size:12px'>Applied as the system BASE on every governed dispatch of this agent — direct invokes, orchestration workers, and intercepted IDE calls alike. A caller-supplied system prompt is appended after it and can never replace it. Saving with an empty box clears the prompt.</p>"
    + "</div>"
    // §4 default + ceiling, §12 routing off-switch, ORCH §5.2 run budget —
    // one row in user_agent_policies, so one form.
    + "<h2>Per-user agent policy — default, ceiling, routing, run budget</h2><div class='card'>"
    + form("f-apolicy", [
        {name:"userId",label:"user",options:uOpts},
        {name:"defaultAgentId",label:"default agent",options:[CLEAR].concat(aOpts),req:false,ph:KEEP.l},
        {name:"ceilingAgentId",label:"cost ceiling",options:[CLEAR].concat(aOpts),req:false,ph:KEEP.l},
        {name:"routingMode",label:"routing",options:["automatic","passthrough"],req:false,ph:KEEP.l},
        {name:"runBudgetUsd",label:"run budget usd",type:"number",req:false,ph:"e.g. 0.25"},
        {name:"runBudgetBreachAction",label:"on breach",options:["approve","replan"],req:false,ph:KEEP.l},
      ], "Save policy")
    + "<p class='dim' style='font-size:12px'>The ceiling is a tier cap, not a suggestion — an agent above it is denied even with a grant. A run budget is what makes the run Budget card and the budget-overage approval exist at all; leave a field on “leave unchanged” to keep the stored value.</p>"
    + "</div>"
    + "<h2>Per-user entitlement</h2><div class='card'>"
    + form("f-aview", [{name:"userId",label:"user",options:uOpts}], "View") + "<div id='aview'></div></div>";
  el.querySelectorAll("[data-agent]").forEach((b) => b.addEventListener("click", async () => {
    await post("/v1/agents/" + b.dataset.agent + "/enabled", { enabled: b.dataset.en === "true" }); render();
  }));
  wire("f-agrant", (d) => post("/v1/grants/agents", d));
  // empty textarea = an explicit clear (wire() drops empty values, so an
  // absent systemPrompt key means the operator emptied the box)
  wire("f-asys", (d) => post("/v1/agents/" + d.agentId + "/system-prompt",
    { systemPrompt: d.systemPrompt ?? null }));
  wire("f-apolicy", (d) => {
    const body = {};
    for (const k of ["defaultAgentId", "ceilingAgentId"]) if (k in d) body[k] = d[k] === "__clear__" ? null : d[k];
    if (d.routingMode) body.routingMode = d.routingMode;
    if (d.runBudgetBreachAction) body.runBudgetBreachAction = d.runBudgetBreachAction;
    if ("runBudgetUsd" in d) body.runBudgetUsd = Number(d.runBudgetUsd);
    return post("/v1/users/" + d.userId + "/agent-policy", body);
  });
  wire("f-aview", async (d) => {
    const v = await get("/v1/users/" + d.userId + "/agents");
    $("#aview").innerHTML = table(v.agents)
      + "<div class='kv' style='margin-top:12px'>"
      + "<span class='k'>default</span><span>" + esc(agentName[v.defaultAgentId] ?? "none") + "</span>"
      + "<span class='k'>ceiling</span><span>" + esc(agentName[v.ceilingAgentId] ?? "none") + "</span>"
      + "<span class='k'>routing</span><span>" + esc(v.routingMode ?? "automatic") + "</span>"
      + "<span class='k'>run budget</span><span class='num'>" + (v.runBudgetUsd == null ? "no cap" : fmtUsd(v.runBudgetUsd) + " · " + esc(v.runBudgetBreachAction)) + "</span>"
      + "</div>";
  }, true);
}],
["Model Credentials", async (el) => {
  // Write-only by construction: the API accepts a key, encrypts it with
  // REGULAIT_DATA_KEY, and has no route that returns it — so this panel can
  // only ever show WHICH provider is configured, never the secret itself.
  const [mc, a, u] = await Promise.all([get("/v1/model-credentials"), get("/v1/agents"), get("/v1/users")]);
  const configured = new Set(mc.credentials.map((c) => c.provider));
  const dead = a.agents.filter((x) => x.provider !== "mock" && !configured.has(x.provider));
  el.innerHTML = "<p class='sub'>One platform credential per provider, encrypted at rest. Re-adding a provider rotates its key in place; nothing here ever reads a stored secret back.</p>"
    + "<h2>Add or rotate a platform credential</h2><div class='card'>"
    + form("f-mcred", [
        {name:"provider",options:["anthropic","openai","google","xai"]},
        {name:"apiKey",label:"api key",type:"password",ph:"sk-…",grow:true},
        {name:"baseUrl",label:"base url",req:false,ph:"optional override"},
      ], "Save credential")
    + "<p class='dim' style='font-size:12px'>Sent once, stored AES-256-GCM encrypted, never returned by any endpoint — not to this page, not to anyone.</p></div>"
    + "<h2>Configured providers</h2><div class='card'>"
    + table(mc.credentials.map((c) => ({ provider: c.provider, baseUrl: c.baseUrl ?? "provider default", configuredAt: c.createdAt })),
        (r) => "<button class='small danger' data-mcred='" + esc(r.provider) + "'>remove</button>")
    + "</div>"
    + "<h2>Agents waiting on a credential</h2><div class='card'>"
    + (dead.length
        ? table(dead.map((x) => ({ agent: x.name, provider: x.provider, model: x.model, status: "no credential — dispatch returns 409" })))
        : "<div class='empty'>every non-mock agent has a credential</div>")
    + "</div>"
    + "<h2>Per-user BYO keys</h2><div class='card'>"
    + form("f-ucred", [{name:"userId",label:"user",options:userOpts(u.users)}], "View")
    + "<p class='dim' style='font-size:12px'>Users add their own keys from /app → Settings. A user's own key wins over the platform's for their dispatches.</p>"
    + "<div id='ucred'></div></div>";
  el.querySelectorAll("[data-mcred]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirmClick(b, "Remove?")) return;
    try { await del("/v1/model-credentials/" + encodeURIComponent(b.dataset.mcred)); toast("Credential removed", "ok"); render(); }
    catch (ex) { toast(ex.message, "err"); }
  }));
  wire("f-mcred", (d) => post("/v1/model-credentials", d));
  wire("f-ucred", async (d) => {
    const v = await get("/v1/users/" + d.userId + "/model-credentials");
    $("#ucred").innerHTML = (v.credentials.length
      ? table(v.credentials.map((c) => ({ provider: c.provider, baseUrl: c.baseUrl ?? "provider default", addedAt: c.createdAt })),
          (r) => "<button class='small danger' data-ucred='" + esc(r.provider) + "' data-uid='" + esc(d.userId) + "'>remove</button>")
      : "<div class='empty'>this user has no keys of their own — their dispatches use the platform credential</div>");
    $("#ucred").querySelectorAll("[data-ucred]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirmClick(b, "Remove?")) return;
      try {
        await del("/v1/users/" + b.dataset.uid + "/model-credentials/" + encodeURIComponent(b.dataset.ucred));
        toast("Key removed", "ok");
        $("#f-ucred").requestSubmit();
      } catch (ex) { toast(ex.message, "err"); }
    }));
  }, true);
}],
["Connectors", async (el) => {
  const [c, u] = await Promise.all([get("/v1/connectors"), get("/v1/users")]);
  const uOpts = userOpts(u.users);
  el.innerHTML = "<h2>Connector catalog</h2><div class='card'>" + form("f-conn", [{name:"name"},{name:"kind"}], "Create") + table(c.connectors) + "</div>"
    + "<h2>Grant — mode + data scope</h2><div class='card'>"
    + form("f-cgrant", [{name:"userId",label:"user",options:uOpts},{name:"connectorId",label:"connector",options:connectorOpts(c.connectors)},{name:"mode",options:["read","readwrite"]}], "Grant") + "</div>"
    + "<h2>Per-user entitlement</h2><div class='card'>"
    + form("f-cview", [{name:"userId",label:"user",options:uOpts}], "View") + "<div id='cview'></div></div>";
  wire("f-conn", (d) => post("/v1/connectors", d));
  wire("f-cgrant", (d) => post("/v1/grants/connectors", d));
  wire("f-cview", async (d) => {
    const v = await get("/v1/users/" + d.userId + "/connectors");
    $("#cview").innerHTML = table(v.connectors);
  }, true);
}],
["MCP Servers", async (el) => {
  const [s, u] = await Promise.all([get("/v1/servers"), get("/v1/users")]);
  const tools = await toolIndex(s.servers);
  const uOpts = userOpts(u.users), sOpts = serverOpts(s.servers);
  el.innerHTML = "<h2>Server registry</h2><div class='card'>" + form("f-srv", [{name:"name"},{name:"url"}], "Register")
    + table(s.servers, (r) => "<button class='small' data-srv='" + r.id + "'>tools</button>") + "<div id='srvtools'></div></div>"
    // Every policy rule hard-references a tool by name, so the inventory has
    // to be buildable here — not only as a side effect of proxy traffic.
    + "<h2>Tool inventory</h2><div class='card'>"
    + form("f-tool", [{name:"serverId",label:"server",options:sOpts},{name:"name",ph:"tool name"},{name:"kind",options:["read","write"]},{name:"description",req:false}], "Register tool")
    + "<p class='dim' style='font-size:12px'>Registered here, or auto-discovered on first proxy use. Pick a server above to list what it already has.</p></div>"
    + "<h2>Tool-level allow-list grants</h2><div class='card'>"
    + form("f-tgrant", [{name:"userId",label:"user",options:uOpts},{name:"serverId",label:"server",options:sOpts},{name:"toolName",label:"tool",options:[]}], "Grant tool")
    + form("f-sgrant", [{name:"userId",label:"user",options:uOpts},{name:"serverId",label:"server",options:sOpts},{name:"readOnlyAll",label:"read-only all",options:["true","false"]}], "Grant server") + "</div>";
  el.querySelectorAll("[data-srv]").forEach((b) => b.addEventListener("click", async () => {
    const t = await get("/v1/servers/" + b.dataset.srv + "/tools");
    $("#srvtools").innerHTML = "<h2>Tools on this server</h2>" + table(t.tools);
  }));
  linkTools("f-tgrant", tools);
  wire("f-srv", (d) => post("/v1/servers", d));
  wire("f-tool", (d) => post("/v1/servers/" + d.serverId + "/tools", { name: d.name, kind: d.kind, description: d.description }));
  wire("f-tgrant", (d) => post("/v1/grants/tools", d));
  wire("f-sgrant", (d) => post("/v1/grants/servers", { ...d, readOnlyAll: d.readOnlyAll === "true" }));
}],
["Rules Engine", async (el) => {
  // PILLAR 1 rule scoping: a rule can target one user, an assigned role, a
  // team, or the whole fleet — on one server or all of them. Fetch roles and
  // teams alongside users/servers so every scope has a named target select.
  const [ap, ds, rl, u, s, r, t] = await Promise.all([
    get("/v1/rules/approvals"), get("/v1/rules/data-scopes"), get("/v1/rules/rate-limits"),
    get("/v1/users"), get("/v1/servers"), get("/v1/roles"), get("/v1/teams"),
  ]);
  const tools = await toolIndex(s.servers);
  const uOpts = userOpts(u.users), sOpts = serverOpts(s.servers);
  const rOpts = roleOpts(r.roles), tOpts = (t.teams ?? []).map((x) => ({ v: x.id, l: x.name }));
  // The subject block: scope select, the three swappable target selects (only
  // the matching one stays live — linkScope handles it), then the server
  // dimension. toolName is optional and repopulated from the chosen server.
  const subject = [
    {name:"scope",label:"scope",options:[{v:"user",l:"user"},{v:"role",l:"role"},{v:"team",l:"team"},{v:"fleet",l:"fleet"}]},
    {name:"userId",label:"user",options:uOpts},
    {name:"roleId",label:"role",options:rOpts},
    {name:"teamId",label:"team",options:tOpts},
    {name:"serverScope",label:"servers",options:[{v:"server",l:"this server"},{v:"all",l:"all servers"}]},
    {name:"serverId",label:"server",options:sOpts},
    {name:"toolName",label:"tool",options:[],req:false},
  ];
  // Legible rule rows: every id becomes a name and the discriminant collapses
  // to one "target" + one "server" cell, like the Approvals Queue does.
  const uName = new Map(u.users.map((x) => [x.id, x.displayName || x.email]));
  const rName = new Map(r.roles.map((x) => [x.id, x.name]));
  const tName = new Map((t.teams ?? []).map((x) => [x.id, x.name]));
  const sName = new Map(s.servers.map((x) => [x.id, x.name]));
  const targetOf = (row) =>
    row.scope === "fleet" ? "fleet"
    : row.scope === "role" ? "role: " + (rName.get(row.roleId) ?? row.roleId)
    : row.scope === "team" ? "team: " + (tName.get(row.teamId) ?? row.teamId)
    : "user: " + (uName.get(row.userId) ?? row.userId);
  const serverOf = (row) => row.serverScope === "all" ? "all servers" : (sName.get(row.serverId) ?? row.serverId);
  const rulesView = (rows) => (rows ?? []).map((row) => {
    const o = { id: row.id, target: targetOf(row), server: serverOf(row), tool: row.toolName ?? "— any —" };
    if (row.writeOnly !== undefined) o.writeOnly = row.writeOnly;
    if (row.approverUserId) o.approver = uName.get(row.approverUserId) ?? row.approverUserId;
    if (row.argPath !== undefined) o.argPath = row.argPath;
    if (row.allowedValues !== undefined) o.allowedValues = row.allowedValues;
    if (row.maxCalls !== undefined) o.maxCalls = row.maxCalls;
    if (row.windowSeconds !== undefined) o.windowSeconds = row.windowSeconds;
    o.createdAt = row.createdAt;
    return o;
  });
  el.innerHTML = "<h2>Approval rules</h2><div class='card'>"
    + form("f-apr", subject.concat([{name:"approverUserId",label:"approver",options:uOpts}]), "Add") + table(rulesView(ap.rules)) + "</div>"
    + "<h2>Data-scope rules</h2><div class='card'>"
    + form("f-dsr", subject.concat([{name:"argPath",label:"arg path",ph:"e.g. database"},{name:"allowedValues",label:"allowed values",ph:"comma,separated"}]), "Add") + table(rulesView(ds.rules)) + "</div>"
    + "<h2>Rate limits</h2><div class='card'>"
    + form("f-rlr", subject.concat([{name:"maxCalls",label:"max calls",type:"number"},{name:"windowSeconds",label:"window seconds",type:"number"}]), "Add") + table(rulesView(rl.rules)) + "</div>";
  for (const id of ["f-apr", "f-dsr", "f-rlr"]) { linkTools(id, tools); linkScope(id); }
  wire("f-apr", (d) => post("/v1/rules/approvals", d));
  wire("f-dsr", (d) => post("/v1/rules/data-scopes", { ...d, allowedValues: String(d.allowedValues).split(",") }));
  wire("f-rlr", (d) => post("/v1/rules/rate-limits", { ...d, maxCalls: Number(d.maxCalls), windowSeconds: Number(d.windowSeconds) }));
}],
["Workflows", async (el) => {
  // Pillar 2's admin home: templates (with their stage chain), the assignment
  // rules that route changes to them, and the git connections their
  // git_operation stages execute against.
  const [t, r, g, cp] = await Promise.all([
    get("/v1/workflows/templates"),
    get("/v1/workflows/assignment-rules"),
    get("/v1/git/connections").catch(() => ({ connections: [] })),
    // ADR-0018 addendum: the 6th dim matches a compliance classification tag,
    // so the picker offers exactly the tags that exist — an admin can never
    // type a sensitivity no profile defines (and so no project can carry).
    get("/v1/compliance/profiles").catch(() => ({ profiles: [] })),
  ]);
  const sensOpts = (cp.profiles ?? []).map((p) => ({ v: p.tag, l: p.tag }));
  const tplName = Object.fromEntries(t.templates.map((x) => [x.id, x.name]));
  // ADR-0022: retired templates start no new instances — routing a NEW rule
  // at one would only mint refusals, so the rule form offers active ones.
  const tplOpts = t.templates.filter((x) => !x.retiredAt).map((x) => ({ v: x.id, l: x.name }));
  const rail = (def) => "<div class='stage-rail' style='margin-top:6px'>"
    + (def.stages ?? []).map((s) => "<span class='stage'>" + esc(s.id)
      + "<span class='faint' style='font-size:10px'>" + esc(s.type) + "</span></span>").join("")
    + "</div>";
  const conds = (x) => [
    x.pathPattern ? "path " + x.pathPattern : null,
    x.changeType ? "type " + x.changeType : null,
    x.environment ? "env " + x.environment : null,
    x.targetSystem ? "target " + x.targetSystem : null,
    x.initiatorRole ? "role " + x.initiatorRole : null,
    x.dataSensitivity ? "sensitivity " + x.dataSensitivity : null,
  ].filter(Boolean).join(" + ");
  const tplRows = t.templates.map((tpl) => {
    const assigned = r.rules.filter((x) => x.templateId === tpl.id);
    return "<div class='node-row' style='align-items:flex-start'><div class='grow'>"
      + "<div><strong" + (tpl.retiredAt ? " class='faint'" : "") + ">" + esc(tpl.name) + "</strong>"
      + (tpl.retiredAt ? " <span class='badge bad' title='retired " + esc(String(tpl.retiredAt).slice(0, 10)) + (tpl.retiredReason ? " — " + esc(tpl.retiredReason) : "") + "'>retired</span>" : "")
      + (tpl.definition.costSensitivity ? " <span class='badge'>" + esc(tpl.definition.costSensitivity) + "</span>" : "") + "</div>"
      + rail(tpl.definition)
      + "<div class='dim' style='font-size:12px;margin-top:6px'>"
      + (tpl.retiredAt
          ? "retired — starts no new instances; in-flight instances keep their snapshotted definition" + (tpl.retiredReason ? ". Why: " + esc(tpl.retiredReason) : "")
          : (assigned.length ? "routed when: " + esc(assigned.map(conds).join("  |  ")) : "no assignment rule routes here — reachable only via compliance cascade or an admin's explicit pick"))
      + "</div>"
      + "<div data-retirebox='" + tpl.id + "'></div>"
      + "</div>"
      + (tpl.retiredAt ? "" : "<button class='small' data-retire='" + tpl.id + "' title='soft-disable: no new instances; in-flight unaffected'>retire</button>")
      + "</div>";
  }).join("") || "<div class='empty'>no templates yet — author one below</div>";

  // Starter definitions match the exact shape the template zod schema
  // accepts. Approvals default to "requesting_user" so a starter POSTs as-is;
  // git stages reference the first registered connection.
  const connName = (g.connections[0] || {}).name ?? "demo-git";
  const planStages = [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
    { id: "requirements", type: "artifact_generation", output: "requirements_file" },
    { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
  ];
  const buildStages = planStages.concat([
    { id: "build", type: "automated_build", scope: "requirements_file" },
    { id: "checks", type: "automated_check", checks: ["unit_tests", "lint"] },
  ]);
  const STARTERS = [
    { id: "plan", label: "Plan & sign-off (4 stages)", def: { workflow: "plan-signoff", stages: planStages } },
    { id: "build", label: "Plan, build & check (6 stages)", def: { workflow: "build-check", stages: buildStages } },
    { id: "pipeline", label: "Complete pipeline to merge (10 stages)", def: {
      workflow: "complete-pipeline",
      stages: buildStages.slice(0, 5).concat([
        { id: "checks", type: "automated_check", checks: ["unit_tests", "lint", "security_scan"] },
        { id: "branch", type: "git_operation", action: "create_branch", connection: connName, repo: "acme/app" },
        { id: "open_pr", type: "git_operation", action: "open_pr", connection: connName, repo: "acme/app" },
        { id: "merge_gate", type: "human_approval", approvers: ["requesting_user"] },
        { id: "merge", type: "git_operation", action: "merge", connection: connName, repo: "acme/app", strategy: "squash" },
      ]),
    } },
  ];
  el.innerHTML = "<h2>Templates — stage chains + how changes route to them</h2><div class='card'>" + tplRows + "</div>"
    + "<h2>Author a template</h2><div class='card'>"
    + "<div class='row'>"
    + "<div><label class='f'>name</label><input id='wft-name' placeholder='e.g. api-change'></div>"
    + "<div><label class='f'>start from</label><select id='wft-starter'>"
    + STARTERS.map((s) => "<option value='" + s.id + "'>" + esc(s.label) + "</option>").join("")
    + "</select></div></div>"
    + "<textarea id='wft-json' rows='16' style='width:100%;margin-top:10px' spellcheck='false'></textarea>"
    + "<p class='dim' style='font-size:12px;margin:8px 0 0'>A definition is { workflow, costSensitivity?, stages[] }; the first stage must be a trigger. Stage types: trigger · planning · artifact_generation {output} · human_approval {approvers: user-ids or the literal requesting_user} · automated_build {scope?, run?} (a run graph executes as a governed nested run) · automated_check {checks[]} (named checks run automatically and record pass results) · git_operation {action: create_branch | open_pr | merge, connection, repo, base?, branchPrefix?, strategy?}. open_pr needs an earlier create_branch, merge an earlier open_pr. Validation errors from the server appear below, field by field.</p>"
    + "<div class='row' style='margin-top:10px'><button class='small primary' id='wft-create'>Create template</button><span class='err-line' id='wft-err'></span></div></div>"
    + "<h2>Assignment rules — which template governs which change</h2><div class='card'>"
    + form("f-wfrule", [
        {name:"templateId",label:"template",options:tplOpts},
        {name:"pathPattern",label:"path pattern",req:false,ph:"e.g. src/** (optional)"},
        {name:"changeType",label:"change type",req:false,ph:"e.g. feature (optional)"},
        {name:"environment",label:"environment",req:false,ph:"e.g. production (optional)"},
        {name:"targetSystem",label:"target system",req:false,ph:"e.g. checkout-svc (optional)"},
        {name:"initiatorRole",label:"initiator role",req:false,ph:"e.g. release-manager (optional)"},
        {name:"dataSensitivity",label:"data sensitivity",options:sensOpts,req:false,ph:"— any sensitivity —"},
      ], "Add rule")
    + table(r.rules.map((x) => ({
        id: x.id, template: tplName[x.templateId] ?? x.templateId,
        matches: conds(x), created: x.createdAt,
      })), (row) => "<button class='small danger' data-rdel='" + row.id + "'>delete</button>")
    + "<p class='dim' style='font-size:12px'>Conditions AND together; set at least one. All six dims are now wired: path, change type, environment, target system, initiator role (matched against the initiator's SERVER-derived roles), and data sensitivity (matched against the compliance classifications of the change's attributed project). The last two are server-resolved — never a client-supplied value — so a rule can only fire for a genuine role holder or a genuinely classified project; a change with no project matches as having no sensitivity. Every rule that matches a change contributes its template — the merged flow keeps every sign-off. Deleting a rule stops the routing; in-flight instances keep their snapshotted definition.</p></div>"
    + "<h2>Git connections — what git_operation stages execute against</h2><div class='card'>"
    + form("f-git", [
        {name:"name",ph:"e.g. demo-git"},
        {name:"provider",options:["mock","github","gitlab","bitbucket","azure_devops"]},
        {name:"baseUrl",label:"base url",req:false,ph:"optional (e.g. GHE)"},
        {name:"token",type:"password",ph:"never shown again",grow:true},
      ], "Add connection")
    + dataTable(g.connections.map((c) => ({
        name: c.name, provider: c.provider, baseUrl: c.baseUrl ?? "provider default", created: c.createdAt,
      })), { cells: { provider: (v) => badge(v, v === "mock" ? "" : "info") } })
    + "<p class='dim' style='font-size:12px'>Tokens are AES-256-GCM encrypted at rest and never returned by any endpoint. Templates reference a connection by name. Every listed kind has a real adapter — a kind without one is refused at creation (400), never discovered mid-workflow. The demo runs entirely on the mock provider — no external service is touched.</p></div>";

  const fillStarter = () => {
    const s = STARTERS.find((x) => x.id === $("#wft-starter").value) ?? STARTERS[0];
    $("#wft-json").value = JSON.stringify(s.def, null, 2);
  };
  fillStarter();
  $("#wft-starter").addEventListener("change", fillStarter);
  $("#wft-create").addEventListener("click", async () => {
    const err = $("#wft-err"); err.textContent = "";
    const name = $("#wft-name").value.trim();
    if (!name) { err.textContent = "name: a template name is required"; return; }
    let definition;
    try { definition = JSON.parse($("#wft-json").value); }
    catch (ex) { err.textContent = "definition JSON does not parse — " + ex.message; return; }
    try { await post("/v1/workflows/templates", { name, definition }); render(); }
    catch (ex) { err.textContent = ex.message; }
  });
  el.querySelectorAll("[data-rdel]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirmClick(b, "Delete rule?")) return;
    try { await del("/v1/workflows/assignment-rules/" + b.dataset.rdel); toast("Rule deleted — routing stops; in-flight instances keep their snapshotted definition", "ok"); render(); }
    catch (ex) { toast(ex.message, "err"); }
  }));
  // ADR-0022 retire: the button opens an inline reason box (the why is the
  // record — required); confirm posts the retire and re-renders.
  el.querySelectorAll("[data-retire]").forEach((b) => b.addEventListener("click", () => {
    const box = el.querySelector("[data-retirebox='" + b.dataset.retire + "']");
    if (!box || box.childElementCount) return;
    box.innerHTML = "<div class='row' style='margin-top:8px'>"
      + "<input class='grow' data-retirereason='" + b.dataset.retire + "' placeholder='why is this template retiring? (required, recorded)'>"
      + "<button class='small danger' data-retirego='" + b.dataset.retire + "'>Retire</button>"
      + "<button class='ghost small' data-retirecancel='" + b.dataset.retire + "'>Cancel</button></div>";
    box.querySelector("[data-retirecancel]").addEventListener("click", () => { box.innerHTML = ""; });
    box.querySelector("[data-retirego]").addEventListener("click", async () => {
      const reason = (box.querySelector("[data-retirereason]")?.value ?? "").trim();
      if (!reason) { toast("A reason is required — it is the retirement record.", "err"); return; }
      try {
        await post("/v1/workflows/templates/" + b.dataset.retire + "/retire", { reason });
        toast("Template retired — no new instances; in-flight ones are unaffected", "ok"); render();
      } catch (ex) { toast(ex.message, "err"); }
    });
  }));
  wire("f-wfrule", (d) => post("/v1/workflows/assignment-rules", d));
  wire("f-git", (d) => post("/v1/git/connections", d));
}],
["Deploy Targets", async (el) => {
  // Pillar 2/3's deploy destinations: the governed targets a deployment /
  // rollback stage acts on. mock runs everywhere with no credential; aws/azure/
  // gcp/kubernetes are the BYOC dry-run shapes (A2). A credential, when given,
  // is AES-256-GCM encrypted at rest and never returned. Admin-only.
  const d = await get("/v1/deploy/targets").catch(() => ({ targets: [] }));
  el.innerHTML = "<h2>Deploy targets — where a deployment/rollback stage acts</h2><div class='card'>"
    + form("f-deploy", [
        {name:"name",ph:"e.g. prod-us"},
        {name:"provider",options:["mock","aws","azure","gcp","kubernetes"]},
        {name:"mode",options:["hosted","byoc","air_gapped"]},
        {name:"environment",label:"environment",req:false,ph:"e.g. production (optional)"},
        {name:"baseUrl",label:"base url",req:false,ph:"optional"},
        {name:"roleArn",label:"role arn (aws)",req:false,ph:"arn:aws:iam::<acct>:role/<name>"},
        {name:"region",label:"region",req:false,ph:"e.g. us-east-1 / eastus / us-central1"},
        {name:"credential",label:"credential",type:"password",req:false,ph:"kubeconfig etc. — never shown again"},
        // migration 0043 per-kind config — fill only the fields of the chosen
        // provider; the API rejects a field on the wrong kind loudly
        {name:"cluster",label:"ecs cluster (aws)",req:false,ph:"optional"},
        {name:"subscriptionId",label:"subscription (azure)",req:false,ph:"azure subscription id"},
        {name:"resourceGroup",label:"resource group (azure)",req:false,ph:"optional"},
        {name:"templateUri",label:"template uri (azure)",req:false,ph:"https://… (optional)"},
        {name:"projectId",label:"project (gcp)",req:false,ph:"gcp project id"},
        {name:"blueprintGcs",label:"blueprint (gcp)",req:false,ph:"gs://… (optional)"},
        {name:"namespace",label:"namespace (k8s)",req:false,ph:"optional"},
      ], "Add target")
    + dataTable(d.targets, {
        actions: (row) => "<button class='small danger' data-tdel='" + esc(row.name) + "'>delete</button>",
      })
    + "<p class='dim' style='font-size:12px'>Credentials are AES-256-GCM encrypted at rest and never returned. Per-kind config (migration 0043): aws needs a role arn (arn:aws:iam::&lt;acct&gt;:role/&lt;name&gt;) + region and may name the ecs cluster; azure needs a subscription + region and may name the resource group / template uri; gcp needs a project + region and may name the gs:// blueprint; kubernetes needs a kubeconfig credential and may name the namespace. Fields set here are row-first — they beat the matching gateway env vars. aws/azure/gcp/kubernetes run as deterministic dry-run shapes (no live cloud mutation) — a dry-run deploy is recorded and badged as such, and it can never satisfy a production deploy gate (#79c).</p></div>";
  el.querySelectorAll("[data-tdel]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirmClick(b, "Delete target?")) return;
    try { await del("/v1/deploy/targets/" + encodeURIComponent(b.dataset.tdel)); toast("Target deleted", "ok"); render(); }
    catch (ex) { toast(ex.message, "err"); }
  }));
  wire("f-deploy", (dd) => post("/v1/deploy/targets", dd));
}],
["PM Connections", async (el) => {
  // Pillar 8's admin home: the customer's PM tool stays the source of truth
  // for priority/description; RegulAIt links work items, mirrors status and
  // sign-offs out, and records inbound webhook state as drift — never a
  // shadow copy.
  const c = await get("/v1/pm/connections");
  el.innerHTML = "<p class='sub'>Task graphs and workflow stages map onto the customer's own work items (pillar 8). Users link a run from its detail page; status, sign-offs and decisions mirror out; inbound webhooks record drift, never overwrite the state machine.</p>"
    + "<h2>Connections</h2><div class='card'>"
    + table(c.connections.map((x) => ({
        name: x.name, provider: x.provider, project: x.project,
        baseUrl: x.baseUrl ?? "provider default",
        api: x.apiVersion ? "v" + x.apiVersion : "provider default",
        webhookUrl: "/v1/pm/webhooks/" + x.name,
        created: x.createdAt,
      })))
    + "<p class='dim' style='font-size:12px'>Tokens are AES-256-GCM encrypted at rest and never returned by any endpoint. The webhook secret is shown exactly once at creation (stored hashed plus AES-256-GCM encrypted, never plaintext) and verifies inbound traffic with each provider's NATIVE mechanism: HMAC signatures for linear (<span class='mono'>linear-signature</span>), asana (<span class='mono'>x-hook-signature</span>, after the x-hook-secret handshake) and generic_webhook (<span class='mono'>x-regulait-signature</span>); a <span class='mono'>?token=</span> URL parameter for jira and monday (which cannot sign); basic-auth password for azure_devops; mock and generic_webhook also accept the legacy <span class='mono'>x-regulait-webhook-secret</span> header.</p></div>"
    + "<h2>Add a connection</h2><div class='card'>"
    + form("f-pmconn", [
        {name:"name",ph:"e.g. demo-pm"},
        {name:"provider",options:["mock","jira","azure_devops","linear","asana","monday","generic_webhook"]},
        {name:"project",ph:"e.g. REGULAIT-DEMO"},
        {name:"baseUrl",label:"base url",req:false,ph:"required for jira / azure_devops / generic_webhook"},
        {name:"apiVersion",label:"api version (jira)",req:false,ph:"v2 (default)",
         options:[{v:"3",l:"v3 + ADF rich text"},{v:"2",l:"v2 (legacy plain text)"}]},
        {name:"token",type:"password",ph:"never shown again",grow:true},
      ], "Add connection")
    + "<p class='dim' style='font-size:12px'>Every provider kind is implemented — generic_webhook speaks RegulAIt's signed normalized event contract (HMAC-SHA256 of the body in <span class='mono'>x-regulait-signature</span>, under the connection token) to any HTTP receiver at its base URL. jira, azure_devops and generic_webhook need their base URL (e.g. https://&lt;site&gt;.atlassian.net, https://dev.azure.com/&lt;org&gt;, your receiver endpoint). The api version select applies to jira only: v2 (default) sends plain-text descriptions/comments; v3 sends them as ADF rich-text documents (paragraphs, headings, lists, code blocks) — Atlassian's GA direction. The demo runs entirely on the mock provider — no external service is touched.</p></div>"
    + "<div id='pmreveal'></div>";
  wire("f-pmconn", async (d) => {
    const created = await post("/v1/pm/connections", d);
    // same one-time-secret pattern as API keys: the webhook secret exists in
    // exactly one response, so the reveal must survive this render.
    revealSecret("#pmreveal", "Webhook secret for " + created.name, created.webhookSecret,
      "External systems present it as x-regulait-webhook-secret when POSTing to " + location.origin + "/v1/pm/webhooks/" + created.name + ". Revisit this tab to see the new connection listed.");
    $("#pmreveal").scrollIntoView({ block: "nearest" });
  }, true);
}],
["Audit Log", async (el) => {
  const [u, ret] = await Promise.all([get("/v1/users"), get("/v1/audit/retention")]);
  // the users list is already here for the filter — reuse it so the table
  // says who acted by name (an unknown id still renders as a truncated chip)
  const uname = Object.fromEntries(u.users.map((x) => [x.id, x.displayName || x.email]));
  // §8.4 retention floor + prune. The floor is a single GLOBAL value (longest
  // auditRetentionDays across all compliance profiles) because audit rows are
  // not per-project — a shorter-retention framework can never shorten another
  // framework's trail. Show it before pruning; the button confirms first.
  const retLine = ret.retainedDays == null
    ? "No compliance profile sets a retention — nothing is eligible for pruning (all rows kept)."
    : "Global floor <b>" + ret.retainedDays + " days</b> (from " + esc((ret.floorSource || []).join(", ") || "—")
      + ") · <b>" + ret.prunable + "</b> row(s) older than the floor";
  el.innerHTML = "<div class='card'>"
    + "<h2 style='margin:0 0 4px'>Audit-log retention (§8.4)</h2>"
    + "<p class='sub'>Retention is a single global floor: the longest auditRetentionDays across every compliance profile (longest-floor-wins). Pruning deletes audit rows older than that floor; the prune itself is audited.</p>"
    + "<p>" + retLine + "</p>"
    + (ret.retainedDays != null
        ? "<button class='danger' id='audit-prune'" + (ret.prunable ? "" : " disabled") + ">Prune audit log</button>"
        : "")
    + "</div>"
    + "<div class='card'>"
    + "<div class='row'>" + form("f-audit", [{name:"userId",label:"filter by user",options:userOpts(u.users),req:false,ph:"— all users —"}], "Load")
    + "<span class='grow'></span><button class='small' id='audit-csv' title='download the FULL filtered trail (the table shows the latest 100 rows)'>Download CSV</button></div>"
    + "<div id='auditout'></div></div>";
  // ADR-0022: CSV export of the CURRENT filtered view — full trail, streamed
  // with the same authed-blob pattern as the costs CSV.
  $("#audit-csv")?.addEventListener("click", () => {
    const userId = $("#f-audit")?.querySelector("[name=userId]")?.value ?? "";
    downloadCsv("/v1/audit.csv" + (userId ? "?userId=" + userId : ""), "audit-log.csv");
  });
  const prune = $("#audit-prune");
  if (prune) prune.addEventListener("click", async () => {
    if (!confirmClick(prune, "Delete " + ret.prunable + " row(s)?")) return;
    try {
      const r = await post("/v1/audit/prune", {});
      toast("Pruned " + r.deleted + " audit row(s) — floor " + r.retainedDays + "d from " + (r.floorSource || []).join(", ") + ".", "ok");
      render();
    } catch (ex) { toast(ex.message, "err"); }
  });
  const load = async (userId) => {
    const a = await get("/v1/audit" + (userId ? "?userId=" + userId : ""));
    $("#auditout").innerHTML = dataTable(a.entries.map((e) => ({
      at: e.at, user: uname[e.userId] ?? e.userId, object: e.objectType, effect: e.effect, rule: e.ruleId, reason: e.reason,
    })));
  };
  wire("f-audit", (d) => load(d.userId), true);
  await load("");
}],
["Approvals Queue", async (el) => {
  // /v1/me names the signed-in admin: on rows naming someone else the decide
  // is an OVERRIDE — the endpoint requires a reason and audit-marks it.
  const [a, me, u, dg] = await Promise.all([
    get("/v1/approvals"),
    get("/v1/me").catch(() => ({ userId: null })),
    get("/v1/users").catch(() => ({ users: [] })),
    get("/v1/delegations").catch(() => ({ delegations: [] })),
  ]);
  const uOpts = userOpts(u.users);
  el.innerHTML = "<p class='sub'>The one inbox: MCP pauses, workflow sign-offs, run escalations, budget overages, context conflicts, reclassifications. The named approver decides; an active delegation lets the delegate decide on-behalf-of (both audited); an admin may decide in anyone's place only with a recorded reason (audit-marked as an override).</p><div class='card'>"
    + dataTable(a.approvals.map((r) => ({
        id: r.id, type: r.objectType,
        // internal sentinel stages read as their human labels (shared with
        // /app's inbox) — '__context_conflict__:<uuid>' never reaches a cell
        stage: approvalStageLabel(r) ?? r.stageId,
        governs: r.objectLabel,
        requestedBy: r.requestedByName, approver: r.approverName ?? r.approverUserId,
        status: r.status,
        // only rows that HAVE a decision reason contribute the column — an
        // all-pending queue doesn't pay 70px for an empty header
        ...(r.decisionReason ? { reason: r.decisionReason } : {}),
        requestedAt: r.requestedAt,
      })),
      { actions: (r) => {
        const row = a.approvals.find((x) => x.id === r.id);
        if (row.status !== "pending") return "";
        const override = me.userId !== row.approverUserId;
        return "<input data-reason='" + row.id + "' placeholder='" + (override ? "reason (override)" : "reason (optional)") + "' title='" + (override ? "required — you are not the named approver" : "optional") + "' style='font-size:12px;width:140px'> "
          + "<button class='small primary' data-dec='approved' data-id='" + row.id + "'>approve</button> "
          + "<button class='small danger' data-dec='denied' data-id='" + row.id + "'>deny</button>"
          + (override ? " <span class='badge warn'>override</span>" : "");
      } }) + "</div>"
    // ADR-0022: approver delegation windows (admin-managed). While active,
    // the delegate sees the delegator's pending approvals in their own inbox
    // and may decide them — recorded as the real decider on-behalf-of.
    + "<h2>Approver delegations — vacation / offboarding coverage</h2><div class='card'>"
    + form("f-delegation", [
        {name:"fromUserId",label:"delegator (from)",options:uOpts},
        {name:"toUserId",label:"delegate (to)",options:uOpts},
        {name:"startsAt",label:"starts",type:"datetime-local"},
        {name:"endsAt",label:"ends",type:"datetime-local"},
        {name:"reason",req:false,ph:"why (recorded)"},
      ], "Create delegation")
    + table((dg.delegations ?? []).map((x) => ({
        id: x.id, from: x.fromName ?? x.fromUserId, to: x.toName ?? x.toUserId,
        window: String(x.startsAt).slice(0, 16).replace("T", " ") + " \\u2192 " + String(x.endsAt).slice(0, 16).replace("T", " "),
        status: x.active ? "active" : (new Date(x.endsAt).getTime() < Date.now() ? "expired" : "scheduled"),
        reason: x.reason ?? "\\u2014",
      })), (row) => "<button class='small danger' data-dgend='" + row.id + "'>end now</button>")
    + "<p class='dim' style='font-size:12px'>While a window is active, the delegate's inbox additionally shows the delegator's PENDING approvals and the delegate may decide them; the decision records the real decider plus an on-behalf-of audit row. Ending a delegation takes effect immediately. The org-wide master switch lives in Policy \\u2192 Organization.</p></div>";
  el.querySelectorAll("[data-dgend]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirmClick(b, "End now?")) return;
    try { await del("/v1/delegations/" + b.dataset.dgend); toast("Delegation ended", "ok"); render(); }
    catch (ex) { toast(ex.message, "err"); }
  }));
  wire("f-delegation", (d) => post("/v1/delegations", {
    fromUserId: d.fromUserId, toUserId: d.toUserId,
    startsAt: new Date(d.startsAt).toISOString(), endsAt: new Date(d.endsAt).toISOString(),
    ...(d.reason ? { reason: d.reason } : {}),
  }));
  // delegate on el so decide buttons survive a dataTable sort/filter/page
  // re-render (note: an unsaved reason typed into a row resets on re-render).
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-dec]");
    if (!b) return;
    const reason = (el.querySelector("[data-reason='" + b.dataset.id + "']")?.value ?? "").trim();
    try { await post("/v1/approvals/" + b.dataset.id + "/decide", { decision: b.dataset.dec, ...(reason ? { reason } : {}) }); toast("Decision recorded", "ok"); render(); }
    catch (ex) { toast(ex.message, "err"); }
  });
}],
["Simulation / Access preview", async (el) => {
  const [u, s] = await Promise.all([get("/v1/users"), get("/v1/servers")]);
  const tools = await toolIndex(s.servers);
  el.innerHTML = "<p class='sub'>Would this call be allowed right now? Evaluates live policy without executing anything.</p><div class='card'>"
    + form("f-sim", [{name:"userId",label:"user",options:userOpts(u.users)},{name:"serverId",label:"server",options:serverOpts(s.servers)},{name:"toolName",label:"tool",options:[]}], "Evaluate")
    + "<div id='simout'><div class='empty'>Run an evaluation to see the decision.</div></div></div>";
  linkTools("f-sim", tools);
  wire("f-sim", async (d) => {
    $("#simout").innerHTML = renderDecision(await post("/v1/evaluate", d));
  }, true);
}],
["Cost & Projects", async (el) => {
  const [p, u, cp, ini, unattr] = await Promise.all([
    get("/v1/projects"), get("/v1/users"), get("/v1/compliance/profiles"), get("/v1/initiatives"),
    get("/v1/costs/unattributed").catch(() => null),
  ]);
  const uOpts = userOpts(u.users);
  const uname = Object.fromEntries(u.users.map((x) => [x.id, x.displayName || x.email]));
  // pillar-5 rollup: id -> name so the fleet table can name each project's parent
  const iname = Object.fromEntries((ini.initiatives ?? []).map((x) => [x.id, x.name]));
  const tagOpts = cp.profiles.map((x) => x.tag);
  const pOpts = p.projects.map((x) => ({ v: x.id, l: x.name }));
  const iniOpts = (ini.initiatives ?? []).map((x) => ({ v: x.id, l: x.name }));
  const KEEP = { v: "", l: "— leave unchanged —" }, CLEAR = { v: "__clear__", l: "— clear —" };
  el.innerHTML = "<h2>Create a project</h2><div class='card'>"
    + form("f-proj", [
        {name:"name"},
        {name:"costCenter",label:"cost center",req:false,ph:"e.g. CC-0042"},
        {name:"budgetUsd",label:"budget usd",type:"number",req:false,ph:"e.g. 25"},
        {name:"budgetApproverUserId",label:"budget approver",options:uOpts,req:false,ph:"— none —"},
        {name:"budgetPeriod",label:"budget period",options:[{v:"none",l:"none (lifetime)"},{v:"monthly",l:"monthly (calendar month)"}],req:false,ph:"none (lifetime)"},
        {name:"alertThresholdPct",label:"alert threshold %",type:"number",req:false,ph:"e.g. 80 (default 100)"},
        {name:"arbiterUserId",label:"context arbiter",options:uOpts,req:false,ph:"— none —"},
        {name:"classifications",label:"classifications",options:tagOpts,req:false,multi:true},
      ], "Create project")
    + "<p class='dim' style='font-size:12px'>A budget only exists together with its named budget approver — set both or neither; the API refuses one without the other. Classifications (ctrl/cmd-click for several) come from the compliance profiles and cascade that framework's required workflows, PII mode and retention onto everything the project governs — changing them later goes through the reclassification review, never a plain edit.</p></div>"
    + "<h2>Projects — fleet spend</h2><div class='card'>"
    + dataTable(p.projects.map((r) => ({ name: r.name, costCenter: r.costCenter, initiative: iname[r.initiativeId] ?? "—", spent: fmtUsd(r.spentUsd), budget: fmtUsd(r.budgetUsd), period: r.budgetPeriod ?? "none", "alert %": r.alertThresholdPct ?? 100, classifications: (r.classifications ?? []).join(", ") })),
      { actions: (r) => {
        const id = p.projects.find((x) => x.name === r.name).id;
        return "<button class='small' data-proj='" + id + "'>rollup</button> <button class='small' data-pedit='" + id + "'>edit</button>";
      } })
    + "</div><div id='projout'></div>"
    // ADR-0024 (O11): the EXPLICIT Unattributed bucket — visible and labeled,
    // never hidden inside any project's totals. An admin has to SEE the
    // attribution leak to close it (the require-attribution toggles in
    // Client Access close it entirely).
    + "<h2>Unattributed spend — calls with no project header</h2><div class='card'>"
    + (unattr && unattr.measured
        ? "<div class='grid2'>"
          + "<div class='card stat'><div class='v'>" + fmtUsd(unattr.measured.costUsd) + "</div><div class='l'>unattributed spend · " + (unattr.measured.events ?? 0) + " calls</div></div>"
          + "<div class='card stat'><div class='v'>" + (unattr.measured.inputTokens ?? 0) + " → " + (unattr.measured.outputTokens ?? 0) + "</div><div class='l'>tokens in → out</div></div>"
          + "</div>"
          + ((unattr.byUser ?? []).length
              ? "<h3>By user</h3>" + barChart(unattr.byUser, "costUsd", (i) => uname[i.userId] ?? i.userId)
              : "")
          + ((unattr.byMcpTool ?? []).length
              ? "<h3>By MCP tool</h3>" + barChart(unattr.byMcpTool, "costUsd", (i) => i.toolName ?? "tool")
              : "")
          + ((unattr.measured.events ?? 0) === 0
              ? "<div class='empty'>Nothing unattributed — every metered call carried a project.</div>"
              : "<p class='dim' style='font-size:12px'>These calls arrived without an x-regulait-project-id header. They are metered on the same ledger but can never count against any project budget. Close the gap in Client Access: 'require project attribution' (compat surfaces) and 'require MCP attribution' (MCP proxy).</p>")
        : "<div class='empty'>Unattributed rollup unavailable.</div>")
    + "</div>"
    + "<h2>Initiatives — cross-team rollup</h2><div class='card'>"
    + form("f-ini", [
        {name:"name",ph:"e.g. Platform Modernization"},
        {name:"costCenter",label:"cost center",req:false,ph:"e.g. CC-PLAT"},
      ], "Create initiative")
    + table((ini.initiatives ?? []).map((r) => ({ name: r.name, "cost center": r.costCenter ?? "—", projects: r.projectCount ?? 0, "rolled-up spend": fmtUsd(r.spentUsd) })))
    + "<p class='dim' style='font-size:12px'>An initiative is a flat, reporting-only grouping of projects for cross-team cost attribution — no initiative-level budget or enforcement; each project keeps its own budget and governance. Group a project under one on the edit form below.</p></div>"
    + "<h2>Edit a project — budget, approver, arbiter, cost center, name</h2><div class='card'>" // NB: Teams moved to the Identity & Access section
    + form("f-pedit", [
        {name:"projectId",label:"project",options:pOpts},
        {name:"name",label:"new name",req:false,ph:"leave unchanged"},
        {name:"costCenter",label:"cost center",req:false,ph:"leave unchanged"},
        {name:"budgetUsd",label:"budget usd",type:"number",req:false,ph:"leave unchanged"},
        {name:"budgetApproverUserId",label:"budget approver",options:[CLEAR].concat(uOpts),req:false,ph:KEEP.l},
        {name:"budgetPeriod",label:"budget period",options:[{v:"none",l:"none (lifetime)"},{v:"monthly",l:"monthly (calendar month)"}],req:false,ph:KEEP.l},
        {name:"alertThresholdPct",label:"alert threshold %",type:"number",req:false,ph:"leave unchanged"},
        {name:"arbiterUserId",label:"arbiter",options:[CLEAR].concat(uOpts),req:false,ph:KEEP.l},
        {name:"initiativeId",label:"initiative",options:[CLEAR].concat(iniOpts),req:false,ph:KEEP.l},
      ], "Save changes")
    + "<p class='dim' style='font-size:12px'>Only the fields you fill in change. A budget still requires a named approver after the edit — the API holds the invariant against the merged result. Classifications are absent on purpose: reclassification is a governed diff-then-approve change with its own flow.</p></div>";
  // delegate on el so the fleet dataTable can re-render (sort/filter/page)
  // without dropping the row-action handlers.
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pedit]");
    if (!b) return;
    const f = $("#f-pedit");
    f.querySelector("[name=projectId]").value = b.dataset.pedit;
    f.scrollIntoView({ block: "center" });
  });
  wire("f-proj", (d) => {
    // the schema's budget-requires-approver rule, surfaced before the POST
    if (d.budgetUsd && !d.budgetApproverUserId) {
      throw new Error("a project budget requires a named budget approver — pick one or clear the budget");
    }
    return post("/v1/projects", {
      name: d.name,
      ...(d.costCenter ? { costCenter: d.costCenter } : {}),
      ...(d.budgetUsd ? { budgetUsd: Number(d.budgetUsd) } : {}),
      ...(d.budgetApproverUserId ? { budgetApproverUserId: d.budgetApproverUserId } : {}),
      ...(d.budgetPeriod ? { budgetPeriod: d.budgetPeriod } : {}),
      ...(d.alertThresholdPct ? { alertThresholdPct: Number(d.alertThresholdPct) } : {}),
      ...(d.arbiterUserId ? { arbiterUserId: d.arbiterUserId } : {}),
      ...(d.classifications ? { classifications: [].concat(d.classifications) } : {}),
    });
  });
  wire("f-pedit", (d) => {
    const body = {};
    if (d.name) body.name = d.name;
    if (d.costCenter) body.costCenter = d.costCenter;
    if ("budgetUsd" in d) body.budgetUsd = Number(d.budgetUsd);
    if (d.budgetPeriod) body.budgetPeriod = d.budgetPeriod;
    if (d.alertThresholdPct) body.alertThresholdPct = Number(d.alertThresholdPct);
    for (const k of ["budgetApproverUserId", "arbiterUserId", "initiativeId"]) if (k in d) body[k] = d[k] === "__clear__" ? null : d[k];
    return patch("/v1/projects/" + d.projectId, body);
  });
  wire("f-ini", (d) => post("/v1/initiatives", {
    name: d.name,
    ...(d.costCenter ? { costCenter: d.costCenter } : {}),
  }));
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-proj]");
    if (!b) return;
    const [costs, compliance] = await Promise.all([
      get("/v1/projects/" + b.dataset.proj + "/costs"),
      get("/v1/projects/" + b.dataset.proj + "/compliance"),
    ]);
    const m = costs.measured ?? {};
    $("#projout").innerHTML =
      "<h2>" + esc(costs.project.name) + (costs.initiative ? " <span class='dim' style='font-size:14px'>· " + esc(costs.initiative.name) + "</span>" : "") + "</h2>"
      + "<div class='grid2'>"
      + "<div class='card stat'><div class='v'>" + fmtUsd(m.costUsd) + "</div><div class='l'>measured spend · " + (m.events ?? 0) + " calls</div></div>"
      + "<div class='card stat'><div class='v'>" + fmtUsd(costs.forecast?.projectedEomUsd) + "</div><div class='l'>projected month-end · " + esc(costs.forecast?.basis ?? "") + "</div></div>"
      + "<div class='card stat'><div class='v'>" + (m.inputTokens ?? 0) + " → " + (m.outputTokens ?? 0) + "</div><div class='l'>tokens in → out</div></div>"
      + "<div class='card stat'><div class='v'>" + fmtUsd(m.measuredCostSavedUsd) + "</div><div class='l'>measured savings (pillar 6)</div></div>"
      + "</div>"
      + "<div class='row'><h2 style='margin:0'>Budget vs actual</h2><span class='grow'></span><button class='small' id='proj-csv'>Download CSV</button></div>"
      + "<div class='card'>" + budgetGauge(costs.budget.spentUsd, costs.budget.budgetUsd, costs.budget.overageApproved, costs.budget)
      + "<div class='row' style='margin-top:8px'><span class='dim' style='font-size:12px'>budget window: "
      + (costs.budget.period === "monthly" ? "this calendar month (" + esc(costs.budget.periodKey ?? "") + ")" : "lifetime")
      + " · alert at " + (costs.budget.alertThresholdPct ?? 100) + "%</span></div></div>"
      + "<h2>Showback by user</h2><div class='card'>" + barChart(costs.byUser, "costUsd", (i) => uname[i.userId] ?? i.userId) + "</div>"
      + "<h2>Showback by team</h2><div class='card'>" + barChart(costs.byTeam ?? [], "costUsd", (i) => i.name ?? "(no team)") + "</div>"
      + "<h2>By agent / model</h2><div class='card'>" + barChart(costs.byAgent, "costUsd", (i) => i.model) + "</div>"
      + "<h2>Estimated savings by technique</h2><div class='card'>" + barChart(costs.estimatedSavings, "estimatedCostSavedUsd", (i) => i.technique) + "</div>"
      + "<h2>Compliance — effective policy + enforcement labels</h2><div class='card'>" + renderCompliance(compliance) + "</div>";
    const csvBtn = $("#proj-csv");
    if (csvBtn) csvBtn.addEventListener("click", () =>
      downloadCsv("/v1/projects/" + b.dataset.proj + "/costs.csv", (costs.project?.name ?? "project") + "-costs.csv"));
  });
}],
["Infrastructure", async (el) => {
  // PILLAR 3 §8.2: monitored resources + operational policies + detected
  // findings + governed remediation. Findings are inert until governed — a new
  // one is auto-remediated (audited) only under a permissive policy, else it is
  // approval-gated; every 'critical' is always approval-gated.
  const [res, pol, fin, posture, u, cp, certs, patches, backups, org] = await Promise.all([
    get("/v1/infra/resources"), get("/v1/infra/policies"), get("/v1/infra/findings"),
    get("/v1/infra/posture"), get("/v1/users"), get("/v1/compliance/profiles"),
    get("/v1/infra/certs"), get("/v1/infra/patches"), get("/v1/infra/backups"),
    get("/v1/org/settings").catch(() => ({ settings: {} })),
  ]);
  const uOpts = userOpts(u.users);
  const tagOpts = cp.profiles.map((x) => x.tag);
  const rOpts = res.resources.map((x) => ({ v: x.id, l: x.name + " · " + x.kind }));
  const SEV = { critical: "bad", high: "bad", medium: "warn", low: "ok" };
  const STATUS_BADGE = {
    open: "warn", remediation_proposed: "warn", auto_remediated: "ok",
    approved: "ok", remediated: "ok", accepted_risk: "bad",
  };
  const p = posture;
  el.innerHTML =
    "<h2>Posture</h2><div class='grid2'>"
    + "<div class='card stat'><div class='v'>" + (p.resources ?? 0) + "</div><div class='l'>monitored resources</div></div>"
    + "<div class='card stat'><div class='v'>" + (p.open ?? 0) + "</div><div class='l'>open findings (" + (p.findings ?? 0) + " total)</div></div>"
    + "<div class='card stat'><div class='v'>" + (p.bySeverity?.critical ?? 0) + " / " + (p.bySeverity?.high ?? 0) + "</div><div class='l'>critical / high</div></div>"
    + "<div class='card stat'><div class='v'>" + (p.backup?.missed ?? 0) + " / " + (p.backup?.targets ?? 0) + "</div><div class='l'>backups missed / targets</div></div>"
    + "</div>"
    + "<div class='card'><div class='kv'>"
    + "<span class='k'>by kind</span><span>" + inlineCounts(p.byKind ?? {}) + "</span>"
    + "<span class='k'>by severity</span><span>" + inlineCounts(p.bySeverity ?? {}) + "</span>"
    + "<span class='k'>by status</span><span>" + inlineCounts(p.byStatus ?? {}) + "</span>"
    + "</div><div class='row' style='margin-top:12px'><button class='small primary' id='infra-scan'>Scan now</button>"
    + "<span class='dim' style='font-size:12px'>Scanning detects findings idempotently, then auto-remediates any that a policy permits (audited) — everything else waits for a governed remediation.</span></div></div>"

    + "<h2>Register a resource</h2><div class='card'>"
    + form("f-ires", [
        {name:"name",ph:"e.g. control-plane-gateway"},
        {name:"kind",label:"kind",options:["control_plane","agent_runtime","cert","backup_target"]},
        {name:"provider",label:"provider",options:["mock","aws","azure","gcp"]},
        {name:"daysUntilExpiry",label:"cert: days-until-expiry",type:"number",req:false,ph:"cert only (<=0 = expired = critical)"},
        {name:"hoursSinceLastBackup",label:"backup: hours since last",type:"number",req:false,ph:"backup_target only"},
        {name:"classifications",label:"classifications",options:tagOpts,req:false,multi:true},
      ], "Register resource")
    + "<p class='dim' style='font-size:12px'>Only 'mock' executes today (keyless, deterministic); aws/azure/gcp are interface-ready and 501 on scan. Classifications cascade §8.3 backup-retention/patch-cadence floors onto the resource.</p></div>"

    + "<h2>Resources — with cascade-derived floors</h2><div class='card'>"
    + table(res.resources.map((r) => ({
        name: r.name, kind: r.kind, provider: r.provider,
        classifications: (r.classifications ?? []).join(", ") || "—",
        autoCeiling: r.effectivePolicy?.autoRemediateMaxSeverity ?? "never",
        backupFloorDays: r.effectivePolicy?.backupRetentionDaysFloor ?? "—",
        patchCeilingDays: r.effectivePolicy?.patchCadenceDaysCeiling ?? "—",
      })))
    + "<p class='dim' style='font-size:12px'>backupFloorDays = max(policy, §8.3 backup retention, §8.3 audit retention) — this is where the formerly-dead auditRetentionDays is finally consumed. patchCeilingDays = min(policy, §8.3 patch cadence).</p></div>"

    + "<h2>Set a policy</h2><div class='card'>"
    + form("f-ipol", [
        {name:"resourceId",label:"resource (blank = fleet-wide)",options:rOpts,req:false,ph:"— fleet-wide default —"},
        {name:"patchCadenceDays",label:"patch cadence days",type:"number",req:false},
        {name:"certRotationDaysBeforeExpiry",label:"cert rotation window days",type:"number",req:false},
        {name:"backupSchedule",label:"backup schedule",req:false,ph:"e.g. daily-0200"},
        {name:"backupRetentionDays",label:"backup retention days",type:"number",req:false},
        {name:"autoRemediateMaxSeverity",label:"auto-remediate ceiling",options:["low","medium","high"],req:false,ph:"— never auto-remediate —"},
      ], "Save policy")
    + "<p class='dim' style='font-size:12px'>The auto-remediate ceiling cannot be 'critical' — every critical finding is always approval-gated. A resource-scoped policy overrides the fleet-wide default.</p></div>"
    + "<div class='card'>" + table(pol.policies.map((r) => ({
        scope: r.resourceId ? (rOpts.find((o) => o.v === r.resourceId)?.l ?? "resource") : "fleet-wide",
        patchCadenceDays: r.patchCadenceDays ?? "—",
        certWindowDays: r.certRotationDaysBeforeExpiry ?? "—",
        backupSchedule: r.backupSchedule ?? "—",
        backupRetentionDays: r.backupRetentionDays ?? "—",
        autoCeiling: r.autoRemediateMaxSeverity ?? "never",
      }))) + "</div>"

    + "<h2>Findings — severity-sorted posture inbox</h2><div class='card'>"
    + form("f-remapprover", [{name:"approverUserId",label:"remediation approver",options:uOpts}], "Set approver")
    + "<p class='dim' style='font-size:12px'>The chosen approver is a PERSISTED org default — 'Set approver' saves it (audited, in org settings) and it prefills on every visit. Each 'propose remediation'/'rotate'/'patch'/'restore' names it explicitly and lands in the Approvals Queue (objectType infra_operation). Auto-remediated findings are already fixed; only 'open' findings can be proposed.</p>"
    // color+text severity/status: badges carry the word AND a title, so status
    // is never signalled by color alone. Sort/filter/paginate via dataTable.
    + dataTable(fin.findings.map((f) => ({
        id: f.id,
        resource: f.resourceName ?? "—",
        kind: f.kind,
        severity: f.severity,
        status: f.status,
        summary: (f.detail && f.detail.summary) ? f.detail.summary : "",
        detected: f.detectedAt,
      })), {
        cells: {
          severity: (v) => "<span class='badge " + (SEV[v] ?? "") + "' title='severity: " + esc(v) + "'>" + esc(v) + "</span>",
          status: (v) => "<span class='badge " + (STATUS_BADGE[v] ?? "") + "' title='status: " + esc(v) + "'>" + esc(v) + "</span>",
        },
        actions: (r) => r.status === "open"
          ? "<button class='small primary' data-remediate='" + r.id + "'>propose remediation</button>"
          : r.status === "auto_remediated" ? "<span class='dim'>auto-fixed</span>"
          : r.status === "remediated" ? "<span class='dim'>remediated</span>"
          : r.status === "remediation_proposed" ? "<span class='dim'>awaiting approval</span>"
          : r.status === "accepted_risk" ? "<span class='dim'>accepted risk</span>" : "",
      })
    + "</div>"

    // ADR-0017 automation ledgers: durable domain records that hang off the
    // findings above. Each governed verb funnels into the SAME Approvals Queue
    // (objectType infra_operation) via the shared #f-remapprover approver.
    + "<h2>Certificates — rotation ledger</h2><div class='card'>"
    + dataTable((certs.certs || []).map((c) => ({
        id: c.id,
        resource: c.resourceName || "—",
        commonName: c.commonName,
        notAfter: c.notAfter,
        status: c.status,
        serial: c.serial || "—",
      })), {
        cells: { status: (v) => "<span class='badge' title='status: " + esc(v) + "'>" + esc(v) + "</span>" },
        actions: (r) => r.status === "active"
          ? "<button class='small primary' data-rotate='" + r.id + "'>propose rotation</button>"
          : "<span class='dim'>" + esc(r.status) + "</span>",
      })
    + "<p class='dim' style='font-size:12px'>A governed rotation advances not-after / last-rotated and writes a cert_rotations outcome row — only after the named approver approves.</p></div>"

    + "<h2>CVE patches — remediation ledger</h2><div class='card'>"
    + dataTable((patches.patches || []).map((p) => ({
        id: p.id,
        resource: p.resourceName || "—",
        cve: p.cve,
        severity: p.severity,
        package: p.package || "—",
        fixedVersion: p.fixedVersion || "—",
        status: p.status,
      })), {
        cells: {
          severity: (v) => "<span class='badge " + (SEV[v] || "") + "' title='severity: " + esc(v) + "'>" + esc(v) + "</span>",
          status: (v) => "<span class='badge' title='status: " + esc(v) + "'>" + esc(v) + "</span>",
        },
        actions: (r) => r.status === "open"
          ? "<button class='small primary' data-apply='" + r.id + "'>propose patch</button>"
          : "<span class='dim'>" + esc(r.status) + "</span>",
      })
    + "<p class='dim' style='font-size:12px'>Applying a patch marks the CVE patched only after approval; denying it records accepted risk.</p></div>"

    + "<h2>Backups — run / restore ledger</h2><div class='card'>"
    + dataTable((backups.backups || []).map((r) => ({
        id: r.id,
        resource: r.resourceName || "—",
        kind: r.kind,
        status: r.status,
        retentionUntil: r.retentionUntil || "—",
      })), {
        cells: { status: (v) => "<span class='badge' title='status: " + esc(v) + "'>" + esc(v) + "</span>" },
        actions: (r) => r.status === "missed"
          ? "<button class='small primary' data-restore='" + r.id + "'>propose restore</button>"
          : "<span class='dim'>" + esc(r.status) + "</span>",
      })
    + "<p class='dim' style='font-size:12px'>A governed restore appends a kind=restore, status=restored run — only after approval.</p></div>";

  $("#infra-scan").addEventListener("click", async () => {
    try { const r = await post("/v1/infra/scan", {}); toast("Scan complete — " + r.created + " new, " + r.autoRemediated + " auto-remediated, " + r.refreshed + " refreshed.", "ok"); render(); }
    catch (ex) { toast(ex.message, "err"); }
  });
  // delegate so the remediate buttons survive a findings dataTable re-render.
  // Native confirm() silently no-ops in embedded browsers, so every governed
  // verb uses the two-step inline confirmClick instead.
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-remediate]");
    if (!b) return;
    const approver = $("#f-remapprover")?.querySelector("[name=approverUserId]")?.value;
    if (!approver) { toast("Pick a remediation approver first.", "err"); return; }
    if (!confirmClick(b, "Propose?")) return;
    try { await post("/v1/infra/findings/" + b.dataset.remediate + "/remediate", { approverUserId: approver }); toast("Remediation proposed — awaiting the named approver in the Approvals Queue", "ok"); render(); }
    catch (ex) { toast(ex.message, "err"); }
  });
  // ADR-0017 verbs — same delegated pattern, same #f-remapprover approver,
  // each confirm-armed inline. cert_rotate / patch_apply / backup_restore all
  // POST into the one governed approval path.
  el.addEventListener("click", async (e) => {
    const rot = e.target.closest("[data-rotate]");
    const app_ = e.target.closest("[data-apply]");
    const rst = e.target.closest("[data-restore]");
    const hit = rot || app_ || rst;
    if (!hit) return;
    const approver = $("#f-remapprover") && $("#f-remapprover").querySelector("[name=approverUserId]") ? $("#f-remapprover").querySelector("[name=approverUserId]").value : "";
    if (!approver) { toast("Pick a remediation approver first.", "err"); return; }
    if (!confirmClick(hit, "Propose?")) return;
    let url = "";
    if (rot) url = "/v1/infra/certs/" + rot.dataset.rotate + "/rotate";
    else if (app_) url = "/v1/infra/patches/" + app_.dataset.apply + "/apply";
    else url = "/v1/infra/backups/" + rst.dataset.restore + "/restore";
    try { await post(url, { approverUserId: approver }); toast("Proposed — awaiting approval in the Approvals Queue", "ok"); render(); }
    catch (ex) { toast(ex.message, "err"); }
  });
  // ADR-0022 (defect fix): "Set approver" is a REAL, persisted setting now —
  // it PUTs org_settings.infraApproverUserId (audited like every org-settings
  // write) and the select prefills from the stored value on every visit.
  {
    const sel = $("#f-remapprover")?.querySelector("[name=approverUserId]");
    if (sel && org.settings && org.settings.infraApproverUserId) sel.value = org.settings.infraApproverUserId;
  }
  wire("f-remapprover", async (d) => {
    await api("PUT", "/v1/org/settings", { infraApproverUserId: d.approverUserId });
    toast("Default remediation approver saved (org setting, audited)", "ok");
  }, true);
  wire("f-ires", (d) => {
    const config = {};
    if (d.daysUntilExpiry != null && d.daysUntilExpiry !== "") config.daysUntilExpiry = Number(d.daysUntilExpiry);
    if (d.hoursSinceLastBackup != null && d.hoursSinceLastBackup !== "") config.hoursSinceLastBackup = Number(d.hoursSinceLastBackup);
    return post("/v1/infra/resources", {
      name: d.name, kind: d.kind, provider: d.provider,
      ...(Object.keys(config).length ? { config } : {}),
      ...(d.classifications ? { classifications: [].concat(d.classifications) } : {}),
    });
  });
  wire("f-ipol", (d) => {
    const body = {};
    if (d.resourceId) body.resourceId = d.resourceId;
    for (const k of ["patchCadenceDays", "certRotationDaysBeforeExpiry", "backupRetentionDays"]) if (k in d) body[k] = Number(d[k]);
    if (d.backupSchedule) body.backupSchedule = d.backupSchedule;
    if (d.autoRemediateMaxSeverity) body.autoRemediateMaxSeverity = d.autoRemediateMaxSeverity;
    return post("/v1/infra/policies", body);
  });
}],
// ADR-0020 (Batch H) — IDE / existing-agent interception. Two jobs: choose the
// deployment's INTERCEPTION POSTURE (which surfaces exist, how a model string
// resolves, whether attribution is mandatory, which ladder rung the org
// declares) and hand a developer a copy-paste config for their own IDE built
// from THIS deployment's origin.
["Client Access", async (el) => {
  const [s, srv, prj, u, rl, rules] = await Promise.all([
    get("/v1/interception/settings"),
    get("/v1/servers").catch(() => ({ servers: [] })),
    get("/v1/projects").catch(() => ({ projects: [] })),
    get("/v1/users").catch(() => ({ users: [] })),
    get("/v1/roles").catch(() => ({ roles: [] })),
    get("/v1/interception/scope-rules").catch(() => ({ rules: [] })),
  ]);
  const cur = s.settings;
  const BASE = location.origin;
  // ADR-0024 (O15): the HONEST per-rung status comes from the server
  // (postureStatus) so this page can never imply enforcement that does not
  // exist. Per-rung reference notes stay here for the ladder table.
  const LADDER = {
    observe: { bypass: "n/a — no enforcement", status: "honor system", note: "Telemetry only. Nothing stops a developer calling the vendor directly; you will see what they choose to emit." },
    voluntary: { bypass: "trivially bypassable", status: "honor system", note: "HONOR SYSTEM. A developer points their IDE at RegulAIt, and nothing prevents them from pointing it straight back at the vendor. Key custody or network egress is what makes interception non-bypassable — not this setting." },
    managed: { bypass: "developer can undo locally", status: "policy", note: "Pushed by IDE policy / managed settings / MDM. Better than voluntary, still reversible on the developer's own machine." },
    key_custody: { bypass: "no — no key, no call (when ENFORCED below)", status: cur.keyCustodyEnforced ? "ENFORCED by this deployment" : "declared — NOT enforced", note: "The org never issues raw vendor keys, only RegulAIt keys. With 'enforce key custody' ON this deployment makes it real: per-user BYO credentials are refused (409) and dispatch uses org/platform credentials only. Declared without the toggle, it is a statement — not a mechanism." },
    network: { bypass: "no", status: "requires egress control at your network boundary — see docs", note: "RegulAIt is the only sanctioned egress to the vendor APIs. Enforced by YOUR network (egress allowlist), never by this product — the recipe is in docs/product/IDE_INTEGRATION.md (Network rung)." },
  };
  const posture = s.posture || {};
  const rung = LADDER[cur.enforcementPosture] || LADDER.voluntary;
  const postureWarn = posture.status === "honor_system" || posture.status === "declared_not_enforced";
  const sOpts = (srv.servers || []).map((x) => ({ v: x.id, l: x.name }));
  const pOpts = (prj.projects || []).map((x) => ({ v: x.id, l: x.name }));
  const uOpts = userOpts(u.users || []);
  const rOpts = roleOpts(rl.roles || []);

  el.innerHTML =
    "<p class='sub'>Batch H / ADR-0020, deepened by ADR-0024. RegulAIt governs calls that ARRIVE at it. These settings decide which arrival surfaces exist, how an IDE's model string resolves onto a governed agent, and which rung of the interception ladder this organisation is on — labeled honestly as enforced, policy, or honor system. Both provider-shaped surfaces are OFF until you turn them on; while off they answer 404 and are indistinguishable from not existing.</p>"
    + "<h2>Enforcement posture — declared vs enforced</h2><div class='card'>"
    + "<div class='kv'>"
    + "<span class='k'>Rung</span><span>" + badge(cur.enforcementPosture, postureWarn ? "warn" : "ok") + " " + badge(posture.label || rung.status, posture.status === "enforced" ? "ok" : postureWarn ? "warn" : "ok") + "</span>"
    + "<span class='k'>Bypassable?</span><span>" + esc(rung.bypass) + "</span>"
    + "<span class='k'>What that means</span><span>" + esc(posture.detail || rung.note) + "</span>"
    + "</div>"
    + (posture.status === "honor_system"
        ? "<p class='dim' style='font-size:12px'>This rung is an <strong>honor system</strong>. Pointing an IDE here is a request, not an enforcement. If an enterprise buyer asks what stops a developer from simply not doing it, the honest answer at this rung is: nothing. Key custody (the org holds the vendor keys, developers hold only RegulAIt keys) is the cheapest non-bypassable answer — and this deployment CAN enforce it: turn on 'enforce key custody' below. Network egress control is the airtight one (see docs).</p>"
        : posture.status === "declared_not_enforced"
          ? "<p class='dim' style='font-size:12px'><strong>Warning:</strong> key custody is DECLARED but the enforcement toggle is OFF — per-user BYO credentials still work, so nothing currently stops a developer using their own vendor key through this gateway or outside it. Turn on 'enforce key custody' below to make the declaration true.</p>"
          : posture.status === "external_infrastructure"
            ? "<p class='dim' style='font-size:12px'>The network rung is enforced at your <strong>network boundary</strong>, not by this product: an egress allowlist that blocks api.anthropic.com / api.openai.com etc. and allows only the RegulAIt gateway. The concrete recipe is documented in docs/product/IDE_INTEGRATION.md (Network rung). Declaring it here only changes what this portal tells you.</p>"
            : posture.status === "enforced"
              ? "<p class='dim' style='font-size:12px'>Key custody is <strong>enforced by this deployment</strong>: per-user BYO model credentials are refused with a 409 and dispatch resolution skips any stored user credential — the org's platform credentials are the only way to a vendor. Existing user credential rows are kept inert (turning the toggle off restores them).</p>"
              : "<p class='dim' style='font-size:12px'>This rung is pushed by IDE policy / managed settings / MDM — better than voluntary, still reversible on the developer's own machine.</p>")
    + "</div>"

    + "<h2>Interception surfaces &amp; resolution policy</h2><div class='card'>"
    + form("f-intercept", [
        {name:"anthropicCompatEnabled",label:"POST /v1/messages (Anthropic-shaped)",options:["false","true"]},
        {name:"openaiCompatEnabled",label:"POST /v1/chat/completions (OpenAI-shaped)",options:["false","true"]},
        {name:"mcpInterceptionEnabled",label:"POST /mcp/:serverId (MCP tool calls)",options:["true","false"]},
        {name:"resolutionMode",label:"model to agent resolution",options:["map_by_model","require_agent","router_decides"]},
        {name:"enforcementPosture",label:"declared ladder rung",options:["observe","voluntary","managed","key_custody","network"]},
        {name:"requireProjectAttribution",label:"require project attribution (compat)",options:["false","true"]},
        {name:"requireMcpAttribution",label:"require MCP attribution",options:["false","true"]},
        {name:"keyCustodyEnforced",label:"enforce key custody",options:[{v:"false",l:"off — BYO user keys allowed"},{v:"true",l:"on — org/platform keys only"}]},
        {name:"streamingOnBlockMode",label:"stream on PII-block project",options:[{v:"suppress",l:"suppress (buffer + disclose)"},{v:"reject",l:"reject (400 the stream request)"}]},
        {name:"strictFieldRejection",label:"strict field rejection",options:[{v:"false",l:"off — accept & disclose (temperature ignored)"},{v:"true",l:"on — unsupported fields 400"}]},
      ], "Save posture")
    + "<div class='kv' style='margin-top:10px'>"
    + "<span class='k'>Stream on block</span><span>'suppress' (default) answers a stream request on a block-mode PII project with the same governed call fully buffered as JSON, disclosed via streamingSuppressed. 'reject' refuses it with a 400 so a client that requires streaming fails fast instead of getting a shape it did not ask for.</span>"
    + "<span class='k'>Strict fields</span><span>Off (default): an unsupported-but-harmless field like temperature is accepted, NOT honoured, and disclosed in x-regulait-ignored-fields. On: any unsupported field is a 400 — the strict posture some compliance programs require.</span>"
    + "</div><div class='kv' style='margin-top:10px'>"
    + "<span class='k'>map_by_model</span><span>Resolve to the governed agent whose model id matches the request. Several matches tie-break on lowest tier, then oldest. Least developer friction.</span>"
    + "<span class='k'>require_agent</span><span>The caller MUST send x-regulait-agent-id; the model string is advisory. Missing header is a 400. Strictest, explicit attribution per call.</span>"
    + "<span class='k'>router_decides</span><span>The requested model is a HINT the pillar-6 router may override for cost. The response always carries the model actually served, and the audit row records requested-vs-served.</span>"
    + "<span class='k'>Unmapped model</span><span>Always <strong>403 default-deny</strong>, in every mode. RegulAIt never passes an ungoverned call through to the vendor.</span>"
    + "<span class='k'>Attribution (compat)</span><span>Turning 'require project attribution' ON rejects any compat call without an x-regulait-project-id header, rather than running it as untracked spend — but only enable it for clients that can send custom headers (see the matrix below).</span>"
    + "<span class='k'>Attribution (MCP)</span><span>Every MCP tool call is METERED whether or not it is attributed; an unattributed call lands in the explicit 'Unattributed' bucket (Cost &amp; Projects) instead of a project. 'Require MCP attribution' rejects unattributed MCP calls outright — together the two require-toggles close the unattributed gap entirely.</span>"
    + "<span class='k'>Key custody</span><span>ON: per-user BYO model credentials are refused (409, audited) and dispatch resolution skips stored user credentials — org/platform credentials only. Existing user rows are kept but inert; turning it back off restores them. This is what turns the key_custody rung from a declaration into a mechanism.</span>"
    + "</div></div>"

    + "<h2>Staged rollout — per-scope overrides (ADR-0024)</h2><div class='card'>"
    + "<p class='dim' style='font-size:12px'>Pilot a compat surface with one user, project, or role instead of flipping the org-wide switch. Precedence: <strong>user &gt; project &gt; role &gt; org</strong>; the first non-inherit value per field wins; ties inside one kind go to the most recently created rule. A rule that enables a surface grants NOTHING — every dispatch still passes the same per-user entitlement check, and a surface disabled by resolution answers the same indistinguishable 404.</p>"
    + form("f-scope-rule", [
        {name:"scopeKind",label:"scope",options:[{v:"user",l:"user (strongest)"},{v:"project",l:"project"},{v:"role",l:"role"}]},
        {name:"scopeId",label:"target",options:[]},
        {name:"anthropicCompatEnabled",label:"/v1/messages",options:[{v:"",l:"inherit"},{v:"true",l:"enabled"},{v:"false",l:"disabled"}],req:false,ph:"inherit"},
        {name:"openaiCompatEnabled",label:"/v1/chat/completions",options:[{v:"",l:"inherit"},{v:"true",l:"enabled"},{v:"false",l:"disabled"}],req:false,ph:"inherit"},
        {name:"resolutionMode",label:"resolution mode",options:[{v:"",l:"inherit"},{v:"map_by_model",l:"map_by_model"},{v:"require_agent",l:"require_agent"},{v:"router_decides",l:"router_decides"}],req:false,ph:"inherit"},
        {name:"note",label:"note",req:false,ph:"e.g. anthropic pilot, platform team"},
      ], "Create rule")
    + "<div id='scoperules'>"
    + ((rules.rules || []).length
        ? table((rules.rules || []).map((r) => ({
            id: r.id,
            scope: r.scopeKind + " · " + (r.scopeName ?? r.scopeId),
            "/v1/messages": r.anthropicCompatEnabled === null ? "inherit" : String(r.anthropicCompatEnabled),
            "/v1/chat/completions": r.openaiCompatEnabled === null ? "inherit" : String(r.openaiCompatEnabled),
            resolution: r.resolutionMode ?? "inherit",
            note: r.note ?? "—",
            created: r.createdAt,
          })), (row) => "<button class='small' data-ruledel='" + row.id + "'>delete</button>")
        : "<div class='empty'>No scope rules — the org singleton applies to everyone.</div>")
    + "</div>"
    + "<h3 style='margin-top:14px'>Effective values — live preview</h3>"
    + "<p class='dim' style='font-size:12px'>What would this user get right now? Runs the exact resolver the request gate uses, so the preview cannot drift from enforcement.</p>"
    + form("f-scope-preview", [
        {name:"userId",label:"user",options:uOpts},
        {name:"projectId",label:"project (attribution header)",options:pOpts,req:false,ph:"— none —"},
      ], "Preview")
    + "<div id='scopepreview'></div>"
    + "</div>"

    + "<h2>Connect a client</h2><div class='card'>"
    + "<p class='dim' style='font-size:12px'>Generated from this page's own origin (" + esc(BASE) + "). The snippet uses a placeholder for the API key on purpose — issue the developer their own key in Identity &amp; Access &rarr; Users, never paste yours.</p>"
    + form("f-client", [
        {name:"client",label:"client",options:[
          {v:"claude-code",l:"Claude Code"},
          {v:"cursor",l:"Cursor"},
          {v:"cline",l:"Cline"},
          {v:"roo",l:"Roo Code"},
          {v:"continue",l:"Continue"},
          {v:"zed",l:"Zed"},
          {v:"generic-anthropic",l:"Generic Anthropic-compatible"},
          {v:"generic-openai",l:"Generic OpenAI-compatible"},
        ]},
        {name:"serverId",label:"MCP server",options:sOpts,req:false,ph:"— none / placeholder —"},
        {name:"projectId",label:"project (attribution)",options:pOpts,req:false,ph:"— unattributed —"},
        {name:"model",label:"model id",req:false,ph:"claude-opus-5"},
      ], "Generate")
    + "<div id='clientsnip'></div></div>"

    + "<h2>Honest coverage</h2><div class='card'>"
    + table([
        {client:"Claude Code", modelCalls:"ANTHROPIC_BASE_URL -> /v1/messages", toolCalls:"MCP proxy (claude mcp add)", customHeaders:"yes"},
        {client:"Cursor", modelCalls:"OpenAI-compatible base URL -> /v1/chat/completions", toolCalls:"MCP proxy (.cursor/mcp.json)", customHeaders:"MCP only"},
        {client:"Cline", modelCalls:"OpenAI- or Anthropic-compatible base URL", toolCalls:"MCP proxy", customHeaders:"MCP only"},
        {client:"Roo Code", modelCalls:"OpenAI- or Anthropic-compatible base URL", toolCalls:"MCP proxy", customHeaders:"MCP only"},
        {client:"Continue", modelCalls:"apiBase override", toolCalls:"MCP proxy", customHeaders:"MCP only"},
        {client:"Zed", modelCalls:"language_models api_url override", toolCalls:"MCP (context servers)", customHeaders:"MCP only"},
        {client:"VS Code (built-in MCP)", modelCalls:"not applicable", toolCalls:"MCP proxy", customHeaders:"yes"},
        {client:"GitHub Copilot", modelCalls:"NOT SUPPORTED — largely locked down; enterprise proxy path or nothing", toolCalls:"not via this proxy", customHeaders:"n/a"},
        {client:"Eclipse", modelCalls:"no first-party agent; third-party plugins vary and are often not configurable", toolCalls:"varies by plugin", customHeaders:"n/a"},
      ])
    + "<p class='dim' style='font-size:12px'>&quot;Works with every IDE&quot; would be a false claim. What is true: any client that accepts a custom Anthropic- or OpenAI-compatible base URL can have its <strong>model calls</strong> governed here, and any MCP-capable client can have its <strong>tool calls</strong> governed here. Those are two independent halves — enabling one does not cover the other.</p>"
    + "</div>";

  // prefill the posture form from the stored settings (field() renders plain
  // selects with no value binding, so bind them here)
  const pf = $("#f-intercept");
  if (pf) {
    for (const k of ["anthropicCompatEnabled","openaiCompatEnabled","mcpInterceptionEnabled","resolutionMode","enforcementPosture","requireProjectAttribution","requireMcpAttribution","keyCustodyEnforced","streamingOnBlockMode","strictFieldRejection"]) {
      const c = pf.querySelector("[name=" + k + "]");
      if (c) c.value = String(cur[k]);
    }
  }
  wire("f-intercept", (d) => api("PUT", "/v1/interception/settings", {
    anthropicCompatEnabled: d.anthropicCompatEnabled === "true",
    openaiCompatEnabled: d.openaiCompatEnabled === "true",
    mcpInterceptionEnabled: d.mcpInterceptionEnabled === "true",
    resolutionMode: d.resolutionMode,
    enforcementPosture: d.enforcementPosture,
    requireProjectAttribution: d.requireProjectAttribution === "true",
    requireMcpAttribution: d.requireMcpAttribution === "true",
    keyCustodyEnforced: d.keyCustodyEnforced === "true",
    streamingOnBlockMode: d.streamingOnBlockMode,
    strictFieldRejection: d.strictFieldRejection === "true",
  }));

  // --- ADR-0024 scope rules: kind-driven target select, create, delete,
  // and the live effective-value preview -----------------------------------
  const SCOPE_TARGETS = { user: uOpts, project: pOpts, role: rOpts };
  const srf = $("#f-scope-rule");
  function fillScopeTargets() {
    const kind = srf.querySelector("[name=scopeKind]").value || "user";
    const sel = srf.querySelector("[name=scopeId]");
    const opts = SCOPE_TARGETS[kind] || [];
    sel.innerHTML = opts.length
      ? opts.map((o) => "<option value='" + esc(o.v) + "'>" + esc(o.l) + "</option>").join("")
      : "<option value=''>— none available —</option>";
  }
  if (srf) {
    fillScopeTargets();
    srf.querySelector("[name=scopeKind]").addEventListener("change", fillScopeTargets);
  }
  const tri = (v) => (v === "true" ? true : v === "false" ? false : undefined);
  wire("f-scope-rule", (d) => post("/v1/interception/scope-rules", {
    scopeKind: d.scopeKind,
    scopeId: d.scopeId,
    ...(tri(d.anthropicCompatEnabled) !== undefined ? { anthropicCompatEnabled: tri(d.anthropicCompatEnabled) } : {}),
    ...(tri(d.openaiCompatEnabled) !== undefined ? { openaiCompatEnabled: tri(d.openaiCompatEnabled) } : {}),
    ...(d.resolutionMode ? { resolutionMode: d.resolutionMode } : {}),
    ...(d.note ? { note: d.note } : {}),
  }));
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ruledel]");
    if (!b) return;
    try {
      await del("/v1/interception/scope-rules/" + b.dataset.ruledel);
      toast("Rule deleted — the scope falls back to inheritance", "ok");
      render();
    } catch (ex) { toast(ex.message, "err"); }
  });
  wire("f-scope-preview", async (d) => {
    const eff = await get("/v1/interception/effective?userId=" + d.userId + (d.projectId ? "&projectId=" + d.projectId : ""));
    const srcLabel = (s) => s.level === "org" ? "org singleton" : s.level + " rule (" + s.ruleId.slice(0, 8) + "…)";
    $("#scopepreview").innerHTML = "<div class='kv' style='margin-top:8px'>"
      + "<span class='k'>/v1/messages</span><span>" + badge(String(eff.effective.anthropicCompatEnabled), eff.effective.anthropicCompatEnabled ? "ok" : "warn") + " <span class='dim'>from " + esc(srcLabel(eff.sources.anthropicCompatEnabled)) + " (org: " + eff.org.anthropicCompatEnabled + ")</span></span>"
      + "<span class='k'>/v1/chat/completions</span><span>" + badge(String(eff.effective.openaiCompatEnabled), eff.effective.openaiCompatEnabled ? "ok" : "warn") + " <span class='dim'>from " + esc(srcLabel(eff.sources.openaiCompatEnabled)) + " (org: " + eff.org.openaiCompatEnabled + ")</span></span>"
      + "<span class='k'>resolution mode</span><span>" + badge(eff.effective.resolutionMode, "info") + " <span class='dim'>from " + esc(srcLabel(eff.sources.resolutionMode)) + " (org: " + esc(eff.org.resolutionMode) + ")</span></span>"
      + "</div>"
      + "<p class='dim' style='font-size:12px'>Surface exposure is NOT entitlement: an enabled surface only means the route exists for this user — every dispatch still runs the same per-user entitlement check.</p>";
  }, true);

  wire("f-client", (d) => {
    const KEYPH = "<REGULAIT_API_KEY>";
    const sid = d.serverId || "<MCP_SERVER_ID>";
    const pid = d.projectId || "";
    const model = d.model || "claude-opus-5";
    const mcpUrl = BASE + "/mcp/" + sid;
    const hdrJson = '"Authorization": "Bearer ' + KEYPH + '"' + (pid ? ',\\n        "x-regulait-project-id": "' + pid + '"' : "");
    const mcpJson = "{\\n  \\"mcpServers\\": {\\n    \\"regulait\\": {\\n      \\"url\\": \\"" + mcpUrl + "\\",\\n      \\"headers\\": {\\n        " + hdrJson + "\\n      }\\n    }\\n  }\\n}";
    const notes = [];
    let snip = "";
    if (d.client === "claude-code") {
      snip = "# Model calls -> RegulAIt (Anthropic-shaped)\\n"
        + "export ANTHROPIC_BASE_URL=\\"" + BASE + "\\"\\n"
        + "export ANTHROPIC_API_KEY=\\"" + KEYPH + "\\"\\n"
        + (pid ? "export ANTHROPIC_CUSTOM_HEADERS=\\"x-regulait-project-id: " + pid + "\\"\\n" : "")
        + "\\n# Tool calls -> RegulAIt (governed MCP proxy)\\n"
        + "claude mcp add --transport http regulait " + mcpUrl + " --header \\"Authorization: Bearer " + KEYPH + "\\"" + (pid ? " --header \\"x-regulait-project-id: " + pid + "\\"" : "") + "\\n"
        + "\\n# or as .mcp.json in the repo root\\n" + mcpJson;
      notes.push("Claude Code sends the key as x-api-key; POST /v1/messages accepts that header name for exactly this reason.");
      notes.push("ANTHROPIC_BASE_URL takes the ORIGIN — the client appends /v1/messages itself.");
    } else if (d.client === "cursor") {
      snip = "# Cursor -> Settings -> Models -> OpenAI API Key -> Override base URL\\n"
        + "Base URL:  " + BASE + "/v1\\n"
        + "API key:   " + KEYPH + "\\n"
        + "Model:     " + model + "\\n"
        + "\\n# .cursor/mcp.json (tool calls)\\n" + mcpJson;
      notes.push("Cursor takes an OpenAI-compatible endpoint, so enable POST /v1/chat/completions above.");
      notes.push("Cursor sends no custom headers on MODEL calls — with 'require project attribution' ON its completions would be rejected. Attribute its TOOL calls via the MCP header instead.");
    } else if (d.client === "cline" || d.client === "roo") {
      const nm = d.client === "cline" ? "Cline" : "Roo Code";
      snip = "# " + nm + " -> Settings -> API Provider: OpenAI Compatible\\n"
        + "Base URL:  " + BASE + "/v1\\n"
        + "API key:   " + KEYPH + "\\n"
        + "Model ID:  " + model + "\\n"
        + "\\n# or API Provider: Anthropic, with a custom base URL\\n"
        + "Base URL:  " + BASE + "\\n"
        + "API key:   " + KEYPH + "\\n"
        + "\\n# MCP settings JSON (tool calls)\\n" + mcpJson;
      notes.push(nm + " accepts either shape — enable whichever surface above matches the provider you pick.");
    } else if (d.client === "continue") {
      snip = "# ~/.continue/config.yaml\\n"
        + "models:\\n"
        + "  - name: regulait\\n"
        + "    provider: openai\\n"
        + "    model: " + model + "\\n"
        + "    apiKey: " + KEYPH + "\\n"
        + "    apiBase: " + BASE + "/v1\\n"
        + "\\n# MCP (tool calls)\\n" + mcpJson;
      notes.push("For the Anthropic shape instead, use provider: anthropic and apiBase: " + BASE + " .");
    } else if (d.client === "zed") {
      snip = "// Zed settings.json\\n"
        + "{\\n  \\"language_models\\": {\\n    \\"anthropic\\": { \\"api_url\\": \\"" + BASE + "\\" },\\n"
        + "    \\"openai\\": { \\"api_url\\": \\"" + BASE + "/v1\\" }\\n  },\\n"
        + "  \\"context_servers\\": {\\n    \\"regulait\\": { \\"source\\": \\"custom\\", \\"url\\": \\"" + mcpUrl + "\\" }\\n  }\\n}\\n"
        + "\\n// the API key is entered in Zed's agent panel, not in settings.json";
      notes.push("Zed cannot attach custom headers to model calls — leave 'require project attribution' off for it.");
    } else if (d.client === "generic-anthropic") {
      snip = "curl " + BASE + "/v1/messages \\n"
        + "  -H \\"x-api-key: " + KEYPH + "\\"\\n"
        + (pid ? "  -H \\"x-regulait-project-id: " + pid + "\\"\\n" : "")
        + "  -H \\"content-type: application/json\\"\\n"
        + "  -d '{\\"model\\":\\"" + model + "\\",\\"max_tokens\\":256,\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hello\\"}]}'\\n"
        + "\\n# base URL for any Anthropic SDK: " + BASE;
      notes.push("Authorization: Bearer <key> works identically — x-api-key is the alias Anthropic clients send.");
    } else {
      snip = "curl " + BASE + "/v1/chat/completions \\n"
        + "  -H \\"Authorization: Bearer " + KEYPH + "\\"\\n"
        + (pid ? "  -H \\"x-regulait-project-id: " + pid + "\\"\\n" : "")
        + "  -H \\"content-type: application/json\\"\\n"
        + "  -d '{\\"model\\":\\"" + model + "\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hello\\"}]}'\\n"
        + "\\n# base URL for any OpenAI SDK: " + BASE + "/v1";
    }
    if (!d.serverId) notes.push("No MCP server selected — the snippet carries a placeholder. Register one under AI Governance -> MCP Servers.");
    if (!pid) notes.push("No project selected — these calls run UNATTRIBUTED and land no per-project cost row. With 'require project attribution' ON they would be rejected outright.");
    // The snippet is the most copy-destined text in the product — a real Copy
    // button beside it, not just a select-all hope.
    $("#clientsnip").innerHTML = "<div class='row' style='margin-top:14px;align-items:center'><h2 style='margin:0'>Copy-paste config</h2><span class='grow'></span><button class='small' id='snip-copy'>Copy</button></div>"
      + "<pre class='mono' style='white-space:pre-wrap;overflow-x:auto;margin-top:8px'>" + esc(snip) + "</pre>"
      + (notes.length ? "<ul class='dim' style='font-size:12px'>" + notes.map((n) => "<li>" + esc(n) + "</li>").join("") + "</ul>" : "");
    $("#snip-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(snip); $("#snip-copy").textContent = "Copied"; setTimeout(() => { const b = $("#snip-copy"); if (b) b.textContent = "Copy"; }, 1500); }
      catch { toast("Clipboard unavailable — select the text manually", "err"); }
    });
  }, true);
}],
["Organization", async (el) => {
  // ADR-0021: org-wide functional defaults (the org_settings singleton). One
  // page, five sections, each its own PARTIAL PUT — an admin can change one
  // dial without restating the rest. Every default equals the shipped
  // behaviour, so an untouched page IS the previous release.
  const [s, ag] = await Promise.all([
    get("/v1/org/settings"),
    get("/v1/agents").catch(() => ({ agents: [] })),
  ]);
  const cur = s.settings;
  const aOpts = agentOpts(ag.agents || []);
  const ON_OFF = [{v:"true",l:"enabled"},{v:"false",l:"disabled"}];
  const CLEAR = { v: "__clear__", l: "— clear (use cheapest) —" };

  el.innerHTML =
    "<p class='sub'>Org-wide functional defaults (ADR-0021). Everything here used to be a hardcoded constant; now it is your choice. Org settings are CEILINGS: they only ever narrow what happens below them — a per-user passthrough still wins, and turning a technique off here cannot be undone per-user. Every save is audited with exactly which keys changed.</p>"

    // --- Optimization -----------------------------------------------------
    + "<h2>Optimization — pillar-6 techniques (org-wide ceilings)</h2><div class='card'>"
    + form("f-org-opt", [
        {name:"routingEnabled",label:"model routing",options:ON_OFF},
        {name:"compactionEnabled",label:"context compaction",options:ON_OFF},
        {name:"promptCachingEnabled",label:"prompt caching",options:ON_OFF},
        {name:"editVsRewriteEnabled",label:"edit vs rewrite",options:ON_OFF},
        {name:"filePreprocessingEnabled",label:"file preprocessing",options:ON_OFF},
        {name:"lazyToolLoadingEnabled",label:"lazy tool loading",options:ON_OFF},
        {name:"defaultRoutingMode",label:"default for unset users",options:[{v:"automatic",l:"automatic (optimize)"},{v:"passthrough",l:"passthrough (never optimize)"}]},
      ], "Save toggles")
    + "<p class='dim' style='font-size:12px'>Each toggle is the org CEILING for one cost-optimization technique: disabled means it never runs for anyone, and no savings ledger row is written for it. Enabled (the default — today's behaviour) defers to each user's own routing mode; 'default for unset users' is what a user with no per-user setting gets. A user's explicit passthrough always wins; an explicit automatic only works while the technique is enabled here.</p>"
    + form("f-org-cache", [
        {name:"semanticCachePolicy",label:"semantic cache",options:[{v:"opt_in",l:"opt-in (caller asks — default)"},{v:"off",l:"off (even if the caller asks)"},{v:"always",l:"always (every eligible dispatch)"}]},
        {name:"semanticCacheTtlSeconds",label:"cache TTL seconds",type:"number"},
        {name:"compactionFailureMode",label:"compaction failure",options:[{v:"fail_open",l:"fail open (turn proceeds, full history)"},{v:"fail_closed",l:"fail closed (turn is refused)"}]},
        {name:"summarizerSelection",label:"summarizer",options:[{v:"cheapest",l:"cheapest entitled agent (default)"},{v:"fixed_agent",l:"a fixed agent"}]},
        {name:"summarizerAgentId",label:"fixed summarizer agent",options:[CLEAR].concat(aOpts),req:false,ph:"— leave unchanged —"},
      ], "Save cache & compaction policy")
    + "<p class='dim' style='font-size:12px'>Semantic cache 'off' beats a caller's semanticCache:true — nothing is stored or served. 'always' caches every eligible single-turn dispatch even when the caller didn't ask. Compaction 'fail closed' refuses the user's turn when summarization fails, for orgs whose posture is never to send un-summarized history the system decided to compact. A fixed summarizer must still be in the calling user's own entitled roster — it can never widen entitlement; if unavailable, compaction fails per the failure mode.</p>"
    + form("f-org-dials", [
        {name:"compactionThresholdTokens",label:"compaction threshold (tokens)",type:"number"},
        {name:"compactionRecentWindow",label:"verbatim window (messages)",type:"number"},
        {name:"minCacheableTokens",label:"min cacheable prefix (tokens)",type:"number"},
        {name:"cacheReadDiscount",label:"cache read discount (0..1)",type:"number"},
        {name:"maxToolsInManifest",label:"max tools in manifest",type:"number"},
        {name:"minEditableBaselineTokens",label:"min editable baseline (tokens)",type:"number"},
        {name:"batchOverheadTokens",label:"batch overhead (tokens)",type:"number"},
        {name:"minPreprocessTokens",label:"min preprocess size (tokens)",type:"number"},
      ], "Save dials")
    + "<p class='dim' style='font-size:12px'>The numeric dials behind the techniques, previously hardcoded kernel constants. Defaults: compact past 1600 tokens keeping the 4 newest messages verbatim; mark a system prefix cacheable at 1024+ tokens with a 0.9 read discount; lazy-load at most 20 tools; diff edits over 200-token baselines; estimate 200 framing tokens per batched request; preprocess references over 200 tokens.</p>"
    + "</div>"

    // --- Compliance defaults ---------------------------------------------
    + "<h2>Compliance defaults</h2><div class='card'>"
    + form("f-org-comp", [
        {name:"defaultPiiMode",label:"default PII mode (unclassified projects)",options:[{v:"none",l:"none — no enforcement (default)"},{v:"log",l:"log — record category counts"},{v:"warn",l:"warn — proceed with warning"},{v:"block",l:"block — deny / withhold"}]},
        {name:"envKeyFallbackEnabled",label:"env-var key fallback",options:ON_OFF},
        {name:"envFallbackProviders",label:"providers allowed to fall back",options:["anthropic","openai","google","xai"],req:false,multi:true},
      ], "Save compliance defaults")
    + "<p class='dim' style='font-size:12px'>Default PII mode applies wherever a project-attributed call resolves to NO compliance-cascade PII policy (an unclassified project, or tags with no profile). A classified project's own cascade always wins — this fills the gap, it never overrides a framework. The env-var fallback lets a dispatch use ANTHROPIC_API_KEY-style server env vars when no credential is stored; regulated orgs can turn it off to force every key through the encrypted store, or narrow which providers may use it (leaving the multi-select empty keeps the stored list unchanged).</p>"
    + "<h2 style='margin-top:14px'>Env keys currently present on this server</h2>"
    + table((s.envKeys || []).map((k) => ({
        provider: k.provider, envVar: k.envVar,
        present: k.present ? "present" : "not set",
        allowed: (cur.envKeyFallbackEnabled && (cur.envFallbackProviders || []).indexOf(k.provider) !== -1) ? "fallback allowed" : "fallback blocked",
      })))
    + "<p class='dim' style='font-size:12px'>Names and presence only — a key's value is never read back by any endpoint. 'fallback blocked' means the var may exist but dispatches will not use it.</p>"
    + "</div>"

    // --- Budgets & limits --------------------------------------------------
    + "<h2>Budgets &amp; limits</h2><div class='card'>"
    + form("f-org-budget", [
        {name:"budgetEnforcement",label:"project budget enforcement",options:[{v:"block",l:"block (409 past the threshold — default)"},{v:"warn_only",l:"warn only (escalate + audit, let it run)"}]},
        {name:"budgetHardBlockPct",label:"hard-block at % of budget",type:"number"},
      ], "Save budget policy")
    + "<p class='dim' style='font-size:12px'>'Block' (default) refuses attributed dispatches once measured spend reaches the hard-block threshold, until the named approver sanctions the overage. 'Warn only' still files the overage into the Approvals Queue and audits every crossing, but lets the calls run — showback without enforcement. The threshold defaults to 100% of the project budget; setting e.g. 90 blocks earlier. The per-project alert threshold stays the softer, non-blocking warning.</p>"
    + form("f-org-workers", [
        {name:"defaultWorkerMaxTurns",label:"worker default max turns",type:"number"},
        {name:"maxWorkerTurns",label:"worker hard turn ceiling",type:"number"},
        {name:"maxAttachmentsPerDispatch",label:"max attachments / dispatch",type:"number"},
        {name:"maxAttachmentBytes",label:"max attachment bytes",type:"number"},
        {name:"imageTokenEstimateTokens",label:"image token estimate",type:"number"},
        {name:"sharedContextMaxChars",label:"node instruction max chars",type:"number"},
        {name:"nodeOutputMaxChars",label:"stored node output max chars",type:"number"},
      ], "Save limits")
    + "<p class='dim' style='font-size:12px'>Worker caps bound the pillar-7 tool-using loop: a node with no declared cap runs up to the default (6); nothing may exceed the ceiling (20 is also the absolute API wall — this can only narrow below it). The size ceilings narrow below their API walls too: at most 8 attachments of 6 MiB each (the shipped composer's own clamps), a flat 1200-token estimate per image for routing/budget, 100k-char node instructions, 20k chars of stored node output.</p>"
    + "</div>"

    // --- Approvals ----------------------------------------------------------
    + "<h2>Approvals</h2><div class='card'>"
    + form("f-org-approvals", [
        {name:"approvalQuorum",label:"human-approval quorum",options:[{v:"all",l:"all named approvers (default)"},{v:"any",l:"any one approver advances"}]},
        {name:"approvalDelegationEnabled",label:"approver delegation",options:[{v:"true",l:"enabled (delegation windows apply)"},{v:"false",l:"disabled (strict separation of duties)"}]},
      ], "Save approval policy")
    + "<p class='dim' style='font-size:12px'>Applies to workflow human_approval stages. 'All' (default — today's behaviour): the stage advances only when every named approver has approved; any denial denies it. 'Any': the first approval advances the stage and the remaining pending approvals are superseded so no dead gate lingers. Denials behave identically in both modes. Org-wide for now — a per-template stage override is recorded as deferred in ADR-0021. Approver delegation (ADR-0022): when disabled, creating delegation windows is refused and existing windows stop applying immediately — for orgs whose control posture forbids deciding in another's name.</p>"
    + "</div>"

    // --- Retention -----------------------------------------------------------
    + "<h2>Audit retention</h2><div class='card'>"
    + form("f-org-retention", [
        {name:"autoPruneEnabled",label:"scheduled auto-prune",options:[{v:"false",l:"off (manual prune only — default)"},{v:"true",l:"on (prune on a schedule)"}]},
        {name:"pruneIntervalHours",label:"prune interval (hours)",type:"number"},
        {name:"defaultAuditRetentionDays",label:"org default retention (days, 0 = none)",type:"number"},
      ], "Save retention policy")
    + "<p class='dim' style='font-size:12px'>Off by default: pruning only happens when an admin presses the button on the Audit Log page. When on, the gateway prunes on the configured interval under the SAME floor the manual button uses. The org default retention only fills the gap when no compliance profile sets one — a profile floor always wins upward, so this can never shorten a framework's audit trail. Enter 0 to clear the org default (never prune without a profile floor — today's behaviour). Every prune, manual or scheduled, is itself audited.</p>"
    + "</div>"

    // --- Sign-in & sessions (ADR-0025) -------------------------------------
    + "<h2>Sign-in &amp; sessions</h2><div class='card'>"
    + form("f-org-auth", [
        {name:"passwordMinLength",label:"password min length",type:"number"},
        {name:"passwordRequireClasses",label:"character classes required (1–4)",type:"number"},
        {name:"sessionLifetimeHours",label:"session lifetime (hours)",type:"number"},
        {name:"sessionIdleMinutes",label:"idle timeout (minutes)",type:"number"},
        {name:"mfaRequired",label:"require TOTP MFA",options:[{v:"off",l:"off (self-service — default)"},{v:"admins",l:"admins must enroll"},{v:"all",l:"everyone must enroll"}]},
        {name:"ssoOnly",label:"SSO only",options:[{v:"false",l:"off — password login allowed (default)"},{v:"true",l:"on — password login refused"}]},
        {name:"loginLockoutThreshold",label:"lock after N failed logins",type:"number"},
        {name:"loginLockoutWindowMinutes",label:"failure window (minutes)",type:"number"},
        {name:"loginLockoutMinutes",label:"lockout duration (minutes)",type:"number"},
      ], "Save sign-in policy")
    + "<p class='dim' style='font-size:12px'>ADR-0025 password/session policy for the browser login. Defaults: 12+ characters using 2 of 4 character classes; sessions live at most 24h with a 2h idle wall (any use slides the idle wall, never the lifetime); 5 failures inside 15 minutes lock the account for 15 minutes (audited; the login answer stays the same uniform 401 so lockout leaks nothing). 'Require TOTP MFA' gates enrollment at next sign-in for the chosen population. 'SSO only' refuses password logins entirely and will not engage while zero enabled OIDC providers exist (Users tab) — no self-lockouts; API keys and the bootstrap token are unaffected (they are machine credentials, not browser logins).</p>"
    + "</div>";

  // prefill every form from the stored row (field() renders unbound controls)
  const setVals = (formId, keys) => {
    const f = $("#" + formId);
    if (!f) return;
    for (const k of keys) {
      const c = f.querySelector("[name=" + k + "]");
      if (!c) continue;
      if (c.multiple) {
        const vals = (cur[k] || []).map(String);
        for (const o of c.options) o.selected = vals.indexOf(o.value) !== -1;
      } else if (cur[k] !== null && cur[k] !== undefined) {
        c.value = String(cur[k]);
      }
    }
  };
  setVals("f-org-opt", ["routingEnabled","compactionEnabled","promptCachingEnabled","editVsRewriteEnabled","filePreprocessingEnabled","lazyToolLoadingEnabled","defaultRoutingMode"]);
  setVals("f-org-cache", ["semanticCachePolicy","semanticCacheTtlSeconds","compactionFailureMode","summarizerSelection","summarizerAgentId"]);
  setVals("f-org-dials", ["compactionThresholdTokens","compactionRecentWindow","minCacheableTokens","cacheReadDiscount","maxToolsInManifest","minEditableBaselineTokens","batchOverheadTokens","minPreprocessTokens"]);
  setVals("f-org-comp", ["defaultPiiMode","envKeyFallbackEnabled","envFallbackProviders"]);
  setVals("f-org-budget", ["budgetEnforcement","budgetHardBlockPct"]);
  setVals("f-org-workers", ["defaultWorkerMaxTurns","maxWorkerTurns","maxAttachmentsPerDispatch","maxAttachmentBytes","imageTokenEstimateTokens","sharedContextMaxChars","nodeOutputMaxChars"]);
  setVals("f-org-approvals", ["approvalQuorum","approvalDelegationEnabled"]);
  setVals("f-org-retention", ["autoPruneEnabled","pruneIntervalHours","defaultAuditRetentionDays"]);
  setVals("f-org-auth", ["passwordMinLength","passwordRequireClasses","sessionLifetimeHours","sessionIdleMinutes","mfaRequired","ssoOnly","loginLockoutThreshold","loginLockoutWindowMinutes","loginLockoutMinutes"]);
  // the retention-days number input has no stored 0; show blank when null
  const retIn = $("#f-org-retention [name=defaultAuditRetentionDays]");
  if (retIn && cur.defaultAuditRetentionDays == null) retIn.value = "0";

  // each section PUTs only its own keys (a PARTIAL update server-side)
  const putOrg = (body) => api("PUT", "/v1/org/settings", body);
  const asBool = (v) => v === "true";
  wire("f-org-opt", (d) => putOrg({
    routingEnabled: asBool(d.routingEnabled),
    compactionEnabled: asBool(d.compactionEnabled),
    promptCachingEnabled: asBool(d.promptCachingEnabled),
    editVsRewriteEnabled: asBool(d.editVsRewriteEnabled),
    filePreprocessingEnabled: asBool(d.filePreprocessingEnabled),
    lazyToolLoadingEnabled: asBool(d.lazyToolLoadingEnabled),
    defaultRoutingMode: d.defaultRoutingMode,
  }));
  wire("f-org-cache", (d) => putOrg({
    semanticCachePolicy: d.semanticCachePolicy,
    semanticCacheTtlSeconds: Number(d.semanticCacheTtlSeconds),
    compactionFailureMode: d.compactionFailureMode,
    summarizerSelection: d.summarizerSelection,
    ...(d.summarizerAgentId ? { summarizerAgentId: d.summarizerAgentId === "__clear__" ? null : d.summarizerAgentId } : {}),
  }));
  wire("f-org-dials", (d) => putOrg({
    compactionThresholdTokens: Number(d.compactionThresholdTokens),
    compactionRecentWindow: Number(d.compactionRecentWindow),
    minCacheableTokens: Number(d.minCacheableTokens),
    cacheReadDiscount: Number(d.cacheReadDiscount),
    maxToolsInManifest: Number(d.maxToolsInManifest),
    minEditableBaselineTokens: Number(d.minEditableBaselineTokens),
    batchOverheadTokens: Number(d.batchOverheadTokens),
    minPreprocessTokens: Number(d.minPreprocessTokens),
  }));
  wire("f-org-comp", (d) => putOrg({
    defaultPiiMode: d.defaultPiiMode,
    envKeyFallbackEnabled: asBool(d.envKeyFallbackEnabled),
    ...(d.envFallbackProviders ? { envFallbackProviders: [].concat(d.envFallbackProviders) } : {}),
  }));
  wire("f-org-budget", (d) => putOrg({
    budgetEnforcement: d.budgetEnforcement,
    budgetHardBlockPct: Number(d.budgetHardBlockPct),
  }));
  wire("f-org-workers", (d) => putOrg({
    defaultWorkerMaxTurns: Number(d.defaultWorkerMaxTurns),
    maxWorkerTurns: Number(d.maxWorkerTurns),
    maxAttachmentsPerDispatch: Number(d.maxAttachmentsPerDispatch),
    maxAttachmentBytes: Number(d.maxAttachmentBytes),
    imageTokenEstimateTokens: Number(d.imageTokenEstimateTokens),
    sharedContextMaxChars: Number(d.sharedContextMaxChars),
    nodeOutputMaxChars: Number(d.nodeOutputMaxChars),
  }));
  wire("f-org-approvals", (d) => putOrg({ approvalQuorum: d.approvalQuorum, approvalDelegationEnabled: asBool(d.approvalDelegationEnabled) }));
  wire("f-org-retention", (d) => putOrg({
    autoPruneEnabled: asBool(d.autoPruneEnabled),
    pruneIntervalHours: Number(d.pruneIntervalHours),
    defaultAuditRetentionDays: Number(d.defaultAuditRetentionDays) === 0 ? null : Number(d.defaultAuditRetentionDays),
  }));
  wire("f-org-auth", (d) => putOrg({
    passwordMinLength: Number(d.passwordMinLength),
    passwordRequireClasses: Number(d.passwordRequireClasses),
    sessionLifetimeHours: Number(d.sessionLifetimeHours),
    sessionIdleMinutes: Number(d.sessionIdleMinutes),
    mfaRequired: d.mfaRequired,
    ssoOnly: asBool(d.ssoOnly),
    loginLockoutThreshold: Number(d.loginLockoutThreshold),
    loginLockoutWindowMinutes: Number(d.loginLockoutWindowMinutes),
    loginLockoutMinutes: Number(d.loginLockoutMinutes),
  }));
}],
];

// The nav is grouped into labelled sections; each entry names a tab by its
// title and is resolved to its TABS index at render time — so the physical
// order of the TABS array is independent of the sidebar's grouping/order.
const NAV = [
  // The guided setup journey leads the nav: it is the portal's de-facto home
  // (TABS index 0 = the hashless landing) and the first thing a new admin
  // needs. One-tab section, mirroring how Cost is grouped.
  ["Overview", ["Getting started"]],
  // "Client Access" sits in Identity & Access, not Operations: its two jobs are
  // (a) deciding which arrival surfaces exist at all and (b) handing a named
  // developer the base URL + key that lets their IDE reach one. That is the same
  // question Users/Roles/Teams answer — who may reach what, and how they
  // authenticate — rather than a day-2 operational concern.
  ["Identity & Access", ["Users", "Roles", "Teams", "Client Access"]],
  ["AI Governance", ["Agents", "Model Credentials", "Connectors", "MCP Servers"]],
  // "Organization" sits in Policy: org_settings is the layer of org-wide
  // functional DEFAULTS beneath every specific rule — the same "what does this
  // org allow / default to" question the Rules Engine answers per-object,
  // answered once for the whole deployment. A separate top-level group for one
  // tab would fragment the nav without adding meaning.
  ["Policy", ["Rules Engine", "Simulation / Access preview", "Organization"]],
  ["Delivery", ["Workflows", "Deploy Targets", "PM Connections"]],
  ["Cost", ["Cost & Projects"]],
  ["Operations", ["Infrastructure", "Approvals Queue", "Audit Log"]],
];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const tabIndex = (title) => TABS.findIndex(([t]) => t === title);
function navHtml() {
  let out = "";
  for (const [sec, titles] of NAV) {
    out += "<div class='sec'>" + esc(sec) + "</div>";
    for (const title of titles) {
      const i = tabIndex(title);
      if (i < 0) continue;
      const on = i === active;
      // aria-current marks the active tab for assistive tech; the dot is
      // decorative (aria-hidden) since the label already names the tab.
      out += "<button class='nav-item" + (on ? " active" : "") + "' data-tab='" + i + "'"
        + " aria-label='" + esc(title) + "'" + (on ? " aria-current='page'" : "") + ">"
        + "<span class='dot' aria-hidden='true'></span>" + esc(title) + "</button>";
    }
  }
  return out;
}
// deep-linking: the tab is derived from location.hash (a slug of its title), so
// a reload or a shared link lands on the same page; an unknown hash falls back
// to the first tab.
function tabFromHash() {
  const h = (location.hash || "").replace(/^#/, "");
  const i = TABS.findIndex(([name]) => slug(name) === h);
  return i >= 0 ? i : 0;
}
let active = tabFromHash();
window.addEventListener("hashchange", () => { active = tabFromHash(); render(); });
// Getting-started deep links: the selector of the form to scroll to + flash
// after the target tab renders. Consumed (once) at the end of render().
let SETUP_FOCUS = null;
// The setup checklist recomputes when the admin comes back to the tab — they
// typically complete a step in another tab/window (or via the API) and return.
window.addEventListener("focus", () => {
  if (AUTHED && TABS[active] && TABS[active][0] === "Getting started") render();
});
function shell() {
  return \`
  <div class="shell">
    <aside class="side" id="side">
      <div class="brand"><span class="word">regul<em>ai</em>t</span><span class="tag">admin</span></div>
      \${navHtml()}
      <div class="foot">
        <div class="who">admin console</div>
        <button class="ghost small" id="signout" style="margin-top:8px;padding-left:0">Sign out</button>
      </div>
    </aside>
    <main class="main">
      <button class="hamburger" id="navtoggle" aria-label="Toggle navigation" aria-expanded="false">☰ Menu</button>
      <h1 tabindex="-1">\${TABS[active][0]}</h1>
      <div id="panel"><div class="empty">loading…</div></div>
    </main>
  </div>\`;
}

async function render() {
  const root = $("#root");
  // dataTable state is per-render — drop last render's instances so the Map
  // doesn't grow across tab switches.
  DT.clear();
  if (!AUTHED) {
    // ADR-0025: probe the session cookie; only an ADMIN session opens the
    // portal. Everything else lands on the shared login gate.
    const me = await fetchAuthMe().catch(() => null);
    if (me && me.isAdmin && !me.mustChangePassword && !me.mfaSetupRequired) {
      AUTHED = me;
    } else {
      renderLoginGate(root, {
        brandHtml: '<div class="brand"><span class="word">regul<em>ai</em>t</span><span class="tag">admin</span></div>',
        returnTo: "/admin",
        requireAdmin: true,
        onSignedIn: () => render(),
      });
      return;
    }
  }
  root.innerHTML = shell();
  // nav clicks route through the hash so the current page survives a reload and
  // is shareable; the hashchange listener re-renders. (Re-clicking the active
  // tab leaves the hash unchanged, so nothing re-renders — which is correct.)
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => { location.hash = slug(TABS[Number(b.dataset.tab)][0]); }));
  const toggle = $("#navtoggle");
  if (toggle) toggle.addEventListener("click", () => {
    const side = $("#side");
    if (!side) return;
    const open = side.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  $("#signout").addEventListener("click", () => {
    authCall("POST", "/auth/logout").finally(() => { AUTHED = null; render(); });
  });
  const panel = $("#panel");
  try { await TABS[active][1](panel); }
  catch (ex) {
    panel.innerHTML = ex.status === 403
      ? "<div class='empty'>You don’t have access to this view — " + esc(ex.message) + "</div>"
      : "<div class='empty'>Couldn’t load — " + esc(ex.message) + "</div>";
  }
  // move keyboard focus to the panel heading after a (re)render so a tab switch
  // doesn't dump keyboard/AT users back at <body>.
  const h1 = $(".main h1");
  if (h1) h1.focus({ preventScroll: false });
  // a Getting-started deep link lands here: scroll the named form into view
  // and flash it so the admin sees exactly what completes the step.
  if (SETUP_FOCUS) {
    const target = $(SETUP_FOCUS);
    SETUP_FOCUS = null;
    if (target) {
      target.scrollIntoView({ block: "center" });
      target.classList.add("setup-flash");
      setTimeout(() => target.classList.remove("setup-flash"), 2400);
    }
  }
}
render();
</script>
</body>
</html>
`;
