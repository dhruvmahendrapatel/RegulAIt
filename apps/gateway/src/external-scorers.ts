/**
 * ADR-0088 — REGISTERED EXTERNAL EVAL SCORERS (the L14 adapter half).
 *
 * WHAT THIS IS. The gap analysis reaffirmed the refusal to build or fake an
 * in-house guardrail/scoring model ("a partnership or an adapter, not a
 * build"). This module is the adapter: an admin registers a Fiddler-class
 * scoring endpoint THEY run or buy, and an eval scorer config may then name
 * it for a judge-backed metric. The operator brings the instrument; the
 * gateway brings the governance — egress allow-list, DNS-pinned fetch,
 * register → test → enable, audit — and stamps `method: "external:<name>"`
 * on every row the instrument scores.
 *
 * WHERE IT ATTACHES, AND WHERE IT DELIBERATELY DOES NOT. It attaches to the
 * EVAL PATH only, as a third scoring method beside `lexical-idf-overlap` and
 * `model-judged`, with the ADR-0067/0072 refusal semantics carried over
 * verbatim (a named-but-unusable instrument is a 422 before any row is
 * written). It does NOT attach to the ADR-0042 inline guardrail path: a
 * network hop inside every dispatch is a latency/availability/PII-egress
 * decision the owner has not made, and ADR-0088 records that boundary as the
 * named follow-up rather than crossing it quietly.
 *
 * THE THING TO KEEP IN MIND WHILE READING (same as custom-providers.ts): an
 * admin-typed URL is an SSRF primitive. Registration does not enable;
 * enabling requires a connection test; the test goes through the guard; and
 * the guard runs AGAIN at run pre-flight and again per HTTP request, because
 * DNS can be re-pointed after approval. Air-gapped posture is INHERITED, not
 * re-implemented: a typed destination is strictly adjudicated against the
 * default-deny allow-list in EVERY deploy mode, which is precisely what
 * ADR-0062's strict posture demands of an outbound provider.
 */

import type { FastifyInstance } from "fastify";
import { auditLog, eq, externalScorers, type Db, type ExternalScorerRow } from "@regulait/db";
import {
  createExternalScorerSchema,
  parseExternalScorerResponse,
  setExternalScorerEnabledSchema,
  updateExternalScorerSchema,
  type ExternalScorerFacts,
  type ExternalScorerRequest,
  type ExternalScorerVerdict,
} from "@regulait/shared";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { loadEgressAllowList } from "./custom-providers.js";
import {
  checkEgress,
  createGuardedFetch,
  egressRefusal,
  type EgressResolver,
} from "./egress-guard.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** the hard ceiling on one scoring call. Bounded because an eval run makes one
 * call per externally-scored case, serially — an unbounded hang would park the
 * whole run on the vendor's outage. */
export const EXTERNAL_SCORER_TIMEOUT_MS = 20_000;

/** read-back projection: the key is structurally absent, only `hasApiKey` */
function publicRow(row: ExternalScorerRow) {
  const { keyCiphertext, ...rest } = row;
  return { ...rest, hasApiKey: keyCiphertext != null };
}

// ---------------------------------------------------------------------------
// resolution + the scoring call (used by the eval runner)
// ---------------------------------------------------------------------------

export interface ResolvedExternalScorer {
  row: ExternalScorerRow;
  fetchImpl: typeof fetch;
  apiKey: string | null;
}

/**
 * Gather the pre-flight FACTS about every named scorer (for the pure
 * `externalScorerAvailabilityFor` decision) and, for each usable one, the
 * guarded fetch the scoring calls will ride. The guard re-validates inside
 * that fetch on every request, so a DNS re-point between pre-flight and a
 * case's scoring call still refuses.
 */
