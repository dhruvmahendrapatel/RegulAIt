/**
 * ADR-0012: the admin portal — one dependency-free HTML+JS page, served as a
 * static shell at GET /admin. Strictly a client of the public REST API: the
 * admin pastes an API key (held in sessionStorage for this tab only) and
 * every read/write goes through the same endpoints any script would use.
 * Panels use §6's names verbatim, plus the §10.4-mandated cost surface with
 * hand-rolled SVG charts (strict self-containment — no external assets).
 */

import { UI_CSS, UI_DISPLAY_JS, UI_ERRORS_JS } from "./ui-theme.js";

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
<script>
"use strict";
${UI_ERRORS_JS}
${UI_DISPLAY_JS}
const $ = (s, el) => (el ?? document).querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtUsd = (v) => v == null ? "—" : "$" + Number(v).toFixed(4).replace(/0+$/,"").replace(/\\.$/,"");
let KEY = sessionStorage.getItem("regulait.admin.key") ?? "";

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: "Bearer " + KEY, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    if (path === "/v1/users" && method === "GET") throw new Error("not an admin key");
  }
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

// short enum-ish cells that must never wrap into a vertical smear
const NOWRAP_COLS = new Set(["status", "type", "effect", "kind", "provider", "mode", "role"]);
const ISO_RE = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}/;
function table(rows, actions) {
  if (!rows || rows.length === 0) return "<div class='empty'>none yet</div>";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== "ruleChain");
  let h = "<div class='tblwrap'><table><tr>" + cols.map((c) => "<th>" + esc(c) + "</th>").join("") + (actions ? "<th></th>" : "") + "</tr>";
  for (const r of rows) {
    h += "<tr>" + cols.map((c) => {
      let v = r[c];
      if (typeof v === "object" && v !== null) v = JSON.stringify(v);
      // any raw UUID renders as a truncated chip — full id in the tooltip,
      // click to copy — never as thirteen stacked fragments
      if (typeof v === "string" && UUID_RE.test(v)) return "<td class='nowrap'>" + idChip(v) + "</td>";
      // ISO timestamps compact to date + minute, full precision in the tooltip
      if (typeof v === "string" && ISO_RE.test(v)) {
        return "<td class='mono dim nowrap' title='" + esc(v) + "'>" + esc(v.slice(0, 10) + " " + v.slice(11, 16)) + "</td>";
      }
      const cls = c === "id" || String(c).endsWith("Id") || c === "at" || c === "createdAt" ? " class='mono dim'"
        : c === "stage" ? " class='label'"
        : NOWRAP_COLS.has(c) ? " class='nowrap'" : "";
      return "<td" + cls + ">" + esc(v) + "</td>";
    }).join("");
    if (actions) h += "<td class='act'>" + actions(r) + "</td>";
    h += "</tr>";
  }
  return h + "</table></div>";
}
// An option is either a bare string (value === label) or {v,l} — the second
// form is what lets every id field become a name the operator recognizes
// instead of a UUID they have to copy in from somewhere else.
function field(f) {
  const lbl = "<label class='f'>" + esc(f.label ?? f.name) + "</label>";
  if (f.options) {
    // multi:true renders a multiple select; leaving it empty just omits the
    // field, so it never needs the "— none —" placeholder row
    const opts = (f.req === false && !f.multi ? [{ v: "", l: f.ph ?? "— none —" }] : [])
      .concat(f.options.map((o) => (typeof o === "object" ? o : { v: o, l: o })));
    if (opts.length === 0) opts.push({ v: "", l: "— none available —" });
    return "<div>" + lbl + "<select name='" + f.name + "'"
      + (f.multi ? " multiple size='" + Math.min(4, Math.max(2, opts.length)) + "'" : "")
      + (f.req === false ? " data-optional='true'" : " required")
      + ">" + opts.map((o) => "<option value='" + esc(o.v) + "'>" + esc(o.l) + "</option>").join("")
      + "</select></div>";
  }
  return "<div" + (f.grow ? " class='grow'" : "") + ">" + lbl
    + "<input name='" + f.name + "' type='" + esc(f.type ?? "text") + "'"
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
    try { await fn(data); if (!keep) render(); } catch (ex) { err.textContent = ex.message; }
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
function budgetGauge(spent, cap, overageApproved) {
  if (cap == null) return "<span class='dim'>no budget set</span>";
  const pct = Math.min(100, (spent / cap) * 100);
  const over = spent > cap;
  return \`<div class="row"><span class="num">\${fmtUsd(spent)}</span><span class="dim">of \${fmtUsd(cap)}</span>
    \${over ? '<span class="badge ' + (overageApproved ? "warn" : "bad") + '">' + (overageApproved ? "overage approved" : "over budget") + "</span>" : ""}</div>
    <div class="bar" style="margin-top:8px"><i class="\${over ? "over" : ""}" style="width:\${pct}%"></i></div>\`;
}

// --- §6's eight functional surfaces + the §10.4 cost surface -------------
const TABS = [
["Users & Roles", async (el) => {
  const [u, r, rev, srv, k] = await Promise.all([
    get("/v1/users"), get("/v1/roles"), get("/v1/revocations"), get("/v1/servers"), get("/v1/keys"),
  ]);
  const tools = await toolIndex(srv.servers);
  const uOpts = userOpts(u.users), sOpts = serverOpts(srv.servers);
  const email = Object.fromEntries(u.users.map((x) => [x.id, x.email]));
  el.innerHTML = "<h2>Users</h2><div class='card'>"
    + form("f-user", [{name:"email"},{name:"displayName"},{name:"isAdmin",label:"admin",options:["false","true"]}], "Create user")
    + table(u.users, (row) => "<button class='small' data-key='" + row.id + "'>issue key</button>") + "</div>"
    + "<div id='keyreveal'></div>"
    // A user with no API key cannot sign in to anything — issuing one is part
    // of creating them, not a separate API-only chore.
    + "<h2>API keys — plaintext returned exactly once, sha256 at rest</h2><div class='card'>"
    + table(k.keys.map((x) => ({
        id: x.id, name: x.name, user: email[x.userId] ?? x.userId, created: x.createdAt,
        lastUsed: x.lastUsedAt ?? "never", status: x.revokedAt ? "revoked" : "active",
      })), (row) => row.status === "active"
        ? "<button class='small danger' data-revoke='" + row.id + "'>revoke</button>" : "")
    + "</div>"
    + "<h2>Roles</h2><div class='card'>" + form("f-role", [{name:"name"},{name:"description",req:false}], "Create role")
    + form("f-assign", [{name:"userId",label:"user",options:uOpts},{name:"roleId",label:"role",options:roleOpts(r.roles)}], "Assign role")
    + table(r.roles) + "</div>"
    + "<h2>Per-user overrides — revocations, visibly flagged deviations</h2><div class='card'>"
    + form("f-revoke", [{name:"userId",label:"user",options:uOpts},{name:"serverId",label:"server",options:sOpts},{name:"toolName",label:"tool",options:[],req:false}], "Add revocation")
    + table(rev.revocations) + "</div>";
  linkTools("f-revoke", tools);
  el.querySelectorAll("[data-key]").forEach((b) => b.addEventListener("click", async () => {
    try {
      const issued = await post("/v1/users/" + b.dataset.key + "/keys", { name: "portal" });
      revealSecret("#keyreveal", "API key for " + (email[b.dataset.key] ?? "this user"), issued.token,
        "Hand it to them over a channel you trust; if it is lost, revoke it and issue another.");
      $("#keyreveal").scrollIntoView({ block: "nearest" });
    } catch (ex) { alert(ex.message); }
  }));
  el.querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", async () => {
    try { await post("/v1/keys/" + b.dataset.revoke + "/revoke", {}); render(); }
    catch (ex) { alert(ex.message); }
  }));
  wire("f-user", (d) => post("/v1/users", { ...d, isAdmin: d.isAdmin === "true" }));
  wire("f-role", (d) => post("/v1/roles", d));
  wire("f-assign", (d) => post("/v1/users/" + d.userId + "/roles", { roleId: d.roleId }));
  wire("f-revoke", (d) => post("/v1/revocations", { ...d, toolName: d.toolName ?? null }));
}],
["Agent Governance", async (el) => {
  const [a, u] = await Promise.all([get("/v1/agents"), get("/v1/users")]);
  const uOpts = userOpts(u.users), aOpts = agentOpts(a.agents);
  const agentName = Object.fromEntries(a.agents.map((x) => [x.id, x.name]));
  // "leave unchanged" is the endpoint's own semantics (an omitted field is
  // untouched); "clear" is the only way to actually null one out, so it has
  // to be a distinct choice rather than an empty box.
  const KEEP = { v: "", l: "— leave unchanged —" }, CLEAR = { v: "__clear__", l: "— clear —" };
  el.innerHTML = "<h2>Agent catalog</h2><div class='card'>"
    + table(a.agents, (r) => "<button class='small' data-agent='" + r.id + "' data-en='" + !r.enabled + "'>" + (r.enabled ? "disable" : "enable") + "</button>") + "</div>"
    + "<h2>Grant an agent</h2><div class='card'>"
    + form("f-agrant", [{name:"userId",label:"user",options:uOpts},{name:"agentId",label:"agent",options:aOpts}], "Grant") + "</div>"
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
    try { await del("/v1/model-credentials/" + encodeURIComponent(b.dataset.mcred)); render(); }
    catch (ex) { alert(ex.message); }
  }));
  wire("f-mcred", (d) => post("/v1/model-credentials", d));
  wire("f-ucred", async (d) => {
    const v = await get("/v1/users/" + d.userId + "/model-credentials");
    $("#ucred").innerHTML = (v.credentials.length
      ? table(v.credentials.map((c) => ({ provider: c.provider, baseUrl: c.baseUrl ?? "provider default", addedAt: c.createdAt })),
          (r) => "<button class='small danger' data-ucred='" + esc(r.provider) + "' data-uid='" + esc(d.userId) + "'>remove</button>")
      : "<div class='empty'>this user has no keys of their own — their dispatches use the platform credential</div>");
    $("#ucred").querySelectorAll("[data-ucred]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await del("/v1/users/" + b.dataset.uid + "/model-credentials/" + encodeURIComponent(b.dataset.ucred));
        $("#f-ucred").requestSubmit();
      } catch (ex) { alert(ex.message); }
    }));
  }, true);
}],
["Connector Governance", async (el) => {
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
["MCP Server Governance", async (el) => {
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
["Policy & Rules Engine", async (el) => {
  const [ap, ds, rl, u, s] = await Promise.all([
    get("/v1/rules/approvals"), get("/v1/rules/data-scopes"), get("/v1/rules/rate-limits"),
    get("/v1/users"), get("/v1/servers"),
  ]);
  const tools = await toolIndex(s.servers);
  const uOpts = userOpts(u.users), sOpts = serverOpts(s.servers);
  const subject = [{name:"userId",label:"user",options:uOpts},{name:"serverId",label:"server",options:sOpts},{name:"toolName",label:"tool",options:[],req:false}];
  el.innerHTML = "<h2>Approval rules</h2><div class='card'>"
    + form("f-apr", subject.concat([{name:"approverUserId",label:"approver",options:uOpts}]), "Add") + table(ap.rules) + "</div>"
    + "<h2>Data-scope rules</h2><div class='card'>"
    + form("f-dsr", subject.concat([{name:"argPath",label:"arg path",ph:"e.g. database"},{name:"allowedValues",label:"allowed values",ph:"comma,separated"}]), "Add") + table(ds.rules) + "</div>"
    + "<h2>Rate limits</h2><div class='card'>"
    + form("f-rlr", subject.concat([{name:"maxCalls",label:"max calls",type:"number"},{name:"windowSeconds",label:"window seconds",type:"number"}]), "Add") + table(rl.rules) + "</div>";
  for (const id of ["f-apr", "f-dsr", "f-rlr"]) linkTools(id, tools);
  wire("f-apr", (d) => post("/v1/rules/approvals", d));
  wire("f-dsr", (d) => post("/v1/rules/data-scopes", { ...d, allowedValues: String(d.allowedValues).split(",") }));
  wire("f-rlr", (d) => post("/v1/rules/rate-limits", { ...d, maxCalls: Number(d.maxCalls), windowSeconds: Number(d.windowSeconds) }));
}],
["Workflows", async (el) => {
  // Pillar 2's admin home: templates (with their stage chain), the assignment
  // rules that route changes to them, and the git connections their
  // git_operation stages execute against.
  const [t, r, g] = await Promise.all([
    get("/v1/workflows/templates"),
    get("/v1/workflows/assignment-rules"),
    get("/v1/git/connections").catch(() => ({ connections: [] })),
  ]);
  const tplName = Object.fromEntries(t.templates.map((x) => [x.id, x.name]));
  const tplOpts = t.templates.map((x) => ({ v: x.id, l: x.name }));
  const rail = (def) => "<div class='stage-rail' style='margin-top:6px'>"
    + (def.stages ?? []).map((s) => "<span class='stage'>" + esc(s.id)
      + "<span class='faint' style='font-size:10px'>" + esc(s.type) + "</span></span>").join("")
    + "</div>";
  const conds = (x) => [
    x.pathPattern ? "path " + x.pathPattern : null,
    x.changeType ? "type " + x.changeType : null,
    x.environment ? "env " + x.environment : null,
  ].filter(Boolean).join(" + ");
  const tplRows = t.templates.map((tpl) => {
    const assigned = r.rules.filter((x) => x.templateId === tpl.id);
    return "<div class='node-row' style='align-items:flex-start'><div class='grow'>"
      + "<div><strong>" + esc(tpl.name) + "</strong>"
      + (tpl.definition.costSensitivity ? " <span class='badge'>" + esc(tpl.definition.costSensitivity) + "</span>" : "") + "</div>"
      + rail(tpl.definition)
      + "<div class='dim' style='font-size:12px;margin-top:6px'>"
      + (assigned.length ? "routed when: " + esc(assigned.map(conds).join("  |  ")) : "no assignment rule routes here — reachable only via compliance cascade or an admin's explicit pick")
      + "</div></div></div>";
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
      ], "Add rule")
    + table(r.rules.map((x) => ({
        id: x.id, template: tplName[x.templateId] ?? x.templateId,
        matches: conds(x), created: x.createdAt,
      })), (row) => "<button class='small danger' data-rdel='" + row.id + "'>delete</button>")
    + "<p class='dim' style='font-size:12px'>Conditions AND together; set at least one. Every rule that matches a change contributes its template — the merged flow keeps every sign-off. Deleting a rule stops the routing; in-flight instances keep their snapshotted definition.</p></div>"
    + "<h2>Git connections — what git_operation stages execute against</h2><div class='card'>"
    + form("f-git", [
        {name:"name",ph:"e.g. demo-git"},
        {name:"provider",options:["mock","github","gitlab","bitbucket","azure_devops"]},
        {name:"baseUrl",label:"base url",req:false,ph:"optional (e.g. GHE)"},
        {name:"token",type:"password",ph:"never shown again",grow:true},
      ], "Add connection")
    + table(g.connections.map((c) => ({
        name: c.name, provider: c.provider, baseUrl: c.baseUrl ?? "provider default", created: c.createdAt,
      })))
    + "<p class='dim' style='font-size:12px'>Tokens are AES-256-GCM encrypted at rest and never returned by any endpoint. Templates reference a connection by name. The demo runs entirely on the mock provider — no external service is touched.</p></div>";

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
    try { await del("/v1/workflows/assignment-rules/" + b.dataset.rdel); render(); }
    catch (ex) { alert(ex.message); }
  }));
  wire("f-wfrule", (d) => post("/v1/workflows/assignment-rules", d));
  wire("f-git", (d) => post("/v1/git/connections", d));
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
        webhookUrl: "/v1/pm/webhooks/" + x.name,
        created: x.createdAt,
      })))
    + "<p class='dim' style='font-size:12px'>Tokens are AES-256-GCM encrypted at rest and never returned by any endpoint. Inbound events POST to the webhook URL with the connection's secret in <span class='mono'>x-regulait-webhook-secret</span> — the secret is shown exactly once at creation and only its hash is stored.</p></div>"
    + "<h2>Add a connection</h2><div class='card'>"
    + form("f-pmconn", [
        {name:"name",ph:"e.g. demo-pm"},
        {name:"provider",options:["mock","jira","azure_devops","linear","asana"]},
        {name:"project",ph:"e.g. REGULAIT-DEMO"},
        {name:"baseUrl",label:"base url",req:false,ph:"required for jira / azure_devops"},
        {name:"token",type:"password",ph:"never shown again",grow:true},
      ], "Add connection")
    + "<p class='dim' style='font-size:12px'>The select offers exactly the providers the registry can dispatch today — monday and the generic webhook adapter are interface-ready but not yet implemented, so they are deliberately not offered. jira and azure_devops need their base URL (e.g. https://&lt;site&gt;.atlassian.net, https://dev.azure.com/&lt;org&gt;). The demo runs entirely on the mock provider — no external service is touched.</p></div>"
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
["Audit & Activity Log", async (el) => {
  const u = await get("/v1/users");
  // the users list is already here for the filter — reuse it so the table
  // says who acted by name (an unknown id still renders as a truncated chip)
  const uname = Object.fromEntries(u.users.map((x) => [x.id, x.displayName || x.email]));
  el.innerHTML = "<div class='card'>"
    + form("f-audit", [{name:"userId",label:"filter by user",options:userOpts(u.users),req:false,ph:"— all users —"}], "Load")
    + "<div id='auditout'></div></div>";
  const load = async (userId) => {
    const a = await get("/v1/audit" + (userId ? "?userId=" + userId : ""));
    $("#auditout").innerHTML = table(a.entries.map((e) => ({
      at: e.at, user: uname[e.userId] ?? e.userId, object: e.objectType, effect: e.effect, rule: e.ruleId, reason: e.reason,
    })));
  };
  wire("f-audit", (d) => load(d.userId), true);
  await load("");
}],
["Approvals Queue", async (el) => {
  // /v1/me names the signed-in admin: on rows naming someone else the decide
  // is an OVERRIDE — the endpoint requires a reason and audit-marks it.
  const [a, me] = await Promise.all([get("/v1/approvals"), get("/v1/me").catch(() => ({ userId: null }))]);
  el.innerHTML = "<p class='sub'>The one inbox: MCP pauses, workflow sign-offs, run escalations, budget overages, context conflicts, reclassifications. The named approver decides; an admin may decide in their place only with a recorded reason (audit-marked as an override).</p><div class='card'>"
    + table(a.approvals.map((r) => ({
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
      (r) => {
        const row = a.approvals.find((x) => x.id === r.id);
        if (row.status !== "pending") return "";
        const override = me.userId !== row.approverUserId;
        return "<input data-reason='" + row.id + "' placeholder='" + (override ? "reason (override)" : "reason (optional)") + "' title='" + (override ? "required — you are not the named approver" : "optional") + "' style='font-size:12px;width:140px'> "
          + "<button class='small primary' data-dec='approved' data-id='" + row.id + "'>approve</button> "
          + "<button class='small danger' data-dec='denied' data-id='" + row.id + "'>deny</button>"
          + (override ? " <span class='badge warn'>override</span>" : "");
      }) + "</div>";
  el.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", async () => {
    const reason = (el.querySelector("[data-reason='" + b.dataset.id + "']")?.value ?? "").trim();
    try { await post("/v1/approvals/" + b.dataset.id + "/decide", { decision: b.dataset.dec, ...(reason ? { reason } : {}) }); render(); }
    catch (ex) { alert(ex.message); }
  }));
}],
["Simulation / Access preview", async (el) => {
  const [u, s] = await Promise.all([get("/v1/users"), get("/v1/servers")]);
  const tools = await toolIndex(s.servers);
  el.innerHTML = "<p class='sub'>Would this call be allowed right now? Evaluates live policy without executing anything.</p><div class='card'>"
    + form("f-sim", [{name:"userId",label:"user",options:userOpts(u.users)},{name:"serverId",label:"server",options:serverOpts(s.servers)},{name:"toolName",label:"tool",options:[]}], "Evaluate")
    + "<pre id='simout'>—</pre></div>";
  linkTools("f-sim", tools);
  wire("f-sim", async (d) => {
    $("#simout").textContent = JSON.stringify(await post("/v1/evaluate", d), null, 2);
  }, true);
}],
["Cost & Projects", async (el) => {
  const [p, u, cp, t] = await Promise.all([
    get("/v1/projects"), get("/v1/users"), get("/v1/compliance/profiles"), get("/v1/teams"),
  ]);
  const uOpts = userOpts(u.users);
  const uname = Object.fromEntries(u.users.map((x) => [x.id, x.displayName || x.email]));
  const tagOpts = cp.profiles.map((x) => x.tag);
  const pOpts = p.projects.map((x) => ({ v: x.id, l: x.name }));
  const teamOpts = t.teams.map((x) => ({ v: x.id, l: x.name }));
  const KEEP = { v: "", l: "— leave unchanged —" }, CLEAR = { v: "__clear__", l: "— clear —" };
  el.innerHTML = "<h2>Create a project</h2><div class='card'>"
    + form("f-proj", [
        {name:"name"},
        {name:"costCenter",label:"cost center",req:false,ph:"e.g. CC-0042"},
        {name:"budgetUsd",label:"budget usd",type:"number",req:false,ph:"e.g. 25"},
        {name:"budgetApproverUserId",label:"budget approver",options:uOpts,req:false,ph:"— none —"},
        {name:"arbiterUserId",label:"context arbiter",options:uOpts,req:false,ph:"— none —"},
        {name:"classifications",label:"classifications",options:tagOpts,req:false,multi:true},
      ], "Create project")
    + "<p class='dim' style='font-size:12px'>A budget only exists together with its named budget approver — set both or neither; the API refuses one without the other. Classifications (ctrl/cmd-click for several) come from the compliance profiles and cascade that framework's required workflows, PII mode and retention onto everything the project governs — changing them later goes through the reclassification review, never a plain edit.</p></div>"
    + "<h2>Projects — fleet spend</h2><div class='card'>"
    + table(p.projects.map((r) => ({ name: r.name, costCenter: r.costCenter, spent: fmtUsd(r.spentUsd), budget: fmtUsd(r.budgetUsd), classifications: (r.classifications ?? []).join(", ") })),
      (r) => {
        const id = p.projects.find((x) => x.name === r.name).id;
        return "<button class='small' data-proj='" + id + "'>rollup</button> <button class='small' data-pedit='" + id + "'>edit</button>";
      })
    + "</div><div id='projout'></div>"
    + "<h2>Edit a project — budget, approver, arbiter, cost center, name</h2><div class='card'>"
    + form("f-pedit", [
        {name:"projectId",label:"project",options:pOpts},
        {name:"name",label:"new name",req:false,ph:"leave unchanged"},
        {name:"costCenter",label:"cost center",req:false,ph:"leave unchanged"},
        {name:"budgetUsd",label:"budget usd",type:"number",req:false,ph:"leave unchanged"},
        {name:"budgetApproverUserId",label:"budget approver",options:[CLEAR].concat(uOpts),req:false,ph:KEEP.l},
        {name:"arbiterUserId",label:"arbiter",options:[CLEAR].concat(uOpts),req:false,ph:KEEP.l},
      ], "Save changes")
    + "<p class='dim' style='font-size:12px'>Only the fields you fill in change. A budget still requires a named approver after the edit — the API holds the invariant against the merged result. Classifications are absent on purpose: reclassification is a governed diff-then-approve change with its own flow.</p></div>"
    + "<h2>Teams</h2><div class='card'>"
    + form("f-team", [
        {name:"name",ph:"team name"},
        {name:"defaultClassifications",label:"default classifications",options:tagOpts,req:false,multi:true},
      ], "Create team")
    + form("f-tmadd", [
        {name:"teamId",label:"team",options:teamOpts},
        {name:"userId",label:"user",options:uOpts},
      ], "Add member")
    + table(t.teams.map((x) => ({
        name: x.name,
        members: (x.members ?? []).map((m) => m.name).join(", ") || "—",
        defaultClassifications: (x.defaultClassifications ?? []).join(", "),
        created: x.createdAt,
      })))
    + "<p class='dim' style='font-size:12px'>Team membership is flat — per-user roles (owner/contributor/viewer) live on Shared-Project membership, not here. A team's default classifications are surfaced (never silently resolved) when a member joins a project whose tags don't cover them.</p></div>";
  el.querySelectorAll("[data-pedit]").forEach((b) => b.addEventListener("click", () => {
    const f = $("#f-pedit");
    f.querySelector("[name=projectId]").value = b.dataset.pedit;
    f.scrollIntoView({ block: "center" });
  }));
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
      ...(d.arbiterUserId ? { arbiterUserId: d.arbiterUserId } : {}),
      ...(d.classifications ? { classifications: [].concat(d.classifications) } : {}),
    });
  });
  wire("f-pedit", (d) => {
    const body = {};
    if (d.name) body.name = d.name;
    if (d.costCenter) body.costCenter = d.costCenter;
    if ("budgetUsd" in d) body.budgetUsd = Number(d.budgetUsd);
    for (const k of ["budgetApproverUserId", "arbiterUserId"]) if (k in d) body[k] = d[k] === "__clear__" ? null : d[k];
    return patch("/v1/projects/" + d.projectId, body);
  });
  wire("f-team", (d) => post("/v1/teams", {
    name: d.name,
    ...(d.defaultClassifications ? { defaultClassifications: [].concat(d.defaultClassifications) } : {}),
  }));
  wire("f-tmadd", (d) => post("/v1/teams/" + d.teamId + "/members", { userId: d.userId }));
  el.querySelectorAll("[data-proj]").forEach((b) => b.addEventListener("click", async () => {
    const [costs, compliance] = await Promise.all([
      get("/v1/projects/" + b.dataset.proj + "/costs"),
      get("/v1/projects/" + b.dataset.proj + "/compliance"),
    ]);
    const m = costs.measured ?? {};
    $("#projout").innerHTML =
      "<h2>" + esc(costs.project.name) + "</h2>"
      + "<div class='grid2'>"
      + "<div class='card stat'><div class='v'>" + fmtUsd(m.costUsd) + "</div><div class='l'>measured spend · " + (m.events ?? 0) + " calls</div></div>"
      + "<div class='card stat'><div class='v'>" + fmtUsd(costs.forecast?.projectedEomUsd) + "</div><div class='l'>projected month-end · " + esc(costs.forecast?.basis ?? "") + "</div></div>"
      + "<div class='card stat'><div class='v'>" + (m.inputTokens ?? 0) + " → " + (m.outputTokens ?? 0) + "</div><div class='l'>tokens in → out</div></div>"
      + "<div class='card stat'><div class='v'>" + fmtUsd(m.measuredCostSavedUsd) + "</div><div class='l'>measured savings (pillar 6)</div></div>"
      + "</div>"
      + "<h2>Budget vs actual</h2><div class='card'>" + budgetGauge(costs.budget.spentUsd, costs.budget.budgetUsd, costs.budget.overageApproved) + "</div>"
      + "<h2>Showback by user</h2><div class='card'>" + barChart(costs.byUser, "costUsd", (i) => uname[i.userId] ?? i.userId) + "</div>"
      + "<h2>By agent / model</h2><div class='card'>" + barChart(costs.byAgent, "costUsd", (i) => i.model) + "</div>"
      + "<h2>Estimated savings by technique</h2><div class='card'>" + barChart(costs.estimatedSavings, "estimatedCostSavedUsd", (i) => i.technique) + "</div>"
      + "<h2>Compliance — effective policy + enforcement labels</h2><div class='card'><pre>" + esc(JSON.stringify(compliance, null, 2)) + "</pre></div>";
  }));
}],
];

let active = 0;
function shell(content) {
  return \`
  <div class="shell">
    <aside class="side">
      <div class="brand"><span class="word">regul<em>ai</em>t</span><span class="tag">admin</span></div>
      <div class="sec">Governance</div>
      \${TABS.map(([name], i) => \`
        <button class="nav-item \${i === active ? "active" : ""}" data-tab="\${i}">
          <span class="dot"></span>\${name}
        </button>\`).join("")}
      <div class="foot">
        <div class="who">admin console</div>
        <button class="ghost small" id="signout" style="margin-top:8px;padding-left:0">Sign out</button>
      </div>
    </aside>
    <main class="main">
      <h1>\${TABS[active][0]}</h1>
      <div id="panel"><div class="empty">loading…</div></div>
    </main>
  </div>\`;
}

async function render() {
  const root = $("#root");
  if (!KEY) {
    root.innerHTML = \`
    <div class="gate"><div class="card">
      <div class="brand"><span class="word">regul<em>ai</em>t</span><span class="tag">admin</span></div>
      <p>Sign in with an admin API key. It stays in this browser tab and is sent only to this server.</p>
      <input id="gate-key" type="password" placeholder="rgl_…" style="width:100%" autofocus>
      <div class="err-line" id="gate-err" style="margin:6px 0"></div>
      <button class="primary" id="gate-go" style="width:100%;margin-top:6px">Continue</button>
    </div></div>\`;
    const go = async () => {
      KEY = $("#gate-key").value.trim();
      try { await get("/v1/users"); sessionStorage.setItem("regulait.admin.key", KEY); render(); }
      catch (ex) { KEY = ""; $("#gate-err").textContent = "That key didn’t work: " + ex.message; }
    };
    $("#gate-go").addEventListener("click", go);
    $("#gate-key").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    return;
  }
  root.innerHTML = shell();
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => { active = Number(b.dataset.tab); render(); }));
  $("#signout").addEventListener("click", () => { sessionStorage.removeItem("regulait.admin.key"); KEY = ""; render(); });
  const panel = $("#panel");
  try { await TABS[active][1](panel); }
  catch (ex) { panel.innerHTML = "<div class='empty'>Couldn’t load — " + esc(ex.message) + "</div>"; }
}
render();
</script>
</body>
</html>
`;
