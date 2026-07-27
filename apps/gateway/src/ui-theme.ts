/**
 * What both single-file UIs (/app, /admin) share: the design system, and the
 * one client-side error formatter.
 * Direction: warm dark, terracotta accent, monospace for data, generous
 * whitespace, hairline borders — closer to a well-made terminal tool than a
 * dashboard template. No external assets (strict self-containment).
 */

export const UI_CSS = `
:root {
  --bg: #191714;
  --bg-raised: #201d19;
  --bg-inset: #14120f;
  --border: #ffffff14;
  --border-strong: #ffffff26;
  --text: #ece7df;
  --text-dim: #a89f92;
  --text-faint: #6f675c;
  --accent: #d97757;
  --accent-soft: #d9775726;
  --ok: #7fa650;
  --warn: #d9a441;
  --bad: #cd5b52;
  --info: #6f9fc4;
  --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--sans); font-size: 14px; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
::selection { background: var(--accent-soft); }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: #ffffff1c; border-radius: 5px; }
::-webkit-scrollbar-track { background: transparent; }

/* ---- shell -------------------------------------------------------- */
.shell { display: flex; min-height: 100vh; }
.side {
  width: 218px; flex: none; border-right: 1px solid var(--border);
  padding: 20px 14px; display: flex; flex-direction: column; gap: 2px;
  position: sticky; top: 0; height: 100vh;
}
.brand { display: flex; align-items: baseline; gap: 8px; padding: 0 8px 18px; }
.brand .word { font-family: var(--mono); font-weight: 600; font-size: 15px; letter-spacing: .02em; }
.brand .word em { color: var(--accent); font-style: normal; }
.brand .tag { font-size: 10.5px; color: var(--text-faint); letter-spacing: .08em; text-transform: uppercase; }
.side .sec { font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-faint); padding: 14px 8px 5px; }
.nav-item {
  display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 7px;
  color: var(--text-dim); cursor: pointer; border: none; background: none;
  font: inherit; text-align: left; width: 100%;
}
.nav-item:hover { color: var(--text); background: #ffffff08; }
.nav-item.active { color: var(--text); background: var(--accent-soft); }
.nav-item.active .dot { background: var(--accent); }
.nav-item .dot { width: 6px; height: 6px; border-radius: 3px; background: var(--text-faint); flex: none; }
.nav-item .badge { margin-left: auto; }
.side .foot { margin-top: auto; padding: 10px 8px 0; font-size: 11.5px; color: var(--text-faint); border-top: 1px solid var(--border); }
.side .foot .who { color: var(--text-dim); font-family: var(--mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
.main { flex: 1; min-width: 0; padding: 26px 34px 60px; max-width: 1060px; }
/* mobile nav toggle — hidden on desktop, shown only inside the <900px query */
.hamburger { display: none; align-items: center; justify-content: center; font-size: 18px; line-height: 1; background: #ffffff0d; border: 1px solid var(--border-strong); border-radius: 8px; padding: 6px 11px; margin-bottom: 14px; cursor: pointer; color: var(--text); }

/* ---- primitives ---------------------------------------------------- */
h1 { font-size: 19px; font-weight: 600; margin: 0 0 2px; letter-spacing: -.01em; }
.sub { color: var(--text-dim); font-size: 13px; margin: 0 0 22px; }
h2 { font-size: 11.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-dim); font-weight: 600; margin: 26px 0 10px; }
.card { background: var(--bg-raised); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
.card + .card { margin-top: 12px; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.grow { flex: 1; min-width: 0; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 900px) {
  .grid2 { grid-template-columns: 1fr; }
  .side { display: none; }
  .side.open {
    display: flex; position: fixed; top: 0; left: 0; bottom: 0; z-index: 60;
    width: 240px; height: 100vh; background: var(--bg-raised);
    box-shadow: 0 0 40px #000000aa;
  }
  .hamburger { display: inline-flex; }
  .main { padding: 18px; }
}

button, .btn {
  font: inherit; color: var(--text); background: #ffffff0d; border: 1px solid var(--border-strong);
  border-radius: 8px; padding: 7px 14px; cursor: pointer;
}
button:hover, .btn:hover { background: #ffffff14; }
button.primary { background: var(--accent); border-color: var(--accent); color: #1b120d; font-weight: 600; }
button.primary:hover { filter: brightness(1.07); }
button.ghost { background: none; border-color: transparent; color: var(--text-dim); }
button.ghost:hover { color: var(--text); }
button.small { padding: 4px 10px; font-size: 12.5px; border-radius: 6px; }
button.danger { color: #f1b6b0; border-color: #cd5b5266; }
button:disabled { opacity: .45; cursor: default; }

input, select, textarea {
  font: inherit; color: var(--text); background: var(--bg-inset);
  border: 1px solid var(--border-strong); border-radius: 8px; padding: 8px 11px; outline: none;
}
input:focus, select:focus, textarea:focus { border-color: var(--accent); }
textarea { resize: vertical; font-family: var(--mono); font-size: 12.5px; }
label.f { display: block; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--text-dim); margin: 0 0 4px; }

table { border-collapse: collapse; width: 100%; font-size: 13px; }
th { text-align: left; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-dim); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--border-strong); }
td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
tr:hover td { background: #ffffff05; }
tr.click { cursor: pointer; }
.mono { font-family: var(--mono); font-size: 12px; }
/* compact tables: ids truncate to a chip, short enum-ish cells never wrap,
   an action cell keeps a sensible width (its controls may wrap once, its
   buttons never split), and a too-wide table scrolls inside its wrapper
   instead of bleeding past the card edge */
td.nowrap, .nowrap { white-space: nowrap; }
td.act { min-width: 160px; }
td.act button { white-space: nowrap; }
/* label-ish cells (e.g. a friendly stage name) wrap at spaces, never mid-word */
td.label { min-width: 150px; overflow-wrap: normal; }
.tblwrap { overflow-x: auto; }
.id-chip { cursor: pointer; }
.id-chip:hover { color: var(--text); }
.dim { color: var(--text-dim); }
.faint { color: var(--text-faint); }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }

.badge {
  display: inline-block; font-size: 10.5px; font-weight: 600; letter-spacing: .05em;
  padding: 2px 8px; border-radius: 20px; text-transform: uppercase; white-space: nowrap;
  background: #ffffff10; color: var(--text-dim); border: 1px solid var(--border);
}
.badge.ok { color: var(--ok); border-color: #7fa65044; background: #7fa65014; }
.badge.warn { color: var(--warn); border-color: #d9a44144; background: #d9a44114; }
.badge.bad { color: var(--bad); border-color: #cd5b5244; background: #cd5b5214; }
.badge.info { color: var(--info); border-color: #6f9fc444; background: #6f9fc414; }
.badge.accent { color: var(--accent); border-color: #d9775744; background: var(--accent-soft); }

pre, .codeblock {
  background: var(--bg-inset); border: 1px solid var(--border); border-radius: 8px;
  padding: 12px 14px; overflow: auto; font-family: var(--mono); font-size: 12.5px; line-height: 1.6;
  margin: 0; white-space: pre-wrap;
}
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 18px; font-size: 13px; }
.kv .k { color: var(--text-faint); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; padding-top: 2px; }
.hr { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
.empty { color: var(--text-faint); padding: 26px 0; text-align: center; font-size: 13px; }
.err-line { color: var(--bad); font-size: 12.5px; }
#toast-region { position: fixed; bottom: 22px; right: 22px; display: flex; flex-direction: column; gap: 8px; z-index: 50; pointer-events: none; }
.toast {
  background: var(--bg-raised);
  border: 1px solid var(--border-strong); border-left: 3px solid var(--accent);
  border-radius: 8px; padding: 10px 16px; font-size: 13px; max-width: 380px;
  box-shadow: 0 8px 30px #00000066;
}
.toast.ok { border-left-color: var(--ok); }
.toast.err { border-left-color: var(--bad); }
/* ---- one-time secret reveal ---------------------------------------- */
/* A plaintext API key exists for exactly one response — the panel that shows
   it should look like the one chance it is. */
.reveal { border-color: #d9775766; box-shadow: 0 0 0 1px #d9775722; margin-top: 12px; }
.secret { display: flex; gap: 10px; align-items: center; }
.secret code {
  flex: 1; min-width: 0; font-family: var(--mono); font-size: 12.5px;
  background: var(--bg-inset); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; overflow-wrap: anywhere; user-select: all;
}
.stat { padding: 14px 16px; }
.stat .v { font-family: var(--mono); font-size: 21px; font-weight: 600; }
.stat .l { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-faint); margin-top: 2px; }
.bar { height: 6px; border-radius: 3px; background: #ffffff10; overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
.bar > i.over { background: var(--bad); }
.bar > i.warn { background: var(--warn); }
.bar > span.mark { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--text); opacity: .55; }

/* ---- auth gate ----------------------------------------------------- */
.gate { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.gate .card { width: 380px; padding: 30px; }
.gate .brand { padding-bottom: 8px; }
.gate p { color: var(--text-dim); font-size: 13px; }

/* ---- chat ---------------------------------------------------------- */
.pg-split { display: flex; gap: 14px; align-items: flex-start; }
.convo-rail { width: 232px; flex: none; padding: 10px; position: sticky; top: 20px; max-height: calc(100vh - 40px); overflow-y: auto; }
.convo-item { display: flex; align-items: flex-start; gap: 6px; padding: 7px 6px 7px 9px; border-radius: 7px; color: var(--text-dim); cursor: pointer; }
.convo-item:hover { background: #ffffff08; color: var(--text); }
.convo-item.active { background: var(--accent-soft); color: var(--text); }
.convo-item .t { font-size: 12.5px; line-height: 1.35; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.convo-item .m { font-size: 10.5px; color: var(--text-faint); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.convo-item .x { flex: none; background: none; border: none; color: var(--text-faint); cursor: pointer; font: inherit; font-size: 14px; line-height: 1; padding: 2px 4px; border-radius: 4px; visibility: hidden; }
.convo-item:hover .x { visibility: visible; }
.convo-item .x:hover { color: var(--bad); background: #cd5b5214; }
@media (max-width: 900px) { .pg-split { flex-direction: column; } .convo-rail { width: 100%; position: static; max-height: none; } }
.chat-log { display: flex; flex-direction: column; gap: 14px; min-height: 120px; }
.msg { max-width: 88%; }
.msg.user { align-self: flex-end; }
.msg .who { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-faint); margin-bottom: 4px; }
.msg.user .who { text-align: right; }
.msg .bubble { border-radius: 10px; padding: 10px 14px; font-size: 13.5px; white-space: pre-wrap; }
.msg.user .bubble { background: var(--accent-soft); border: 1px solid #d9775733; }
.msg.agent .bubble { background: var(--bg-inset); border: 1px solid var(--border); font-family: var(--mono); font-size: 12.5px; }
.msg .meta { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.caret { display: inline-block; width: 7px; height: 14px; background: var(--accent); animation: blink 1s steps(1) infinite; vertical-align: text-bottom; }
@keyframes blink { 50% { opacity: 0; } }

/* ---- run graph ----------------------------------------------------- */
.node-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.node-row:last-child { border-bottom: none; }
.node-dot { width: 10px; height: 10px; border-radius: 5px; flex: none; }
.node-dot.not_started { background: var(--text-faint); }
.node-dot.in_progress { background: var(--info); box-shadow: 0 0 0 4px #6f9fc41f; }
.node-dot.blocked { background: var(--bad); }
.node-dot.in_review { background: var(--warn); }
.node-dot.done { background: var(--ok); }

/* ---- workflow stages ---------------------------------------------- */
.stage-rail { display: flex; gap: 6px; flex-wrap: wrap; }
.stage {
  display: flex; align-items: center; gap: 7px; padding: 5px 11px; border-radius: 18px;
  border: 1px solid var(--border); font-size: 12px; color: var(--text-dim);
}
.stage.completed { color: var(--ok); border-color: #7fa65044; }
.stage.active { color: var(--text); border-color: var(--accent); background: var(--accent-soft); }
.stage.reopened { color: var(--warn); border-color: #d9a44144; }
.chart svg { display: block; width: 100%; }
`;

