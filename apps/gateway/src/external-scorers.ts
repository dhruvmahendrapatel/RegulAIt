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

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { auditLog, eq, externalScorers, type Db, type ExternalScorerRow } from "@regulait/db";
import {
  createExternalScorerSchema,
  isVendorAdapter,
  parseExternalScorerResponse,
  vendorAdapterRefusal,
  type ExternalScorerAdapter,
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
import { errMessage } from "./err-serializer.js";
import { resolveDeployMode } from "./deploy-posture.js";
import { CHANGED_CONCURRENTLY, checkStepUp, isStepUpPrompt } from "./step-up.js";
import { enabledDetectorsUsingScorer, lockTrainedDetectorBindings } from "./trained-detector-lock.js";
import type { VendorCallAttribution } from "./guardrail-vendor-adapters.js";

/**
 * ADR-0237 + ADR-0062: a third-party guardrail adapter sends scanned text to a
 * vendor's public API. An air-gapped deployment refuses it at registration, at
 * enable, at the connection test and at every call, whatever the allow-list
 * says: the deployment mode is the floor, and no admin setting loosens it.
 */
export function vendorAdapterAirGapRefusal(adapter: string): string | null {
  if (!isVendorAdapter(adapter)) return null;
  return resolveDeployMode() === "air_gapped"
    ? `adapter '${adapter}' calls a third-party vendor API, which an air-gapped deployment (REGULAIT_DEPLOY_MODE=air_gapped) refuses`
    : null;
}

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
    const airGap = vendorAdapterAirGapRefusal(row.adapter);
    if (airGap) {
      facts.push({ ...base, reachable: false, detail: airGap });
      continue;
    }
    if (isVendorAdapter(row.adapter) && !row.keyCiphertext) {
      facts.push({ ...base, reachable: false, detail: `adapter '${row.adapter}' needs an API key and none is stored` });
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
  opts: {
    timeoutMs?: number;
    /** ADR-0237: required for a vendor adapter, whose every call is attributed and audited */
    vendor?: { db: Db; attribution: VendorCallAttribution; phase: "input" | "output" };
  } = {},
): Promise<ExternalScorerVerdict> {
  const timeoutMs = opts.timeoutMs ?? EXTERNAL_SCORER_TIMEOUT_MS;
  if (isVendorAdapter(scorer.row.adapter)) {
    // fail closed: a vendor call that cannot be attributed and audited is not made
    if (!opts.vendor) throw new Error(`external scorer '${scorer.row.name}' (${scorer.row.adapter}) needs call attribution`);
    const airGap = vendorAdapterAirGapRefusal(scorer.row.adapter);
    if (airGap) throw new Error(airGap);
    const { callVendorScorer } = await import("./guardrail-vendor-adapters.js");
    // the vendor adapters scan ONE text: the input on the input phase, the output on the output phase
    const text = opts.vendor.phase === "output" ? req.output : req.input;
    return callVendorScorer(opts.vendor.db, scorer, { scorerKind: req.scorerKind, phase: opts.vendor.phase, text }, opts.vendor.attribution, timeoutMs);
  }
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
      `external scorer '${scorer.row.name}' request failed: ${errMessage(err)}`,
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
    exec: Db = db,
  ) {
    await exec.insert(auditLog).values({
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

  /**
   * P7R-01 (ADR-0220 decision 6). An enabled trained detector calls this scorer at every enforcement site, so changing
   * what the scorer is (endpoint, transport, dialect, credential, claimed kinds, enablement) changes the detector's
   * instrument without touching the detector. That is the relaxation the detector's own PUT guards when its scorer is
   * swapped, so it needs the same settings_relax step-up, bound to this scorer and the new values (ADR-0180). An API
   * key or the bootstrap credential can never give one. A refusal the caller cannot answer is audited; a prompt is the
   * normal first half of the ceremony and writes nothing (`isStepUpPrompt`).
   */
  async function requireInUseStepUp(
    req: FastifyRequest,
    reply: FastifyReply,
    scorerId: string,
    name: string,
    phase: "update" | "enablement",
    inUse: ReadonlyArray<{ kind: string }>,
    values: Record<string, unknown>,
  ): Promise<boolean> {
    if (Object.keys(values).length === 0) return true;
    const relaxed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) relaxed[`externalScorers.${scorerId}.${k}`] = v;
    const out = await checkStepUp(db, req, { kind: "settings_relax", facts: { values: relaxed } }, { spend: true });
    if (out.ok) return true;
    if (!isStepUpPrompt(out.body)) {
      await audit(
        actor(req),
        scorerId,
        "external-scorer-in-use-refused",
        `external scorer '${name}' ${phase} refused: ${inUse.length > 0 ? `the enabled trained detector(s) ${inUse.map((d) => d.kind).join(", ")} use it, and ` : ""}` +
          `the change needs a settings_relax step-up the caller did not give (${String(out.body.error)})`,
        { phase, detectors: inUse.map((d) => d.kind), fields: Object.keys(values), code: out.body.error },
        "deny",
      );
    }
    await reply.status(out.status).send(out.body);
    return false;
  }

  /** P7R-01: a write whose step-up was decided on an unlocked read, refused because that read moved */
  async function refuseChanged(req: { authCtx: { userId?: string | null } }, scorerId: string, name: string, phase: string) {
    await audit(
      actor(req),
      scorerId,
      "external-scorer-changed-concurrently",
      `external scorer '${name}' ${phase} refused: the scorer or a trained detector using it changed while the request was checked`,
      { phase, code: CHANGED_CONCURRENTLY.body.error },
      "deny",
    );
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
    const adapter: ExternalScorerAdapter = body.adapter ?? "regulait";
    if (body.apiKey && !opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
    }
    const airGap = vendorAdapterAirGapRefusal(adapter);
    if (airGap) {
      await audit(actor(req), null, "egress-blocked", `external scorer registration refused: ${airGap}`, { phase: "registration", adapter, code: "air_gapped" }, "deny");
      return reply.status(403).send({ error: "air_gapped", detail: airGap });
    }
    if (isVendorAdapter(adapter) && !body.apiKey) {
      return reply.status(422).send({ error: "api_key_required", detail: `adapter '${adapter}' needs the vendor API key` });
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
        adapter,
        adapterOptions: body.adapterOptions ?? null,
        pricePerCallUsd: body.pricePerCallUsd ?? null,
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
        adapter,
        adapterOptions: row!.adapterOptions,
        pricePerCallUsd: row!.pricePerCallUsd,
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
    const nextAdapter: ExternalScorerAdapter = body.adapter ?? row.adapter;
    const nextOptions = body.adapterOptions !== undefined ? body.adapterOptions : row.adapterOptions;
    // ADR-0237: the merged combination is checked as a whole (a PATCH may move only one part of it)
    const comboRefusal = vendorAdapterRefusal({
      adapter: nextAdapter,
      scorerKinds: body.scorerKinds ?? ((row.scorerKinds as string[]) ?? []),
      allowPlaintextHttp: nextPlaintext,
      options: nextOptions,
    });
    if (comboRefusal) return reply.status(422).send({ error: "adapter_invalid", detail: comboRefusal });
    const airGap = vendorAdapterAirGapRefusal(nextAdapter);
    if (airGap) return reply.status(403).send({ error: "air_gapped", detail: airGap });
    const nextHasKey = body.apiKey !== undefined ? body.apiKey !== null : row.keyCiphertext != null;
    if (isVendorAdapter(nextAdapter) && !nextHasKey) {
      return reply.status(422).send({ error: "api_key_required", detail: `adapter '${nextAdapter}' needs the vendor API key` });
    }
    // moving the endpoint, the dialect or the vendor options (a Lakera project is a different policy) re-arms the gate,
    // and so does replacing the key of a vendor adapter (a different account)
    const endpointMoved =
      nextBaseUrl !== row.baseUrl ||
      nextPlaintext !== row.allowPlaintextHttp ||
      nextAdapter !== row.adapter ||
      JSON.stringify(nextOptions ?? null) !== JSON.stringify(row.adapterOptions ?? null) ||
      (isVendorAdapter(nextAdapter) && body.apiKey !== undefined);
    // P7R-01: the fields that change the instrument an enabled trained detector calls (the key's value is never
    // bound into the step-up facts; only that it is replaced or cleared)
    const nextKinds = body.scorerKinds ?? ((row.scorerKinds as string[]) ?? []);
    const instrumentChanges: Record<string, unknown> = {
      ...(nextBaseUrl !== row.baseUrl ? { baseUrl: nextBaseUrl } : {}),
      ...(nextPlaintext !== row.allowPlaintextHttp ? { allowPlaintextHttp: nextPlaintext } : {}),
      ...(nextAdapter !== row.adapter ? { adapter: nextAdapter } : {}),
      ...(JSON.stringify(nextOptions ?? null) !== JSON.stringify(row.adapterOptions ?? null) ? { adapterOptions: nextOptions ?? null } : {}),
      ...(JSON.stringify([...nextKinds].sort()) !== JSON.stringify([...((row.scorerKinds as string[]) ?? [])].sort())
        ? { scorerKinds: [...nextKinds].sort() }
        : {}),
      ...(body.apiKey !== undefined ? { apiKey: body.apiKey === null ? null : "replaced" } : {}),
    };
    const inUse = await enabledDetectorsUsingScorer(db, scorerId);
    if (inUse.length > 0 && !(await requireInUseStepUp(req, reply, scorerId, row.name, "update", inUse, instrumentChanges))) {
      return reply;
    }
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
    const steppedUp = inUse.length > 0 && Object.keys(instrumentChanges).length > 0;
    const updated = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      // P7R-01: serialised against trained-detector binds; the step-up above was decided on `row` and `inUse`
      await lockTrainedDetectorBindings(tx);
      const [rowNow] = await tx.select().from(externalScorers).where(eq(externalScorers.id, scorerId)).for("update");
      const inUseNow = await enabledDetectorsUsingScorer(tx, scorerId);
      if (JSON.stringify(rowNow ?? null) !== JSON.stringify(row) || JSON.stringify(inUseNow) !== JSON.stringify(inUse)) return null;
      const [saved] = await tx
      .update(externalScorers)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.scorerKinds !== undefined ? { scorerKinds: body.scorerKinds } : {}),
        ...(body.allowPlaintextHttp !== undefined ? { allowPlaintextHttp: body.allowPlaintextHttp } : {}),
        ...(body.adapter !== undefined ? { adapter: body.adapter } : {}),
        ...(body.adapterOptions !== undefined ? { adapterOptions: body.adapterOptions } : {}),
        ...(body.pricePerCallUsd !== undefined ? { pricePerCallUsd: body.pricePerCallUsd } : {}),
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
        `external scorer '${saved!.name}' updated${endpointMoved ? " — endpoint changed, disabled pending a fresh connection test" : ""}` +
          (steppedUp ? ` — used by enabled trained detector(s) ${inUse.map((d) => d.kind).join(", ")} (step-up verified)` : ""),
        {
          phase: "update",
          changed: Object.keys(body),
          endpointMoved,
          baseUrl: saved!.baseUrl,
          ...(inUse.length > 0 ? { inUseBy: inUse.map((d) => d.kind) } : {}),
          ...(steppedUp ? { stepUp: "settings_relax", relaxed: Object.keys(instrumentChanges) } : {}),
        },
        "allow",
        tx,
      );
      return saved!;
    });
    if (!updated) {
      await refuseChanged(req, scorerId, row.name, "update");
      return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    }
    return publicRow(updated);
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
      const verdict = await callExternalScorer(scorer, probe, {
        vendor: { db, attribution: { userId: actor(req), projectId: null, source: "connection_test" }, phase: "input" },
      });
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
      const message = errMessage(err);
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
    const vendor = isVendorAdapter(row.adapter);
    if (body.enabled && vendor) {
      const airGap = vendorAdapterAirGapRefusal(row.adapter);
      if (airGap) return reply.status(403).send({ error: "air_gapped", detail: airGap });
    }
    const inUse = await enabledDetectorsUsingScorer(db, scorerId);
    const relax: Record<string, unknown> = {};
    // ADR-0237: enabling a vendor adapter lets scanned text leave for a third party — a relaxation, so a
    // settings_relax step-up bound to this scorer and adapter (ADR-0180). Turning it off is tightening.
    if (body.enabled && vendor && !row.enabled) Object.assign(relax, { enabled: true, adapter: row.adapter });
    // P7R-01: re-enabling a scorer an enabled trained detector uses puts an instrument back under that detector
    // (after a PATCH moved it, or a race bound it while disabled) — bound to the endpoint it now has
    if (body.enabled && !row.enabled && inUse.length > 0) {
      Object.assign(relax, { enabled: true, adapter: row.adapter, baseUrl: row.baseUrl });
    }
    // P7R-01: disabling it is a relaxation when a detector using it falls back to the heuristic on failure (the
    // trained check silently stops); when every such detector fails closed it is a tightening and stays free
    if (!body.enabled && row.enabled && inUse.some((d) => d.onFailure === "heuristic")) Object.assign(relax, { enabled: false });
    if (!(await requireInUseStepUp(req, reply, scorerId, row.name, "enablement", inUse, relax))) return reply;
    const steppedUp = Object.keys(relax).length > 0;
    const updated = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await lockTrainedDetectorBindings(tx);
      const [rowNow] = await tx.select().from(externalScorers).where(eq(externalScorers.id, scorerId)).for("update");
      const inUseNow = await enabledDetectorsUsingScorer(tx, scorerId);
      if (JSON.stringify(rowNow ?? null) !== JSON.stringify(row) || JSON.stringify(inUseNow) !== JSON.stringify(inUse)) return null;
      const [saved] = await tx
        .update(externalScorers)
        .set({ enabled: body.enabled })
        .where(eq(externalScorers.id, scorerId))
        .returning();
      await audit(
        actor(req),
        scorerId,
        body.enabled ? "external-scorer-enabled" : "external-scorer-disabled",
        `external scorer '${row.name}' ${body.enabled ? "ENABLED" : "disabled"}` +
          (inUse.length > 0 ? ` — used by enabled trained detector(s) ${inUse.map((d) => d.kind).join(", ")}` : ""),
        {
          phase: "enablement",
          enabled: body.enabled,
          baseUrl: row.baseUrl,
          adapter: row.adapter,
          ...(inUse.length > 0 ? { inUseBy: inUse.map((d) => d.kind) } : {}),
          ...(steppedUp ? { stepUp: "settings_relax" } : {}),
        },
        "allow",
        tx,
      );
      return saved!;
    });
    if (!updated) {
      await refuseChanged(req, scorerId, row.name, "enablement");
      return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    }
    return publicRow(updated);
  });

  app.delete("/v1/external-scorers/:scorerId", async (req, reply) => {
    const { scorerId } = idParam.parse(req.params);
    // ADR-0220: an enabled trained detector calls this scorer at every
    // enforcement site; turn the detector off first (a step-up relaxation).
    // P7R-01: the check and the delete hold the trained-detector lock, so a
    // concurrent bind cannot slip between them.
    const out = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await lockTrainedDetectorBindings(tx);
      const [first] = await enabledDetectorsUsingScorer(tx, scorerId);
      if (first) return { tag: "in_use", inUse: first } as const;
      const [removed] = await tx.delete(externalScorers).where(eq(externalScorers.id, scorerId)).returning();
      if (!removed) return { tag: "missing" } as const;
      // Scorer configs reference this row by NAME (jsonb), so there is no FK to
      // block this delete. That is honest, not lax: a dataset that still names
      // the deleted scorer refuses its next run with 422 external_scorer_unknown
      // — the ADR-0067 semantics — rather than silently scoring another way.
      await audit(
        actor(req),
        scorerId,
        "external-scorer-removed",
        `external scorer '${removed.name}' removed`,
        { phase: "removal", name: removed.name, baseUrl: removed.baseUrl },
        "allow",
        tx,
      );
      return { tag: "removed" } as const;
    });
    if (out.tag === "in_use") {
      await audit(
        actor(req),
        scorerId,
        "external-scorer-in-use-refused",
        `external scorer removal refused: the enabled trained detector ${out.inUse.kind} uses it`,
        { phase: "removal", detectors: [out.inUse.kind] },
        "deny",
      );
      return reply.status(409).send({
        error: "external_scorer_in_use",
        detail: `an enabled trained detector (${out.inUse.kind}) uses this scorer — turn it off on the Guardrails page first`,
      });
    }
    if (out.tag === "missing") return reply.status(404).send({ error: "unknown_external_scorer" });
    return { removed: true };
  });
}
