/**
 * The end-user app (/app): playground, runs, workflows, inbox, projects.
 * Same contract as /admin (ADR-0012): one dependency-free file, strictly a
 * client of the public REST API. The API key lives in sessionStorage — this
 * tab only, gone when it closes — and every call is the same call a script
 * would make.
 */

import { UI_CSS, UI_ERRORS_JS } from "./ui-theme.js";

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
<script>
"use strict";
${UI_ERRORS_JS}
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
let PROJECTS = [];      // my member projects
let INBOX_COUNT = 0;
let MY_PROVIDERS = []; // providers I hold my own key for (never the key itself)

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
const del = (p) => api("DELETE", p);

function toast(msg, ms) {
  const el = document.createElement("div");
  el.className = "toast"; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms ?? 3600);
}
function signOut() {
  sessionStorage.removeItem("regulait.key"); KEY = ""; ME = null; render();
}

const statusBadge = (s) => {
  const map = { completed: "ok", done: "ok", running: "info", in_progress: "info",
    planned: "", not_started: "", blocked_on_approval: "warn", blocked_on_artifact: "warn",
    awaiting_trigger: "warn", awaiting_execution: "info", in_review: "warn", blocked: "bad",
    aborted: "bad", denied: "bad", pending: "warn", approved: "ok" };
  return '<span class="badge ' + (map[s] ?? "") + '">' + esc(String(s).replaceAll("_", " ")) + "</span>";
};

// ---------------------------------------------------------------- shell --
const PAGES = [
  { id: "playground", label: "Playground" },
  { id: "runs", label: "Runs" },
  { id: "workflows", label: "Workflows" },
  { id: "inbox", label: "Inbox" },
  { id: "projects", label: "Projects" },
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
  const [mine, projects, creds] = await Promise.all([
    get("/v1/users/" + ME.userId + "/agents"),
    get("/v1/projects").catch(() => ({ projects: [] })),
    get("/v1/users/" + ME.userId + "/model-credentials").catch(() => ({ credentials: [] })),
  ]);
  AGENTS = mine.agents ?? [];
  AGENT_NAMES = Object.fromEntries(AGENTS.map((a) => [a.agentId, a.name]));
  PROJECTS = projects.projects ?? [];
  MY_PROVIDERS = (creds.credentials ?? []).map((c) => c.provider);
  const inbox = await get("/v1/approvals").catch(() => ({ approvals: [] }));
  INBOX_COUNT = (inbox.approvals ?? []).filter((a) => a.status === "pending").length;
}

