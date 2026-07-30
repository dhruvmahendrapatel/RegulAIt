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
<div id="toast-region" aria-live="polite"></div>
<script>
"use strict";
${UI_ERRORS_JS}
${UI_DISPLAY_JS}
const $ = (s, el) => (el ?? document).querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtUsd = (v) => v == null ? "—" : "$" + Number(v).toFixed(4).replace(/0+$/,"").replace(/\\.$/,"");
let KEY = sessionStorage.getItem("regulait.admin.key") ?? "";

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
  let h = "<div class='tblwrap'><table><tr>" + cols.map((c) => "<th>" + esc(humanizeKey(c)) + "</th>").join("") + (actions ? "<th></th>" : "") + "</tr>";
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

// --- human column labels ------------------------------------------------
// camelCase / snake_case DB keys -> Title Case, with a small override map so
// domain acronyms read right ("budgetApproverUserId" -> "Budget Approver User
// ID", "alertThresholdPct" -> "Alert Threshold %"). Row keys never change —
// only the <th> label. Used by table() above and dataTable() below.
const HUMAN_OVERRIDES = {
  id:"ID", ids:"IDs", usd:"USD", pct:"%", url:"URL", uri:"URI", api:"API",
  mcp:"MCP", pii:"PII", cve:"CVE", byo:"BYO", eom:"EOM", csv:"CSV", pm:"PM",
  ok:"OK", ttl:"TTL", eod:"EOD",
};
function humanizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\\s]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => HUMAN_OVERRIDES[w.toLowerCase()] ?? (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ") || String(key);
}
// a status/label pill; kind is a .badge modifier (ok/warn/bad/info/accent) or ""
function badge(text, kind) {
  return "<span class='badge" + (kind ? " " + kind : "") + "'>" + esc(text) + "</span>";
}
// an object -> definition list (.kv) with humanized keys; labels overrides keys
function kvList(obj, labels) {
  labels = labels || {};
  const entries = Object.entries(obj || {});
  if (!entries.length) return "<div class='empty'>none</div>";
  return "<div class='kv'>" + entries.map((e) => {
    const k = e[0]; let val = e[1];
    if (val === null || val === undefined || val === "") val = "—";
    else if (Array.isArray(val)) val = val.length ? val.join(", ") : "—";
    else if (typeof val === "object") val = JSON.stringify(val);
    return "<span class='k'>" + esc(labels[k] ?? humanizeKey(k)) + "</span><span>" + esc(val) + "</span>";
  }).join("") + "</div>";
}
// small count map -> "cve 2 · drift 1" inline labeled counts (no raw JSON)
function inlineCounts(obj) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return "<span class='dim'>none</span>";
  return entries.map((e) => esc(e[0]) + " <span class='num'>" + esc(e[1]) + "</span>")
    .join(" <span class='faint'>·</span> ");
}

