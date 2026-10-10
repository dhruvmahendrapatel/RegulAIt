/**
 * ADR-0169 — one glyph per navigation destination, for the auto-hidden rail's
 * icon strip.
 *
 * The kit's icon discipline (see SuiteGlyph): inline SVG, stroke currentColor
 * at 1.6, round caps and joins, fill none, aria-hidden — the LINK carries the
 * accessible name (its label stays in the DOM when the rail is collapsed).
 *
 * Paths only, never `<circle>`: the brand contract counts the `<circle>`s
 * inside the rail to prove the mark has exactly five nodes, so a round glyph
 * is drawn with arcs (see `ring`). A destination with no glyph here falls back
 * to a two-letter monogram so a new nav entry can never render as a blank.
 */

/** a circle as an SVG path (two arcs) */
const ring = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const G = {
  home: "M4.5 11L12 4.8l7.5 6.2M6.5 9.5V19h4v-5h3v5h4V9.5",
  chat: "M5 6h14v9.5h-8.5L6.5 19v-3.5H5V6z",
  run: `${ring(12, 12, 7.5)}M10.5 9.2v5.6l4.4-2.8-4.4-2.8z`,
  flow: "M4.5 4.5h5v5h-5zM14.5 14.5h5v5h-5zM7 9.5v4a3 3 0 0 0 3 3h4.5",
  inbox: "M4.5 13.5L6.8 6h10.4l2.3 7.5V19h-15v-5.5zm0 0H9l1 2h4l1-2h4.5",
  folder: "M4.5 6.5h5.3l1.7 2h8v9.5h-15V6.5z",
  layers: "M12 4.5L19.5 8.3 12 12 4.5 8.3 12 4.5zM4.5 12L12 15.8l7.5-3.8M4.5 15.7L12 19.5l7.5-3.8",
  wallet: "M4.5 7.5h13.5a1.5 1.5 0 0 1 1.5 1.5v9H4.5V7.5zm0 0l10-3v3M15.5 12.8h.01",
  gauge: "M4.8 16.5a7.2 7.2 0 1 1 14.4 0M12 16.5l3.6-4.6M4 19.5h16",
  shield: "M12 4l7 2.6v5.1c0 4.2-2.9 7.1-7 8.3-4.1-1.2-7-4.1-7-8.3V6.6L12 4zm-2.6 8.2l1.9 1.9 3.4-3.6",
  bell: "M7 16v-4.5a5 5 0 0 1 10 0V16l1.5 2h-13L7 16zM10.5 20.5h3",
  report: "M7 4.5h7l3.5 3.5v11.5H7V4.5zm7 0V8h3.5M9.5 12h5M9.5 15h5",
  spark: "M11 4.5l1.6 4.4 4.4 1.6-4.4 1.6L11 16.5l-1.6-4.4L5 10.5l4.4-1.6L11 4.5zM17.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z",
  list: "M5 6.5h1.5M10 6.5h9M5 12h1.5M10 12h9M5 17.5h1.5M10 17.5h9",
  intake: "M9 4.5h6v2.5H9zM7 5.8H5.5V20h13V5.8H17M12 10.5v6M9 13.5h6",
  graph: `${ring(6.5, 7, 2)}${ring(17.5, 7, 2)}${ring(12, 17.5, 2)}M8.3 8.3l2.8 7.4M15.7 8.3l-2.8 7.4M8.5 7h7`,
  scales: "M12 4.5v15M8 19.5h8M5 8h14M7.5 8L5 13.5a2.5 2.5 0 0 0 5 0L7.5 8zm9 0L14 13.5a2.5 2.5 0 0 0 5 0L16.5 8z",
  cube: "M12 4l7.5 4v8L12 20l-7.5-4V8L12 4zM4.5 8L12 12l7.5-4M12 12v8",
  building: "M5 19.5V8l7-3.5L19 8v11.5M9.5 19.5v-5h5v5M3.5 19.5h17M9 10.5h.01M15 10.5h.01",
  warning: "M12 4.5l8.2 14.5H3.8L12 4.5zM12 10v4M12 16.5v.01",
  eye: `M3.5 12s3.2-5.5 8.5-5.5 8.5 5.5 8.5 5.5-3.2 5.5-8.5 5.5S3.5 12 3.5 12z${ring(12, 12, 2.5)}`,
  checklist: "M5 7l1.5 1.5L9 6M11.5 7.5H19M5 13l1.5 1.5L9 12M11.5 13.5H19M5.5 18.5h2M11.5 18.5H19",
  columns: "M4.5 5.5h15v13h-15zM9.5 5.5v13M14.5 5.5v13",
  chatCheck: "M5 6h14v9.5h-8.5L6.5 19v-3.5H5V6zm4.5 4.8l1.8 1.8 3.4-3.4",
  log: "M6 4.5h9l3 3v12H6v-15zM9 10h6M9 13h6M9 16h4",
  branch: `${ring(7, 6, 1.8)}${ring(7, 18, 1.8)}${ring(17, 8, 1.8)}M7 7.8v8.4M17 9.8c0 3.4-3.2 4.2-8.4 6.6`,
  pulse: "M3.5 12h3.8l2.2-5.5 4 11 2.2-5.5h4.8",
  robot: `M6.5 9h11v9.5h-11zM12 5.5V9M10 13h.01M14 13h.01M10 16h4M4.5 12.5v3M19.5 12.5v3${ring(12, 4.6, 1)}`,
  bulb: "M9.5 17.5h5M10.3 20.5h3.4M12 4.5a5 5 0 0 0-3 9c.6.5 1 1.2 1 2v.5h4v-.5c0-.8.4-1.5 1-2a5 5 0 0 0-3-9z",
  ribbon: `${ring(12, 9.5, 4.8)}M9.4 13.6L8.5 20l3.5-2 3.5 2-.9-6.4`,
  divide: `M5 12h14${ring(12, 7, 1.3)}${ring(12, 17, 1.3)}`,
  sliders: "M5 7h14M5 12h14M5 17h14M9 5v4M15 10v4M7.5 15v4",
  tag: "M4.5 4.5h7l8 8-7 7-8-8v-7zM8.5 8.5h.01",
  rails: "M6 4.5v15M18 4.5v15M6 9h12M6 15h12",
  history: `${ring(12, 12, 3)}M12 4.5V9M12 15v4.5`,
  flask: "M9.5 4.5h5M10.5 4.5v5L6 18a1.4 1.4 0 0 0 1.2 2h9.6A1.4 1.4 0 0 0 18 18l-4.5-8.5v-5M8.2 14.5h7.6",
  template: "M4.5 4.5h15v5h-15zM4.5 12.5h6v7h-6zM13.5 12.5h6v7h-6z",
  bars: "M4 19.5h16M6.5 19V12M10.5 19V6.5M14.5 19v-4.5M18.5 19V9.5",
  crosshair: `${ring(12, 12, 6.5)}M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4`,
  star: "M12 4.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2L4.5 10l5.2-.7L12 4.5z",
  person: `${ring(12, 8.5, 3.5)}M5.5 19.5c.8-3.3 3.4-5 6.5-5s5.7 1.7 6.5 5`,
  idCard: `M4.5 6h15v12h-15zM14 10h3.5M14 13.5h3.5${ring(9.5, 10.8, 1.9)}M6.8 15.6c.5-1.3 1.5-2 2.7-2s2.2.7 2.7 2`,
  people: `${ring(9, 9, 2.8)}M3.8 18.5c.6-2.6 2.6-4 5.2-4s4.6 1.4 5.2 4${ring(16.5, 9.5, 2.3)}M15.6 14.4c2.2 0 3.9 1.2 4.6 3.6`,
  laptop: "M5.5 6.5h13V15h-13zM3.5 18h17",
  key: "M10 12a3.5 3.5 0 1 1 3.4 3.5H13l-1.5 1.5H10v1.7l-1.6 1.6H5.5V17l4.6-4.6",
  lock: "M7 10.5h10v9H7zM9 10.5V8a3 3 0 0 1 6 0v2.5M12 14v2.5",
  sync: "M6 9a6.5 6.5 0 0 1 11.3-1.6M18 15a6.5 6.5 0 0 1-11.3 1.6M17.5 4v3.5H14M6.5 20v-3.5H10",
  mapping: "M4.5 7h6M4.5 12h6M4.5 17h6M13.5 12h6M17 9l3 3-3 3",
  chip: "M8 8h8v8H8zM10 4.5V8M14 4.5V8M10 16v3.5M14 16v3.5M4.5 10H8M4.5 14H8M16 10h3.5M16 14h3.5",
  plug: "M9 4.5V9m6-4.5V9M7 9h10v3a5 5 0 0 1-10 0V9zm5 8v3",
  server: "M5 5h14v5H5zM5 14h14v5H5zM8 7.5h.01M8 16.5h.01",
  kanban: "M4.5 5h15v14h-15zM9.5 5v14M14.5 5v14M6.3 8.5h1.4M11.3 8.5h1.4M16.3 8.5h1.4M11.3 11.5h1.4",
  cloud: "M7.2 17.5a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 8.6a3.5 3.5 0 0 1 .5 7M12 12v7.5M9.5 14.5L12 12l2.5 2.5",
  dollar: `${ring(12, 12, 7.5)}M14.4 9.4c-.5-.8-1.4-1.2-2.4-1.2-1.5 0-2.5.8-2.5 1.9 0 2.6 5.1 1.4 5.1 4 0 1.1-1.1 1.9-2.6 1.9-1.2 0-2.2-.5-2.7-1.3M12 6.8V8.2M12 15.9v1.3`,
  merge: "M6.5 4.5v4a3 3 0 0 0 3 3h5a3 3 0 0 1 3 3v5M17.5 4.5v4a3 3 0 0 1-3 3",
  trend: "M5 5v14h14M8 14l3-3.5 2.5 2L17 8m0 0h-3.2M17 8v3.2",
  receipt: "M6.5 4.5h11v15l-2-1.3-1.8 1.3-1.7-1.3-1.7 1.3-1.8-1.3-2 1.3v-15zM9.5 9h5M9.5 12h5M9.5 15h3",
  bolt: "M13 3.5L6 13.5h5l-1 7 7-10h-5l1-7z",
  box: "M4.5 8L12 4.5 19.5 8v8L12 19.5 4.5 16V8zm0 0L12 11.5 19.5 8M12 11.5v8",
  ticket: "M4.5 7.5h15v3a1.5 1.5 0 0 0 0 3v3h-15v-3a1.5 1.5 0 0 0 0-3v-3zM14 7.5v9",
  clock: `${ring(12, 12, 7.5)}M12 8v4.5l3 2`,
  pause: `${ring(12, 12, 7.5)}M10 9.5v5M14 9.5v5`,
  flag: "M6.5 20V4.5M6.5 5h10l-2 3.5 2 3.5h-10",
  compass: `${ring(12, 12, 7.5)}M14.8 9.2l-1.6 4-4 1.6 1.6-4 4-1.6z`,
  // ADR-0173 — a feature × model grid with one allowed tick
  modelGrid: "M4.5 4.5h15v15h-15zM4.5 9.5h15M4.5 14.5h15M9.5 4.5v15M14.5 4.5v15M15.8 12l1.2 1.2 2-2.2",
};

