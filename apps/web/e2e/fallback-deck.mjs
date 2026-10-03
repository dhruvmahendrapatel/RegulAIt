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
 * Keys: → / Space next, ← previous, Home / End, T toggles the screenshot theme
 * (only with --dark), S shows or hides the presenter's "Say" line (hidden by
 * default, so a shared screen shows the product, not the script). A missing
 * screenshot is a build error, never a blank slide.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, "artifacts", "demo");
const SCRIPT = path.resolve(here, "../../../docs/product/DEMO_SCRIPT_2026-10-05.md");
const withDark = process.argv.includes("--dark");

const PHASES = { 1: "Discover & Register", 2: "Assess & Deploy", 3: "Monitor & Respond" };

/** beat → the screenshots that show it, in presenting order */
const BEATS = [
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
      ["real-05-avery-signoff", "The sign-off waits for Avery, never the proposer"],
      ["real-05b-avery-approved", "Approved: one audited decision"],
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

/** "### 1A. Shadow AI discovery — Ada" → title; its "- **Say:**" bullet → say */
function readScript() {
  const lines = readFileSync(SCRIPT, "utf8").split("\n");
  const beats = {};
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const h = /^### (\d[A-Z])\. (.+?)(?: — .+)?$/.exec(lines[i]);
    if (h) {
      current = beats[h[1]] = { title: h[2].trim(), say: "" };
      continue;
    }
    if (/^## /.test(lines[i])) current = null;
    if (current && lines[i].startsWith("- **Say:**")) {
      let say = lines[i].replace("- **Say:**", "").trim();
      while (lines[i + 1] && /^\s{2,}\S/.test(lines[i + 1])) say += " " + lines[++i].trim();
      current.say = say.replace(/^"|"$/g, "");
    }
  }
  return beats;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dataUri = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;

const script = readScript();
const missing = [];
const slides = [];
for (const b of BEATS) {
  const meta = script[b.beat];
  if (!meta) throw new Error(`beat ${b.beat} is not in ${path.basename(SCRIPT)}`);
  const phase = PHASES[b.beat[0]];
  if (b.gate) {
    const file = path.join(SHOTS, b.gate);
    if (!existsSync(file)) {
      missing.push(b.gate);
      continue;
    }
    const text = readFileSync(file, "utf8").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    slides.push({ ...b, ...meta, phase, caption: "The deploy gate answers the pipeline from live governance state", text });
    continue;
  }
  for (const [shot, caption] of b.shots) {
    const light = path.join(SHOTS, `${shot}-light.png`);
    const dark = path.join(SHOTS, `${shot}-dark.png`);
    if (!existsSync(light) || (withDark && !existsSync(dark))) {
      missing.push(shot);
      continue;
    }
    slides.push({ ...b, ...meta, phase, caption, light: dataUri(light), dark: withDark ? dataUri(dark) : null });
  }
}
if (missing.length) {
  console.error(`fallback-deck: missing ${missing.join(", ")} in ${SHOTS}\nRun the gate capture and the real journey first (see the header of this file).`);
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
<title>RegulAIt demo walkthrough</title>
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

const out = path.join(SHOTS, "fallback-deck.html");
writeFileSync(out, html);
console.log(`fallback-deck: ${slides.length} slides → ${out} (${(html.length / 1048576).toFixed(1)} MB)`);
