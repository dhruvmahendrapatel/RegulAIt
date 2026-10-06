/**
 * The guided "connect your first real provider" journey (UI-review pilot
 * blocker #3): one admin-only endpoint that aggregates REAL readiness signals
 * out of the objects that already exist — never a static tutorial. Each step
 * is computed from the same tables/logic its owning surface uses, so a step
 * flips to done the moment the real object is created, and the evidence names
 * the object (which provider, which connection) instead of a bare boolean.
 *
 * Read-only by construction: this module only SELECTs. It confers nothing,
 * writes nothing, and leaks no secret — evidence carries names/providers/
 * counts, never key material (the same discipline as /v1/model-providers/
 * status).
 *
 * Honesty notes, mirrored in the portal card's copy:
 * - "model provider" counts a STORED platform credential only when
 *   REGULAIT_DATA_KEY is set (without it the ciphertext is undecryptable at
 *   dispatch — configuredProviders() applies the same rule), and counts the
 *   env fallback only when the ADR-0021 org gate allows that provider.
 * - git/PM connections distinguish real from 'mock' via their provider enum.
 * - mock vs real IS distinguishable in usage_events for agent dispatches
 *   (rows carry the served provider), so the last step is honestly "first
 *   REAL dispatch", with mock dispatch counts reported alongside.
 */

import { publicUrlPosture } from "./public-url.js";
import type { FastifyInstance } from "fastify";
import {
  and,
  count,
  eq,
  gitConnections,
  isNull,
  mcpServers,
  modelCredentials,
  pmConnections,
  projects,
  complianceProfiles,
  sql,
  usageEvents,
  users,
  type Db,
} from "@regulait/db";
import { ENV_FALLBACK_PROVIDERS, platformEnvKey } from "./agents-connectors.js";
import { envFallbackAllowed, loadOrgSettings } from "./org-settings.js";
import { interceptionScopeRulesExist, loadInterceptionSettings } from "./compat-core.js";

export interface SetupStep {
  key: string;
  title: string;
  done: boolean;
  evidence: Record<string, unknown>;
  /** prerequisite step keys that are themselves still NOT done — empties as
   * the prerequisites complete, so the UI can grey a step that cannot
   * meaningfully be finished yet */
  blockedBy: string[];
}

