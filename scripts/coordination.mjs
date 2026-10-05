/**
 * AgentCoordination.md tooling — the ONE way agents check in, and the lint
 * that keeps the file small.
 *
 *   pnpm checkin <claude|codex|gemini> --now "<doing>" [--next "<then>"]
 *        [--eta "<HH:MM UTC>"] [--blocked "<on what>"] [--ack] [--push]
 *        [--trailer "<git trailer line>"]...
 *       Rewrites YOUR row of the Live-status table IN PLACE (one row per agent,
 *       never a history), stamps the UTC time, prints your inbox and your
 *       tasks, then lints. `--ack` clears the "To <You>" messages you have just
 *       read. `--push` commits ONLY AgentCoordination.md, rebases, pushes.
 *
 *   pnpm coord:status   every agent's row with its age; STALE > 60 min,
 *                       OFFLINE > 90 min (owner directive: check in hourly)
 *   pnpm coord:lint     structural limits; exit 1 on violation (runs in CI)
 *
 * NO SHEBANG, ON PURPOSE. The file is not executable (mode 100644) and every
 * caller runs `node scripts/coordination.mjs`, so a `#!` line bought nothing —
 * and `coordination.test.mjs` imports this module under Vitest, whose module
 * transform turned a `#!` line ending in CR (a Windows checkout with
 * core.autocrlf) into "SyntaxError: Invalid or unexpected token" before a single
 * assertion ran (codexInputs G10-G15-VERIFY). Reproduced on Linux by converting
 * both files to CRLF; it passes with the line gone.
 *
 * WHY A SCRIPT. "Edit your row, don't append" is a rule people (and agents)
 * break under time pressure; a command that can only overwrite cannot. The
 * history is in git — `git log -p AgentCoordination.md` — so nothing is lost
 * by keeping the file to the current state.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(root, "AgentCoordination.md");
const AGENTS = { claude: "Claude", codex: "Codex", gemini: "Gemini" };

/** structural limits — the file stays readable in one sitting */
export const LIMITS = {
  maxLines: 800,
  maxMessagesPerInbox: 8,
  maxMessageAgeHours: 12,
  maxDoneLogEntries: 40,
  maxStatusLinesPerTask: 1,
  staleMinutes: 60,
  offlineMinutes: 90,
};

const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
/** "10-02 03:10" → Date in the current UTC year (rolls back a year if that lands in the future) */
function parseStamp(s, now = new Date()) {
  const m = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  let d = new Date(Date.UTC(now.getUTCFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]));
  if (d.getTime() - now.getTime() > 24 * 3600_000) d = new Date(Date.UTC(now.getUTCFullYear() - 1, +m[1] - 1, +m[2], +m[3], +m[4]));
  return d;
}
const cell = (s) => (s ?? "—").replace(/\|/g, "/").replace(/\s+/g, " ").trim() || "—";

function liveRows(lines) {
  const start = lines.findIndex((l) => /^## Live status/.test(l));
  if (start < 0) throw new Error("AgentCoordination.md has no '## Live status' section");
  const rows = {};
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const m = /^\| (Claude|Codex|Gemini) \|/.exec(lines[i]);
    if (m) (rows[m[1]] ??= []).push(i);
  }
  return { start, rows };
}

function inboxRange(lines, agentName) {
  const h = lines.findIndex((l) => l.trim() === `### To ${agentName}`);
  if (h < 0) return null;
  let end = h + 1;
  while (end < lines.length && !/^### /.test(lines[end]) && !/^---\s*$/.test(lines[end]) && !/^## /.test(lines[end])) end++;
  return { h, end };
}

function messages(lines, range) {
  const out = [];
  for (let i = range.h + 1; i < range.end; i++) {
    const m = /^- \((\w+), (\d{2}-\d{2} \d{2}:\d{2})\)/.exec(lines[i]);
    if (m) out.push({ line: i, from: m[1], at: m[2] });
  }
  return out;
}

function taskBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^- \*\*([CXG]\d+[a-z]?) — /.exec(lines[i]);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && !/^- \*\*/.test(lines[end]) && !/^#{2,3} /.test(lines[end]) && lines[end].trim() !== "") end++;
    blocks.push({ id: m[1], start: i, end, lines: lines.slice(i, end) });
  }
  return blocks;
}

