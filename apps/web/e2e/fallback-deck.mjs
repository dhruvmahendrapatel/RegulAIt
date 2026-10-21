#!/usr/bin/env node
/**
 * Offline fallback deck for the AI-intake demo.
 *
 * If the live demo fails (laptop, network, projector), the presenter walks the
 * same beats from REAL screenshots of the seeded-database journey. Nothing here
 * is mocked up: every image is a screenshot `e2e/demo-intake.spec.ts` took from
 * the running product, and every "Say" line is read from the demo script, so the
 * deck cannot drift from either.
 *
 *   1. On a fresh `demo:prepare` database, BEFORE the journey, capture the gate:
 *        pnpm -s --filter @regulait/gateway demo:gate -- "Real-Time Fraud Detection Engine" \
 *          production build-4417 > apps/web/e2e/artifacts/demo/real-gate.txt
 *   2. Run the real journey (playwright.demo-real.config.ts) — it writes real-*.png.
 *   3. node apps/web/e2e/fallback-deck.mjs [--dark]
 *        → apps/web/e2e/artifacts/demo/fallback-deck.html (one self-contained file)
 *
 * The 2026-11-01 deck (ADR-0197) is built from the `demo-screens` pack instead, in that script's order (Shadow AI
 * first, then governance):
 *   1. Download the `demo-screens` artifact of a green `Demo journey` run into apps/web/e2e/artifacts/demo-screens/
 *      (`e2e/demo-screens.spec.ts` writes ds-*.png there).
 *   2. node apps/web/e2e/fallback-deck.mjs --pack 2026-11-01 [--dark] (--gate <file> | --no-gate)
 *        → apps/web/e2e/artifacts/demo-screens/fallback-deck-2026-11-01.html
 *      G3 is terminal output, not in the pack: pass the captured `demo:gate` output with --gate, or leave the beat
 *      out on purpose with --no-gate. With --dark, the screens the pack shot in dark get a dark slide.
 *
 * Keys: → / Space next, ← previous, Home / End, T toggles the screenshot theme
 * (only with --dark), S shows or hides the presenter's "Say" line (hidden by
 * default, so a shared screen shows the product, not the script). A missing
 * screenshot is a build error, never a blank slide.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const pack = argValue("--pack");
if (pack !== undefined && pack !== "2026-11-01") throw new Error(`--pack ${pack}: only 2026-11-01 is known`);
const v3 = pack === "2026-11-01";
const SHOTS = path.join(here, "artifacts", v3 ? "demo-screens" : "demo");
const SCRIPT = path.resolve(here, `../../../docs/product/DEMO_SCRIPT_${v3 ? "2026-11-01" : "2026-10-05"}.md`);
const SCRIPT_1005 = path.resolve(here, "../../../docs/product/DEMO_SCRIPT_2026-10-05.md");
const withDark = argv.includes("--dark");
const gateFile = argValue("--gate");
const noGate = argv.includes("--no-gate");
if (v3 && !gateFile && !noGate) throw new Error("--pack 2026-11-01 needs --gate <file> (the captured demo:gate output) or --no-gate");

const PHASES = { 1: "Discover & Register", 2: "Assess & Deploy", 3: "Monitor & Respond" };

/** beat → the screenshots that show it, in presenting order */
const BEATS_1005 = [
  { beat: "1A", persona: "Ada", shots: [["real-01-discover", "Shadow AI found in imported evidence, ready to register"]] },
  { beat: "1B", persona: "Ada", shots: [["real-02-assist", "Intake: tier from structured answers; every suggestion reviewed by a person"]] },
  {
    beat: "2A",
    persona: "Ada",
    shots: [
      ["real-03-use-case-360", "Use-case 360"],
      ["real-03b-stack", "The agent the evidence pointed at, with its model-card status"],
      ["real-03c-dependencies", "Use case → agent → model → vendor, with inherited risk"],
      ["real-04-risks-controls", "Risks with declared inherent and residual positions, tied to controls"],
    ],
  },
  {
    beat: "2B",
    persona: "Avery",
    shots: [
      ["real-05-avery-signoff", "Avery reviews the evidence in one task panel — never the proposer"],
      ["real-05a-avery-conditions", "Approve with conditions: a before-go-live condition holds deployment"],
      ["real-05b-avery-approved", "Approved for six months (high tier): one audited decision"],
    ],
  },
  { beat: "2C", persona: "Pipeline", gate: "real-gate.txt" },
  { beat: "3A", persona: "Ada", shots: [["real-05c-trust-dashboard", "Evidence coverage per dimension; unmeasured is a gap"]] },
  {
    beat: "3B",
    persona: "Ada → Avery",
    shots: [
      ["real-06-alert-acknowledged", "Alerts raise, refresh and resolve; an acknowledgement is recorded"],
      ["real-07-remediation-proposed", "Ada proposes an executable remediation"],
      ["real-08-remediation-approved", "Avery approves it; only then does governed state change"],
    ],
  },
  { beat: "3C", persona: "Ada", shots: [["real-09-dependency-graph", "Declared and observed dependencies; risk propagates as a maximum"]] },
  { beat: "3D", persona: "Ada", shots: [["real-10-regulatory-intelligence", "Source-dated obligations joined to our controls and use cases"]] },
  { beat: "3E", persona: "Ada", shots: [["real-11-signed-audit-export", "One hash-chained trail, exported as a signed bundle"]] },
];

