/**
 * ADR-0173 §4 — the command palette's data rules, as pure functions so they
 * are unit-tested without a browser.
 *
 * PAGES come from the same suites the navigation renders, filtered the same way
 * (an admin-only suite is absent for a non-admin), so the palette can never list
 * a destination the person's navigation does not. ENTITIES come from list
 * endpoints the person already reads, each of which is entitlement-scoped by the
 * gateway; the palette adds no search backend of its own.
 */
import { SUITES, type NavEntry, type Suite } from "./suites";

export type PaletteKind = "page" | "use_case" | "builder_agent" | "model" | "project" | "thread";

export interface PaletteItem {
  /** unique across kinds: `${kind}:${id}` */
  key: string;
  kind: PaletteKind;
  label: string;
  /** secondary text: the section a page sits in, a model id, an agent's name … */
  sub?: string;
  /** the in-app route to open */
  to: string;
}

export const KIND_LABELS: Record<PaletteKind, string> = {
  page: "Pages",
  thread: "Recent agent threads",
  builder_agent: "Builder agents",
  model: "Models",
  project: "Projects",
  use_case: "Use cases",
};

/** the order groups appear in */
export const KIND_ORDER: PaletteKind[] = ["page", "thread", "builder_agent", "model", "project", "use_case"];

/** every navigation destination this person may see, plus the two that live outside the suites */
export function pageItems(isAdmin: boolean, suites: readonly Suite[] = SUITES): PaletteItem[] {
  const seen = new Set<string>();
  const out: PaletteItem[] = [];
  const add = (n: NavEntry, sub: string) => {
    if (seen.has(n.to)) return;
    seen.add(n.to);
    out.push({ key: `page:${n.to}`, kind: "page", label: n.label, sub, to: n.to });
  };
  add({ label: "Home", to: "/" }, "Workspace");
  for (const suite of suites) {
    if (suite.admin && !isAdmin) continue;
    for (const section of suite.sections) for (const n of section.items) add(n, section.group === suite.name ? suite.name : `${suite.name} · ${section.group}`);
  }
  add({ label: "Account", to: "/account" }, "Your account");
  return out;
}

function score(item: PaletteItem, q: string): number {
  const label = item.label.toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  if (label.split(/[\s·/—-]+/).some((w) => w.startsWith(q))) return 60;
  if (label.includes(q)) return 40;
  if ((item.sub ?? "").toLowerCase().includes(q)) return 20;
  return 0;
}

/**
 * Filter and rank. Every whitespace-separated term must match somewhere (label
 * or sub). Empty query: the person's recent items, then pages. Results are
 * grouped by kind in KIND_ORDER, at most `perKind` each.
 */
export function searchPalette(
  items: readonly PaletteItem[],
  query: string,
  opts: { recentKeys?: readonly string[]; perKind?: number } = {},
): Array<{ kind: PaletteKind | "recent"; items: PaletteItem[] }> {
  const perKind = opts.perKind ?? 8;
  const q = query.trim().toLowerCase();
  if (!q) {
    const byKey = new Map(items.map((i) => [i.key, i]));
    const recent = (opts.recentKeys ?? []).map((k) => byKey.get(k)).filter((i): i is PaletteItem => Boolean(i));
    const recentSet = new Set(recent.map((r) => r.key));
    const pages = items.filter((i) => i.kind === "page" && !recentSet.has(i.key)).slice(0, perKind);
    return [
      ...(recent.length ? [{ kind: "recent" as const, items: recent }] : []),
      ...(pages.length ? [{ kind: "page" as const, items: pages }] : []),
    ];
  }
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = items
    .map((item) => {
      const hay = `${item.label} ${item.sub ?? ""}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return null;
      return { item, s: Math.max(...terms.map((t) => score(item, t))) };
    })
    .filter((x): x is { item: PaletteItem; s: number } => x !== null);
  return KIND_ORDER.map((kind) => ({
    kind,
    items: scored
      .filter((x) => x.item.kind === kind)
      .sort((a, b) => b.s - a.s || a.item.label.localeCompare(b.item.label))
      .slice(0, perKind)
      .map((x) => x.item),
  })).filter((g) => g.items.length > 0);
}

// ---- recent items (per browser; storage may be unavailable) ---------------

export const PALETTE_RECENT_KEY = "regulait.palette.recent";
const RECENT_MAX = 6;

export function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(PALETTE_RECENT_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecent(current: readonly string[], key: string): string[] {
  const next = [key, ...current.filter((k) => k !== key)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(PALETTE_RECENT_KEY, JSON.stringify(next));
  } catch {
    /* recent items still work for this tab */
  }
  return next;
}