export async function resolveExternalScorersByName(
  db: Db,
  dataKey: string | undefined,
  names: ReadonlyArray<string>,
  deps: { resolve?: EgressResolver; fetchImpl?: typeof fetch } = {},
): Promise<{ facts: ExternalScorerFacts[]; resolved: Map<string, ResolvedExternalScorer> }> {
  const facts: ExternalScorerFacts[] = [];
  const resolved = new Map<string, ResolvedExternalScorer>();
  if (names.length === 0) return { facts, resolved };
  const allowList = await loadEgressAllowList(db);
  for (const name of names) {
    const [row] = await db.select().from(externalScorers).where(eq(externalScorers.name, name));
    if (!row) continue; // absent from facts == unknown to the pure decision
    const base: Omit<ExternalScorerFacts, "reachable" | "detail"> = {
      name: row.name,
      enabled: row.enabled,
      scorerKinds: (row.scorerKinds as string[]) ?? [],
    };
    const decision = await checkEgress(row.baseUrl, {
      allowList,
      providerAllowsPlaintextHttp: row.allowPlaintextHttp,
      ...(deps.resolve ? { resolve: deps.resolve } : {}),
    });
    if (!decision.ok) {
      facts.push({ ...base, reachable: false, detail: decision.reason });
      continue;
    }
    if (row.keyCiphertext && !dataKey) {
      facts.push({
        ...base,
        reachable: false,
        detail: "the scorer has an auth secret but no REGULAIT_DATA_KEY is set on this gateway",
      });
      continue;
    }
    facts.push({ ...base, reachable: true });
    resolved.set(name, {
      row,
      apiKey: row.keyCiphertext && dataKey ? decryptSecret(dataKey, row.keyCiphertext) : null,
      fetchImpl: createGuardedFetch({
        allowList,
        providerAllowsPlaintextHttp: row.allowPlaintextHttp,
        ...(deps.resolve ? { resolve: deps.resolve } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }),
    });
  }
  return { facts, resolved };
}

/**
 * ONE scoring call — the whole wire contract. Throws on ANY non-conformance
 * (non-2xx, non-JSON, missing/out-of-range score, egress refusal, timeout):
 * the caller records that as a scorer ERROR on the result row, exactly the
 * `judge_failed` idiom. It never fabricates a 0 or a 1.
 */
export async function callExternalScorer(
  scorer: ResolvedExternalScorer,
  req: ExternalScorerRequest,
  opts: { timeoutMs?: number } = {},
): Promise<ExternalScorerVerdict> {
  const timeoutMs = opts.timeoutMs ?? EXTERNAL_SCORER_TIMEOUT_MS;
  let res: Response;
  try {
    res = await scorer.fetchImpl(scorer.row.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(scorer.apiKey ? { authorization: `Bearer ${scorer.apiKey}` } : {}),
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // a guard refusal is a governance decision with a reason — surface it
    const refusal = egressRefusal(err);
    if (refusal) throw new Error(refusal);
    // undici wraps the abort in "fetch failed" with the TimeoutError as the
    // CAUSE — walk the (bounded) chain so the deadline is reported as a
    // deadline, not as an opaque network blip
    let cur: unknown = err;
    for (let i = 0; i < 8 && cur; i += 1) {
      if (cur instanceof Error && (cur.name === "TimeoutError" || cur.name === "AbortError")) {
        throw new Error(`external scorer '${scorer.row.name}' timed out after ${timeoutMs}ms`);
      }
      cur = (cur as { cause?: unknown }).cause;
    }
    throw new Error(
      `external scorer '${scorer.row.name}' request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `external scorer '${scorer.row.name}' returned HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  const parsed = parseExternalScorerResponse(text);
  if (!parsed.ok) {
    throw new Error(`external scorer '${scorer.row.name}' reply is non-conforming: ${parsed.error}`);
  }
  return parsed.verdict;
}

// ---------------------------------------------------------------------------
// routes — admin-only by the global gate (none appear in NON_ADMIN_ROUTES)
// ---------------------------------------------------------------------------

const idParam = z.object({ scorerId: z.string().uuid() });

export function registerExternalScorerRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { dataKey?: string; resolve?: EgressResolver; fetchImpl?: typeof fetch } = {},
) {
  const actor = (req: { authCtx: { userId?: string | null } }) => req.authCtx.userId ?? NIL_USER;

  async function audit(
    userId: string,
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
    effect: "allow" | "deny" = "allow",
  ) {
    await db.insert(auditLog).values({
      userId,
      objectType: "external_scorer",
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  }

  async function preflight(baseUrl: string, providerAllowsPlaintextHttp: boolean) {
    return checkEgress(baseUrl, {
      allowList: await loadEgressAllowList(db),
      providerAllowsPlaintextHttp,
      ...(opts.resolve ? { resolve: opts.resolve } : {}),
    });
  }

  async function recordTest(scorerId: string, error: string | null) {
    await db
      .update(externalScorers)
      .set(
        error === null
          ? { lastTestedAt: new Date(), lastTestError: null }
          : // a FAILED test never sets lastTestedAt — the enable gate reads it
            { lastTestError: error },
      )
      .where(eq(externalScorers.id, scorerId));
  }

  app.get("/v1/external-scorers", async () => ({
    scorers: (await db.select().from(externalScorers)).map(publicRow),
  }));

  app.post("/v1/external-scorers", async (req, reply) => {
    const body = createExternalScorerSchema.parse(req.body);
    if (body.apiKey && !opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
    }
    // THE GUARD, at the earliest honest moment. Not a substitute for the
    // pre-flight at run time or the per-request check inside the guarded
    // fetch — the earliest refusal, so a bad endpoint is a 4xx here rather
    // than a surprise inside somebody's eval run.
    const decision = await preflight(body.baseUrl, body.allowPlaintextHttp ?? false);
    if (!decision.ok) {
      await audit(
        actor(req),
        null,
        "egress-blocked",
        `external scorer registration refused: ${decision.reason}`,
        { phase: "registration", baseUrl: body.baseUrl, code: decision.code },
        "deny",
      );
      return reply.status(400).send({ error: "egress_blocked", code: decision.code, detail: decision.reason });
    }
    const [existing] = await db
      .select({ id: externalScorers.id })
      .from(externalScorers)
      .where(eq(externalScorers.name, body.name));
    if (existing) {
      return reply
        .status(409)
        .send({ error: "duplicate_name", detail: `an external scorer named '${body.name}' already exists` });
    }
    const [row] = await db
      .insert(externalScorers)
      .values({
        name: body.name,
        baseUrl: body.baseUrl,
        keyCiphertext: body.apiKey && opts.dataKey ? encryptSecret(opts.dataKey, body.apiKey) : null,
        scorerKinds: body.scorerKinds,
        allowPlaintextHttp: body.allowPlaintextHttp ?? false,
        // ALWAYS false on create — a connection test stands between
        // registration and use, exactly like a custom provider.
        enabled: false,
        createdBy: req.authCtx.userId ?? null,
      })
      .returning();
    await audit(
      actor(req),
      row!.id,
      "external-scorer-registered",
      `external scorer '${row!.name}' registered at ${decision.host} claiming [${body.scorerKinds.join(", ")}]`,
      {
        phase: "registration",
        name: row!.name,
        host: decision.host,
        port: decision.port,
        protocol: decision.protocol,
        scorerKinds: body.scorerKinds,
        allowPlaintextHttp: row!.allowPlaintextHttp,
        hasApiKey: row!.keyCiphertext != null,
      },
    );
    return reply.status(201).send(publicRow(row!));
  });

  app.patch("/v1/external-scorers/:scorerId", async (req, reply) => {
    const { scorerId } = idParam.parse(req.params);
    const body = updateExternalScorerSchema.parse(req.body);
    const [row] = await db.select().from(externalScorers).where(eq(externalScorers.id, scorerId));
    if (!row) return reply.status(404).send({ error: "unknown_external_scorer" });
    if (body.apiKey && !opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
    }
    const nextBaseUrl = body.baseUrl ?? row.baseUrl;
    const nextPlaintext = body.allowPlaintextHttp ?? row.allowPlaintextHttp;
    const endpointMoved = nextBaseUrl !== row.baseUrl || nextPlaintext !== row.allowPlaintextHttp;
    if (endpointMoved) {
      const decision = await preflight(nextBaseUrl, nextPlaintext);
      if (!decision.ok) {
        await audit(
          actor(req),
          scorerId,
          "egress-blocked",
          `external scorer '${row.name}' endpoint change refused: ${decision.reason}`,
          { phase: "update", baseUrl: nextBaseUrl, code: decision.code },
          "deny",
        );
        return reply.status(400).send({ error: "egress_blocked", code: decision.code, detail: decision.reason });
      }
    }
    const [updated] = await db
      .update(externalScorers)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.scorerKinds !== undefined ? { scorerKinds: body.scorerKinds } : {}),
        ...(body.allowPlaintextHttp !== undefined ? { allowPlaintextHttp: body.allowPlaintextHttp } : {}),
        // null CLEARS the key; undefined keeps it
        ...(body.apiKey !== undefined
          ? { keyCiphertext: body.apiKey && opts.dataKey ? encryptSecret(opts.dataKey, body.apiKey) : null }
          : {}),
        // MOVING THE ENDPOINT RE-ARMS THE GATE, verbatim from custom
        // providers: tested-and-enabled against endpoint A must not survive
        // being pointed at endpoint B.
        ...(endpointMoved ? { enabled: false, lastTestedAt: null, lastTestError: null } : {}),
      })
      .where(eq(externalScorers.id, scorerId))
      .returning();
    await audit(
      actor(req),
      scorerId,
      "external-scorer-updated",
      `external scorer '${updated!.name}' updated${endpointMoved ? " — endpoint changed, disabled pending a fresh connection test" : ""}`,
      { phase: "update", changed: Object.keys(body), endpointMoved, baseUrl: updated!.baseUrl },
    );
    return publicRow(updated!);
  });

  /**
   * THE CONNECTION TEST — the gate before enable. It proves the endpoint is
   * (a) permitted by the egress guard and (b) actually speaking OUR contract:
   * a real probe request is POSTed and the reply must parse as a conforming
   * verdict. "The TCP port is open" is not a connection test, and a failure
   * is a real 502 carrying the endpoint's own words.
   */
  app.post("/v1/external-scorers/:scorerId/test", async (req, reply) => {
    const { scorerId } = idParam.parse(req.params);
    const [row] = await db.select().from(externalScorers).where(eq(externalScorers.id, scorerId));
    if (!row) return reply.status(404).send({ error: "unknown_external_scorer" });

    const { facts, resolved } = await resolveExternalScorersByName(db, opts.dataKey, [row.name], {
      ...(opts.resolve ? { resolve: opts.resolve } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const fact = facts[0];
    const scorer = resolved.get(row.name);
    if (!fact || !fact.reachable || !scorer) {
      const detail = fact?.detail ?? "scorer could not be resolved";
      await recordTest(scorerId, detail);
      await audit(
        actor(req),
        scorerId,
        "egress-blocked",
        `connection test for '${row.name}' refused before any request: ${detail}`,
        { phase: "connection_test", baseUrl: row.baseUrl },
        "deny",
      );
      return reply.status(403).send({ ok: false, error: "egress_blocked", detail });
    }

    const probe: ExternalScorerRequest = {
      input: "connection test — is this endpoint speaking the RegulAIt external-scorer contract?",
      output: "connection test",
      context: [],
      scorerKind: (row.scorerKinds as string[])[0] ?? "llm_as_judge",
    };
    try {
      const verdict = await callExternalScorer(scorer, probe);
      await recordTest(scorerId, null);
      await audit(
        actor(req),
        scorerId,
        "external-scorer-tested",
        `connection test for '${row.name}' passed — endpoint answered the contract with score ${verdict.score}`,
        { phase: "connection_test", baseUrl: row.baseUrl, score: verdict.score },
      );
      return { ok: true, score: verdict.score, reasons: verdict.reasons };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordTest(scorerId, message);
      await audit(
        actor(req),
        scorerId,
        "external-scorer-test-failed",
        `connection test for '${row.name}' failed: ${message}`,
        { phase: "connection_test", baseUrl: row.baseUrl, error: message },
        "deny",
      );
      // HONEST REFUSAL: a failed test is a failed test. No optimistic 200.
      return reply.status(502).send({ ok: false, error: "connection_test_failed", detail: message });
    }
  });

  app.post("/v1/external-scorers/:scorerId/enabled", async (req, reply) => {
    const { scorerId } = idParam.parse(req.params);
    const body = setExternalScorerEnabledSchema.parse(req.body);
    const [row] = await db.select().from(externalScorers).where(eq(externalScorers.id, scorerId));
    if (!row) return reply.status(404).send({ error: "unknown_external_scorer" });
    if (body.enabled && !row.lastTestedAt) {
      // THE GATE: no untested endpoint is ever enabled.
      return reply.status(409).send({
        error: "connection_test_required",
        detail:
          `external scorer '${row.name}' has not passed a connection test — ` +
          `POST /v1/external-scorers/${scorerId}/test first`,
      });
    }
    const [updated] = await db
      .update(externalScorers)
      .set({ enabled: body.enabled })
      .where(eq(externalScorers.id, scorerId))
      .returning();
    await audit(
      actor(req),
      scorerId,
      body.enabled ? "external-scorer-enabled" : "external-scorer-disabled",
      `external scorer '${row.name}' ${body.enabled ? "ENABLED" : "disabled"}`,
      { phase: "enablement", enabled: body.enabled, baseUrl: row.baseUrl },
    );
    return publicRow(updated!);
  });

  app.delete("/v1/external-scorers/:scorerId", async (req, reply) => {
    const { scorerId } = idParam.parse(req.params);
    const [removed] = await db
      .delete(externalScorers)
      .where(eq(externalScorers.id, scorerId))
      .returning();
    if (!removed) return reply.status(404).send({ error: "unknown_external_scorer" });
    // Scorer configs reference this row by NAME (jsonb), so there is no FK to
    // block this delete. That is honest, not lax: a dataset that still names
    // the deleted scorer refuses its next run with 422 external_scorer_unknown
    // — the ADR-0067 semantics — rather than silently scoring another way.
    await audit(actor(req), scorerId, "external-scorer-removed", `external scorer '${removed.name}' removed`, {
      phase: "removal",
      name: removed.name,
      baseUrl: removed.baseUrl,
    });
    return { removed: true };
  });
}
