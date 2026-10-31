/**
 * ADR-0214 (PENDING P3) — THE POSTURE ESTIMATE: objective cards, one
 * explainable score, and a ranked action list, computed from the ADR-0082
 * posture document and nothing else.
 *
 * Rules, enforced by the shape of the payload:
 *
 *  1. AN ESTIMATE, NEVER A VERDICT. The score is labelled an estimate on its
 *     face and never says "compliant" or "certified"; `POSTURE_SCORE_DISCLAIMER`
 *     rides with every payload.
 *  2. IT EXPLAINS ITSELF. Every objective carries its weight, its inputs, the
 *     formula in words, and its sub-score; the overall score is the weighted
 *     mean of those sub-scores and nothing more. Weights are constants in this
 *     file, shown verbatim, and no admin setting can change them.
 *  3. DETERMINISTIC, NO AI. A pure function of the posture document: the same
 *     ledgers give the same score, the same objectives and the same ranking.
 *  4. UNMEASURED SCORES ZERO. An objective with no data behind it is shown as
 *     unmeasured and contributes nothing — empty never reads as good (the
 *     ADR-0082 honesty rule, carried into the arithmetic).
 *  5. ACTIONS ARE RANKED BY WHAT FIXING THEM IS WORTH. Each action's points are
 *     the counterfactual: the objective is re-scored with that one deficit
 *     removed, and the gain is weighted into the overall score. Ties break by
 *     objective order, then by action key, so the ranking is stable.
 */

export const POSTURE_SCORE_DISCLAIMER =
  "An estimate computed from this deployment's own records. It is not a compliance verdict, an audit opinion or a " +
  "certification, and a high figure does not mean an obligation is met.";

/** the fields of the ADR-0082 posture document the estimate reads */
export interface PostureScoreInput {
  packs: { active: Array<{ packId: string; title: string; totals: { controls: number; unaddressed: number }; evidencedPct: number | null }> };
  risks: { open: number; mitigating: number; accepted: number; closed: number; total: number };
  redteam: { measured: boolean; runsInWindow: number; latest: { agentName: string; asrUpper: number | null } | null };
  evals: { groundedness: { runsInWindow: number; latest: { passRate: number | null } | null } };
  spend: { budgets: Array<{ projectId: string; projectName: string; overBudget: boolean }> };
  auditChain: { anchors: number; sink: { tamperResistant: boolean } | null };
  agentOwnership: { total: number; owned: number; unowned: number; orphaned: number };
  certificationCampaigns: { expiredIncomplete: number };
  sod: { currentViolations: number };
}

export type ObjectiveId = "coverage" | "risk" | "adversarial" | "evaluation" | "access" | "audit" | "spend";

/** the published weights; they sum to 100, so a sub-score of 100 everywhere is an estimate of 100 */
export const POSTURE_WEIGHTS: Readonly<Record<ObjectiveId, number>> = Object.freeze({
  coverage: 20,
  risk: 20,
  adversarial: 15,
  access: 15,
  evaluation: 10,
  audit: 10,
  spend: 10,
});

/** points taken off access hygiene for each separation-of-duties violator and each lapsed certification campaign */
export const ACCESS_DEDUCTION_PER_ITEM = 10;
/** a red-team result older than the report window counts at this share of its value */
export const STALE_REDTEAM_FACTOR = 0.5;

export interface PostureInput {
  label: string;
  value: string;
}

export interface PostureObjective {
  id: ObjectiveId;
  title: string;
  /** the outcome the objective is after, in one line */
  outcome: string;
  /** the outcome metric, measured from the ledgers */
  metric: { label: string; value: string };
  weight: number;
  measured: boolean;
  /** 0–100, whole numbers; 0 when unmeasured */
  score: number;
  /** weight × score ÷ 100, to one decimal: this objective's share of the overall estimate */
  contribution: number;
  inputs: PostureInput[];
  formula: string;
  link: { to: string; label: string };
}

export interface PostureAction {
  key: string;
  rank: number;
  objective: ObjectiveId;
  title: string;
  /** points the overall estimate would gain if this one deficit were removed, to one decimal */
  points: number;
  reason: string;
  link: { to: string; label: string };
}

export interface PostureScore {
  estimate: true;
  score: number;
  scale: { min: 0; max: 100 };
  method: string;
  disclaimer: string;
  weights: Array<{ objective: ObjectiveId; title: string; weight: number }>;
  objectives: PostureObjective[];
  actions: PostureAction[];
}