/**
 * The one error formatter both UIs interpolate into their script. Every
 * gateway failure body carries the sentence that actually explains it —
 * zod's `issues`, an explicit `detail`, a governance `decision.reason`, or
 * Fastify's own `message` — and dropping it leaves a bare slug like
 * "validation" on screen with nothing actionable in it. One implementation,
 * two pages.
 */
export const UI_ERRORS_JS = `
// every reason the server volunteered, most specific first
function errDetails(json) {
  if (!json || typeof json !== "object") return [];
  const out = [];
  if (Array.isArray(json.issues)) {
    for (const i of json.issues) out.push(((i.path ?? []).join(".") || "body") + ": " + i.message);
  }
  if (typeof json.detail === "string") out.push(json.detail);
  if (json.decision && json.decision.reason) out.push(json.decision.reason);
  if (typeof json.message === "string" && json.message !== json.error) out.push(json.message);
  if (typeof json.raw === "string" && json.raw.trim()) out.push(json.raw.trim().slice(0, 200));
  return out;
}
// the slug plus the explanation, e.g. "validation — email: Invalid email"
function errMessage(status, json) {
  const head = (json && json.error) || ("HTTP " + status);
  const details = errDetails(json);
  return details.length ? head + " — " + details.join("; ") : head;
}
`;