/** the 2026-11-01 script's beats → the demo-screens pack (`e2e/demo-screens.spec.ts`), in presenting order */
const BEATS_1101 = [
  { beat: "S1", persona: "Ada", shots: [["ds-s1-discovery-sources", "Every source is read-only and off until an admin enables it"]] },
  {
    beat: "S2",
    persona: "Ada",
    shots: [
      ["ds-s2-findings", "Each finding says what each scanner saw, and where"],
      ["ds-s2b-pseudonym-reveal-prefilled", "A pseudonym opens Reveal prefilled; revealing is a step-up"],
      ["ds-s2d-coverage", "The coverage scorecard: gaps are shown, never papered over"],
    ],
  },
  {
    beat: "S3",
    persona: "Ada → Morgan",
    shots: [
      ["ds-s3a-remediation-plan-seeded", "The remediation plan, already linked to a workflow waiting on Morgan"],
      ["ds-s3b-remediation-plan-live", "A plan for another finding, with its environment typed"],
      ["ds-s3c-start-dialog", "Starting the workflow is a person's act"],
      ["ds-s3d-started-and-linked", "Started and linked: the finding is now confirmed"],
      ["ds-s3e-workflow-plan-only", "Plan only: nothing builds until a person finishes planning"],
      ["ds-s3f-workflow-artifact", "The remediation plan submitted as the stage's artifact"],
      ["ds-s3g-workflow-waiting-signoff", "Waiting for sign-off by an admin other than the initiator"],
      ["ds-s3h-morgan-inbox", "Morgan reviews the request in her Inbox; the decision row stays in view"],
      ["ds-s3i-morgan-approved", "Morgan approves"],
      ["ds-s3j-workflow-signed-off", "The workflow is signed off"],
    ],
  },
  { beat: "S4", persona: "Ada", shots: [["ds-s4-intake-prefilled", "Intake prefilled with only what the evidence established"]] },
  {
    beat: "G1",
    persona: "Ada",
    shots: [
      ["ds-g1a-registry", "The AI registry"],
      ["ds-g1b-use-case-record", "The use-case record: tier, lifecycle, approval and conditions"],
      ["ds-g1c-use-case-audit", "The use case's own audit trail"],
    ],
  },
  {
    beat: "G2",
    persona: "Avery",
    shots: [
      ["ds-g2a-avery-inbox", "Avery's Inbox: the independent reviewer is never the proposer"],
      ["ds-g2b-avery-review-conditions", "Approve with conditions"],
    ],
  },
  { beat: "G3", persona: "Pipeline", gate: true },
  { beat: "G4", persona: "Ada", shots: [["ds-g4-trust", "Evidence coverage per dimension; unmeasured is a gap"]] },
  {
    beat: "G5",
    persona: "Ada → Avery",
    shots: [
      ["ds-g5-alerts", "Governance alerts"],
      ["ds-g5b-alert-drawer", "An alert opens beside the list; its Acknowledge row stays in view"],
    ],
  },
  { beat: "G6", persona: "Ada", shots: [["ds-g6-graph", "Declared and observed dependencies; risk propagates as a maximum"]] },
  { beat: "G7", persona: "Ada", shots: [["ds-g7-regulatory", "Source-dated obligations joined to our controls and use cases"]] },
  { beat: "G8", persona: "Ada", shots: [["ds-g8-audit", "One hash-chained trail, exported as a signed bundle"]] },
  {
    beat: "G9",
    persona: "Ada",
    shots: [
      ["ds-g9-incidents", "Open incidents with their clocks and corrective actions"],
      ["ds-g9-feedback", "Problem reports and appeals routed for an independent answer"],
      ["ds-g9-decision-records", "The decision records behind the use case's approval"],
    ],
  },
  { beat: "G10", persona: "Ada", shots: [["ds-g10-content-trust", "Content below the write floor cannot drive a write"]] },
];
const BEATS = v3 ? BEATS_1101.filter((b) => !(b.gate && noGate)) : BEATS_1005;

