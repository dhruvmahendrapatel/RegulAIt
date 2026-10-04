/**
 * ADR-0172 — the agent builder's pure logic, kept out of the components so it
 * can be unit-tested without a DOM: bundle import parsing, schedule wording,
 * integrations filtering, usage shaping, spend-vs-limit, code snippets.
 */
import { providerLabel as fmtProviderLabel } from "../../api/format";
import type { ModelPickerAgent } from "../../ui/ModelPicker";
import { providerLogoKey } from "../../ui/logos/providerLogo";
import type {
  BuilderAgentSummary,
  BuilderBundle,
  BuilderImportDropped,
  BuilderCadence,
  BuilderIntegrationCategory,
  BuilderIntegrationsResponse,
  BuilderThreadSummary,
  BuilderUsage,
} from "../../api/types";

// ---- agent identity -------------------------------------------------------

/** Avatar fills. Every one carries white initials at WCAG AA (≥ 4.5:1). */
export const AGENT_COLORS = ["#2563eb", "#7c3aed", "#0e7490", "#047857", "#b45309", "#be185d", "#4338ca", "#0f766e"] as const;

export function agentInitials(name: string): string {
  const words = name.trim().split(/[\s\-_.]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** a server colour we do not recognise falls back to a palette colour picked from the name, so initials stay legible */
export function safeAgentColor(color: string | null | undefined, name: string): string {
  if (color && (AGENT_COLORS as readonly string[]).includes(color.toLowerCase())) return color.toLowerCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length]!;
}

/**
 * A builder agent as a picker tile: its name, and the model it runs on (the
 * provider's logo and the binding's name), so choosing an agent also shows
 * which governed model will answer.
 */
export function agentTile(a: Pick<BuilderAgentSummary, "id" | "name" | "modelAgent">): ModelPickerAgent {
  const m = a.modelAgent;
  return {
    id: a.id,
    name: a.name,
    provider: m?.provider ?? "",
    providerLabel: m ? fmtProviderLabel(m.provider) : "No model chosen",
    model: m ? m.name : null,
    logoKey: m ? providerLogoKey(m.provider) : null,
  };
}

// ---- bundle import --------------------------------------------------------

export type BundleParse = { ok: true; bundle: BuilderBundle } | { ok: false; error: string };

/**
 * A file chosen in "Import" must be an exported agent bundle before anything
 * is sent: valid JSON, `version: 1`, an agent with a name. A readable reason
 * beats a server validation error for a file that was never a bundle.
 */
export function parseBundleText(text: string): BundleParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "This file isn't valid JSON. Choose a file exported from an agent's settings." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "This file isn't an agent export." };
  }
  // an export response saved whole ({ bundle: {...} }) is accepted too
  const obj = (raw as Record<string, unknown>).bundle && typeof (raw as Record<string, unknown>).bundle === "object"
    ? ((raw as Record<string, unknown>).bundle as Record<string, unknown>)
    : (raw as Record<string, unknown>);
  if (obj.version !== 1) {
    return { ok: false, error: "This export is from an unsupported version. Export the agent again and retry." };
  }
  const agent = obj.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    return { ok: false, error: "This export has no agent in it." };
  }
  const name = (agent as Record<string, unknown>).name;
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, error: "The agent in this export has no name." };
  }
  const skills = obj.skills;
  if (skills !== undefined && !Array.isArray(skills)) {
    return { ok: false, error: "The skills in this export are not a list." };
  }
  return {
    ok: true,
    bundle: {
      version: 1,
      agent: agent as BuilderBundle["agent"],
      skills: (skills as Array<Record<string, unknown>> | undefined) ?? [],
    },
  };
}

/** `Vendor risk assessor` → `vendor-risk-assessor.agent.json` */
/**
 * What an import says when it is done. The gateway re-resolves every bundled
 * tool for the IMPORTER and reports what it left out, and why: a tool that
 * does not exist here, or one the importer holds no grant for.
 */
