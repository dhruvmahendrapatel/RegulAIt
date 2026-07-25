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
const nrAgentSel = (nid) => '<select data-nagent="' + nid + '">' + AGENTS.map((a) =>
  '<option value="' + a.agentId + '"' + (a.agentId === nrDefaultAgent() ? " selected" : "") + '>' + esc(a.name) + " · " + esc(a.provider) + "</option>").join("") + "</select>";
const nrNodeRowsHtml = (t) => t.nodes.map((n) => \`<div class="node-row">
  <span class="node-dot not_started"></span>
  <div class="grow"><label class="f">\${esc(n.id)}\${n.dependsOn.length ? " · after " + n.dependsOn.join(", ") : ""}</label>
    <input data-ntitle="\${n.id}" value="\${esc(n.title)}" style="width:100%" title="\${esc(n.instruction)}"></div>
  <div><label class="f">Agent</label>\${nrAgentSel(n.id)}</div>
</div>\`).join("");
// the exact JSON the form POSTs — also what the advanced textarea pre-fills
function nrGraph() {
  const t = RUN_TEMPLATES.find((x) => x.id === $("#nr-template")?.value) ?? RUN_TEMPLATES[0];
  return {
    run: ($("#nr-title")?.value ?? "").trim() || "untitled run",
    // escalations land in the planner's own inbox unless the JSON names someone else
    escalationApproverUserId: ME.userId,
    nodes: t.nodes.map((n) => ({
      id: n.id,
      title: ($('[data-ntitle="' + n.id + '"]')?.value ?? n.title).trim() || n.title,
      instruction: n.instruction,
      ownerAgentId: $('[data-nagent="' + n.id + '"]')?.value ?? nrDefaultAgent(),
      mode: "execute",
      dependsOn: n.dependsOn,
    })),
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
  const newRun = AGENTS.length === 0
    ? '<div class="empty">No agents are granted to your account — ask an admin to grant you one before planning a run.</div>'
    : \`
    <div class="row">
      <div class="grow"><label class="f">Title</label><input id="nr-title" placeholder="What is this run for?" style="width:100%"></div>
      <div><label class="f">Bill to</label><select id="nr-project">\${projectOpts}</select></div>
      <div><label class="f">Template</label><select id="nr-template">\${tplOpts}</select></div>
    </div>
    <div id="nr-nodes" style="margin-top:6px">\${nrNodeRowsHtml(RUN_TEMPLATES[0])}</div>
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
  $("#nr-template")?.addEventListener("change", () => {
    const t = RUN_TEMPLATES.find((x) => x.id === $("#nr-template").value) ?? RUN_TEMPLATES[0];
    $("#nr-nodes").innerHTML = nrNodeRowsHtml(t);
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
      toast(r.budgetApprovalPending ? "Run planned — over your budget cap, approval requested" : "Run planned");
      location.hash = "#/runs/" + r.id;
    } catch (e) { err.textContent = e.message; } // zod issues arrive via errMessage
  });
}

async function runDetailPage(id) {
  const v = await get("/v1/runs/" + id);
  const run = v.run, graph = run.graph, state = run.state, budget = run.budget ?? {};
  const outputs = {};
  for (const e of v.events) if (e.event?.kind === "node_dispatched") outputs[e.event.nodeId] = e.event;
  const nodes = graph.nodes.map((n) => {
    const st = state.nodeStatuses[n.id];
    const out = outputs[n.id];
    // instruction edits only matter for a node that can still dispatch
    const editable = st === "not_started" || st === "in_progress" || st === "blocked";
    const instr = n.instruction ?? n.title;
    const editor = editable ? \`<div data-nedbox="\${n.id}" style="display:none;margin-top:6px">
        <textarea data-ninput="\${n.id}" data-def="\${esc(instr)}" rows="4" style="width:100%" spellcheck="false">\${esc(instr)}</textarea>
        <div class="faint" style="font-size:11.5px;margin-top:2px">Sent to this node's worker as its instructions on the next dispatch\${st === "in_progress" ? "" : " (auto-advance picks edits up)"}.</div>
        \${st === "in_progress" ? '<button class="small" data-dispatch="' + n.id + '" style="margin-top:6px">Dispatch with these instructions</button>' : ""}
      </div>\` : "";
    return \`<div class="node-row">
      <span class="node-dot \${st}"></span>
      <div class="grow">
        <div>\${esc(n.title)} <span class="faint mono" style="font-size:11px">\${esc(n.id)}</span></div>
        <div class="dim" style="font-size:12px">\${esc(AGENT_NAMES[state.owners[n.id]] ?? "agent")}\${n.dependsOn?.length ? " · after " + n.dependsOn.join(", ") : ""}</div>
        \${out ? \`<details style="margin-top:4px"><summary class="faint" style="cursor:pointer;font-size:11.5px">output · \${fmtUsd(out.costUsd)} · \${esc(out.model)}</summary><pre style="margin-top:6px">\${esc(out.outputText)}</pre></details>\` : ""}
        \${state.lastError?.[n.id] ? '<div class="err-line">' + esc(state.lastError[n.id]) + "</div>" : ""}
        \${editor}
      </div>
      \${editable ? '<button class="ghost small" data-nedit="' + n.id + '" title="adjust the instructions sent to this node&#39;s worker">✎</button>' : ""}
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
  \${v.pendingApprovals?.length ? '<h2>Waiting on approvals</h2><div class="card">' + v.pendingApprovals.map((a) => '<div class="row"><span class="mono">' + esc(a.stageId) + '</span><span class="dim" style="font-size:12px">awaiting ' + esc(a.approverName ?? "the named approver") + "</span>" + statusBadge(a.status) + "</div>").join("") + "</div>" : ""}\`;
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
      // any edited per-node instruction rides along as that node's input
      const inputs = {};
      document.querySelectorAll("[data-ninput]").forEach((t) => {
        const v = t.value.trim();
        if (v && v !== t.dataset.def) inputs[t.dataset.ninput] = v;
      });
      const r = await post("/v1/runs/" + id + "/auto", {
        acceptReviews: $("#run-accept")?.checked ?? true,
        ...(Object.keys(inputs).length ? { inputs } : {}),
      });
      return r;
    }, "Auto-advance pass complete"));
  document.querySelectorAll("[data-nedit]").forEach((b) =>
    b.addEventListener("click", () => {
      const box = $('[data-nedbox="' + b.dataset.nedit + '"]');
      if (box) box.style.display = box.style.display === "none" ? "" : "none";
    }));
  // manual dispatch of an in_progress node (e.g. one a failed pass stranded):
  // dispatch with the adjusted instructions, then submit the output for
  // review — the same two steps an auto-advance pass takes.
  document.querySelectorAll("[data-dispatch]").forEach((b) =>
    b.addEventListener("click", () =>
      act(async () => {
        const t = $('[data-ninput="' + b.dataset.dispatch + '"]');
        const v = (t?.value ?? "").trim();
        await post("/v1/runs/" + id + "/nodes/" + b.dataset.dispatch + "/dispatch",
          v && v !== t.dataset.def ? { input: v } : {});
        await post("/v1/runs/" + id + "/events", { kind: "node_submitted", nodeId: b.dataset.dispatch });
      }, "Node dispatched — output submitted for review")));
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
    const awaiting = [...new Set((v.pendingApprovals ?? []).map((a) => a.approverName ?? "the named approver"))];
    action = '<div class="card"><span class="badge warn">waiting for sign-off</span> <span class="dim">awaiting ' + esc(awaiting.join(", ") || "the named approver") + " — it is in their inbox</span></div>";
  } else if (inst.status === "awaiting_trigger" && current) {
    action = \`<div class="card"><div class="row"><button class="primary" id="wf-advance">Run \${esc(current.id)}</button><span class="err-line" id="wf-derr"></span></div></div>\`;
  } else if (inst.status === "awaiting_execution") {
    action = '<div class="card"><span class="badge info">executing</span> <span class="dim">a nested run or git operation is in flight' + (inst.context?.["runId:" + (current?.id ?? "")] ? ' — <a href="#/runs/' + inst.context["runId:" + current.id] + '">watch the run</a>' : "") + "</span>" + (inst.context?.lastError ? '<div class="err-line" style="margin-top:6px">' + esc(inst.context.lastError) + "</div>" : "") + "</div>";
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
  document.querySelectorAll("[data-promote]").forEach((b) =>
    b.addEventListener("click", () => promoteArtifact(b.dataset.pid, b.dataset.promote)));
}

// ------------------------------------------------------------------ inbox --
const approvalLabel = (a) => {
  if (a.stageId === "__project_budget__") return "Project budget overage";
  if (a.stageId === "__reclassification__") return "Compliance reclassification";
  if (a.stageId?.startsWith("__context_conflict__"))
    return "Shared-context conflict" + (a.contextConflict ? " · '" + a.contextConflict.key + "'" : "");
  if (a.stageId?.startsWith("__budget__")) return "Run budget overage";
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
    if (!v || !(v.artifacts ?? []).length) return "";
    const latest = {};
    for (const art of v.artifacts) if (!latest[art.output] || art.version > latest[art.output].version) latest[art.output] = art;
    return Object.values(latest).map((art) =>
      \`<details style="margin-top:6px"><summary class="faint" style="cursor:pointer;font-size:11.5px">submitted \${esc(art.output)} v\${art.version}</summary><pre style="margin-top:6px">\${esc(art.content)}</pre></details>\`).join("");
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
    if (!named && !ME.isAdmin) return '<span class="dim" style="font-size:12px">awaiting ' + esc(a.approverName ?? "the named approver") + "</span>";
    return (named ? "" : '<span class="badge warn" title="you are not the named approver — a reason is required">override</span>')
      + \`<input data-reason="\${a.id}" placeholder="\${named ? "reason (optional)" : "reason (required — admin override)"}" style="font-size:12px;max-width:\${named ? 170 : 210}px">
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

  const memberRows = members.map((m) => \`<div class="node-row">
    <div class="grow">
      <div>\${esc(m.userName ?? "unknown")}\${m.userId === ME.userId ? ' <span class="faint">(you)</span>' : ""}</div>
      <div class="dim" style="font-size:12px">\${m.teamName ? esc(m.teamName) : "no team"} · joined \${ago(m.createdAt)}</div>
    </div>
    <span class="badge \${m.role === "owner" ? "accent" : m.role === "contributor" ? "info" : ""}">\${m.role}</span>
  </div>\`).join("");
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
  document.querySelectorAll("[data-promote]").forEach((b) =>
    b.addEventListener("click", () => promoteArtifact(b.dataset.pid, b.dataset.promote)));
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
  if (page === "runs" && !id) wireRuns();
  if (page === "runs" && id) wireRunDetail(id);
  if (page === "workflows" && !id) wireWorkflows();
  if (page === "workflows" && id) wireWorkflowDetail(id);
  if (page === "inbox") wireInbox();
  if (page === "projects") wireProjects();
}
render();
</script>
</body>
</html>
`;