export function registerSetupStatusRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { dataKey?: string } = {},
) {
  // Admin-only via the global gate (deliberately NOT in NON_ADMIN_ROUTES):
  // the checklist aggregates org-wide posture (user counts, connection names,
  // interception settings) that only the admin surface shows.
  app.get("/v1/setup/status", async () => {
    const [
      org,
      interception,
      scopeRulesExist,
      storedCreds,
      gitConns,
      pmConns,
      servers,
      nonAdminCount,
      projectRows,
      profileRows,
      [dispatchAgg],
      [mcpUse],
    ] = await Promise.all([
      loadOrgSettings(db),
      loadInterceptionSettings(db),
      interceptionScopeRulesExist(db),
      db.select({ provider: modelCredentials.provider }).from(modelCredentials),
      db
        .select({ name: gitConnections.name, provider: gitConnections.provider })
        .from(gitConnections),
      db
        .select({ name: pmConnections.name, provider: pmConnections.provider })
        .from(pmConnections),
      db.select({ name: mcpServers.name, url: mcpServers.url }).from(mcpServers),
      db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.isAdmin, false), isNull(users.disabledAt)))
        .then((r) => r[0]?.n ?? 0),
      db
        .select({ name: projects.name, classifications: projects.classifications })
        .from(projects),
      db.select({ tag: complianceProfiles.tag }).from(complianceProfiles),
      // agent dispatch rows split into real vs mock — usage_events carries the
      // SERVED provider on agent rows, so the split is honest, not inferred
      db
        .select({
          real: count(sql4RealAgentRow()),
          mock: count(sql4MockAgentRow()),
        })
        .from(usageEvents),
      db
        .select({ n: count() })
        .from(usageEvents)
        .where(eq(usageEvents.objectType, "mcp_tool")),
    ]);

    // --- 1. model provider ------------------------------------------------
    // Same rules as configuredProviders()/GET /v1/model-providers/status: a
    // stored platform credential needs the data key to ever decrypt; the env
    // fallback needs the org gate open for that provider.
    const providerSources: Array<{ provider: string; source: string }> = [];
    if (opts.dataKey) {
      for (const c of storedCreds) {
        providerSources.push({ provider: c.provider, source: "platform_credential" });
      }
    }
    for (const p of ENV_FALLBACK_PROVIDERS) {
      if (
        envFallbackAllowed(org, p) &&
        platformEnvKey(p) !== null &&
        !providerSources.some((x) => x.provider === p)
      ) {
        providerSources.push({ provider: p, source: "env" });
      }
    }
    const modelProvider: SetupStep = {
      key: "model_provider",
      title: "Configure a real model provider",
      done: providerSources.length > 0,
      evidence: {
        providers: providerSources,
        ...(storedCreds.length > 0 && !opts.dataKey
          ? {
              note:
                "a platform credential is stored but REGULAIT_DATA_KEY is not set — it cannot be decrypted at dispatch, so it does not count",
            }
          : {}),
      },
      blockedBy: [],
    };

    // --- 2. real (non-mock) git connection --------------------------------
    const realGit = gitConns.filter((c) => c.provider !== "mock");
    const gitStep: SetupStep = {
      key: "git_connection",
      title: "Connect a real git provider",
      done: realGit.length > 0,
      evidence: {
        real: realGit.map((c) => ({ name: c.name, provider: c.provider })),
        mockCount: gitConns.length - realGit.length,
      },
      blockedBy: [],
    };

    // --- 3. real (non-mock) PM connection ---------------------------------
    const realPm = pmConns.filter((c) => c.provider !== "mock");
    const pmStep: SetupStep = {
      key: "pm_connection",
      title: "Connect a PM tool",
      done: realPm.length > 0,
      evidence: {
        real: realPm.map((c) => ({ name: c.name, provider: c.provider })),
        mockCount: pmConns.length - realPm.length,
      },
      blockedBy: [],
    };

    // --- 4. MCP server registered -----------------------------------------
    // (no mock/real provider enum on mcp_servers — any registered server
    // counts; the url is the evidence)
    const mcpStep: SetupStep = {
      key: "mcp_server",
      title: "Register an MCP server",
      done: servers.length > 0,
      evidence: { servers: servers.slice(0, 5) },
      blockedBy: [],
    };

    // --- 5. at least one non-admin user -----------------------------------
    const usersStep: SetupStep = {
      key: "non_admin_user",
      title: "Invite a non-admin user",
      done: nonAdminCount > 0,
      evidence: { activeNonAdminUsers: nonAdminCount },
      blockedBy: [],
    };

    // --- 6. at least one project ------------------------------------------
    const projectStep: SetupStep = {
      key: "project",
      title: "Create a project",
      done: projectRows.length > 0,
      evidence: { projects: projectRows.slice(0, 5).map((p) => p.name) },
      blockedBy: [],
    };

    // --- 7. compliance profile assigned -----------------------------------
    // "Assigned" means the cascade is LIVE: a project carries a classification
    // tag for which a compliance_profiles row exists. Tags with no profile
    // row cascade nothing, so they honestly do not complete the step.
    const profileTags = new Set(profileRows.map((p) => p.tag));
    const classified = projectRows
      .map((p) => ({
        name: p.name,
        tags: ((p.classifications ?? []) as string[]).filter((t) => profileTags.has(t)),
      }))
      .filter((p) => p.tags.length > 0);
    const complianceStep: SetupStep = {
      key: "compliance_profile",
      title: "Assign a compliance profile to a project",
      done: classified.length > 0,
      evidence: {
        classifiedProjects: classified.slice(0, 5),
        profilesDefined: profileRows.length,
      },
      blockedBy: [],
    };

    // --- 8. interception surface in use -----------------------------------
    // mcp_interception_enabled defaults ON, so it is NOT adoption evidence on
    // its own; what counts is an explicitly enabled compat surface, a scope
    // rule (staged rollout), or the MCP proxy actually having been used.
    const mcpProxyCalls = mcpUse?.n ?? 0;
    const interceptionStep: SetupStep = {
      key: "interception_surface",
      title: "Enable an interception surface (or use the MCP proxy)",
      done:
        interception.anthropicCompatEnabled ||
        interception.openaiCompatEnabled ||
        scopeRulesExist ||
        mcpProxyCalls > 0,
      evidence: {
        anthropicCompatEnabled: interception.anthropicCompatEnabled,
        openaiCompatEnabled: interception.openaiCompatEnabled,
        scopeRulesExist,
        mcpProxyCalls,
      },
      blockedBy: [],
    };

    // --- 9. first REAL governed dispatch ----------------------------------
    // usage_events agent rows carry the served provider, so mock vs real IS
    // distinguishable — the step is honestly "first real dispatch" and the
    // mock count is reported alongside (mock traffic proves the flow, not
    // production readiness). Blocked until a real provider is configured.
    const realDispatches = Number(dispatchAgg?.real ?? 0);
    const mockDispatches = Number(dispatchAgg?.mock ?? 0);
    const dispatchStep: SetupStep = {
      key: "first_real_dispatch",
      title: "Run a first real governed dispatch",
      done: realDispatches > 0,
      evidence: { realDispatches, mockDispatches },
      blockedBy: modelProvider.done ? [] : ["model_provider"],
    };

    const steps: SetupStep[] = [
      modelProvider,
      gitStep,
      pmStep,
      mcpStep,
      usersStep,
      projectStep,
      complianceStep,
      interceptionStep,
      dispatchStep,
    ];
    return {
      complete: steps.every((s) => s.done),
      doneCount: steps.filter((s) => s.done).length,
      totalCount: steps.length,
      steps,
      // ADR-0121 amendment: outbound mail links only to this origin; unset = no mail courier
      publicUrl: publicUrlPosture(),
    };
  });
}

// count(<expr>) counts non-null rows: NULLIF collapses the non-matching rows
// to NULL so one pass over usage_events yields both the real and the mock
// agent-dispatch totals.
function sql4RealAgentRow() {
  return sql`nullif(${usageEvents.objectType} = 'agent' and ${usageEvents.provider} is not null and ${usageEvents.provider} <> 'mock', false)`;
}
function sql4MockAgentRow() {
  return sql`nullif(${usageEvents.objectType} = 'agent' and ${usageEvents.provider} = 'mock', false)`;
}