/** route → glyph. Detail routes resolve through their list entry upstream. */
const BY_ROUTE: Record<string, keyof typeof G> = {
  "/": "home",
  "/chat": "chat",
  "/models": "cube",
  "/builder": "chat",
  "/builder/inbox": "inbox",
  "/builder/agents": "robot",
  "/builder/templates": "template",
  "/builder/integrations": "plug",
  "/builder/skills": "bolt",
  "/builder/usage": "bars",
  // ADR-0173 batch 2b
  "/builder/prompts": "tag",
  "/builder/playground": "flask",
  "/runs": "run",
  "/workflows": "flow",
  "/inbox": "inbox",
  "/projects": "folder",
  "/context": "layers",
  "/spend": "wallet",
  // ADR-0182 (D4)
  "/incidents": "warning",
  "/feedback": "chatCheck",
  "/admin/posture": "gauge",
  "/admin/governance/trust": "shield",
  "/admin/governance/alerts": "bell",
  "/admin/monitoring": "gauge",
  "/admin/reports": "report",
  "/admin/copilot": "spark",
  "/admin/approvals": "checklist",
  "/admin/review-workbench": "columns",
  "/admin/chatops": "chatCheck",
  "/admin/audit": "log",
  "/admin/lineage": "branch",
  "/admin/traces": "pulse",
  "/admin/use-cases": "list",
  "/admin/governance/intake": "intake",
  "/admin/governance/review-policy": "checklist",
  "/admin/governance/graph": "graph",
  "/admin/governance/regulatory": "scales",
  "/admin/governance/decision-regression": "history", // ADR-0182 A11
  "/admin/governance/literacy": "ribbon", // ADR-0182 A14
  "/admin/model-risk": "cube",
  "/admin/vendors": "building",
  "/admin/risks": "warning",
  "/admin/shadow-ai": "eye",
  "/admin/inventory": "robot",
  "/admin/recommendations": "bulb",
  "/admin/certification": "ribbon",
  "/admin/sod": "divide",
  "/admin/rules": "sliders",
  "/admin/abac-policies": "tag",
  "/admin/guardrails": "rails",
  "/admin/model-policy": "modelGrid",
  "/admin/prompt-versions": "history",
  "/admin/simulation": "flask",
  "/admin/workflow-templates": "template",
  "/admin/evals": "bars",
  "/admin/redteam": "crosshair",
  "/admin/external-scorers": "star",
  "/admin/annotation-queues": "checklist", // ADR-0173 batch 2c (Q)
  "/admin/users": "person",
  "/admin/roles": "idCard",
  "/admin/teams": "people",
  "/admin/client-access": "laptop",
  "/admin/virtual-keys": "key",
  "/admin/credentials": "key",
  "/admin/sso": "lock",
  "/admin/provisioning": "sync",
  "/admin/group-mappings": "mapping",
  "/admin/agents": "robot",
  "/admin/model-credentials": "key",
  "/admin/custom-providers": "chip",
  "/admin/regulait-llm": "spark",
  "/admin/connectors": "plug",
  "/admin/mcp-servers": "server",
  "/admin/webhooks": "sync",
  "/admin/engines": "box", // ADR-0187
  "/admin/admission": "shield",
  "/admin/git-connections": "branch",
  "/admin/pm-connections": "kanban",
  "/admin/deploy-targets": "cloud",
  "/admin/cost": "dollar",
  "/admin/cost-consolidation": "merge",
  "/admin/spend-monitor": "trend",
  "/admin/billing": "receipt",
  "/admin/optimization": "bolt",
  "/admin/compliance": "shield",
  "/admin/compliance-packs": "box",
  "/admin/infrastructure": "server",
  "/admin/organization": "building",
  "/admin/retention": "history",
  "/admin/licensing": "ticket",
  "/admin/data-key": "lock",
  "/admin/scheduler": "clock",
  "/admin/enforcement-posture": "shield",
  "/admin/execution": "pause",
  "/admin/first-run": "flag",
  "/admin/setup": "compass",
};

