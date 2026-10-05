/**
 * ADR-0181 (strict defaults), agent SB2 — what the demo configures so the
 * governance gates that are now ON by default pass its legitimate work, and
 * nothing more. Every step goes through the real routes, as the real persona,
 * and leaves the gates on:
 *
 *   mrmEnforced                 the mock agents the demo dispatches carry an
 *                               approved, signed-off model card, decided by
 *                               Avery, the named approver (the bootstrap token
 *                               cannot decide an approval, by design);
 *   mrmStalenessRecertEnabled   after the demo's required-test suite runs (new
 *                               ledger evidence, so the cards are stale),
 *                               Avery recertifies them — a new sign-off that
 *                               supersedes the old one — exactly as an org
 *                               would after reviewing fresh test evidence;
 *   dispatchAttributionRequired every demo dispatch already names a project
 *   / requireMcpAttribution     (and the runbook's MCP beat sends the project
 *   / requireProjectAttribution header); nothing here relaxes them;
 *   useCaseGateMode             a project linked to a use case needs it approved
 *                               — the demo's intake walk does that;
 *   keyCustodyEnforced          the demo uses org/platform credentials only;
 *   requirePreviewBeforeActivate the demo activates no ABAC policy version;
 *   builder ask-first           the demo builds no builder agent.
 *
 * Two callers: `seed.ts` (one line, before its first dispatch) and
 * `demo-intake-seed.ts` (one line, after the required-test runs).
 */
import type { FastifyInstance } from "fastify";
import { nistAiRmfLabel } from "@regulait/shared";

type Json = Record<string, any>;

/** the agents the demo itself dispatches: mock, so zero external credentials */
export const DEMO_CARD_AGENTS = ["fast-mock", "balanced-mock", "premium-mock"] as const;

const DEMO_CARD = {
  intendedUse:
    "Demonstration dispatch on the RegulAIt capability demo. Mock provider: no customer data, no external call.",
  dataClaims: {
    trainingData: "none — deterministic mock provider, no model was trained",
    customerData: "none reaches this agent; the provider is in-process",
    retention: "not applicable",
  },
  limitations:
    "A demo double. It is not evaluated for accuracy, bias or robustness and must not be relied on for any decision.",
  standardRefs: ["MAP-1.1", "MAP-2.2", "MEASURE-2.1"].map(nistAiRmfLabel),
};

export interface StrictGovernanceDemoReport {
  notes: string[];
}

function caller(app: FastifyInstance) {
  return async (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) => {
    const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: Json = {};
    try {
      body = res.json() as Json;
    } catch {
      /* the status is the fact */
    }
    return { status: res.statusCode, body };
  };
}

/**
 * Give each demo mock agent an approved model card valid for a year, signed
 * off by Avery. Idempotent: a live card (`approved` / `expiring`) is left
 * alone; a pending sign-off from an interrupted run is decided rather than
 * re-requested. With `recertify`, a live card whose ledger has moved since
 * its sign-off (staleness) gets a NEW sign-off that supersedes the old one.
 */
export async function ensureDemoModelCards(
  app: FastifyInstance,
  opts: { bootstrapToken: string; averyAuth: Record<string, string>; averyId: string; recertify?: boolean },
): Promise<StrictGovernanceDemoReport> {
  const call = caller(app);
  const boot = { authorization: `Bearer ${opts.bootstrapToken}` };
  const report: StrictGovernanceDemoReport = { notes: [] };
  const agents: Json[] = (await call("GET", "/v1/agents", boot)).body.agents ?? [];
  // THE DEMO'S OWN card, by its intended use: demo:intake adds fixture cards to
  // the same agents, and their (un)signed state is part of that story
  const cardFor = async (agentId: string): Promise<Json | undefined> =>
    ((await call("GET", "/v1/mrm/cards", boot)).body.cards ?? []).find(
      (c: Json) => c.agentId === agentId && c.intendedUse === DEMO_CARD.intendedUse,
    );
  const validUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  for (const name of DEMO_CARD_AGENTS) {
    const agent = agents.find((a) => a.name === name);
    if (!agent) {
      report.notes.push(`mrm     ${name}: agent missing, no card`);
      continue;
    }
    let card = await cardFor(agent.id);
    const live = card && (card.state === "approved" || card.state === "expiring");
    // staleness is on the detail read only (computed from the ledgers there)
    const stale =
      live && opts.recertify === true &&
      (await call("GET", `/v1/mrm/cards/${card!.id}`, boot)).body.card?.staleness?.drifted === true;
    if (live && !stale) {
      report.notes.push(`mrm     ${name}: card already ${card!.state}`);
      continue;
    }
    if (!card) {
      const created = await call("POST", "/v1/mrm/cards", boot, { agentId: agent.id, ...DEMO_CARD });
      card = created.body.card ?? (await cardFor(agent.id));
    }
    if (!card?.id) throw new Error(`could not resolve a model card for ${name}`);
    let approvalId: string | undefined = ((card.approvals ?? []) as Json[]).find((a) => a.status === "pending")?.approvalId;
    if (!approvalId) {
      const signOff = await call("POST", `/v1/mrm/cards/${card.id}/sign-off`, boot, {
        approverUserId: opts.averyId,
        validUntil,
        reason: stale
          ? "demo environment: recertifying the mock provider's card after reviewing the required-test runs"
          : "demo environment: approving the mock provider's card so the governed path is exercisable",
      });
      approvalId = signOff.body.approvalId ?? signOff.body.approval?.id;
    }
    if (!approvalId) throw new Error(`no approval id for ${name}'s sign-off`);
    const decided = await call("POST", `/v1/approvals/${approvalId}/decide`, opts.averyAuth, {
      decision: "approved",
      reason: stale
        ? "recertified by the named approver after the required-test runs (demo)"
        : "demo environment setup — approved by the named approver",
    });
    if (decided.status >= 400) {
      throw new Error(`${name}: sign-off decision refused (${decided.status}) ${JSON.stringify(decided.body).slice(0, 200)}`);
    }
    report.notes.push(`mrm     ${name}: card ${stale ? "recertified" : "approved"} by Avery, valid until ${validUntil.slice(0, 10)}`);
  }
  return report;
}

/**
 * After the demo's required-test runs: Avery (through a key minted for this
 * step, like demo:setup's) recertifies every demo card whose ledger moved.
 * Returns the report lines.
 */
export async function recertifyDemoModelCards(app: FastifyInstance, bootstrapToken: string): Promise<string[]> {
  const call = caller(app);
  const boot = { authorization: `Bearer ${bootstrapToken}` };
  const users: Json[] = (await call("GET", "/v1/users", boot)).body.users ?? [];
  const avery = users.find((u) => u.email === "avery@regulait.local");
  if (!avery) return ["mrm     avery@regulait.local missing — cards not recertified (run `seed` first)"];
  const key = await call("POST", `/v1/users/${avery.id}/keys`, boot, { name: "demo-recertify" });
  const averyAuth = { authorization: `Bearer ${String(key.body.token)}` };
  const report = await ensureDemoModelCards(app, { bootstrapToken, averyAuth, averyId: avery.id, recertify: true });
  return report.notes;
}
