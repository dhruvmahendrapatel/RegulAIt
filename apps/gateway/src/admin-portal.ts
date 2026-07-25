/**
 * ADR-0012: the admin portal — one dependency-free HTML+JS page, served as a
 * static shell at GET /admin. Strictly a client of the public REST API: the
 * admin pastes an API key (held in sessionStorage for this tab only) and
 * every read/write goes through the same endpoints any script would use.
 * Panels use §6's names verbatim, plus the §10.4-mandated cost surface with
 * hand-rolled SVG charts (strict self-containment — no external assets).
 */

import { UI_CSS } from "./ui-theme.js";

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
  if (!res.ok) throw new Error(res.status + " " + (json.error ?? text));
  return json;
}
const get = (p) => api("GET", p);
const post = (p, b) => api("POST", p, b);

function table(rows, actions) {
  if (!rows || rows.length === 0) return "<div class='empty'>none yet</div>";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== "ruleChain");
  let h = "<table><tr>" + cols.map((c) => "<th>" + esc(c) + "</th>").join("") + (actions ? "<th></th>" : "") + "</tr>";
  for (const r of rows) {
    h += "<tr>" + cols.map((c) => {
      let v = r[c];
      if (typeof v === "object" && v !== null) v = JSON.stringify(v);
      const cls = c === "id" || String(c).endsWith("Id") || c === "at" || c === "createdAt" ? " class='mono dim'" : "";
      return "<td" + cls + ">" + esc(v) + "</td>";
    }).join("");
    if (actions) h += "<td>" + actions(r) + "</td>";
    h += "</tr>";
  }
  return h + "</table>";
}
function form(id, fields, label) {
  return "<form class='row' id='" + id + "' style='margin:10px 0'>" +
    fields.map((f) => f.options
      ? "<select name='" + f.name + "'>" + f.options.map((o) => "<option>" + esc(o) + "</option>").join("") + "</select>"
      : "<input name='" + f.name + "' placeholder='" + esc(f.ph ?? f.name) + "'" + (f.req === false ? "" : " required") + ">"
    ).join("") + "<button class='small primary'>" + esc(label) + "</button> <span class='err-line'></span></form>";
}
function wire(id, fn) {
  $("#" + id)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = e.target.querySelector(".err-line"); err.textContent = "";
    const data = Object.fromEntries(new FormData(e.target).entries());
    for (const k of Object.keys(data)) if (data[k] === "") delete data[k];
    try { await fn(data); render(); } catch (ex) { err.textContent = ex.message; }
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
  const [u, r, rev] = await Promise.all([get("/v1/users"), get("/v1/roles"), get("/v1/revocations")]);
  el.innerHTML = "<h2>Users</h2><div class='card'>" + form("f-user", [{name:"email"},{name:"displayName"}], "Create user")
    + table(u.users) + "</div>"
    + "<h2>Roles</h2><div class='card'>" + form("f-role", [{name:"name"},{name:"description",req:false}], "Create role")
    + form("f-assign", [{name:"userId"},{name:"roleId"}], "Assign role") + table(r.roles) + "</div>"
    + "<h2>Per-user overrides — revocations, visibly flagged deviations</h2><div class='card'>"
    + form("f-revoke", [{name:"userId"},{name:"serverId"},{name:"toolName",req:false}], "Add revocation")
    + table(rev.revocations) + "</div>";
  wire("f-user", (d) => post("/v1/users", d));
  wire("f-role", (d) => post("/v1/roles", d));
  wire("f-assign", (d) => post("/v1/users/" + d.userId + "/roles", { roleId: d.roleId }));
  wire("f-revoke", (d) => post("/v1/revocations", { ...d, toolName: d.toolName ?? null }));
}],
["Agent Governance", async (el) => {
  const a = await get("/v1/agents");
  el.innerHTML = "<h2>Agent catalog</h2><div class='card'>"
    + table(a.agents, (r) => "<button class='small' data-agent='" + r.id + "' data-en='" + !r.enabled + "'>" + (r.enabled ? "disable" : "enable") + "</button>") + "</div>"
    + "<h2>Grant an agent</h2><div class='card'>" + form("f-agrant", [{name:"userId"},{name:"agentId"}], "Grant") + "</div>"
    + "<h2>Per-user entitlement</h2><div class='card'>" + form("f-aview", [{name:"userId"}], "View") + "<div id='aview'></div></div>";
  el.querySelectorAll("[data-agent]").forEach((b) => b.addEventListener("click", async () => {
    await post("/v1/agents/" + b.dataset.agent + "/enabled", { enabled: b.dataset.en === "true" }); render();
  }));
  wire("f-agrant", (d) => post("/v1/grants/agents", d));
  $("#f-aview").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = await get("/v1/users/" + new FormData(e.target).get("userId") + "/agents");
    $("#aview").innerHTML = table(v.agents) + "<p class='dim' style='font-size:12px'>default: <span class='mono'>" + esc(v.defaultAgentId) + "</span> · ceiling: <span class='mono'>" + esc(v.ceilingAgentId) + "</span></p>";
  });
}],
["Connector Governance", async (el) => {
  const c = await get("/v1/connectors");
  el.innerHTML = "<h2>Connector catalog</h2><div class='card'>" + form("f-conn", [{name:"name"},{name:"kind"}], "Create") + table(c.connectors) + "</div>"
    + "<h2>Grant — mode + data scope</h2><div class='card'>"
    + form("f-cgrant", [{name:"userId"},{name:"connectorId"},{name:"mode",options:["read","readwrite"]}], "Grant") + "</div>"
    + "<h2>Per-user entitlement</h2><div class='card'>" + form("f-cview", [{name:"userId"}], "View") + "<div id='cview'></div></div>";
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
  el.innerHTML = "<h2>Server registry</h2><div class='card'>" + form("f-srv", [{name:"name"},{name:"url"}], "Register")
    + table(s.servers, (r) => "<button class='small' data-srv='" + r.id + "'>tools</button>") + "<div id='srvtools'></div></div>"
    + "<h2>Tool-level allow-list grants</h2><div class='card'>"
    + form("f-tgrant", [{name:"userId"},{name:"serverId"},{name:"toolName"}], "Grant tool")
    + form("f-sgrant", [{name:"userId"},{name:"serverId"},{name:"readOnlyAll",options:["true","false"]}], "Grant server") + "</div>";
  el.querySelectorAll("[data-srv]").forEach((b) => b.addEventListener("click", async () => {
    const t = await get("/v1/servers/" + b.dataset.srv + "/tools");
    $("#srvtools").innerHTML = "<h2>Tool inventory — auto-discovered on proxy use</h2>" + table(t.tools);
  }));
  wire("f-tgrant", (d) => post("/v1/grants/tools", d));
  wire("f-sgrant", (d) => post("/v1/grants/servers", { ...d, readOnlyAll: d.readOnlyAll === "true" }));
}],
["Policy & Rules Engine", async (el) => {
  const [ap, ds, rl] = await Promise.all([
    get("/v1/rules/approvals"), get("/v1/rules/data-scopes"), get("/v1/rules/rate-limits"),
  ]);
  el.innerHTML = "<h2>Approval rules</h2><div class='card'>"
    + form("f-apr", [{name:"userId"},{name:"serverId"},{name:"toolName",req:false},{name:"approverUserId"}], "Add") + table(ap.rules) + "</div>"
    + "<h2>Data-scope rules</h2><div class='card'>"
    + form("f-dsr", [{name:"userId"},{name:"serverId"},{name:"toolName",req:false},{name:"argPath"},{name:"allowedValues",ph:"comma,separated"}], "Add") + table(ds.rules) + "</div>"
    + "<h2>Rate limits</h2><div class='card'>"
    + form("f-rlr", [{name:"userId"},{name:"serverId"},{name:"toolName",req:false},{name:"maxCalls"},{name:"windowSeconds"}], "Add") + table(rl.rules) + "</div>";
  wire("f-apr", (d) => post("/v1/rules/approvals", d));
  wire("f-dsr", (d) => post("/v1/rules/data-scopes", { ...d, allowedValues: String(d.allowedValues).split(",") }));
  wire("f-rlr", (d) => post("/v1/rules/rate-limits", { ...d, maxCalls: Number(d.maxCalls), windowSeconds: Number(d.windowSeconds) }));
}],
["Audit & Activity Log", async (el) => {
  el.innerHTML = "<div class='card'>" + form("f-audit", [{name:"userId",ph:"filter by userId (optional)",req:false}], "Load")
    + "<div id='auditout'></div></div>";
  const load = async (userId) => {
    const a = await get("/v1/audit" + (userId ? "?userId=" + userId : ""));
    $("#auditout").innerHTML = table(a.entries.map((e) => ({
      at: e.at, user: e.userId, object: e.objectType, effect: e.effect, rule: e.ruleId, reason: e.reason,
    })));
  };
  $("#f-audit").addEventListener("submit", (e) => { e.preventDefault(); load(new FormData(e.target).get("userId")); });
  await load("");
}],
["Approvals Queue", async (el) => {
  const a = await get("/v1/approvals");
  el.innerHTML = "<p class='sub'>The one inbox: MCP pauses, workflow sign-offs, run escalations, budget overages, context conflicts, reclassifications.</p><div class='card'>"
    + table(a.approvals.map((r) => ({ id: r.id, type: r.objectType, stage: r.stageId, status: r.status, approver: r.approverUserId, requestedAt: r.requestedAt })),
      (r) => {
        const row = a.approvals.find((x) => x.id === r.id);
        return row.status === "pending"
          ? "<button class='small primary' data-dec='approved' data-id='" + r.id + "'>approve</button> <button class='small danger' data-dec='denied' data-id='" + r.id + "'>deny</button>"
          : "";
      }) + "</div>";
  el.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", async () => {
    try { await post("/v1/approvals/" + b.dataset.id + "/decide", { decision: b.dataset.dec }); render(); }
    catch (ex) { alert(ex.message); }
  }));
}],
["Simulation / Access preview", async (el) => {
  el.innerHTML = "<p class='sub'>Would this call be allowed right now? Evaluates live policy without executing anything.</p><div class='card'>"
    + form("f-sim", [{name:"userId"},{name:"serverId"},{name:"toolName"}], "Evaluate") + "<pre id='simout'>—</pre></div>";
  $("#f-sim").addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    try { $("#simout").textContent = JSON.stringify(await post("/v1/evaluate", d), null, 2); }
    catch (ex) { $("#simout").textContent = ex.message; }
  });
}],
["Cost & Projects", async (el) => {
  const p = await get("/v1/projects");
  el.innerHTML = "<h2>Projects — fleet spend</h2><div class='card'>"
    + table(p.projects.map((r) => ({ name: r.name, costCenter: r.costCenter, spent: fmtUsd(r.spentUsd), budget: fmtUsd(r.budgetUsd), classifications: (r.classifications ?? []).join(", ") })),
      (r) => "<button class='small' data-proj='" + p.projects.find((x) => x.name === r.name).id + "'>rollup</button>")
    + "</div><div id='projout'></div>";
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
      + "<h2>Showback by user</h2><div class='card'>" + barChart(costs.byUser, "costUsd", (i) => i.userId) + "</div>"
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