// --- dataTable: sortable headers + free-text filter + pagination ---------
// A richer renderer for long administrative tables. Keeps table()'s UUID-chip,
// ISO-date compaction and NOWRAP behaviors. opts: { actions?, labels?, cells?,
// pageSize? } — cells is an optional per-column HTML renderer (value,row)=>html
// (used for the findings severity/status badges). Per-instance state lives in
// DT keyed by a fresh id; the document-level listeners re-render just the one
// wrapper on sort/filter/page. State is per render() (reset when a tab loads).
let dtSeq = 0;
const DT = new Map();
function dtCell(c, r, cells) {
  if (cells && cells[c]) return "<td>" + cells[c](r[c], r) + "</td>";
  let v = r[c];
  if (typeof v === "object" && v !== null) v = JSON.stringify(v);
  if (typeof v === "string" && UUID_RE.test(v)) return "<td class='nowrap'>" + idChip(v) + "</td>";
  if (typeof v === "string" && ISO_RE.test(v)) {
    return "<td class='mono dim nowrap' title='" + esc(v) + "'>" + esc(v.slice(0, 10) + " " + v.slice(11, 16)) + "</td>";
  }
  const cls = c === "id" || String(c).endsWith("Id") || c === "at" || c === "createdAt" ? " class='mono dim'"
    : c === "stage" ? " class='label'"
    : NOWRAP_COLS.has(c) ? " class='nowrap'" : "";
  return "<td" + cls + ">" + esc(v) + "</td>";
}
function dtCompare(a, b, t) {
  const ae = a === null || a === undefined || a === "";
  const be = b === null || b === undefined || b === "";
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  if (t === "num") return Number(a) - Number(b);
  const sa = String(a).toLowerCase(), sb = String(b).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function dataTable(rows, opts) {
  opts = opts || {};
  const id = "dt-" + (++dtSeq);
  const list = rows || [];
  const cols = [...new Set(list.flatMap((r) => Object.keys(r)))].filter((c) => c !== "ruleChain");
  const colType = {};
  for (const c of cols) {
    let allNum = true, any = false;
    for (const r of list) {
      const v = r[c];
      if (v === null || v === undefined || v === "") continue;
      any = true;
      const isNum = typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)));
      if (!isNum) { allNum = false; break; }
    }
    colType[c] = any && allNum ? "num" : "str";
  }
  DT.set(id, {
    rows: list, cols, colType,
    actions: opts.actions || null, labels: opts.labels || {}, cells: opts.cells || null,
    pageSize: opts.pageSize || 25, sortCol: null, sortDir: 1, filter: "", page: 0,
  });
  return "<div class='dtwrap' data-dt='" + id + "'>" + dtRender(id) + "</div>";
}
function dtRender(id) {
  const st = DT.get(id);
  if (!st) return "";
  // a genuinely empty table shows no filter/paging chrome, like table()
  if (st.rows.length === 0) return "<div class='empty'>none yet</div>";
  const label = (c) => esc(st.labels[c] ?? humanizeKey(c));
  const f = st.filter.trim().toLowerCase();
  let rows = st.rows;
  if (f) rows = rows.filter((r) => st.cols.some((c) => {
    let v = r[c];
    if (v === null || v === undefined) return false;
    if (typeof v === "object") v = JSON.stringify(v);
    return String(v).toLowerCase().indexOf(f) !== -1;
  }));
  if (st.sortCol != null) {
    const c = st.sortCol, t = st.colType[c], dir = st.sortDir;
    rows = rows.map((r, i) => [r, i]).sort((a, b) => {
      const cmp = dtCompare(a[0][c], b[0][c], t);
      return cmp !== 0 ? cmp * dir : a[1] - b[1];
    }).map((x) => x[0]);
  }
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / st.pageSize));
  if (st.page >= pages) st.page = pages - 1;
  if (st.page < 0) st.page = 0;
  const start = st.page * st.pageSize;
  const pageRows = rows.slice(start, start + st.pageSize);
  let h = "<div class='dtbar'><input type='text' class='dtfilter' aria-label='Filter table rows' placeholder='Filter…' " + 'value="' + esc(st.filter) + '"' + "></div>";
  if (total === 0) return h + "<div class='empty'>" + (st.filter ? "no matches" : "none yet") + "</div>";
  h += "<div class='tblwrap'><table><tr>";
  for (const c of st.cols) {
    const on = st.sortCol === c;
    const ind = on ? (st.sortDir === 1 ? " ▲" : " ▼") : "";
    const asort = on ? (st.sortDir === 1 ? "ascending" : "descending") : "none";
    h += "<th class='dtsort' role='button' tabindex='0' data-col='" + esc(c) + "' aria-sort='" + asort + "' title='Sort by " + label(c) + "'>" + label(c) + ind + "</th>";
  }
  if (st.actions) h += "<th></th>";
  h += "</tr>";
  for (const r of pageRows) {
    h += "<tr>" + st.cols.map((c) => dtCell(c, r, st.cells)).join("");
    if (st.actions) h += "<td class='act'>" + st.actions(r) + "</td>";
    h += "</tr>";
  }
  h += "</table></div>";
  const from = start + 1, to = Math.min(total, start + st.pageSize);
  h += "<div class='dtpage'><span class='dim'>showing " + from + "–" + to + " of " + total + "</span>";
  if (pages > 1) h += "<span class='grow'></span>"
    + "<button type='button' class='small dtprev'" + (st.page === 0 ? " disabled" : "") + ">Prev</button>"
    + "<span class='dim' style='padding:0 6px'>page " + (st.page + 1) + " / " + pages + "</span>"
    + "<button type='button' class='small dtnext'" + (st.page >= pages - 1 ? " disabled" : "") + ">Next</button>";
  h += "</div>";
  return h;
}
function dtRerender(wrap) {
  const focused = document.activeElement;
  const inFilter = focused && focused.classList && focused.classList.contains("dtfilter") && wrap.contains(focused);
  const sortCol = (focused && focused.classList && focused.classList.contains("dtsort") && wrap.contains(focused)) ? focused.dataset.col : null;
  const caret = inFilter ? focused.selectionStart : null;
  wrap.innerHTML = dtRender(wrap.dataset.dt);
  if (inFilter) {
    const inp = wrap.querySelector(".dtfilter");
    if (inp) { inp.focus(); try { inp.setSelectionRange(caret, caret); } catch (e) { /* not selectable */ } }
  } else if (sortCol != null) {
    const th = wrap.querySelector(".dtsort[data-col='" + sortCol + "']");
    if (th) th.focus();
  }
}
document.addEventListener("click", (e) => {
  const wrap = e.target && e.target.closest ? e.target.closest("[data-dt]") : null;
  if (!wrap) return;
  const st = DT.get(wrap.dataset.dt);
  if (!st) return;
  const th = e.target.closest(".dtsort");
  if (th) {
    const c = th.dataset.col;
    if (st.sortCol === c) st.sortDir = -st.sortDir; else { st.sortCol = c; st.sortDir = 1; }
    st.page = 0; dtRerender(wrap); return;
  }
  if (e.target.closest(".dtprev")) { st.page -= 1; dtRerender(wrap); return; }
  if (e.target.closest(".dtnext")) { st.page += 1; dtRerender(wrap); return; }
});
document.addEventListener("input", (e) => {
  if (!e.target || !e.target.classList || !e.target.classList.contains("dtfilter")) return;
  const wrap = e.target.closest("[data-dt]");
  if (!wrap) return;
  const st = DT.get(wrap.dataset.dt);
  if (!st) return;
  st.filter = e.target.value; st.page = 0; dtRerender(wrap);
});
document.addEventListener("keydown", (e) => {
  const th = e.target && e.target.closest ? e.target.closest(".dtsort") : null;
  if (!th) return;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); th.click(); }
});

