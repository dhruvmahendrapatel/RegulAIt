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
  /* essential-but-secondary text (.sub/.empty/.faint/.sec/.foot/timestamps):
     bumped from #6f675c (~3.3:1, a real WCAG fail) to ~5:1 */
  --text-faint: #8f8578;
  /* the OLD faint value, kept for purely-decorative faint uses (nav dot,
     scrollbar) so the text bump above doesn't wash them out */
  --decor: #6f675c;
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
.nav-item .dot { width: 6px; height: 6px; border-radius: 3px; background: var(--decor); flex: none; }
.nav-item .badge { margin-left: auto; }
.side .foot { margin-top: auto; padding: 10px 8px 0; font-size: 11.5px; color: var(--text-faint); border-top: 1px solid var(--border); }
.side .foot .who { color: var(--text-dim); font-family: var(--mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
.main { flex: 1; min-width: 0; padding: 26px 34px 60px; max-width: 1060px; }
/* mobile nav toggle — hidden on desktop, shown only inside the <900px query */
.hamburger { display: none; align-items: center; justify-content: center; font-size: 18px; line-height: 1; background: #ffffff0d; border: 1px solid var(--border-strong); border-radius: 8px; padding: 6px 11px; margin-bottom: 14px; cursor: pointer; color: var(--text); }

/* ---- primitives ---------------------------------------------------- */
h1 { font-size: 19px; font-weight: 600; margin: 0 0 2px; letter-spacing: -.01em; }
/* h1 is made programmatically focusable (tabindex=-1) so render() can move
   keyboard focus to the panel heading — suppress the ring on that focus */
h1[tabindex]:focus { outline: none; }
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
/* one keyboard focus ring for every interactive element — visible, accent, and
   never shown on mere mouse focus (:focus-visible). An outset ring for controls
   that have room for it; an inset ring (offset -2px) for form fields, whose own
   border/background would otherwise clip an outset outline. */
button:focus-visible, .nav-item:focus-visible, .convo-item:focus-visible,
.id-chip:focus-visible, a:focus-visible, summary:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--accent); outline-offset: -2px;
}
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
/* ---- data table: sortable / filterable / paginated (dataTable helper) ---- */
.dtbar { margin: 0 0 10px; }
.dtfilter { width: 100%; max-width: 320px; }
th.dtsort { cursor: pointer; user-select: none; white-space: nowrap; }
th.dtsort:hover { color: var(--text); }
th.dtsort:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 4px; }
th.dtsort[aria-sort="ascending"], th.dtsort[aria-sort="descending"] { color: var(--text); }
.dtpage { display: flex; align-items: center; gap: 4px; margin-top: 10px; font-size: 12.5px; }

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
.kv .k { color: var(--text-dim); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; padding-top: 2px; }
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
.stat .l { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-dim); margin-top: 2px; }
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
/* the meta line sits on the lighter active (accent-soft) / rail surface, where
   --text-faint dips under 4.5:1 — use --text-dim so it clears AA there too */