export function importMessage(agentName: string, dropped: readonly BuilderImportDropped[]): string {
  if (!dropped.length) return `Imported ${agentName}`;
  const noAccess = dropped.filter((d) => d.reason === "not_entitled").map((d) => d.name);
  const missing = dropped.filter((d) => d.reason === "not_found").map((d) => d.name);
  const parts: string[] = [];
  if (noAccess.length) parts.push(`${noAccess.length === 1 ? "1 tool" : `${noAccess.length} tools`} you don't have access to: ${noAccess.join(", ")}`);
  if (missing.length) parts.push(`${missing.length === 1 ? "1 tool that doesn't" : `${missing.length} tools that don't`} exist in this workspace: ${missing.join(", ")}`);
  return `Imported ${agentName}. Left out ${parts.join("; and ")}.`;
}

export function bundleFileName(agentName: string): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "agent"}.agent.json`;
}

// ---- skills ---------------------------------------------------------------

/** the frontmatter `name` / `description` of a SKILL.md, or null when it has none */
export function parseSkillFrontmatter(markdown: string): { name: string; description: string } | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  if (!fields.name) return null;
  return { name: fields.name, description: fields.description ?? "" };
}

// ---- schedules ------------------------------------------------------------

export const CADENCES: Array<{ id: BuilderCadence; label: string }> = [
  { id: "hourly", label: "Hourly" },
  { id: "daily", label: "Daily" },
  { id: "weekdays", label: "Weekdays" },
  { id: "weekly", label: "Weekly" },
];

export function isValidTimeUtc(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

/** "09:00" UTC as the reader's own clock time ("10:00 AM"), or null if not a time */
export function localTime(timeUtc: string, timeZone?: string, locale = "en-US"): string | null {
  if (!isValidTimeUtc(timeUtc)) return null;
  const [h, m] = timeUtc.split(":").map(Number) as [number, number];
  const d = new Date(Date.UTC(2026, 0, 15, h, m));
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(d);
}

/** a schedule as one plain sentence: "Weekdays at 09:00 UTC" */
export function scheduleSummary(cadence: BuilderCadence, timeUtc: string): string {
  if (cadence === "hourly") {
    const minute = isValidTimeUtc(timeUtc) ? timeUtc.slice(3) : "00";
    return minute === "00" ? "Every hour, on the hour" : `Every hour at :${minute}`;
  }
  const at = `${timeUtc} UTC`;
  if (cadence === "daily") return `Every day at ${at}`;
  if (cadence === "weekdays") return `Weekdays at ${at}`;
  return `Once a week at ${at}`;
}

// ---- spend ----------------------------------------------------------------

export type SpendState = "none" | "ok" | "warn" | "over";

/** where an agent's month stands against its limit; warn from 80% */
export function spendState(spent: number, limit: number | null | undefined): SpendState {
  if (limit == null || limit <= 0) return "none";
  if (spent >= limit) return "over";
  if (spent >= limit * 0.8) return "warn";
  return "ok";
}

/** a monthly-limit input as the PATCH value: "" → null; otherwise 0.01..100000 or an error */
export function parseLimitInput(text: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = text.trim().replace(/^\$/, "");
  if (t === "") return { ok: true, value: null };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, error: "Enter an amount in US dollars, or leave it empty for no limit." };
  if (n < 0.01) return { ok: false, error: "The limit must be at least $0.01." };
  if (n > 100000) return { ok: false, error: "The limit can be at most $100,000." };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

// ---- integrations ---------------------------------------------------------

export const INTEGRATION_CATEGORIES: Array<{ id: BuilderIntegrationCategory; label: string }> = [
  { id: "productivity", label: "Productivity" },
  { id: "developer", label: "Developer" },
  { id: "communication", label: "Communication" },
  { id: "data", label: "Data" },
  { id: "security", label: "Security" },
  { id: "ai", label: "AI" },
];

export interface IntegrationFilter {
  query: string;
  connectedOnly: boolean;
  category: BuilderIntegrationCategory | null;
}

/** the catalog groups that survive a filter, empty groups dropped, vendor order kept */
export function filterIntegrations(
  groups: BuilderIntegrationsResponse["groups"],
  f: IntegrationFilter,
): BuilderIntegrationsResponse["groups"] {
  const q = f.query.trim().toLowerCase();
  return groups
    .map((g) => ({
      name: g.name,
      items: g.items.filter(
        (i) =>
          (!f.connectedOnly || i.status === "connected") &&
          (!f.category || i.category === f.category) &&
          (!q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)),
      ),
    }))
    .filter((g) => g.items.length > 0);
}

export function countIntegrations(groups: BuilderIntegrationsResponse["groups"]) {
  let total = 0;
  let connected = 0;
  for (const g of groups) for (const i of g.items) {
    total += 1;
    if (i.status === "connected") connected += 1;
  }
  return { total, connected };
}

// ---- usage ----------------------------------------------------------------

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The daily series as exactly `days` consecutive UTC days ending today, missing
 * days filled with zero — a gap in the data must read as a quiet day, not as a
 * day that does not exist (which would stretch the bars beside it).
 */
export function shapeDaily(daily: BuilderUsage["daily"], days: number, today: Date = new Date()): BuilderUsage["daily"] {
  const byDate = new Map<string, { spendUsd: number; messages: number }>();
  for (const d of daily) {
    const key = d.date.slice(0, 10);
    const prev = byDate.get(key);
    byDate.set(key, { spendUsd: (prev?.spendUsd ?? 0) + d.spendUsd, messages: (prev?.messages ?? 0) + d.messages });
  }
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const out: BuilderUsage["daily"] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = isoDay(new Date(end - i * DAY_MS));
    const v = byDate.get(date);
    out.push({ date, spendUsd: v?.spendUsd ?? 0, messages: v?.messages ?? 0 });
  }
  return out;
}

/** "2026-10-04" → "Oct 4" (UTC, so the label never shifts a day in the reader's zone) */
export function shortDate(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}

/** rows sorted by spend, highest first, each with its share of the total */
export function withShare<T extends { spendUsd: number }>(rows: T[]): Array<T & { share: number }> {
  const total = rows.reduce((a, r) => a + r.spendUsd, 0);
  return [...rows]
    .sort((a, b) => b.spendUsd - a.spendUsd)
    .map((r) => ({ ...r, share: total > 0 ? r.spendUsd / total : 0 }));
}

// ---- threads --------------------------------------------------------------

export function filterThreads(threads: BuilderThreadSummary[], query: string): BuilderThreadSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return threads;
  return threads.filter((t) =>
    [t.title, t.agentName, t.lastMessagePreview].some((s) => s.toLowerCase().includes(q)),
  );
}

export const SOURCE_LABEL: Record<BuilderThreadSummary["source"], string> = {
  chat: "Chat",
  schedule: "Scheduled",
  channel: "Channel",
};

// ---- use in code ----------------------------------------------------------

/** copyable snippets for the chat route; the key is always a placeholder, never a real one */
export function codeSnippets(agentId: string, origin: string): { curl: string; typescript: string; python: string } {
  const url = `${origin}/v1/builder/agents/${agentId}/chat`;
  return {
    curl: [
      `curl -X POST "${url}" \\`,
      `  -H "Authorization: Bearer $REGULAIT_API_KEY" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"message": "Summarize what needs my attention today."}'`,
    ].join("\n"),
    typescript: [
      `const res = await fetch("${url}", {`,
      `  method: "POST",`,
      `  headers: {`,
      `    Authorization: \`Bearer \${process.env.REGULAIT_API_KEY}\`,`,
      `    "Content-Type": "application/json",`,
      `  },`,
      `  body: JSON.stringify({ message: "Summarize what needs my attention today." }),`,
      `});`,
      `const { thread, messages } = await res.json();`,
      `// pass { threadId: thread.id } on the next call to continue the conversation`,
      `console.log(messages.at(-1)?.content);`,
    ].join("\n"),
    python: [
      `import os`,
      `import requests`,
      ``,
      `res = requests.post(`,
      `    "${url}",`,
      `    headers={"Authorization": f"Bearer {os.environ['REGULAIT_API_KEY']}"},`,
      `    json={"message": "Summarize what needs my attention today."},`,
      `)`,
      `res.raise_for_status()`,
      `data = res.json()`,
      `# pass {"threadId": data["thread"]["id"]} on the next call to continue`,
      `print(data["messages"][-1]["content"])`,
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// ADR-0175 A6/A5 — skill admission and release-age copy
// ---------------------------------------------------------------------------

export type SkillWithheld = "held" | "refused" | "quarantined";

/** the badge and the one-line reason beside an attached skill whose pinned
 * body is kept out of the agent's prompt */
export function skillWithheldCopy(why: SkillWithheld): { badge: string; sub: string } {
  switch (why) {
    case "held":
      return { badge: "Held for review", sub: "The admission detectors flagged this skill. The agent skips it until an admin admits it." };
    case "refused":
      return { badge: "Blocked by scan", sub: "The admission detectors blocked this skill. The agent skips it until its owner fixes it." };
    case "quarantined":
      return { badge: "Waiting period", sub: "This version is newer than your organization's waiting period. The agent skips it until then." };
  }
}

/** the library card's status badge for a skill, or null when there is nothing to say */
export function skillStatusBadge(k: {
  admissionState: string;
  requestedVisibility: string | null;
  release: { quarantined: boolean; readyAt: string | null } | null;
}): { label: string; tone: "warn" | "danger" | "info" } | null {
  if (k.admissionState === "refused") return { label: "Blocked by scan", tone: "danger" };
  if (k.admissionState === "held") return { label: "Held for review", tone: "warn" };
  if (k.release?.quarantined) return { label: `Waiting until ${shortDate(k.release.readyAt ?? "")}`, tone: "info" };
  if (k.requestedVisibility === "workspace") return { label: "Sharing pending approval", tone: "info" };
  return null;
}

/** "rule (severity ×count)" lines for a findings list — never the matched text */
export function findingLines(findings: ReadonlyArray<{ rule: string; severity: string; where: string; count: number }>): string[] {
  return findings.map((f) => `${f.rule} in ${f.where} (${f.severity}, ×${f.count})`);
}