// --- formatted operator views (replace raw <pre>JSON dumps) --------------
const EFFECT_KIND = { allow: "ok", deny: "bad", require_approval: "warn" };
const OUTCOME_KIND = {
  allow: "ok", "satisfied-by-approval": "ok", deny: "bad", revoked: "bad",
  "require-approval": "warn", "no-match": "",
};
// a policy Decision -> effect badge + rule-chain table + reason prose, raw JSON
// tucked behind a <details> toggle for power users.
function renderDecision(d) {
  d = d || {};
  const eff = String(d.effect ?? "unknown");
  const chain = Array.isArray(d.ruleChain) ? d.ruleChain : [];
  let h = "<div class='row' style='align-items:center'>"
    + badge(eff.replace(/_/g, " "), EFFECT_KIND[eff] ?? "")
    + (d.ruleId ? "<span class='dim'>matched</span><span class='mono'>" + esc(d.ruleId) + "</span>" : "")
    + "</div>";
  if (d.reason) h += "<p style='margin:10px 0 0'>" + esc(d.reason) + "</p>";
  if (eff === "require_approval" && (d.approverName || d.approverUserId))
    h += "<p class='dim' style='margin:6px 0 0'>Requires sign-off from " + esc(d.approverName ?? d.approverUserId) + "</p>";
  h += "<h2>Rule chain — every rule evaluated, in order</h2>";
  if (chain.length) {
    h += "<div class='tblwrap'><table><tr><th>#</th><th>Rule</th><th>Outcome</th><th>Grant / rule ID</th></tr>";
    chain.forEach((t, i) => {
      const gid = t.grantId
        ? (UUID_RE.test(t.grantId) ? idChip(t.grantId) : "<span class='mono dim'>" + esc(t.grantId) + "</span>")
        : "<span class='faint'>—</span>";
      h += "<tr><td class='num'>" + (i + 1) + "</td><td class='nowrap'>" + esc(t.rule) + "</td>"
        + "<td class='nowrap'>" + badge(String(t.outcome).replace(/-/g, " "), OUTCOME_KIND[t.outcome] ?? "") + "</td>"
        + "<td>" + gid + "</td></tr>";
    });
    h += "</table></div>";
  } else h += "<div class='empty'>no rules recorded</div>";
  h += "<details style='margin-top:12px'><summary class='dim' style='cursor:pointer'>Raw decision JSON</summary>"
    + "<pre style='margin-top:8px'>" + esc(JSON.stringify(d, null, 2)) + "</pre></details>";
  return h;
}
// a project compliance profile -> classification badges + effective/enforcement
// key-value lists, raw JSON behind a <details> toggle.
function renderCompliance(c) {
  c = c || {};
  const tags = Array.isArray(c.classifications) ? c.classifications : [];
  const pend = Array.isArray(c.pendingClassifications) ? c.pendingClassifications
    : (c.pendingClassifications ? [c.pendingClassifications] : []);
  let h = "<div class='row' style='align-items:center'><span class='dim'>classifications:</span> "
    + (tags.length ? tags.map((t) => badge(t, "accent")).join(" ") : "<span class='faint'>none</span>")
    + "</div>";
  if (pend.length) h += "<div class='row' style='margin-top:6px;align-items:center'><span class='dim'>pending reclassification:</span> "
    + pend.map((t) => badge(t, "warn")).join(" ") + "</div>";
  h += "<h2>Effective policy (cascaded)</h2>" + kvList(c.effective || {}, {
    requiredTemplateIds: "Required workflow templates", mcpDefaultMode: "MCP default mode",
    auditRetentionDays: "Audit retention (days)", piiMode: "PII mode",
    backupRetentionDays: "Backup retention (days)", patchCadenceDays: "Patch cadence (days)",
  });
  h += "<h2>Enforcement</h2>" + kvList(c.enforcement || {});
  h += "<details style='margin-top:12px'><summary class='dim' style='cursor:pointer'>Raw compliance JSON</summary>"
    + "<pre style='margin-top:8px'>" + esc(JSON.stringify(c, null, 2)) + "</pre></details>";
  return h;
}
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
  const res = await fetch(path, { headers: { authorization: "Bearer " + KEY } });
  if (!res.ok) { toast("CSV download failed (" + res.status + ")", "err"); return; }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// --- §6's eight functional surfaces + the §10.4 cost surface -------------