.convo-item .m { font-size: 10.5px; color: var(--text-dim); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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

/* ---- chat attachments (mimics Claude's native attach) -------------- */
.composer { position: relative; }
.composer.dragover { outline: 2px dashed var(--accent); outline-offset: 3px; border-radius: 10px; }
.composer.dragover::after { content: "Drop files to attach"; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--accent-soft); color: var(--text); font-size: 13px; border-radius: 10px; pointer-events: none; z-index: 2; }
.attach-btn { padding: 8px 11px; font-size: 16px; line-height: 1; background: #ffffff0d; border: 1px solid var(--border-strong); border-radius: 8px; color: var(--text-dim); cursor: pointer; flex: none; }
.attach-btn:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
.attach-tray { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.attach-chip { display: flex; align-items: center; gap: 8px; background: var(--bg-inset); border: 1px solid var(--border-strong); border-radius: 8px; padding: 6px 8px; max-width: 240px; }
.attach-chip .thumb { width: 34px; height: 34px; border-radius: 5px; object-fit: cover; flex: none; background: #ffffff0d; }
.attach-chip .ico { width: 34px; height: 34px; border-radius: 5px; flex: none; display: flex; align-items: center; justify-content: center; font-size: 17px; background: #ffffff0d; }
.attach-chip .an { font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-chip .as { font-size: 10.5px; color: var(--text-faint); }
.attach-chip .rm { margin-left: 2px; background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 4px; flex: none; }
.attach-chip .rm:hover { color: var(--bad); }
.msg .att-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.msg.user .att-row { justify-content: flex-end; }
.att-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-dim); background: var(--bg-inset); border: 1px solid var(--border); border-radius: 6px; padding: 3px 7px; }
.att-pill img { width: 20px; height: 20px; border-radius: 3px; object-fit: cover; }

/* ---- run graph ----------------------------------------------------- */
.node-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.node-row:last-child { border-bottom: none; }
.node-dot { width: 10px; height: 10px; border-radius: 5px; flex: none; }
.node-dot.not_started { background: var(--text-faint); }
.node-dot.in_progress { background: var(--info); box-shadow: 0 0 0 4px #6f9fc41f; }
.node-dot.blocked { background: var(--bad); }
.node-dot.in_review { background: var(--warn); }
.node-dot.done { background: var(--ok); }

/* ---- getting-started deep-link flash -------------------------------- */
/* a setup-checklist deep link highlights the exact form that completes the
   step: a brief accent pulse, removed by the portal after ~2.4s */
.setup-flash { outline: 2px solid var(--accent); outline-offset: 6px; border-radius: 8px; animation: setupflash 2.4s ease-out; }
@keyframes setupflash { 0% { outline-color: var(--accent); } 100% { outline-color: transparent; } }

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
// truncated id chip: full id in the tooltip, click (or Enter/Space) to copy.
// role=button + tabindex=0 make it a real keyboard-reachable control, mirroring
// the dataTable sort headers.
function idChip(id) {
  return "<span class='mono dim id-chip' role='button' tabindex='0' data-copyid='" + esc(id) + "' title='" + esc(id) + " — click to copy'>" + esc(shortId(id)) + "</span>";
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
// Enter/Space on a focused chip triggers the same copy path as a click.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const chip = e.target && e.target.closest ? e.target.closest("[data-copyid]") : null;
  if (!chip) return;
  e.preventDefault();
  chip.click();
});
// Two-step INLINE confirm, replacing native confirm() — which silently
// no-ops (returns false with no dialog) in some embedded/webview browsers,
// leaving dead buttons. First activation ARMS the button ("Sure? …") for
// ~4s; a second activation inside the window returns true and the caller
// proceeds. Anything that re-renders the button simply disarms it.
function confirmClick(btn, prompt) {
  if (!btn) return true;
  if (btn.dataset.cfArmed === "1") {
    btn.dataset.cfArmed = "";
    btn.textContent = btn.dataset.cfLabel ?? btn.textContent;
    btn.style.borderColor = ""; btn.style.color = "";
    return true;
  }
  btn.dataset.cfArmed = "1";
  btn.dataset.cfLabel = btn.textContent;
  btn.textContent = prompt || ("Sure? " + btn.textContent);
  btn.style.borderColor = "var(--bad)"; btn.style.color = "var(--bad)";
  btn.title = btn.title || "click again to confirm";
  setTimeout(() => {
    if (btn.isConnected && btn.dataset.cfArmed === "1") {
      btn.dataset.cfArmed = "";
      btn.textContent = btn.dataset.cfLabel;
      btn.style.borderColor = ""; btn.style.color = "";
    }
  }, 4000);
  return false;
}
`;

/**
 * The shared table + formatting layer both UIs interpolate AFTER UI_DISPLAY_JS
 * (so idChip/UUID_RE/shortId already exist). One source for:
 * - table(): the bare renderer for short lists, which DELEGATES to dataTable()
 *   once a list runs long (>8 rows), so every call site inherits sort/filter/
 *   paginate + human labels + UUID chips for free;
 * - dataTable(): sortable/filterable/paginated, keyboard-operable headers;
 * - humanizeKey/badge/kvList/inlineCounts and the renderDecision/renderCompliance
 *   operator views that replace raw <pre>JSON dumps.
 * These were previously inlined in the admin portal; relocated here verbatim so
 * /app reaches parity with /admin with no per-page copy. All are hoisted
 * declarations called at render time — esc() (page-local) resolves then.
 */
export const UI_TABLE_JS = `
// short enum-ish cells that must never wrap into a vertical smear
const NOWRAP_COLS = new Set(["status", "type", "effect", "kind", "provider", "mode", "role"]);
const ISO_RE = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}/;
function table(rows, actions) {
  if (!rows || rows.length === 0) return "<div class='empty'>none yet</div>";
  // once a list runs long, hand off to dataTable so it gains sort/filter/paging
  // (and the same UUID-chip / ISO-date / human-label treatment) for free; short
  // lists stay bare, with no filter/paging chrome.
  if (rows.length > 8) return dataTable(rows, actions ? { actions: actions } : {});
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
`;