function shell(content, active) {
  return \`
  <div class="shell">
    <aside class="side">
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
    <main class="main">\${content}</main>
  </div>\`;
}

// ------------------------------------------------------------ playground --
const chatHistory = []; // persists across renders within the session

// Whose key pays for this agent, said before the request rather than only
// after it. Routing can still move the request to another agent, so the
// dispatch badge on the reply stays the authoritative answer.
function keyHint(agent) {
  if (!agent) return "";
  if (agent.provider === "mock") return "Mock provider — runs with no credential at all.";
  return MY_PROVIDERS.includes(agent.provider)
    ? "Runs on your own " + esc(agent.provider) + " key. <a href='#/settings'>Manage keys</a>"
    : "No " + esc(agent.provider) + " key of your own — this uses the platform credential if an admin has configured one. <a href='#/settings'>Add your key</a>";
}

function playgroundPage() {
  // No grants means no agent to invoke — without this guard the select is
  // empty, Send POSTs to /v1/agents//invoke, and the user gets Fastify's 404.
  const noAgents = AGENTS.length === 0;
  const agentOpts = AGENTS.map((a) =>
    \`<option value="\${a.agentId}">\${esc(a.name)} · \${esc(a.provider)} · tier \${a.tier}</option>\`).join("");
  const agentField = noAgents
    ? '<div class="grow"><label class="f">Agent</label><div class="dim" style="font-size:12.5px">No agents are granted to your account — ask an admin to grant you one.</div></div>'
    : \`<div><label class="f">Agent</label><select id="pg-agent">\${agentOpts}</select></div>\`;
  const projectOpts = ['<option value="">no project</option>']
    .concat(PROJECTS.map((p) => \`<option value="\${p.id}">\${esc(p.name)}</option>\`)).join("");
  return \`
  <h1>Playground</h1>
  <p class="sub">Every message goes through governance, routing, and metered dispatch — the trace shows what actually happened.</p>
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
    \${noAgents ? "" : '<hr class="hr"><div class="faint" style="font-size:11.5px" id="pg-key">' + keyHint(AGENTS[0]) + "</div>"}
  </div>
  <div class="card" style="margin-top:12px">
    <div class="chat-log" id="chat-log">
      \${chatHistory.length ? "" : (noAgents
        ? '<div class="empty">Nothing to send to yet — an admin has to grant your account an agent first.</div>'
        : '<div class="empty">Pick an agent and say something. Mock agents reply instantly with no external keys; type «&lt;&lt;refuse&gt;&gt;» to see refusal handling.</div>')}
    </div>
    <hr class="hr">
    <div class="row">
      <textarea id="pg-input" class="grow" rows="2" placeholder="\${noAgents ? "No agent granted to your account yet…" : "Ask the agent to do something…"}"\${noAgents ? " disabled" : ""}></textarea>
      <button class="primary" id="pg-send"\${noAgents ? " disabled" : ""}>Send</button>
    </div>
  </div>\`;
}

function renderExchange(x) {
  const meta = [];
  if (x.result) {
    const r = x.result;
    if (r.routing && r.routing.effect === "routed") {
      meta.push('<span class="badge accent">routed → ' + esc(AGENT_NAMES[r.routing.selectedAgentId] ?? "?") + "</span>");
      if (r.routing.estimatedCostSavedUsd > 0) meta.push('<span class="badge ok">est. saved ' + fmtUsd(r.routing.estimatedCostSavedUsd) + "</span>");
    }
    if (r.dispatch) {
      if (r.dispatch.refusal) meta.push('<span class="badge bad">refused</span>');
      if (r.dispatch.costUsd != null) meta.push('<span class="badge">' + fmtUsd(r.dispatch.costUsd) + " · " + r.dispatch.usage.inputTokens + "→" + r.dispatch.usage.outputTokens + " tok</span>");
      meta.push('<span class="badge">' + esc(r.dispatch.model) + "</span>");
      // whose credential actually paid for this call — the one thing a BYO-key
      // user cannot verify any other way
      if (r.dispatch.credentialSource === "user") meta.push('<span class="badge info">your key</span>');
      if (r.dispatch.credentialSource === "platform") meta.push('<span class="badge">platform key</span>');
      if (r.dispatch.projectBudgetAlerted) meta.push('<span class="badge warn">budget alert</span>');
    }
  }
  if (x.denied) meta.push('<span class="badge bad">denied · ' + esc(x.denied.ruleId) + "</span>");
  if (x.error) meta.push('<span class="badge bad">' + esc(x.error) + "</span>");
  const trace = x.result || x.denied
    ? \`<details style="margin-top:6px"><summary class="faint" style="cursor:pointer;font-size:11.5px">governance trace</summary>
       <pre style="margin-top:6px">\${esc(JSON.stringify(x.denied ?? { decision: x.result.decision, routing: x.result.routing }, null, 2))}</pre></details>\`
    : "";
  return \`
    <div class="msg user"><div class="who">\${esc(ME.user.displayName)}</div><div class="bubble">\${esc(x.prompt)}</div></div>
    <div class="msg agent">
      <div class="who">\${esc(x.agentName)}</div>
      <div class="bubble">\${esc(x.text)}\${x.streaming ? '<span class="caret"></span>' : ""}</div>
      <div class="meta">\${meta.join("")}</div>\${trace}
    </div>\`;
}

function drawChat() {
  const log = $("#chat-log");
  if (!log) return;
  log.innerHTML = chatHistory.map(renderExchange).join("") ||
    '<div class="empty">Pick an agent and say something.</div>';
  log.parentElement.scrollIntoView(false);
}

async function sendPrompt() {
  const input = $("#pg-input");
  const prompt = input.value.trim();
  if (!prompt) return;
  const agentId = $("#pg-agent")?.value;
  if (!agentId) { toast("No agents granted to your account — ask an admin."); return; }
  const projectId = $("#pg-project").value || undefined;
  const costSensitivity = $("#pg-sens").value;
  input.value = "";
  const x = { prompt, agentName: AGENT_NAMES[agentId] ?? "agent", text: "", streaming: true };
  chatHistory.push(x); drawChat();

  try {
    const res = await fetch("/v1/agents/" + agentId + "/invoke", {
      method: "POST",
      headers: { authorization: "Bearer " + KEY, "content-type": "application/json" },
      body: JSON.stringify({ mode: "execute", input: prompt, dispatch: true, stream: true, costSensitivity, ...(projectId ? { projectId } : {}) }),
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("event-stream")) {
      const j = await res.json();
      x.streaming = false;
      if (j.decision && j.decision.effect !== "allow") { x.denied = j.decision; x.text = j.decision.reason; }
      else { x.error = j.error ?? ("HTTP " + res.status); x.text = errMessage(res.status, j); }
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
        if (ev === "result") { x.result = payload; x.streaming = false; if (payload.dispatch?.refusal) x.text = "The model declined this request."; drawChat(); }
        // the error event carries the same detail the JSON path does — losing
        // it leaves an empty bubble under a bare red slug. Anything already
        // streamed stays; the explanation is appended to it.
        if (ev === "error") {
          const msg = errMessage(res.status, payload);
          x.error = payload.error;
          x.text = x.text ? x.text + "\\n\\n" + msg : msg;
          // a failed dispatch still had a governance + routing decision — keep
          // it so the trace explains which agent was chosen and why
          if (payload.decision) x.result = { decision: payload.decision, routing: payload.routing };
          x.streaming = false; drawChat();
        }
      }
    }
    x.streaming = false; drawChat();
  } catch (e) {
    x.streaming = false; x.error = "request_failed"; x.text = e.message; drawChat();
  }
}

// ------------------------------------------------------------------ runs --
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
  return \`
  <h1>Runs</h1>
  <p class="sub">Multi-agent task graphs — planned, governed, metered.</p>
  <div class="card" style="padding:0 18px">
    <table><tr><th>Run</th><th>Status</th><th>Progress</th><th>Measured spend</th><th>Created</th></tr>
    \${rows || '<tr><td colspan="5"><div class="empty">No runs yet — seed data includes one, or create runs via the API.</div></td></tr>'}</table>
  </div>\`;
}

async function runDetailPage(id) {
  const v = await get("/v1/runs/" + id);
  const run = v.run, graph = run.graph, state = run.state, budget = run.budget ?? {};
  const outputs = {};
  for (const e of v.events) if (e.event?.kind === "node_dispatched") outputs[e.event.nodeId] = e.event;
  const nodes = graph.nodes.map((n) => {
    const st = state.nodeStatuses[n.id];
    const out = outputs[n.id];
    return \`<div class="node-row">
      <span class="node-dot \${st}"></span>
      <div class="grow">
        <div>\${esc(n.title)} <span class="faint mono" style="font-size:11px">\${esc(n.id)}</span></div>
        <div class="dim" style="font-size:12px">\${esc(AGENT_NAMES[state.owners[n.id]] ?? "agent")}\${n.dependsOn?.length ? " · after " + n.dependsOn.join(", ") : ""}</div>
        \${out ? \`<details style="margin-top:4px"><summary class="faint" style="cursor:pointer;font-size:11.5px">output · \${fmtUsd(out.costUsd)} · \${esc(out.model)}</summary><pre style="margin-top:6px">\${esc(out.outputText)}</pre></details>\` : ""}
        \${state.lastError?.[n.id] ? '<div class="err-line">' + esc(state.lastError[n.id]) + "</div>" : ""}
      </div>
      <div>\${statusBadge(st)}</div>
      \${st === "in_review" ? '<button class="small" data-accept="' + n.id + '">Accept</button>' : ""}
      \${st === "blocked" ? '<button class="small" data-retry="' + n.id + '">Retry</button>' : ""}
    </div>\`;
  }).join("");
  const cap = budget.capUsd;
  const spent = budget.measuredSpentUsd ?? 0;
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
  return \`
  <button class="ghost small" data-go="runs">← All runs</button>
  <h1 style="margin-top:8px">\${esc(run.name)}</h1>
  <p class="sub">\${statusBadge(run.status)} &nbsp; created \${ago(run.createdAt)}\${run.projectId ? " · billed to " + esc((PROJECTS.find((p)=>p.id===run.projectId)||{}).name ?? "a project") : ""}</p>
  <div class="row" style="margin-bottom:12px">
    \${run.status === "planned" ? '<button class="primary" id="run-start">Start run</button>' : ""}
    \${run.status === "running" || run.status === "planned" ? '<button id="run-auto">Auto-advance</button><label class="dim" style="font-size:12.5px"><input type="checkbox" id="run-accept" checked style="vertical-align:-2px"> auto-accept reviews</label>' : ""}
  </div>
  <div class="card">\${nodes}</div>
  \${cap != null ? \`<h2>Budget</h2><div class="card">
    <div class="row"><span class="num">\${fmtUsd(spent)}</span><span class="dim">of \${fmtUsd(cap)} measured</span>
    \${budget.overageApproved ? '<span class="badge warn">overage approved</span>' : ""}</div>
    <div class="bar" style="margin-top:8px"><i class="\${spent > cap ? "over" : ""}" style="width:\${pct}%"></i></div>
  </div>\` : ""}
  \${v.pendingApprovals?.length ? '<h2>Waiting on approvals</h2><div class="card">' + v.pendingApprovals.map((a) => '<div class="row"><span class="mono">' + esc(a.stageId) + "</span>" + statusBadge(a.status) + "</div>").join("") + "</div>" : ""}\`;
}

async function wireRunDetail(id) {
  const act = async (fn, label) => {
    try { await fn(); toast(label); render(); }
    catch (e) { toast("✗ " + e.message); }
  };
  $("#run-start")?.addEventListener("click", () =>
    act(() => post("/v1/runs/" + id + "/events", { kind: "start" }), "Run started"));
  $("#run-auto")?.addEventListener("click", () =>
    act(async () => {
      const r = await post("/v1/runs/" + id + "/auto", { acceptReviews: $("#run-accept")?.checked ?? true });
      return r;
    }, "Auto-advance pass complete"));
  document.querySelectorAll("[data-accept]").forEach((b) =>
    b.addEventListener("click", () =>
      act(() => post("/v1/runs/" + id + "/events", { kind: "node_accepted", nodeId: b.dataset.accept }), "Accepted")));
  document.querySelectorAll("[data-retry]").forEach((b) =>
    b.addEventListener("click", () =>
      act(() => post("/v1/runs/" + id + "/events", { kind: "retry_node", nodeId: b.dataset.retry }), "Node re-opened")));
}

// -------------------------------------------------------------- workflows --
async function workflowsPage() {
  const { instances } = await get("/v1/workflows/instances");
  const rows = instances.map((i) => \`<tr class="click" data-go="workflows/\${i.id}">
    <td>\${esc(i.change?.description ?? "")}</td>
    <td>\${statusBadge(i.status)}</td>
    <td class="dim mono" style="font-size:11.5px">\${esc(i.change?.changeType ?? "")}</td>
    <td class="dim">\${ago(i.createdAt)}</td></tr>\`).join("");
  const projectOpts = ['<option value="">no project</option>']
    .concat(PROJECTS.map((p) => \`<option value="\${p.id}">\${esc(p.name)}</option>\`)).join("");
  return \`
  <h1>Workflows</h1>
  <p class="sub">Governed change requests — intake to sign-off to build.</p>
  <div class="card">
    <div class="row">
      <div class="grow"><label class="f">Describe the change</label><input id="wf-desc" placeholder="Add rate limiting to the public API" style="width:100%"></div>
      <div><label class="f">Type</label><input id="wf-type" value="feature" size="9"></div>
      <div><label class="f">Bill to</label><select id="wf-project">\${projectOpts}</select></div>
      <div style="align-self:flex-end"><button class="primary" id="wf-new">Start workflow</button></div>
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
    action = '<div class="card"><span class="badge warn">waiting for sign-off</span> <span class="dim">the named approver has this in their inbox</span></div>';
  } else if (inst.status === "awaiting_trigger" && current) {
    action = \`<div class="card"><div class="row"><button class="primary" id="wf-advance">Run \${esc(current.id)}</button><span class="err-line" id="wf-derr"></span></div></div>\`;
  } else if (inst.status === "awaiting_execution") {
    action = '<div class="card"><span class="badge info">executing</span> <span class="dim">a nested run or git operation is in flight' + (inst.context?.["runId:" + (current?.id ?? "")] ? ' — <a href="#/runs/' + inst.context["runId:" + current.id] + '">watch the run</a>' : "") + "</span>" + (inst.context?.lastError ? '<div class="err-line" style="margin-top:6px">' + esc(inst.context.lastError) + "</div>" : "") + "</div>";
  }
  const artifacts = (v.artifacts ?? []).map((a) =>
    \`<details style="margin-bottom:8px"><summary class="dim" style="cursor:pointer">\${esc(a.output)} v\${a.version}</summary><pre style="margin-top:6px">\${esc(a.content)}</pre></details>\`).join("");
  return \`
  <button class="ghost small" data-go="workflows">← All workflows</button>
  <h1 style="margin-top:8px">\${esc(inst.change?.description ?? "")}</h1>
  <p class="sub">\${statusBadge(inst.status)} &nbsp; \${esc(inst.change?.changeType ?? "")} · \${esc(inst.change?.environment ?? "")} · created \${ago(inst.createdAt)}</p>
  <div class="card"><div class="stage-rail">\${rail}</div></div>
  \${action}
  \${artifacts ? "<h2>Artifacts</h2><div class=card>" + artifacts + "</div>" : ""}
  \${inst.context?.prUrl ? '<h2>Delivery</h2><div class="card"><a href="' + esc(inst.context.prUrl) + '">' + esc(inst.context.prUrl) + "</a></div>" : ""}\`;
}

function wireWorkflows() {
  $("#wf-new")?.addEventListener("click", async () => {
    try {
      const projectId = $("#wf-project").value || undefined;
      const r = await post("/v1/workflows/instances", {
        ...(projectId ? { projectId } : {}),
        change: {
          description: $("#wf-desc").value || "untitled change",
          paths: ["src/"],
          changeType: $("#wf-type").value || "feature",
          environment: "staging",
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
}

// ------------------------------------------------------------------ inbox --
async function inboxPage() {
  const { approvals } = await get("/v1/approvals");
  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending").slice(0, 12);
  const label = (a) => {
    if (a.stageId === "__project_budget__") return "Project budget overage";
    if (a.stageId === "__reclassification__") return "Compliance reclassification";
    if (a.stageId?.startsWith("__context_conflict__")) return "Shared-context conflict";
    if (a.stageId?.startsWith("__budget__")) return "Run budget overage";
    return (a.objectType === "workflow" ? "Sign-off · " : a.objectType === "run" ? "Run escalation · " : "") + (a.stageId ?? "");
  };
  const row = (a, actions) => \`<div class="node-row">
    <div class="grow">
      <div>\${esc(label(a))}</div>
      <div class="dim" style="font-size:12px">\${esc(a.objectType)} · requested \${ago(a.requestedAt)}</div>
    </div>
    \${actions ? \`<button class="small primary" data-decide="approved" data-id="\${a.id}">Approve</button>
    <button class="small danger" data-decide="denied" data-id="\${a.id}">Deny</button>\` : statusBadge(a.status)}
  </div>\`;
  return \`
  <h1>Inbox</h1>
  <p class="sub">Everything that pauses for you: sign-offs, escalations, budget overages, context conflicts.</p>
  <div class="card">\${pending.map((a) => row(a, true)).join("") || '<div class="empty">Nothing waiting on you.</div>'}</div>
  \${decided.length ? "<h2>Recently decided</h2><div class=card>" + decided.map((a) => row(a, false)).join("") + "</div>" : ""}\`;
}
function wireInbox() {
  document.querySelectorAll("[data-decide]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await post("/v1/approvals/" + b.dataset.id + "/decide", { decision: b.dataset.decide });
        toast(b.dataset.decide === "approved" ? "Approved" : "Denied");
        const inbox = await get("/v1/approvals");
        INBOX_COUNT = inbox.approvals.filter((a) => a.status === "pending").length;
        render();
      } catch (e) { toast("✗ " + e.message); }
    }));
}

// --------------------------------------------------------------- projects --
async function projectsPage() {
  if (!PROJECTS.length) return '<h1>Projects</h1><p class="sub">Shared, governed workspaces.</p><div class="empty">You are not a member of any project yet.</div>';
  const cards = await Promise.all(PROJECTS.map(async (p) => {
    const ctx = await get("/v1/projects/" + p.id + "/context").catch(() => ({ context: [] }));
    const items = (ctx.context ?? []).map((c) =>
      \`<details style="margin-top:6px"><summary class="dim" style="cursor:pointer">\${esc(c.key)} <span class="faint">rev \${c.revision}</span></summary>
        <pre style="margin-top:6px">\${esc(c.content)}</pre></details>\`).join("");
    const cap = p.budgetUsd, spent = p.spentUsd ?? 0;
    const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
    return \`<div class="card">
      <div class="row"><strong>\${esc(p.name)}</strong>
        \${(p.classifications ?? []).map((c) => '<span class="badge info">' + esc(c) + "</span>").join("")}
        <span class="grow"></span>
        <span class="num dim">\${fmtUsd(spent)}\${cap ? " / " + fmtUsd(cap) : ""}</span></div>
      \${cap ? '<div class="bar" style="margin-top:8px"><i class="' + (spent > cap ? "over" : "") + '" style="width:' + pct + '%"></i></div>' : ""}
      <h2 style="margin-top:14px">Shared context</h2>
      \${items || '<div class="faint" style="font-size:12.5px">no shared context yet</div>'}
    </div>\`;
  }));
  return \`<h1>Projects</h1><p class="sub">Shared, governed workspaces — context every member sees, spend every member shares.</p>\${cards.join("")}\`;
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
    <span class="k">user id</span><span class="mono">\${esc(ME.userId)}</span>
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
    if (page === "playground") content = playgroundPage();
    else if (page === "runs" && id) content = await runDetailPage(id);
    else if (page === "runs") content = await runsPage();
    else if (page === "workflows" && id) content = await workflowDetailPage(id);
    else if (page === "workflows") content = await workflowsPage();
    else if (page === "inbox") content = await inboxPage();
    else if (page === "projects") content = await projectsPage();
    else if (page === "settings") content = await settingsPage();
    else content = playgroundPage();
  } catch (e) {
    content = '<div class="empty">Couldn’t load this view — ' + esc(e.message) + "</div>";
  }
  root.innerHTML = shell(content, page);

  document.querySelectorAll("[data-nav]").forEach((b) =>
    b.addEventListener("click", () => { location.hash = "#/" + b.dataset.nav; }));
  document.querySelectorAll("[data-go]").forEach((el) =>
    el.addEventListener("click", () => { location.hash = "#/" + el.dataset.go; }));
  $("#signout")?.addEventListener("click", signOut);

  if (page === "playground") {
    drawChat();
    $("#pg-send")?.addEventListener("click", sendPrompt);
    $("#pg-agent")?.addEventListener("change", (e) => {
      const a = AGENTS.find((x) => x.agentId === e.target.value);
      if ($("#pg-key")) $("#pg-key").innerHTML = keyHint(a);
    });
    $("#pg-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
    });
  }
  if (page === "settings") wireSettings();
  if (page === "runs" && id) wireRunDetail(id);
  if (page === "workflows" && !id) wireWorkflows();
  if (page === "workflows" && id) wireWorkflowDetail(id);
  if (page === "inbox") wireInbox();
}
render();
</script>
</body>
</html>
`;