/** true when a destination has a drawn glyph (exported for the unit test) */
export function hasNavGlyph(to: string): boolean {
  return to in BY_ROUTE;
}

const stroke = {
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  fill: "none",
};

export function NavGlyph(props: { to: string; label: string; className?: string }) {
  const key = BY_ROUTE[props.to];
  if (!key) {
    const mono = props.label
      .replace(/[^A-Za-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0]!)
      .join("")
      .slice(0, 2)
      .toUpperCase();
    return (
      <span className={props.className} aria-hidden data-glyph="monogram">
        {mono || "•"}
      </span>
    );
  }
  return (
    <svg className={props.className} width="20" height="20" viewBox="0 0 24 24" aria-hidden focusable="false">
      <path {...stroke} d={G[key]} />
    </svg>
  );
}

/** small UI glyphs the rail itself uses */
export function RailGlyph(props: { name: "search" | "pin" | "pinOff"; className?: string }) {
  const d =
    props.name === "search"
      ? `${ring(10.5, 10.5, 5.5)}M14.5 14.5l5 5`
      : props.name === "pin"
        ? "M9 4.5h6M10 4.5v5l-3 3.5h10l-3-3.5v-5M12 13v6.5"
        : "M9 4.5h6M10 4.5v5l-3 3.5h10l-3-3.5v-5M12 13v6.5M4.5 4.5l15 15";
  return (
    <svg className={props.className} width="18" height="18" viewBox="0 0 24 24" aria-hidden focusable="false">
      <path {...stroke} d={d} />
    </svg>
  );
}