/**
 * Display helpers both UIs interpolate after UI_ERRORS_JS. One shared source
 * for two things that must never drift apart:
 * - the Approvals Queue's internal sentinel stages (__project_budget__,
 *   __reclassification__, __context_conflict__:<uuid>, __budget__:…) mapped
 *   to the same human labels in /app's inbox and /admin's queue;
 * - UUID display: an id truncates to an 8-char chip whose tooltip carries the
 *   full value and whose click copies it — nothing auditable is lost, nothing
 *   250px tall is rendered.
 * Each page defines esc() and these run at render time, so the reference
 * resolves — helpers here must stay hoisted function declarations.
 */
export const UI_DISPLAY_JS = `
// internal sentinel stages -> human labels (null = not a sentinel)
function approvalStageLabel(a) {
  const s = a.stageId ?? "";
  if (s === "__project_budget__") return "Budget overage";
  if (s === "__reclassification__") return "Reclassification";
  if (s.startsWith("__context_conflict__"))
    return "Context conflict" + (a.contextConflict && a.contextConflict.key ? " · " + a.contextConflict.key : "");
  if (s.startsWith("__budget__")) return "Run budget";
  if (s.startsWith("__infra_remediation__")) return "Infra remediation";
  return null;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortId = (id) => String(id).slice(0, 8) + "…";
// truncated id chip: full id in the tooltip, click to copy
function idChip(id) {
  return "<span class='mono dim id-chip' data-copyid='" + esc(id) + "' title='" + esc(id) + " — click to copy'>" + esc(shortId(id)) + "</span>";
}
document.addEventListener("click", async (e) => {
  const chip = e.target && e.target.closest ? e.target.closest("[data-copyid]") : null;
  if (!chip) return;
  try {
    await navigator.clipboard.writeText(chip.dataset.copyid);
    const orig = chip.textContent;
    chip.textContent = "copied";
    setTimeout(() => { chip.textContent = orig; }, 900);
  } catch { /* clipboard unavailable — the tooltip still shows the full id */ }
});
`;