const TABS = [
["Users", async (el) => {
  const [u, rev, srv, k] = await Promise.all([
    get("/v1/users"), get("/v1/revocations"), get("/v1/servers"), get("/v1/keys"),
  ]);
  const tools = await toolIndex(srv.servers);
  const uOpts = userOpts(u.users), sOpts = serverOpts(srv.servers);
  const email = Object.fromEntries(u.users.map((x) => [x.id, x.email]));
  el.innerHTML = "<h2>Users</h2><div class='card'>"
    + form("f-user", [{name:"email"},{name:"displayName"},{name:"isAdmin",label:"admin",options:["false","true"]}], "Create user")
    + dataTable(u.users, { actions: (row) => "<button class='small' data-key='" + row.id + "'>issue key</button>" }) + "</div>"
    + "<div id='keyreveal'></div>"
    // A user with no API key cannot sign in to anything — issuing one is part
    // of creating them, not a separate API-only chore.
    + "<h2>API keys — plaintext returned exactly once, sha256 at rest</h2><div class='card'>"
    + dataTable(k.keys.map((x) => ({
        id: x.id, name: x.name, user: email[x.userId] ?? x.userId, created: x.createdAt,
        lastUsed: x.lastUsedAt ?? "never", status: x.revokedAt ? "revoked" : "active",
      })), { actions: (row) => row.status === "active"
        ? "<button class='small danger' data-revoke='" + row.id + "'>revoke</button>" : "" })
    + "</div>"
    + "<h2>Per-user overrides — revocations, visibly flagged deviations</h2><div class='card'>"
    + form("f-revoke", [{name:"userId",label:"user",options:uOpts},{name:"serverId",label:"server",options:sOpts},{name:"toolName",label:"tool",options:[],req:false}], "Add revocation")
    + table(rev.revocations) + "</div>";
  linkTools("f-revoke", tools);
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
      } catch (ex) { toast(ex.message, "err"); }
      return;
    }
    const revBtn = e.target.closest("[data-revoke]");
    if (revBtn) {
      if (!confirm("Revoke this API key? The holder can no longer authenticate with it. This cannot be undone.")) return;
      try { await post("/v1/keys/" + revBtn.dataset.revoke + "/revoke", {}); toast("Key revoked", "ok"); render(); }
      catch (ex) { toast(ex.message, "err"); }
    }
  });
  wire("f-user", (d) => post("/v1/users", { ...d, isAdmin: d.isAdmin === "true" }));
  wire("f-revoke", (d) => post("/v1/revocations", { ...d, toolName: d.toolName ?? null }));
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
    + table(r.roles) + "</div>"
    // §5 (ADR-0014): a role is a provisioning bundle. Pick a role, see what it
    // grants, add/adjust grants — all POSTing to the ROLE endpoints (roleId in
    // the path), then assigned to users via the assign-role form above.
    + "<h2>Role grants — what this role provisions</h2><div class='card'>"
    + form("f-rolepick", [{name:"roleId",label:"active role",options:rOpts,req:false,ph:"— select a role —"}], "Load grants")
    + "<div id='rolegrants'><div class='empty'>Select a role to view and edit its grants</div></div>"
    + "</div>";
  wire("f-role", (d) => post("/v1/roles", d));
  wire("f-assign", (d) => post("/v1/users/" + d.userId + "/roles", { roleId: d.roleId }));

  let activeRoleId = "";
  const renderGrants = async () => {
    const host = $("#rolegrants");
    if (!host) return;
    if (!activeRoleId) { host.innerHTML = "<div class='empty'>Select a role to view and edit its grants</div>"; return; }
    const g = await get("/v1/roles/" + activeRoleId + "/grants");
    host.innerHTML =
      "<div class='grid2'>"
      + "<div>" + form("f-r-agrant", [{name:"agentId",label:"agent",options:aOpts}], "Grant agent") + "</div>"
      + "<div>" + form("f-r-cgrant", [
          {name:"connectorId",label:"connector",options:cOpts},
          {name:"mode",options:["read","readwrite"]},
          {name:"allowedObjects",label:"object scope",req:false,ph:"comma,separated (blank = all)"},
        ], "Grant connector") + "</div>"
      + "<div>" + form("f-r-tgrant", [{name:"serverId",label:"server",options:sOpts},{name:"toolName",label:"tool",options:[]}], "Grant MCP tool") + "</div>"
      + "<div>" + form("f-r-sgrant", [{name:"serverId",label:"server",options:sOpts},{name:"readOnlyAll",label:"read-only all",options:["true","false"]}], "Grant MCP server") + "</div>"
      + "</div>"
      + "<h2>Agents</h2>" + table((g.agents ?? []).map((x) => ({ agent: x.agentName ?? x.agentId, modes: (x.allowedModes ?? []).join(", ") || "all" })))
      + "<h2>Connectors</h2>" + table((g.connectors ?? []).map((x) => ({ connector: x.connectorName ?? x.connectorId, mode: x.mode, objects: (x.allowedObjects ?? []).join(", ") || "all" })))
      + "<h2>MCP servers</h2>" + table((g.servers ?? []).map((x) => ({ server: x.serverName ?? x.serverId, readOnlyAll: x.readOnlyAll })))
      + "<h2>MCP tools</h2>" + table((g.tools ?? []).map((x) => ({ server: x.serverName ?? x.serverId, tool: x.toolName })));
    linkTools("f-r-tgrant", tools);
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
    + table(t.teams.map((x) => ({
        name: x.name,
        members: (x.members ?? []).map((m) => m.name).join(", ") || "—",
        defaultClassifications: (x.defaultClassifications ?? []).join(", "),
        created: x.createdAt,
      })))
    + "<p class='dim' style='font-size:12px'>Team membership is flat — per-user roles (owner/contributor/viewer) live on Shared-Project membership, not here. A team's default classifications are surfaced (never silently resolved) when a member joins a project whose tags don't cover them.</p></div>";
  wire("f-team", (d) => post("/v1/teams", {
    name: d.name,
    ...(d.defaultClassifications ? { defaultClassifications: [].concat(d.defaultClassifications) } : {}),
  }));
  wire("f-tmadd", (d) => post("/v1/teams/" + d.teamId + "/members", { userId: d.userId }));
}],
["Agents", async (el) => {
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
    if (!confirm("Remove the platform credential for " + b.dataset.mcred + "? Non-BYO dispatches on this provider will 409 until a new key is added.")) return;
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
      if (!confirm("Remove this user's own " + b.dataset.ucred + " key? Their dispatches will fall back to the platform credential.")) return;
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
    if (!confirm("Delete this assignment rule? Routing stops; in-flight instances keep their snapshotted definition.")) return;
    try { await del("/v1/workflows/assignment-rules/" + b.dataset.rdel); toast("Rule deleted", "ok"); render(); }
    catch (ex) { toast(ex.message, "err"); }
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
    + form("f-audit", [{name:"userId",label:"filter by user",options:userOpts(u.users),req:false,ph:"— all users —"}], "Load")
    + "<div id='auditout'></div></div>";
  const prune = $("#audit-prune");
  if (prune) prune.addEventListener("click", async () => {
    if (!confirm("Delete " + ret.prunable + " audit row(s) older than " + ret.retainedDays + " days? This cannot be undone.")) return;
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
  const [a, me] = await Promise.all([get("/v1/approvals"), get("/v1/me").catch(() => ({ userId: null }))]);
  el.innerHTML = "<p class='sub'>The one inbox: MCP pauses, workflow sign-offs, run escalations, budget overages, context conflicts, reclassifications. The named approver decides; an admin may decide in their place only with a recorded reason (audit-marked as an override).</p><div class='card'>"
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
      } }) + "</div>";
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
  const [p, u, cp, ini] = await Promise.all([
    get("/v1/projects"), get("/v1/users"), get("/v1/compliance/profiles"), get("/v1/initiatives"),
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
  const [res, pol, fin, posture, u, cp, certs, patches, backups] = await Promise.all([
    get("/v1/infra/resources"), get("/v1/infra/policies"), get("/v1/infra/findings"),
    get("/v1/infra/posture"), get("/v1/users"), get("/v1/compliance/profiles"),
    get("/v1/infra/certs"), get("/v1/infra/patches"), get("/v1/infra/backups"),
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
    + "<p class='dim' style='font-size:12px'>Pick the named approver, then 'propose remediation' on any open finding — it lands in the Approvals Queue (objectType infra_operation). Auto-remediated findings are already fixed; only 'open' findings can be proposed.</p>"
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
  // delegate so the remediate buttons survive a findings dataTable re-render
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-remediate]");
    if (!b) return;
    const approver = $("#f-remapprover")?.querySelector("[name=approverUserId]")?.value;
    if (!approver) { toast("Pick a remediation approver first.", "err"); return; }
    if (!confirm("Propose remediation for this finding? It lands in the Approvals Queue for the named approver to decide.")) return;
    try { await post("/v1/infra/findings/" + b.dataset.remediate + "/remediate", { approverUserId: approver }); toast("Remediation proposed", "ok"); render(); }
    catch (ex) { toast(ex.message, "err"); }
  });
  // ADR-0017 verbs — same delegated pattern, same #f-remapprover approver, each
  // confirm()-gated. cert_rotate / patch_apply / backup_restore all POST into
  // the one governed approval path.
  el.addEventListener("click", async (e) => {
    const rot = e.target.closest("[data-rotate]");
    const app_ = e.target.closest("[data-apply]");
    const rst = e.target.closest("[data-restore]");
    const hit = rot || app_ || rst;
    if (!hit) return;
    const approver = $("#f-remapprover") && $("#f-remapprover").querySelector("[name=approverUserId]") ? $("#f-remapprover").querySelector("[name=approverUserId]").value : "";
    if (!approver) { toast("Pick a remediation approver first.", "err"); return; }
    let url = "";
    let msg = "";
    if (rot) { url = "/v1/infra/certs/" + rot.dataset.rotate + "/rotate"; msg = "Propose a governed certificate rotation? It lands in the Approvals Queue for the named approver."; }
    else if (app_) { url = "/v1/infra/patches/" + app_.dataset.apply + "/apply"; msg = "Propose applying this CVE patch? It lands in the Approvals Queue for the named approver."; }
    else { url = "/v1/infra/backups/" + rst.dataset.restore + "/restore"; msg = "Propose a governed restore of this backup? It lands in the Approvals Queue for the named approver."; }
    if (!confirm(msg)) return;
    try { await post(url, { approverUserId: approver }); toast("Proposed — awaiting approval", "ok"); render(); }
    catch (ex) { toast(ex.message, "err"); }
  });
  // the approver select is a live control, not a submit — stop it rebooting the SPA
  $("#f-remapprover")?.addEventListener("submit", (e) => e.preventDefault());
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
];

// The nav is grouped into labelled sections; each entry names a tab by its
// title and is resolved to its TABS index at render time — so the physical
// order of the TABS array is independent of the sidebar's grouping/order.
const NAV = [
  ["Identity & Access", ["Users", "Roles", "Teams"]],
  ["AI Governance", ["Agents", "Model Credentials", "Connectors", "MCP Servers"]],
  ["Policy", ["Rules Engine", "Simulation / Access preview"]],
  ["Delivery", ["Workflows", "PM Connections"]],
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
  $("#signout").addEventListener("click", () => { sessionStorage.removeItem("regulait.admin.key"); KEY = ""; render(); });
  const panel = $("#panel");
  try { await TABS[active][1](panel); }
  catch (ex) { panel.innerHTML = "<div class='empty'>Couldn’t load — " + esc(ex.message) + "</div>"; }
  // move keyboard focus to the panel heading after a (re)render so a tab switch
  // doesn't dump keyboard/AT users back at <body>.
  const h1 = $(".main h1");
  if (h1) h1.focus({ preventScroll: false });
}
render();
</script>
</body>
</html>
`;
