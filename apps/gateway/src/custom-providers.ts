/**
 * ADR-0034 — ADMIN-REGISTERED CUSTOM LLM PROVIDERS.
 *
 * Pillar 1 promises "any publicly available agent/model"; pillar 3 promises an
 * air-gapped deployment mode. Both were false in one specific way: the provider
 * set was a closed enum of four internet SaaS vendors, so Ollama, vLLM,
 * LM Studio, LocalAI, Azure OpenAI, a Bedrock proxy and every internal gateway
 * were unreachable no matter what key you held. This module is the missing
 * registration surface.
 *
 * WHAT IT DOES NOT DO. It adds no dispatch path. A custom-provider agent rides
 * `executeGovernedDispatch` exactly like every other agent, so policy-kernel
 * evaluation, per-user entitlement, audit, PII handling, per-run budget
 * ceilings and cost attribution are inherited rather than re-implemented — the
 * only thing this module contributes to a dispatch is a validated destination
 * and a guarded fetch.
 *
 * THE THING TO KEEP IN MIND WHILE READING. Everything here exists because an
 * admin-typed URL is an SSRF primitive (see `egress-guard.ts`). Registration
 * does not enable; enabling requires a connection test; the test goes through
 * the guard; and the guard runs AGAIN at every dispatch and again per HTTP
 * request, because DNS can be re-pointed after approval.
 */

import type { FastifyInstance } from "fastify";
import {
  agents,
  auditLog,
  customModelProviders,
  egressAllowHosts,
  eq,
  type CustomModelProviderRow,
  type Db,
} from "@regulait/db";
import {
  createCustomModelProviderSchema,
  createEgressAllowHostSchema,
  setCustomModelProviderEnabledSchema,
  updateCustomModelProviderSchema,
} from "@regulait/shared";
import { resolveModelProvider, type ModelProvider } from "@regulait/model-provider";
import { z } from "zod";
import { encryptSecret, decryptSecret } from "./secrets.js";
import { loadOrgSettings } from "./org-settings.js";
import {
  checkEgress,
  createGuardedFetch,
  egressRefusal,
  normalizeHost,
  type EgressAllowEntry,
  type EgressDecision,
  type EgressResolver,
} from "./egress-guard.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** The read-back projection. `keyCiphertext` is structurally absent — the key
 * is never returned by any route, only `hasApiKey` so the portal can show
 * "keyless" vs "key set" without ever holding the material. */
const providerCols = {
  id: customModelProviders.id,
  name: customModelProviders.name,
  wireProtocol: customModelProviders.wireProtocol,
  baseUrl: customModelProviders.baseUrl,
  allowPlaintextHttp: customModelProviders.allowPlaintextHttp,
  enabled: customModelProviders.enabled,
  lastTestedAt: customModelProviders.lastTestedAt,
  lastTestError: customModelProviders.lastTestError,
  createdBy: customModelProviders.createdBy,
  createdAt: customModelProviders.createdAt,
};

function publicRow(row: CustomModelProviderRow) {
  const { keyCiphertext, ...rest } = row;
  return { ...rest, hasApiKey: keyCiphertext != null };
}

// ---------------------------------------------------------------------------
// allow-list loading
// ---------------------------------------------------------------------------

/** The admin egress allow-list as the guard wants it. An EMPTY table means
 * NOTHING is reachable — that is the default-deny posture, not an error. */
export async function loadEgressAllowList(db: Db): Promise<EgressAllowEntry[]> {
  const rows = await db.select().from(egressAllowHosts);
  return rows.map((r) => ({
    host: normalizeHost(r.host),
    allowPrivateRanges: r.allowPrivateRanges,
    allowPlaintextHttp: r.allowPlaintextHttp,
  }));
}

// ---------------------------------------------------------------------------
// the dispatch-time resolution used by executeGovernedDispatch
// ---------------------------------------------------------------------------

export type CustomProviderResolution =
  | {
      ok: true;
      provider: ModelProvider;
      row: CustomModelProviderRow;
      /** for the audit row — WHERE this dispatch went */
      destination: { host: string; port: number; protocol: string; addresses: string[] };
    }
  | { ok: false; status: number; error: string; detail: string };

/**
 * Resolve an agent's custom provider into a live, egress-guarded adapter.
 *
 * Called on EVERY dispatch, not once at registration: the allow-list may have
 * changed, the provider may have been disabled, the org toggle may have been
 * flipped, and — the reason this cannot be cached — the hostname may have been
 * re-pointed in DNS since the day an admin approved it.
 */
