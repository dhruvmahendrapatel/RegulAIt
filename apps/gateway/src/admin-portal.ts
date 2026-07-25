/**
 * ADR-0012: the admin portal MVP — one dependency-free HTML+JS page, served
 * as a static shell at GET /admin. It is STRICTLY a client of the public
 * REST API: the admin pastes an API key (held in a JS variable only, never
 * persisted) and every read/write goes through the same endpoints any script
 * would use. Tabs use §6's eight panel names verbatim, plus the §10.4 cost
 * surface, so coverage gaps stay visible.
 */

export const ADMIN_PORTAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RegulAIt Admin</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; }
header { display: flex; gap: 1rem; align-items: center; padding: .6rem 1rem; border-bottom: 1px solid #8884; }
header h1 { font-size: 1rem; margin: 0; }
header input { flex: 1; max-width: 28rem; padding: .3rem .5rem; }
nav { display: flex; flex-wrap: wrap; gap: .25rem; padding: .5rem 1rem; border-bottom: 1px solid #8884; }
nav button { padding: .35rem .7rem; border: 1px solid #8886; background: transparent; border-radius: .4rem; cursor: pointer; }
nav button.active { background: #4a6cf7; color: #fff; border-color: #4a6cf7; }
main { padding: 1rem; }
section { display: none; }
section.active { display: block; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; font-size: .85rem; }
th, td { border: 1px solid #8884; padding: .25rem .5rem; text-align: left; vertical-align: top; max-width: 26rem; overflow-wrap: anywhere; }
th { background: #8881; }
form.inline { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin: .4rem 0; }
form.inline input, form.inline select { padding: .25rem .4rem; }
button.small { padding: .2rem .5rem; font-size: .8rem; cursor: pointer; }
pre { background: #8881; padding: .6rem; overflow: auto; font-size: .8rem; }
.err { color: #d33; }
h2 { font-size: 1rem; margin: 1rem 0 .25rem; }
.note { font-size: .8rem; opacity: .75; }
</style>
</head>
<body>
<header>
  <h1>RegulAIt Admin</h1>
  <input id="apikey" type="password" placeholder="Paste an admin API key (kept in memory only)">
  <button id="connect" class="small">Connect</button>
  <span id="status" class="note">disconnected</span>
</header>
<nav id="tabs"></nav>
<main id="main"></main>
<script>
"use strict";
let KEY = "";
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: "Bearer " + KEY, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(res.status + " " + (json.error ?? text));
  return json;
}
const get = (p) => api("GET", p);
const post = (p, b) => api("POST", p, b);

function table(rows, actions) {
  if (!rows || rows.length === 0) return "<p class='note'>none</p>";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  let h = "<table><tr>" + cols.map((c) => "<th>" + esc(c) + "</th>").join("") + (actions ? "<th></th>" : "") + "</tr>";
  for (const r of rows) {
    h += "<tr>" + cols.map((c) => "<td>" + esc(typeof r[c] === "object" && r[c] !== null ? JSON.stringify(r[c]) : r[c]) + "</td>").join("");
    if (actions) h += "<td>" + actions(r) + "</td>";
    h += "</tr>";
  }
  return h + "</table>";
}
function form(id, fields, label) {
  return "<form class='inline' id='" + id + "'>" +
    fields.map((f) => f.options
      ? "<select name='" + f.name + "'>" + f.options.map((o) => "<option>" + esc(o) + "</option>").join("") + "</select>"
      : "<input name='" + f.name + "' placeholder='" + esc(f.ph ?? f.name) + "'" + (f.req === false ? "" : " required") + ">"
    ).join("") + "<button class='small'>" + esc(label) + "</button> <span class='err'></span></form>";
}
function wire(id, fn) {
  $("#" + id).addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = e.target.querySelector(".err"); err.textContent = "";
    const data = Object.fromEntries(new FormData(e.target).entries());
    for (const k of Object.keys(data)) if (data[k] === "") delete data[k];
    try { await fn(data); render(); } catch (ex) { err.textContent = ex.message; }
  });
}

// §6's eight functional surfaces, verbatim, plus the §10.4 cost surface.
const TABS = [
["Users & Roles", async (el) => {
  const [u, r, rev] = await Promise.all([get("/v1/users"), get("/v1/roles"), get("/v1/revocations")]);
  el.innerHTML = "<h2>Users</h2>" + form("f-user", [{name:"email"},{name:"displayName"}], "Create user")
    + table(u.users)
    + "<h2>Roles</h2>" + form("f-role", [{name:"name"},{name:"description",req:false}], "Create role")
    + form("f-assign", [{name:"userId"},{name:"roleId"}], "Assign role") + table(r.roles)
    + "<h2>Per-user overrides (revocations — visibly flagged deviations)</h2>"
    + form("f-revoke", [{name:"userId"},{name:"serverId"},{name:"toolName",req:false}], "Add revocation")
    + table(rev.revocations);
  wire("f-user", (d) => post("/v1/users", d));
  wire("f-role", (d) => post("/v1/roles", d));
  wire("f-assign", (d) => post("/v1/users/" + d.userId + "/roles", { roleId: d.roleId }));
  wire("f-revoke", (d) => post("/v1/revocations", { ...d, toolName: d.toolName ?? null }));
}],
["Agent Governance", async (el) => {
  const a = await get("/v1/agents");
  el.innerHTML = "<h2>Agent catalog</h2>"
    + table(a.agents, (r) => "<button class='small' data-agent='" + r.id + "' data-en='" + !r.enabled + "'>" + (r.enabled ? "disable" : "enable") + "</button>")
    + "<h2>Grant an agent</h2>" + form("f-agrant", [{name:"userId"},{name:"agentId"}], "Grant")
    + "<h2>Per-user entitlement</h2>" + form("f-aview", [{name:"userId"}], "View") + "<div id='aview'></div>";
  el.querySelectorAll("[data-agent]").forEach((b) => b.addEventListener("click", async () => {
    await post("/v1/agents/" + b.dataset.agent + "/enabled", { enabled: b.dataset.en === "true" }); render();
  }));
  wire("f-agrant", (d) => post("/v1/grants/agents", d));
  $("#f-aview").addEventListener("submit", async (e) => {
    e.preventDefault();
    const userId = new FormData(e.target).get("userId");
    const v = await get("/v1/users/" + userId + "/agents");
    $("#aview").innerHTML = table(v.agents) + "<p class='note'>default: " + esc(v.defaultAgentId) + " · ceiling: " + esc(v.ceilingAgentId) + "</p>";
  });
}],
["Connector Governance", async (el) => {
  const c = await get("/v1/connectors");
  el.innerHTML = "<h2>Connector catalog</h2>" + form("f-conn", [{name:"name"},{name:"kind"}], "Create") + table(c.connectors)
    + "<h2>Grant (mode + data scope)</h2>"
    + form("f-cgrant", [{name:"userId"},{name:"connectorId"},{name:"mode",options:["read","readwrite"]}], "Grant")
    + "<h2>Per-user entitlement</h2>" + form("f-cview", [{name:"userId"}], "View") + "<div id='cview'></div>";
  wire("f-conn", (d) => post("/v1/connectors", d));
  wire("f-cgrant", (d) => post("/v1/grants/connectors", d));
  $("#f-cview").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = await get("/v1/users/" + new FormData(e.target).get("userId") + "/connectors");
    $("#cview").innerHTML = table(v.connectors);
  });
}],
["MCP Server Governance", async (el) => {
  const s = await get("/v1/servers");
  el.innerHTML = "<h2>Server registry</h2>" + form("f-srv", [{name:"name"},{name:"url"}], "Register") + table(s.servers, (r) => "<button class='small' data-srv='" + r.id + "'>tools</button>")
    + "<div id='srvtools'></div>"
    + "<h2>Tool-level allow-list grants</h2>"
    + form("f-tgrant", [{name:"userId"},{name:"serverId"},{name:"toolName"}], "Grant tool")
    + form("f-sgrant", [{name:"userId"},{name:"serverId"},{name:"readOnlyAll",options:["true","false"]}], "Grant server");
  el.querySelectorAll("[data-srv]").forEach((b) => b.addEventListener("click", async () => {
    const t = await get("/v1/servers/" + b.dataset.srv + "/tools");
    $("#srvtools").innerHTML = "<h2>Tool inventory (auto-discovered on proxy use)</h2>" + table(t.tools);
  }));
  wire("f-tgrant", (d) => post("/v1/grants/tools", d));
  wire("f-sgrant", (d) => post("/v1/grants/servers", { ...d, readOnlyAll: d.readOnlyAll === "true" }));
}],
["Policy & Rules Engine", async (el) => {
  const [ap, ds, rl] = await Promise.all([
    get("/v1/rules/approvals"), get("/v1/rules/data-scopes"), get("/v1/rules/rate-limits"),
  ]);
  el.innerHTML = "<h2>Approval rules</h2>"
    + form("f-apr", [{name:"userId"},{name:"serverId"},{name:"toolName",req:false},{name:"approverUserId"}], "Add") + table(ap.rules)
    + "<h2>Data-scope rules</h2>"
    + form("f-dsr", [{name:"userId"},{name:"serverId"},{name:"toolName",req:false},{name:"argPath"},{name:"allowedValues",ph:"comma,separated"}], "Add") + table(ds.rules)
    + "<h2>Rate limits</h2>"
    + form("f-rlr", [{name:"userId"},{name:"serverId"},{name:"toolName",req:false},{name:"maxCalls"},{name:"windowSeconds"}], "Add") + table(rl.rules);
  wire("f-apr", (d) => post("/v1/rules/approvals", d));
  wire("f-dsr", (d) => post("/v1/rules/data-scopes", { ...d, allowedValues: String(d.allowedValues).split(",") }));
  wire("f-rlr", (d) => post("/v1/rules/rate-limits", { ...d, maxCalls: Number(d.maxCalls), windowSeconds: Number(d.windowSeconds) }));
}],
["Audit & Activity Log", async (el) => {
  el.innerHTML = form("f-audit", [{name:"userId",ph:"filter by userId (optional)",req:false}], "Load") + "<div id='auditout'></div>";
  const load = async (userId) => {
    const a = await get("/v1/audit" + (userId ? "?userId=" + userId : ""));
    $("#auditout").innerHTML = table(a.entries);
  };
  $("#f-audit").addEventListener("submit", (e) => { e.preventDefault(); load(new FormData(e.target).get("userId")); });
  await load("");
}],
["Approvals Queue", async (el) => {
  const a = await get("/v1/approvals");
  el.innerHTML = "<p class='note'>The ONE inbox: MCP pauses, workflow sign-offs, run escalations, budget overages, context conflicts, reclassifications.</p>"
    + table(a.approvals, (r) => r.status === "pending"
      ? "<button class='small' data-dec='approved' data-id='" + r.id + "'>approve</button> <button class='small' data-dec='denied' data-id='" + r.id + "'>deny</button>"
      : "");
  el.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", async () => {
    try { await post("/v1/approvals/" + b.dataset.id + "/decide", { decision: b.dataset.dec }); render(); }
    catch (ex) { alert(ex.message); }
  }));
}],
["Simulation / Access preview", async (el) => {
  el.innerHTML = "<p class='note'>Would this call be allowed right now? (§5 preview — evaluates live policy)</p>"
    + form("f-sim", [{name:"userId"},{name:"serverId"},{name:"toolName"}], "Evaluate") + "<pre id='simout'></pre>";
  $("#f-sim").addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    try { $("#simout").textContent = JSON.stringify(await post("/v1/evaluate", d), null, 2); }
    catch (ex) { $("#simout").textContent = ex.message; }
  });
}],
["Cost & Projects", async (el) => {
  const p = await get("/v1/projects");
  el.innerHTML = "<h2>Projects (spend fleet-wide)</h2>"
    + table(p.projects, (r) => "<button class='small' data-proj='" + r.id + "'>rollup</button>")
    + "<div id='projout'></div>";
  el.querySelectorAll("[data-proj]").forEach((b) => b.addEventListener("click", async () => {
    const [costs, compliance] = await Promise.all([
      get("/v1/projects/" + b.dataset.proj + "/costs"),
      get("/v1/projects/" + b.dataset.proj + "/compliance"),
    ]);
    $("#projout").innerHTML = "<h2>Budget vs actual + forecast</h2><pre>" + esc(JSON.stringify({ budget: costs.budget, forecast: costs.forecast, measured: costs.measured }, null, 2)) + "</pre>"
      + "<h2>Showback by user</h2>" + table(costs.byUser)
      + "<h2>By agent/model</h2>" + table(costs.byAgent)
      + "<h2>Estimated savings (pillar 6)</h2>" + table(costs.estimatedSavings)
      + "<h2>Compliance (effective policy + enforcement labels)</h2><pre>" + esc(JSON.stringify(compliance, null, 2)) + "</pre>";
  }));
}],
];

let active = 0;
function render() {
  const nav = $("#tabs"); nav.innerHTML = "";
  const main = $("#main"); main.innerHTML = "";
  TABS.forEach(([name, fn], i) => {
    const b = document.createElement("button");
    b.textContent = name;
    if (i === active) b.classList.add("active");
    b.addEventListener("click", () => { active = i; render(); });
    nav.appendChild(b);
  });
  const sec = document.createElement("section");
  sec.classList.add("active");
  main.appendChild(sec);
  if (!KEY) { sec.innerHTML = "<p class='note'>Connect with an admin API key to load this panel.</p>"; return; }
  sec.innerHTML = "<p class='note'>loading…</p>";
  TABS[active][1](sec).catch((ex) => { sec.innerHTML = "<p class='err'>" + esc(ex.message) + "</p>"; });
}
$("#connect").addEventListener("click", async () => {
  KEY = $("#apikey").value.trim();
  try { await get("/v1/users"); $("#status").textContent = "connected (admin)"; }
  catch (ex) { $("#status").textContent = "error: " + ex.message; }
  render();
});
render();
</script>
</body>
</html>
`;