/**
 * "### 1A. Shadow AI discovery — Ada" (10-05) or "### S1. Discovery sources — Ada — 3 minutes" (11-01) → title; its
 * first "- **Say:**" (or "- **Say (added for v3):**") bullet → say; the "## " section it sits in → section; and
 * "(10-05 beat 2A)" in the heading → the 10-05 beat it reuses
 */
function readScript(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const beats = {};
  let current = null;
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const h = /^### (\d[A-Z]|[SG]\d+)(?: \([^)]*\))?\. (.+?)(?: — .+)?$/.exec(lines[i]);
    // any other "### " heading (the 11-01 "Close") ends the beat above it
    if (!h && /^### /.test(lines[i])) current = null;
    if (h) {
      const reuses = /\(10-05 beat (\d[A-Z])\)/.exec(lines[i]);
      current = beats[h[1]] = { title: h[2].trim(), say: "", section, reuses: reuses?.[1] };
      continue;
    }
    if (/^## /.test(lines[i])) {
      current = null;
      section = lines[i].replace(/^## /, "").replace(/\s*\(.*\)$/, "").trim();
    }
    const say = /^- \*\*Say(?: \([^)]*\))?:\*\*/.exec(lines[i]);
    if (current && say && !current.say) {
      let text = lines[i].slice(say[0].length).trim();
      while (lines[i + 1] && /^\s{2,}\S/.test(lines[i + 1])) text += " " + lines[++i].trim();
      current.say = text.replace(/^"|"$/g, "");
    }
  }
  return beats;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dataUri = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;

const script = readScript(SCRIPT);
const script1005 = v3 ? readScript(SCRIPT_1005) : script;
const missing = [];
const slides = [];
for (const b of BEATS) {
  const meta = script[b.beat];
  if (!meta) throw new Error(`beat ${b.beat} is not in ${path.basename(SCRIPT)}`);
  // an Act 2 beat of the 11-01 script keeps the 10-05 beat's Say line unless it has its own
  const say = meta.say || (meta.reuses ? (script1005[meta.reuses]?.say ?? "") : "");
  const phase = v3 ? meta.section.replace(/^Act \d+ — /, "") : PHASES[b.beat[0]];
  if (b.gate) {
    const file = v3 ? path.resolve(gateFile) : path.join(SHOTS, b.gate);
    if (!existsSync(file)) {
      missing.push(v3 ? gateFile : b.gate);
      continue;
    }
    const text = readFileSync(file, "utf8").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    slides.push({ ...b, ...meta, say, phase, caption: "The deploy gate answers the pipeline from live governance state", text });
    continue;
  }
  for (const [shot, caption] of b.shots) {
    const light = path.join(SHOTS, `${shot}-light.png`);
    const dark = path.join(SHOTS, `${shot}-dark.png`);
    // the 10-05 deck needs a dark shot of every screen; the 11-01 pack shoots only its opening screens in dark
    const hasDark = withDark && existsSync(dark);
    if (!existsSync(light) || (withDark && !v3 && !hasDark)) {
      missing.push(shot);
      continue;
    }
    slides.push({ ...b, ...meta, say, phase, caption, light: dataUri(light), dark: hasDark ? dataUri(dark) : null });
  }
}
if (missing.length) {
  const hint = v3
    ? "Download the demo-screens artifact of a green Demo journey run first (see the header of this file)."
    : "Run the gate capture and the real journey first (see the header of this file).";
  console.error(`fallback-deck: missing ${missing.join(", ")} in ${SHOTS}\n${hint}`);
  process.exit(1);
}

const slideHtml = slides
  .map((s, i) => {
    const body = s.text
      ? `<pre class="term"><code>${esc(s.text)}</code></pre>`
      : `<img alt="${esc(s.caption)}" src="${s.light}"${s.dark ? ` data-dark="${s.dark}" data-light="${s.light}"` : ""}>`;
    return `<section class="slide" data-i="${i}"${i ? " hidden" : ""}>
  <header><span class="phase">${esc(s.phase)}</span><span class="beat">${s.beat}</span><h1>${esc(s.title)}</h1><span class="persona">${esc(s.persona)}</span></header>
  <p class="caption">${esc(s.caption)}</p>
  <div class="stage">${body}</div>
  <footer><p class="say">${esc(s.say)}</p><span class="count">${i + 1} / ${slides.length}</span></footer>
</section>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${v3 ? "RegulAIt demo walkthrough, 2026-11-01" : "RegulAIt demo walkthrough"}</title>
<style>
  :root { --bg: #f6f7f9; --panel: #ffffff; --ink: #14171c; --muted: #5b6472; --line: #dde1e7; --accent: #2f5bd3; --term: #0f1218; --term-ink: #d7dde7; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink);
    font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .slide { height: 100vh; display: grid; grid-template-rows: auto auto 1fr auto; padding: 20px 28px 16px; gap: 10px; }
  .slide[hidden] { display: none; }
  header { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
  .phase { color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: .06em; white-space: nowrap; }
  .beat { font-weight: 600; color: var(--accent); }
  h1 { margin: 0; font-size: 22px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .persona { border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; font-size: 13px; color: var(--muted); white-space: nowrap; }
  .caption { margin: 0; color: var(--muted); }
  .stage { min-height: 0; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
  .stage img { display: block; width: 100%; height: auto; }
  .term { margin: 0; min-height: 100%; padding: 24px; background: var(--term); color: var(--term-ink);
    font: 15px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace; white-space: pre-wrap; }
  footer { display: flex; align-items: flex-end; gap: 16px; }
  .say { margin: 0; flex: 1; font-size: 16px; }
  body:not(.presenter) .say { visibility: hidden; }
  .say::before { content: "Say  "; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  .count { color: var(--muted); font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  @media (max-width: 700px) { .slide { padding: 12px 16px; } .phase { display: none; } h1 { font-size: 18px; } }
</style>
</head>
<body>
${slideHtml}
<script>
  const slides = [...document.querySelectorAll(".slide")];
  let i = 0, dark = false;
  const show = (n) => {
    i = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach((s, k) => (s.hidden = k !== i));
    slides[i].querySelector(".stage").scrollTop = 0;
  };
  addEventListener("keydown", (e) => {
    if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); show(i + 1); }
    else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); show(i - 1); }
    else if (e.key === "Home") show(0);
    else if (e.key === "s" || e.key === "S") document.body.classList.toggle("presenter");
    else if (e.key === "End") show(slides.length - 1);
    else if (e.key === "t" || e.key === "T") {
      dark = !dark;
      document.querySelectorAll("img[data-dark]").forEach((img) => (img.src = dark ? img.dataset.dark : img.dataset.light));
    }
  });
</script>
</body>
</html>
`;

const out = path.join(SHOTS, v3 ? "fallback-deck-2026-11-01.html" : "fallback-deck.html");
writeFileSync(out, html);
console.log(`fallback-deck: ${slides.length} slides → ${out} (${(html.length / 1048576).toFixed(1)} MB)`);