export function lint(text, now = new Date()) {
  // a Windows checkout (core.autocrlf) hands us CRLF; every rule below is
  // written against "\n", so normalise once rather than let `\r` ride along
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const errors = [];
  if (lines.length > LIMITS.maxLines) {
    errors.push(`file is ${lines.length} lines (limit ${LIMITS.maxLines}) — collapse VERIFIED tasks, prune the Done log and handled messages`);
  }
  const { rows } = liveRows(lines);
  for (const name of Object.values(AGENTS)) {
    const n = rows[name]?.length ?? 0;
    if (n !== 1) errors.push(`Live status has ${n} row(s) for ${name} — exactly one, overwritten at each check-in`);
  }
  for (const name of Object.values(AGENTS)) {
    const r = inboxRange(lines, name);
    if (!r) {
      errors.push(`message board has no "### To ${name}" section`);
      continue;
    }
    const msgs = messages(lines, r);
    if (msgs.length > LIMITS.maxMessagesPerInbox) {
      errors.push(`"To ${name}" holds ${msgs.length} messages (limit ${LIMITS.maxMessagesPerInbox}) — the recipient acks with \`pnpm checkin … --ack\``);
    }
    for (const m of msgs) {
      const d = parseStamp(m.at, now);
      if (d && (now.getTime() - d.getTime()) / 3600_000 > LIMITS.maxMessageAgeHours) {
        errors.push(`"To ${name}" message from ${m.from} at ${m.at} is older than ${LIMITS.maxMessageAgeHours}h — handle and delete it`);
      }
    }
  }
  for (const b of taskBlocks(lines)) {
    const statusLines = b.lines.filter((l) => /^\s*Status:/.test(l)).length;
    if (statusLines > LIMITS.maxStatusLinesPerTask) {
      errors.push(`task ${b.id} has ${statusLines} Status lines — overwrite the one Status line, never append history`);
    }
  }
  const done = lines.findIndex((l) => /^## 6\. Done log/.test(l));
  if (done >= 0) {
    const entries = lines.slice(done + 1).filter((l) => /^- [A-Z]\d+/.test(l)).length;
    if (entries > LIMITS.maxDoneLogEntries) errors.push(`Done log has ${entries} entries (limit ${LIMITS.maxDoneLogEntries}) — older ones live in git history`);
  }
  return errors;
}

function statusReport(text, now = new Date()) {
  const lines = text.split("\n");
  const { rows } = liveRows(lines);
  const out = [];
  for (const name of Object.values(AGENTS)) {
    const i = rows[name]?.[0];
    if (i === undefined) {
      out.push({ name, age: null, flag: "MISSING", row: "" });
      continue;
    }
    const cols = lines[i].split("|").map((c) => c.trim());
    const at = parseStamp(cols[5] ?? "", now);
    const age = at ? Math.round((now.getTime() - at.getTime()) / 60_000) : null;
    const flag = age === null ? "NO-TIME" : age > LIMITS.offlineMinutes ? "OFFLINE" : age > LIMITS.staleMinutes ? "STALE" : "OK";
    out.push({ name, age, flag, now: cols[2], next: cols[3], blocked: cols[6] });
  }
  return out;
}

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
function args(argv, flag) {
  const out = [];
  argv.forEach((a, i) => a === flag && argv[i + 1] !== undefined && out.push(argv[i + 1]));
  return out;
}
const git = (...a) => execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function checkin(argv) {
  const key = (argv[0] ?? "").toLowerCase();
  const name = AGENTS[key];
  const nowText = arg(argv, "--now");
  if (!name || !nowText) {
    console.error('usage: pnpm checkin <claude|codex|gemini> --now "<doing>" [--next ""] [--eta ""] [--blocked ""] [--ack] [--push]');
    process.exit(2);
  }
  if (argv.includes("--push")) {
    try {
      git("pull", "--rebase", "--autostash", "origin", git("rev-parse", "--abbrev-ref", "HEAD"));
    } catch (e) {
      console.error(`git pull --rebase failed — resolve, then re-run:\n${e.stderr ?? e.message}`);
      process.exit(3);
    }
  }
  const now = new Date();
  let lines = readFileSync(FILE, "utf8").split("\n");
  const { rows } = liveRows(lines);
  const row = `| ${name} | ${cell(nowText)} | ${cell(arg(argv, "--next"))} | ${cell(arg(argv, "--eta"))} | ${stamp(now)} | ${cell(arg(argv, "--blocked"))} |`;
  const existing = rows[name] ?? [];
  if (existing.length === 0) {
    const header = lines.findIndex((l) => /^\| Agent \| Now \|/.test(l));
    lines.splice(header + 2, 0, row);
  } else {
    lines[existing[0]] = row;
    // more than one row is exactly the history this tool exists to prevent
    for (const extra of existing.slice(1).reverse()) lines.splice(extra, 1);
  }

  const r = inboxRange(lines, name);
  const inbox = r ? lines.slice(r.h + 1, r.end).filter((l) => l.trim() && !/^- \(empty/.test(l)) : [];
  if (argv.includes("--ack") && r && inbox.length) {
    lines.splice(r.h + 1, r.end - r.h - 1, `- (empty — acknowledged by ${name} ${stamp(now)})`, "");
  }
  const text = lines.join("\n");
  writeFileSync(FILE, text);

  console.log(`checked in: ${row}\n`);
  console.log(`Inbox (To ${name}):${inbox.length ? "" : " empty"}`);
  for (const l of inbox) console.log(`  ${l}`);
  if (argv.includes("--ack") && inbox.length) console.log("  → acknowledged and cleared");
  const mine = taskBlocks(text.split("\n")).filter((b) => b.id.startsWith(name[0]) && !/VERIFIED/.test(b.lines[0]));
  console.log(`\nYour open tasks:`);
  for (const b of mine) {
    const st = b.lines.find((l) => /^\s*Status:/.test(l))?.trim() ?? "Status: (none)";
    console.log(`  ${b.id}  ${st.slice(0, 140)}`);
  }
  console.log("\nTeam:");
  for (const s of statusReport(text, now)) console.log(`  ${s.name.padEnd(7)} ${s.flag.padEnd(8)} ${s.age ?? "?"} min ago — ${s.now ?? ""}`);
  const errs = lint(text, now);
  if (errs.length) {
    console.log("\nLint (fix before pushing):");
    for (const e of errs) console.log(`  ✗ ${e}`);
  }

  if (argv.includes("--push")) {
    if (errs.length) {
      console.error("\nnot pushed: lint errors above");
      process.exit(1);
    }
    const trailers = args(argv, "--trailer");
    git("add", "AgentCoordination.md");
    const msg = [`chore(checkin): ${name} ${stamp(now)} UTC`, "", cell(nowText), ...(trailers.length ? ["", ...trailers] : [])].join("\n");
    try {
      git("commit", "-m", msg);
    } catch {
      console.log("\nnothing to commit");
      return;
    }
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        git("push", "origin", `HEAD:${branch}`);
        console.log(`\npushed to ${branch}`);
        return;
      } catch {
        git("pull", "--rebase", "origin", branch);
      }
    }
    console.error("push failed three times — pull, resolve, re-run");
    process.exit(3);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const [cmd, ...rest] = invokedDirectly ? process.argv.slice(2) : ["__imported__"];
if (cmd === "__imported__") {
  /* imported by the test — no CLI */
} else if (cmd === "checkin") checkin(rest);
else if (cmd === "status") {
  for (const s of statusReport(readFileSync(FILE, "utf8"))) {
    console.log(`${s.name.padEnd(7)} ${s.flag.padEnd(8)} ${String(s.age ?? "?").padStart(4)} min  now: ${s.now ?? ""} | next: ${s.next ?? ""} | blocked: ${s.blocked ?? ""}`);
  }
} else if (cmd === "lint") {
  const errs = lint(readFileSync(FILE, "utf8"));
  for (const e of errs) console.error(`✗ ${e}`);
  console.log(errs.length ? `${errs.length} coordination lint error(s)` : "AgentCoordination.md: OK");
  process.exit(errs.length ? 1 : 0);
} else {
  console.error("usage: coordination.mjs <checkin|status|lint> …");
  process.exit(2);
}