const clamp = (x: number) => Math.max(0, Math.min(100, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
const pctText = (x: number) => `${Math.round(x)}%`;
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

interface Draft {
  objective: Omit<PostureObjective, "contribution" | "score" | "weight"> & { raw: number };
  /** each candidate action with the objective's raw score once that deficit is removed */
  fixes: Array<{ key: string; title: string; fixedRaw: number; why: string; link?: { to: string; label: string } }>;
}

function coverage(d: PostureScoreInput): Draft {
  const packs = d.packs.active;
  const link = { to: "/admin/compliance-packs", label: "Open compliance packs" };
  const pctOf = (p: (typeof packs)[number]) => p.evidencedPct ?? 0;
  const mean = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
  const raw = mean(packs.map(pctOf));
  const measured = packs.length > 0;
  return {
    objective: {
      id: "coverage",
      title: "Control coverage",
      outcome: "Every mapped control in an active pack has current evidence or a live attestation.",
      metric: { label: "Mean evidenced share across active packs", value: measured ? pctText(raw) : "unmeasured" },
      measured,
      raw,
      inputs: measured
        ? packs.map((p) => ({ label: p.title, value: `${p.evidencedPct ?? 0}% evidenced, ${n(p.totals.unaddressed, "control", "controls")} unaddressed` }))
        : [{ label: "Active compliance packs", value: "none" }],
      formula: "The mean of each active pack's evidenced share. No active pack scores 0.",
      link,
    },
    fixes: measured
      ? packs
          .filter((p) => pctOf(p) < 100)
          .map((p) => ({
            key: `coverage:${p.packId}`,
            title: `Evidence the ${n(p.totals.unaddressed, "unaddressed control", "unaddressed controls")} in ${p.title}`,
            fixedRaw: mean(packs.map((q) => (q.packId === p.packId ? 100 : pctOf(q)))),
            why: `${p.title} is ${pctOf(p)}% evidenced`,
          }))
      : [{ key: "coverage:activate", title: "Activate a compliance pack for the frameworks you answer to", fixedRaw: 100, why: "no pack is active, so coverage is unmeasured" }],
  };
}

function risk(d: PostureScoreInput): Draft {
  const r = d.risks;
  const measured = r.total > 0;
  const raw = measured ? ((r.total - r.open) / r.total) * 100 : 0;
  return {
    objective: {
      id: "risk",
      title: "Risk treatment",
      outcome: "Every registered AI risk has a treatment: being mitigated, formally accepted or closed.",
      metric: { label: "Registered risks with a treatment", value: measured ? pctText(raw) : "unmeasured" },
      measured,
      raw,
      inputs: [
        { label: "Open (untreated)", value: String(r.open) },
        { label: "Mitigating", value: String(r.mitigating) },
        { label: "Accepted", value: String(r.accepted) },
        { label: "Closed", value: String(r.closed) },
      ],
      formula: "Risks not open ÷ all registered risks. An empty register scores 0.",
      link: { to: "/admin/risks", label: "Open the risk register" },
    },
    fixes: !measured
      ? [{ key: "risk:register", title: "Register the AI risks your use cases carry", fixedRaw: 100, why: "the risk register is empty, so treatment is unmeasured" }]
      : r.open > 0
        ? [{ key: "risk:treat", title: `Decide a treatment for ${n(r.open, "open risk", "open risks")}`, fixedRaw: 100, why: `${n(r.open, "risk is", "risks are")} open without a treatment` }]
        : [],
  };
}

function adversarial(d: PostureScoreInput): Draft {
  const rt = d.redteam;
  const upper = rt.latest?.asrUpper ?? null;
  const measured = rt.measured && upper !== null;
  const fresh = rt.runsInWindow > 0;
  const base = measured ? (1 - upper) * 100 : 0;
  const raw = fresh ? base : base * STALE_REDTEAM_FACTOR;
  const link = { to: "/admin/redteam", label: "Open red-team runs" };
  const fixes: Draft["fixes"] = [];
  if (!measured) {
    fixes.push({ key: "adversarial:probe", title: "Run a red-team probe against your agents", fixedRaw: 100, why: "no measured attack-success rate exists" });
  } else {
    if (!fresh) fixes.push({ key: "adversarial:rerun", title: "Re-run the red-team probe; the latest result is older than the report window", fixedRaw: base, why: "a stale result counts at half its value" });
    if (upper > 0) {
      fixes.push({
        key: "adversarial:harden",
        title: `Lower the attack-success rate for ${rt.latest!.agentName}`,
        fixedRaw: fresh ? 100 : 100 * STALE_REDTEAM_FACTOR,
        why: `attacks may succeed up to ${pctText(upper * 100)} of the time (upper bound of the 95% interval)`,
      });
    }
  }
  return {
    objective: {
      id: "adversarial",
      title: "Adversarial resilience",
      outcome: "Probes show attacks rarely succeed, measured recently.",
      metric: { label: "Attacks resisted, worst case", value: measured ? pctText(base) : "unmeasured" },
      measured,
      raw,
      inputs: [
        { label: "Attack-success rate, upper bound of the 95% interval", value: upper === null ? "unmeasured" : pctText(upper * 100) },
        { label: "Runs in the report window", value: String(rt.runsInWindow) },
      ],
      formula: `(1 − upper bound of the attack-success rate) × 100, halved when no run falls in the report window. Unmeasured scores 0.`,
      link,
    },
    fixes,
  };
}

function evaluation(d: PostureScoreInput): Draft {
  const g = d.evals.groundedness;
  const rate = g.latest?.passRate ?? null;
  const measured = g.runsInWindow > 0 && rate !== null;
  const raw = measured ? rate * 100 : 0;
  return {
    objective: {
      id: "evaluation",
      title: "Answer quality",
      outcome: "Grounded answers, measured by an evaluation run in the report window.",
      metric: { label: "Latest groundedness pass rate", value: measured ? pctText(raw) : "unmeasured" },
      measured,
      raw,
      inputs: [
        { label: "Groundedness runs in the window", value: String(g.runsInWindow) },
        { label: "Latest pass rate", value: rate === null ? "none" : pctText(rate * 100) },
      ],
      formula: "The latest groundedness evaluation's pass rate × 100. No run in the window scores 0.",
      link: { to: "/admin/evals", label: "Open evaluations" },
    },
    fixes: !measured
      ? [{ key: "evaluation:run", title: "Run a groundedness evaluation", fixedRaw: 100, why: "answer quality is unmeasured in the window" }]
      : raw < 100
        ? [{ key: "evaluation:improve", title: "Raise the groundedness pass rate", fixedRaw: 100, why: `the latest run passed ${pctText(raw)}` }]
        : [],
  };
}

function access(d: PostureScoreInput): Draft {
  const o = d.agentOwnership;
  const sod = d.sod.currentViolations;
  const lapsed = d.certificationCampaigns.expiredIncomplete;
  const measured = o.total > 0;
  const ownedPct = measured ? (o.owned / o.total) * 100 : 0;
  const score = (owned: number, s: number, l: number) => (measured ? clamp(owned - ACCESS_DEDUCTION_PER_ITEM * (s + l)) : 0);
  const raw = score(ownedPct, sod, lapsed);
  const fixes: Draft["fixes"] = [];
  if (!measured) fixes.push({ key: "access:register", title: "Register your agents with an owner", fixedRaw: 100, why: "no agent is registered" });
  else {
    const ownerless = o.unowned + o.orphaned;
    if (ownerless > 0)
      fixes.push({ key: "access:owners", title: `Assign an active owner to ${n(ownerless, "agent", "agents")}`, fixedRaw: score(100, sod, lapsed), why: `${n(ownerless, "agent has", "agents have")} no active owner`, link: { to: "/admin/inventory", label: "Open the agent inventory" } });
    if (sod > 0)
      fixes.push({ key: "access:sod", title: `Resolve ${n(sod, "separation-of-duties violation", "separation-of-duties violations")}`, fixedRaw: score(ownedPct, 0, lapsed), why: `each violation takes ${ACCESS_DEDUCTION_PER_ITEM} points off access hygiene`, link: { to: "/admin/sod", label: "Open separation of duties" } });
    if (lapsed > 0)
      fixes.push({ key: "access:certification", title: `Finish ${n(lapsed, "lapsed certification campaign", "lapsed certification campaigns")}`, fixedRaw: score(ownedPct, sod, 0), why: `each lapsed campaign takes ${ACCESS_DEDUCTION_PER_ITEM} points off access hygiene`, link: { to: "/admin/certification", label: "Open certification campaigns" } });
  }
  return {
    objective: {
      id: "access",
      title: "Access hygiene",
      outcome: "Every agent has an active owner, no one holds a toxic combination, and access reviews finish on time.",
      metric: { label: "Agents with an active owner", value: measured ? pctText(ownedPct) : "unmeasured" },
      measured,
      raw,
      inputs: [
        { label: "Agents owned / total", value: `${o.owned} / ${o.total}` },
        { label: "Separation-of-duties violations", value: String(sod) },
        { label: "Lapsed certification campaigns", value: String(lapsed) },
      ],
      formula: `Share of agents with an active owner, minus ${ACCESS_DEDUCTION_PER_ITEM} points per separation-of-duties violation and per lapsed campaign, floored at 0. No agents scores 0.`,
      link: { to: "/admin/inventory", label: "Open the agent inventory" },
    },
    fixes,
  };
}

function audit(d: PostureScoreInput): Draft {
  const a = d.auditChain;
  const tamper = a.sink?.tamperResistant === true;
  const raw = a.anchors === 0 ? 0 : tamper ? 100 : 50;
  return {
    objective: {
      id: "audit",
      title: "Audit integrity",
      outcome: "The audit trail is anchored to storage this host cannot rewrite.",
      metric: { label: "Anchoring", value: a.anchors === 0 ? "not anchored" : tamper ? "tamper-resistant" : "anchored, rewritable" },
      measured: true,
      raw,
      inputs: [
        { label: "Anchors written", value: String(a.anchors) },
        { label: "Anchor storage", value: a.sink ? (tamper ? "tamper-resistant" : "rewritable") : "none configured" },
      ],
      formula: "100 when anchors reach tamper-resistant storage, 50 when anchored to rewritable storage, 0 when not anchored.",
      link: { to: "/admin/audit", label: "Open the audit log" },
    },
    fixes:
      raw < 100
        ? [{ key: "audit:anchor", title: "Anchor the audit trail to write-once storage", fixedRaw: 100, why: a.anchors === 0 ? "no anchor has been written" : "anchors sit on storage this host can rewrite" }]
        : [],
  };
}

function spend(d: PostureScoreInput): Draft {
  const b = d.spend.budgets;
  const measured = b.length > 0;
  const over = b.filter((x) => x.overBudget);
  const within = (overCount: number) => (measured ? ((b.length - overCount) / b.length) * 100 : 0);
  const raw = within(over.length);
  return {
    objective: {
      id: "spend",
      title: "Spend control",
      outcome: "Every project with AI spend has a budget, and stays within it.",
      metric: { label: "Budgeted projects within budget", value: measured ? pctText(raw) : "unmeasured" },
      measured,
      raw,
      inputs: [
        { label: "Projects with a budget", value: String(b.length) },
        { label: "Over budget", value: String(over.length) },
      ],
      formula: "Budgeted projects within budget ÷ budgeted projects. No budget set scores 0.",
      link: { to: "/admin/cost", label: "Open the cost dashboard" },
    },
    fixes: !measured
      ? [{ key: "spend:budget", title: "Set a budget on the projects that use AI", fixedRaw: 100, why: "no project has a budget, so spend control is unmeasured" }]
      : [...over]
          .sort((x, y) => (x.projectName < y.projectName ? -1 : x.projectName > y.projectName ? 1 : x.projectId < y.projectId ? -1 : 1))
          .map((p) => ({ key: `spend:${p.projectId}`, title: `Bring ${p.projectName} back within budget`, fixedRaw: within(over.length - 1), why: `${p.projectName} is over its budget` })),
  };
}

const ORDER: ObjectiveId[] = ["coverage", "risk", "adversarial", "access", "evaluation", "audit", "spend"];
const BUILDERS: Record<ObjectiveId, (d: PostureScoreInput) => Draft> = { coverage, risk, adversarial, access, evaluation, audit, spend };

/** Score the posture document. Pure and deterministic: no clock, no randomness, no I/O. */
export function scorePosture(d: PostureScoreInput): PostureScore {
  const drafts = ORDER.map((id) => BUILDERS[id](d));
  const objectives: PostureObjective[] = drafts.map(({ objective: { raw, ...o } }) => {
    const score = Math.round(clamp(raw));
    const weight = POSTURE_WEIGHTS[o.id];
    return { ...o, weight, score, contribution: round1((weight * score) / 100) };
  });
  const total = Math.round(objectives.reduce((acc, o) => acc + (o.weight * o.score) / 100, 0));

  const candidates = drafts.flatMap((dr, i) => {
    const o = objectives[i]!;
    return dr.fixes.map((f) => {
      const gain = Math.max(0, Math.round(clamp(f.fixedRaw)) - o.score);
      const points = round1((o.weight * gain) / 100);
      const lead = o.measured ? `Worth ${points} points` : `Worth up to ${points} points once measured`;
      return {
        order: i,
        key: f.key,
        objective: o.id,
        title: f.title,
        points,
        reason: `${lead}: ${f.why}. ${o.title} is at ${o.score} of 100 and carries ${o.weight}% of the estimate.`,
        link: f.link ?? o.link,
      };
    });
  });
  candidates.sort((x, y) => y.points - x.points || x.order - y.order || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const actions: PostureAction[] = candidates
    .filter((c) => c.points > 0)
    .map(({ order: _order, ...c }, i) => ({ rank: i + 1, ...c }));

  return {
    estimate: true,
    score: total,
    scale: { min: 0, max: 100 },
    method:
      "The weighted mean of seven objective scores, each computed from this deployment's own records by a fixed formula. " +
      "An objective with no data scores 0. Actions are ranked by how many points fixing each one would add.",
    disclaimer: POSTURE_SCORE_DISCLAIMER,
    weights: objectives.map((o) => ({ objective: o.id, title: o.title, weight: o.weight })),
    objectives,
    actions,
  };
}