export async function resolveCustomProviderForDispatch(
  db: Db,
  dataKey: string | undefined,
  customProviderId: string | null,
  deps: { resolve?: EgressResolver; fetchImpl?: typeof fetch } = {},
): Promise<CustomProviderResolution> {
  if (!customProviderId) {
    return {
      ok: false,
      status: 409,
      error: "agent_not_dispatchable",
      detail: "agent declares provider 'custom' but names no custom provider",
    };
  }

  const org = await loadOrgSettings(db);
  if (!org.customModelProvidersEnabled) {
    return {
      ok: false,
      status: 409,
      error: "custom_providers_disabled",
      detail:
        "custom LLM providers are switched off for this organisation " +
        "(org settings: customModelProvidersEnabled) — no custom endpoint will be contacted",
    };
  }

  const [row] = await db
    .select()
    .from(customModelProviders)
    .where(eq(customModelProviders.id, customProviderId));
  if (!row) {
    return {
      ok: false,
      status: 409,
      error: "unknown_custom_provider",
      detail: `custom provider ${customProviderId} no longer exists`,
    };
  }
  if (!row.enabled) {
    return {
      ok: false,
      status: 409,
      error: "custom_provider_disabled",
      detail: `custom provider '${row.name}' is disabled — an admin must run its connection test and enable it`,
    };
  }

  // THE GUARD, at dispatch time. Not a cached verdict from registration day.
  const allowList = await loadEgressAllowList(db);
  const decision = await checkEgress(row.baseUrl, {
    allowList,
    providerAllowsPlaintextHttp: row.allowPlaintextHttp,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
  if (!decision.ok) {
    return {
      ok: false,
      status: 403,
      error: "egress_blocked",
      detail: `custom provider '${row.name}': ${decision.reason}`,
    };
  }

  let apiKey: string | null = null;
  if (row.keyCiphertext) {
    if (!dataKey) {
      return { ok: false, status: 503, error: "no_data_key", detail: "set REGULAIT_DATA_KEY" };
    }
    apiKey = decryptSecret(dataKey, row.keyCiphertext);
  }

  const guardedFetch = createGuardedFetch({
    allowList,
    providerAllowsPlaintextHttp: row.allowPlaintextHttp,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const provider = resolveModelProvider(
    {
      provider: "custom",
      apiKey,
      baseUrl: row.baseUrl,
      wireProtocol: row.wireProtocol,
    },
    guardedFetch,
  );

  return {
    ok: true,
    provider,
    row,
    destination: {
      host: decision.host,
      port: decision.port,
      protocol: decision.protocol,
      addresses: decision.addresses,
    },
  };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const idParam = z.object({ providerId: z.string().uuid() });
const hostIdParam = z.object({ hostId: z.string().uuid() });

/**
 * Admin-only by the global gate — NONE of these routes appear in
 * NON_ADMIN_ROUTES. That is the locked decision: registration is admin-only,
 * not per-user self-service, because the person typing the URL is the person
 * choosing what the gateway will connect to from inside the VPC.
 */
export function registerCustomProviderRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { dataKey?: string; resolve?: EgressResolver; fetchImpl?: typeof fetch } = {},
) {
  const actor = (req: { authCtx: { userId?: string | null; via?: string } }) =>
    req.authCtx.userId ?? NIL_USER;

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
      objectType: "custom_model_provider",
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  }

  /** Shared gate: refuse every write while the org switch is off, honestly. */
  async function capabilityOn(): Promise<boolean> {
    return (await loadOrgSettings(db)).customModelProvidersEnabled;
  }

  // --- egress allow-list -------------------------------------------------
  // Registered FIRST because it is the thing that makes the rest safe: with an
  // empty allow-list, every custom provider below is inert.

  app.get("/v1/egress-allow-hosts", async () => ({
    hosts: await db.select().from(egressAllowHosts),
  }));

  app.post("/v1/egress-allow-hosts", async (req, reply) => {
    const body = createEgressAllowHostSchema.parse(req.body);
    const host = normalizeHost(body.host);
    if (!host) {
      return reply.status(400).send({ error: "invalid_host", detail: "host normalizes to empty" });
    }
    const values = {
      host,
      allowPrivateRanges: body.allowPrivateRanges ?? false,
      allowPlaintextHttp: body.allowPlaintextHttp ?? false,
      note: body.note ?? null,
      createdBy: req.authCtx.userId ?? null,
    };
    const [row] = await db
      .insert(egressAllowHosts)
      .values(values)
      .onConflictDoUpdate({ target: egressAllowHosts.host, set: values })
      .returning();
    // AUDITED: widening what the gateway may connect to is a governance act,
    // and opting a host into private ranges or plaintext doubly so.
    await db.insert(auditLog).values({
      userId: actor(req),
      objectType: "custom_model_provider",
      objectId: row!.id,
      detail: { phase: "egress_allow_host", ...values },
      effect: "allow",
      ruleId: "egress-allow-host-set",
      ruleChain: [],
      reason:
        `egress allow-list entry for '${host}'` +
        (values.allowPrivateRanges ? " WITH private-range access" : "") +
        (values.allowPlaintextHttp ? " WITH plaintext http" : ""),
    });
    return reply.status(201).send(row);
  });

  app.delete("/v1/egress-allow-hosts/:hostId", async (req, reply) => {
    const { hostId } = hostIdParam.parse(req.params);
    const [removed] = await db
      .delete(egressAllowHosts)
      .where(eq(egressAllowHosts.id, hostId))
      .returning();
    if (!removed) return reply.status(404).send({ error: "unknown_egress_allow_host" });
    await db.insert(auditLog).values({
      userId: actor(req),
      objectType: "custom_model_provider",
      objectId: hostId,
      detail: { phase: "egress_allow_host", removed: removed.host },
      effect: "allow",
      ruleId: "egress-allow-host-removed",
      ruleChain: [],
      reason: `egress allow-list entry for '${removed.host}' removed`,
    });
    return { removed: true };
  });

  // --- custom providers ---------------------------------------------------

  app.get("/v1/custom-model-providers", async () => ({
    providers: await db.select(providerCols).from(customModelProviders),
  }));

  app.post("/v1/custom-model-providers", async (req, reply) => {
    const body = createCustomModelProviderSchema.parse(req.body);
    if (!(await capabilityOn())) {
      return reply.status(409).send({
        error: "custom_providers_disabled",
        detail:
          "custom LLM providers are switched off for this organisation — enable " +
          "customModelProvidersEnabled in org settings first",
      });
    }
    if (body.apiKey && !opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
    }
    // Pre-flight the URL now so a bad endpoint is a 4xx at registration rather
    // than a surprise at dispatch. It is NOT a substitute for the dispatch-time
    // check — it is the earliest honest failure.
    const decision = await preflight(body.baseUrl, body.allowPlaintextHttp ?? false);
    if (!decision.ok) {
      await audit(
        actor(req),
        null,
        "egress-blocked",
        `custom provider registration refused: ${decision.reason}`,
        { phase: "registration", baseUrl: body.baseUrl, code: decision.code },
        "deny",
      );
      return reply.status(400).send({
        error: "egress_blocked",
        code: decision.code,
        detail: decision.reason,
      });
    }

    const [existing] = await db
      .select({ id: customModelProviders.id })
      .from(customModelProviders)
      .where(eq(customModelProviders.name, body.name));
    if (existing) {
      return reply
        .status(409)
        .send({ error: "duplicate_name", detail: `a custom provider named '${body.name}' already exists` });
    }

    const [row] = await db
      .insert(customModelProviders)
      .values({
        name: body.name,
        wireProtocol: body.wireProtocol,
        baseUrl: body.baseUrl,
        keyCiphertext: body.apiKey && opts.dataKey ? encryptSecret(opts.dataKey, body.apiKey) : null,
        allowPlaintextHttp: body.allowPlaintextHttp ?? false,
        // ALWAYS false on create. There is no "register and enable in one
        // call" — a connection test stands between registration and use.
        enabled: false,
        createdBy: req.authCtx.userId ?? null,
      })
      .returning();

    await audit(
      actor(req),
      row!.id,
      "custom-provider-registered",
      `custom model provider '${row!.name}' registered (${row!.wireProtocol}) at ${decision.host}`,
      {
        phase: "registration",
        name: row!.name,
        wireProtocol: row!.wireProtocol,
        host: decision.host,
        port: decision.port,
        protocol: decision.protocol,
        allowPlaintextHttp: row!.allowPlaintextHttp,
        hasApiKey: row!.keyCiphertext != null,
      },
    );
    return reply.status(201).send(publicRow(row!));
  });

  app.patch("/v1/custom-model-providers/:providerId", async (req, reply) => {
    const { providerId } = idParam.parse(req.params);
    const body = updateCustomModelProviderSchema.parse(req.body);
    const [row] = await db
      .select()
      .from(customModelProviders)
      .where(eq(customModelProviders.id, providerId));
    if (!row) return reply.status(404).send({ error: "unknown_custom_provider" });
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
          providerId,
          "egress-blocked",
          `custom provider '${row.name}' endpoint change refused: ${decision.reason}`,
          { phase: "update", baseUrl: nextBaseUrl, code: decision.code },
          "deny",
        );
        return reply.status(400).send({ error: "egress_blocked", code: decision.code, detail: decision.reason });
      }
    }

    const [updated] = await db
      .update(customModelProviders)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.wireProtocol !== undefined ? { wireProtocol: body.wireProtocol } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.allowPlaintextHttp !== undefined ? { allowPlaintextHttp: body.allowPlaintextHttp } : {}),
        // null CLEARS the key (endpoint becomes keyless); undefined keeps it
        ...(body.apiKey !== undefined
          ? { keyCiphertext: body.apiKey && opts.dataKey ? encryptSecret(opts.dataKey, body.apiKey) : null }
          : {}),
        // MOVING THE ENDPOINT RE-ARMS THE GATE. A provider that was tested and
        // enabled against endpoint A must not stay enabled after being pointed
        // at endpoint B — that would make the connection test a formality an
        // admin passes once and then edits around.
        ...(endpointMoved ? { enabled: false, lastTestedAt: null, lastTestError: null } : {}),
      })
      .where(eq(customModelProviders.id, providerId))
      .returning();

    await audit(
      actor(req),
      providerId,
      "custom-provider-updated",
      `custom model provider '${updated!.name}' updated${endpointMoved ? " — endpoint changed, disabled pending a fresh connection test" : ""}`,
      {
        phase: "update",
        changed: Object.keys(body),
        endpointMoved,
        baseUrl: updated!.baseUrl,
        allowPlaintextHttp: updated!.allowPlaintextHttp,
      },
    );
    return publicRow(updated!);
  });

  /**
   * THE CONNECTION TEST. Enabling requires one to have passed, so this is the
   * gate rather than a convenience: it proves the endpoint is (a) permitted by
   * the egress guard and (b) actually answering the declared dialect. A failure
   * is reported honestly — a real 4xx/5xx with the upstream's own message, and
   * the reason is persisted on the row so the portal can show it.
   */
  app.post("/v1/custom-model-providers/:providerId/test", async (req, reply) => {
    const { providerId } = idParam.parse(req.params);
    const body = z
      .object({ model: z.string().min(1).max(200).optional() })
      .strict()
      .parse(req.body ?? {});
    const [row] = await db
      .select()
      .from(customModelProviders)
      .where(eq(customModelProviders.id, providerId));
    if (!row) return reply.status(404).send({ error: "unknown_custom_provider" });
    if (!(await capabilityOn())) {
      return reply.status(409).send({
        error: "custom_providers_disabled",
        detail: "custom LLM providers are switched off for this organisation",
      });
    }

    const allowList = await loadEgressAllowList(db);
    const decision = await checkEgress(row.baseUrl, {
      allowList,
      providerAllowsPlaintextHttp: row.allowPlaintextHttp,
      ...(opts.resolve ? { resolve: opts.resolve } : {}),
    });
    if (!decision.ok) {
      await recordTest(providerId, decision.reason);
      await audit(
        actor(req),
        providerId,
        "egress-blocked",
        `connection test for '${row.name}' refused before any request: ${decision.reason}`,
        { phase: "connection_test", code: decision.code, baseUrl: row.baseUrl },
        "deny",
      );
      return reply.status(403).send({ ok: false, error: "egress_blocked", code: decision.code, detail: decision.reason });
    }

    let apiKey: string | null = null;
    if (row.keyCiphertext) {
      if (!opts.dataKey) {
        return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
      }
      apiKey = decryptSecret(opts.dataKey, row.keyCiphertext);
    }

    const provider = resolveModelProvider(
      { provider: "custom", apiKey, baseUrl: row.baseUrl, wireProtocol: row.wireProtocol },
      createGuardedFetch({
        allowList,
        providerAllowsPlaintextHttp: row.allowPlaintextHttp,
        ...(opts.resolve ? { resolve: opts.resolve } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );

    // A minimal real dispatch. The endpoint has to answer the dialect it
    // claims — "the TCP port is open" is not a connection test.
    const model = body.model ?? "probe";
    try {
      const result = await provider.dispatch({
        model,
        input: "ping",
        maxTokens: 16,
      });
      await recordTest(providerId, null);
      await audit(
        actor(req),
        providerId,
        "custom-provider-tested",
        `connection test for '${row.name}' passed against ${decision.host}`,
        {
          phase: "connection_test",
          host: decision.host,
          port: decision.port,
          protocol: decision.protocol,
          addresses: decision.addresses,
          model,
          stopReason: result.stopReason,
        },
      );
      return {
        ok: true,
        host: decision.host,
        port: decision.port,
        protocol: decision.protocol,
        model,
        stopReason: result.stopReason,
        usage: result.usage,
      };
    } catch (err) {
      // ADR-0034: an egress refusal raised INSIDE the adapter (a redirect, or
      // the guarded fetch re-checking) is a governance decision. The SDK
      // flattens it to "Connection error."; report the real reason.
      const message = egressRefusal(err) ?? (err instanceof Error ? err.message : String(err));
      await recordTest(providerId, message);
      await audit(
        actor(req),
        providerId,
        "custom-provider-test-failed",
        `connection test for '${row.name}' failed: ${message}`,
        { phase: "connection_test", host: decision.host, error: message },
        "deny",
      );
      // HONEST REFUSAL: a failed test is a failed test. No optimistic 200.
      return reply.status(502).send({ ok: false, error: "connection_test_failed", detail: message });
    }
  });

  app.post("/v1/custom-model-providers/:providerId/enabled", async (req, reply) => {
    const { providerId } = idParam.parse(req.params);
    const body = setCustomModelProviderEnabledSchema.parse(req.body);
    const [row] = await db
      .select()
      .from(customModelProviders)
      .where(eq(customModelProviders.id, providerId));
    if (!row) return reply.status(404).send({ error: "unknown_custom_provider" });

    if (body.enabled) {
      if (!(await capabilityOn())) {
        return reply.status(409).send({
          error: "custom_providers_disabled",
          detail: "custom LLM providers are switched off for this organisation",
        });
      }
      // THE GATE: no untested endpoint is ever enabled.
      if (!row.lastTestedAt) {
        return reply.status(409).send({
          error: "connection_test_required",
          detail:
            `custom provider '${row.name}' has not passed a connection test — ` +
            `POST /v1/custom-model-providers/${providerId}/test first`,
        });
      }
    }

    const [updated] = await db
      .update(customModelProviders)
      .set({ enabled: body.enabled })
      .where(eq(customModelProviders.id, providerId))
      .returning();
    await audit(
      actor(req),
      providerId,
      body.enabled ? "custom-provider-enabled" : "custom-provider-disabled",
      `custom model provider '${row.name}' ${body.enabled ? "ENABLED" : "disabled"}`,
      { phase: "enablement", enabled: body.enabled, baseUrl: row.baseUrl },
    );
    return publicRow(updated!);
  });

  app.delete("/v1/custom-model-providers/:providerId", async (req, reply) => {
    const { providerId } = idParam.parse(req.params);
    // The FK is ON DELETE RESTRICT, so this would fail at the database anyway —
    // checking first turns a 500 into an honest 409 that names the agents.
    const bound = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.customProviderId, providerId));
    if (bound.length > 0) {
      return reply.status(409).send({
        error: "custom_provider_in_use",
        detail: `still referenced by ${bound.length} agent(s): ${bound.map((a) => a.name).join(", ")}`,
      });
    }
    const [removed] = await db
      .delete(customModelProviders)
      .where(eq(customModelProviders.id, providerId))
      .returning();
    if (!removed) return reply.status(404).send({ error: "unknown_custom_provider" });
    await audit(actor(req), providerId, "custom-provider-removed", `custom model provider '${removed.name}' removed`, {
      phase: "removal",
      name: removed.name,
      baseUrl: removed.baseUrl,
    });
    return { removed: true };
  });

  // --- helpers -----------------------------------------------------------

  async function preflight(
    baseUrl: string,
    providerAllowsPlaintextHttp: boolean,
  ): Promise<Extract<EgressDecision, { ok: true }> | Extract<EgressDecision, { ok: false }>> {
    return checkEgress(baseUrl, {
      allowList: await loadEgressAllowList(db),
      providerAllowsPlaintextHttp,
      ...(opts.resolve ? { resolve: opts.resolve } : {}),
    });
  }

  async function recordTest(providerId: string, error: string | null) {
    await db
      .update(customModelProviders)
      .set(
        error === null
          ? { lastTestedAt: new Date(), lastTestError: null }
          : // a FAILED test never sets lastTestedAt — that field is what the
            // enable gate reads, so only a pass may write it
            { lastTestError: error },
      )
      .where(eq(customModelProviders.id, providerId));
  }
}
