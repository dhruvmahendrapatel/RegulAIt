/**
 * ADR-0175 A7 — THE NON-HUMAN CREDENTIAL INVENTORY.
 *
 * One read-time aggregation over every credential this deployment stores:
 * API keys, virtual keys, SCIM tokens, model-provider keys (platform,
 * personal, custom providers), external-scorer secrets, connector
 * credentials, git and PM tokens, the PM webhook secret, deploy-target
 * credentials and roles, ChatOps signing secrets, OIDC client secrets, SAML
 * SP keys, training-backend keys and the tracing export headers. The type
 * catalogue, the flag rules and what each flag means per type live in
 * `@regulait/shared`'s credential-inventory.ts.
 *
 * SECRET MATERIAL NEVER LEAVES THIS FILE, BECAUSE IT NEVER ENTERS IT. Every
 * query below names its columns; none selects a `*_ciphertext` or `*_hash`
 * column, and nothing here decrypts. `credential-inventory.test.ts` scans the
 * endpoint's response for anything secret-shaped.
 *
 * "Last used" is reported only where something records it (the row's own
 * `last_used_at`, or a ledger that records each use of exactly that
 * credential), and the response says which types have no signal. "Age since
 * rotation" is from `secret_set_at` (migration 0142's trigger) where it was
 * recorded, otherwise from creation, and the response says which.
 *
 * Admin-only (the default gate). Read-only: managing a credential happens on
 * its own page, which each row links to.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  apiKeys,
  chatopsConnections,
  chatopsInteractions,
  connectorCredentials,
  connectors,
  customModelProviders,
  deployTargets,
  eq,
  externalScorers,
  gitConnections,
  gte,
  inArray,
  isNotNull,
  modelCredentials,
  oidcProviders,
  orgSettings,
  pmConnections,
  projects,
  samlProviders,
  scimTokens,
  sql,
  trainingBackendConfigs,
  usageEvents,
  userModelCredentials,
  users,
  virtualKeys,
  type Db,
} from "@regulait/db";
import {
  CREDENTIAL_FLAGS,
  CREDENTIAL_FLAG_LABELS,
  CREDENTIAL_TYPES,
  CREDENTIAL_TYPE_IDS,
  CREDENTIALS_NOT_STORED,
  credentialFlags,
  rotationAgeDays,
  staleCredentialEpisodes,
  type CredentialFlag,
  type CredentialRecord,
  type CredentialType,
} from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";

/** how far back the ledger is read for a credential's linked projects/agents */
export const CREDENTIAL_LINK_WINDOW_DAYS = 90;
const LINK_CAP = 10;
const DAY_MS = 86_400_000;

/** GET /v1/admin/credentials paging */
export const CREDENTIAL_PAGE_DEFAULT = 100;
export const CREDENTIAL_PAGE_MAX = 500;

/**
 * ADR-0175 review fix: EVERY LEDGER READ HERE IS BOUNDED. A last use is read
 * from the last `max(unused threshold, link window)` days — enough to judge
 * "unused" exactly, and never the whole ledger; links from the 90-day link
 * window. A credential whose last use is older than the window shows no last
 * use, and its reason says how far back the ledger was read.
 */
export function credentialLedgerWindowDays(unusedDays: number): number {
  return Math.max(unusedDays, CREDENTIAL_LINK_WINDOW_DAYS);
}

/**
 * The virtual-key link query: one grouped, windowed read of agent rows, matched
 * to the keys in SQL. Served by `usage_events_virtual_key_idx`
 * (virtual_key_id, at). Exported so a test can EXPLAIN exactly this query.
 */
export function virtualKeyLinkQuery(db: Db, keyIds: string[], since: Date) {
  return db
    .select({
      keyId: usageEvents.virtualKeyId,
      projectId: usageEvents.projectId,
      agentId: usageEvents.agentId,
    })
    .from(usageEvents)
    .where(
      and(
        inArray(usageEvents.virtualKeyId, keyIds),
        eq(usageEvents.objectType, "agent"),
        gte(usageEvents.at, since),
      ),
    )
    .groupBy(usageEvents.virtualKeyId, usageEvents.projectId, usageEvents.agentId);
}

/**
 * A connector credential's last use: one grouped, windowed read of connector
 * rows, served by `usage_events_connector_at_idx` (connector_id, at). Exported
 * so a test can EXPLAIN exactly this query.
 */
export function connectorLastUseQuery(db: Db, connectorIds: string[], since: Date) {
  return db
    .select({ connectorId: usageEvents.connectorId, at: sql<Date>`max(${usageEvents.at})` })
    .from(usageEvents)
    .where(
      and(
        inArray(usageEvents.connectorId, connectorIds),
        eq(usageEvents.objectType, "connector"),
        gte(usageEvents.at, since),
      ),
    )
    .groupBy(usageEvents.connectorId);
}

/** group rows by a key, in one pass */
function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

interface Ref {
  id: string;
  name: string;
}

export interface InventoryRow extends CredentialRecord {
  typeLabel: string;
  manageAt: string;
  ownerName: string | null;
  status: "active" | "revoked" | "disabled";
  lastUsedSignal: "recorded" | "ledger" | "none";
  expirySignal: "recorded" | "not_tracked";
  rotationSignal: "recorded" | "since_created";
  ageSinceRotationDays: number;
  linkedAgents: Ref[];
  linkedProjects: Ref[];
  flags: CredentialFlag[];
  flagReasons: Partial<Record<CredentialFlag, string>>;
}

export interface CredentialInventory {
  generatedAt: string;
  unusedDays: number;
  /** org_settings.stale_credential_alerts — false = observe only */
  alerting: boolean;
  linkWindowDays: number;
  /** how far back the ledger is read for a ledger-derived last use */
  ledgerWindowDays: number;
  types: Array<{
    type: CredentialType;
    label: string;
    manageAt: string;
    lastUsed: "recorded" | "ledger" | "none";
    lastUsedNote: string;
    overScoped: string | null;
    count: number;
  }>;
  notStored: ReadonlyArray<{ what: string; why: string }>;
  flagLabels: Record<CredentialFlag, string>;
  counts: { total: number; flagged: number; byFlag: Record<CredentialFlag, number> };
  /** what `stale_credentials` raises from this inventory when alerting is on:
   * one episode per (type, flag), covering this many flagged credentials */
  alertPreview: { episodes: number; credentials: number };
  credentials: InventoryRow[];
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

type Draft = Omit<CredentialRecord, "ownerDisabled"> & {
  status: InventoryRow["status"];
  linkedAgents?: Ref[];
  linkedProjects?: Ref[];
};

export async function computeCredentialInventory(
  db: Db,
  opts: { now?: Date; includeRevoked?: boolean } = {},
): Promise<CredentialInventory> {
  const now = opts.now ?? new Date();
  const org = await loadOrgSettings(db);
  const linkSince = new Date(now.getTime() - CREDENTIAL_LINK_WINDOW_DAYS * DAY_MS);
  const ledgerWindowDays = credentialLedgerWindowDays(org.credentialUnusedDays);
  const usedSince = new Date(now.getTime() - ledgerWindowDays * DAY_MS);
  const drafts: Draft[] = [];

  // --- issued here: API keys, virtual keys, SCIM tokens ----------------------
  for (const k of await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      name: apiKeys.name,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
      ownerIsAdmin: users.isAdmin,
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))) {
    drafts.push({
      id: `api_key:${k.id}`,
      type: "api_key",
      name: k.name,
      ownerUserId: k.userId,
      ownerKind: "owner",
      scope: k.ownerIsAdmin
        ? "every entitlement of its owner, including administrator"
        : "every entitlement of its owner",
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: iso(k.lastUsedAt),
      expiresAt: iso(k.expiresAt),
      revokedAt: iso(k.revokedAt),
      secretSetAt: k.createdAt.toISOString(),
      overScoped: k.ownerIsAdmin,
      status: k.revokedAt ? "revoked" : "active",
    });
  }

  const vkRows = await db
    .select({
      id: virtualKeys.id,
      name: virtualKeys.name,
      userId: virtualKeys.userId,
      createdBy: virtualKeys.createdBy,
      purpose: virtualKeys.purpose,
      allowedModels: virtualKeys.allowedModels,
      budgetUsd: virtualKeys.budgetUsd,
      upstreamCredentialId: virtualKeys.upstreamCredentialId,
      expiresAt: virtualKeys.expiresAt,
      revokedAt: virtualKeys.revokedAt,
      createdAt: virtualKeys.createdAt,
      lastUsedAt: virtualKeys.lastUsedAt,
    })
    .from(virtualKeys);
  const vkLinks = groupBy(
    vkRows.length ? await virtualKeyLinkQuery(db, vkRows.map((k) => k.id), linkSince) : [],
    (l) => l.keyId,
  );
  for (const k of vkRows) {
    const models = (k.allowedModels ?? []).filter(Boolean);
    const unrestricted = k.purpose === "dispatch" && models.length === 0 && k.budgetUsd === null;
    const links = vkLinks.get(k.id) ?? [];
    drafts.push({
      id: `virtual_key:${k.id}`,
      type: "virtual_key",
      name: k.name,
      ownerUserId: k.userId,
      ownerKind: "owner",
      scope:
        k.purpose === "pdp"
          ? "authorization checks only (no dispatch)"
          : [
              models.length ? `models: ${models.slice(0, 5).join(", ")}${models.length > 5 ? ` (+${models.length - 5})` : ""}` : "any model its owner may use",
              k.budgetUsd === null ? "no budget" : `budget $${k.budgetUsd}`,
              ...(k.upstreamCredentialId ? ["pinned to one platform provider key"] : []),
            ].join("; "),
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: iso(k.lastUsedAt),
      expiresAt: iso(k.expiresAt),
      revokedAt: iso(k.revokedAt),
      secretSetAt: k.createdAt.toISOString(),
      overScoped: unrestricted,
      status: k.revokedAt ? "revoked" : "active",
      linkedProjects: [...new Set(links.map((l) => l.projectId).filter((p): p is string => !!p))].map((id) => ({ id, name: id })),
      linkedAgents: [...new Set(links.map((l) => l.agentId).filter((a): a is string => !!a))].map((id) => ({ id, name: id })),
    });
  }

  for (const t of await db
    .select({
      id: scimTokens.id,
      name: scimTokens.name,
      createdAt: scimTokens.createdAt,
      lastUsedAt: scimTokens.lastUsedAt,
      revokedAt: scimTokens.revokedAt,
      secretSetAt: scimTokens.secretSetAt,
    })
    .from(scimTokens)) {
    drafts.push({
      id: `scim_token:${t.id}`,
      type: "scim_token",
      name: t.name,
      ownerUserId: null,
      ownerKind: null,
      scope: "create, update and deactivate users and groups",
      createdAt: t.createdAt.toISOString(),
      lastUsedAt: iso(t.lastUsedAt),
      expiresAt: null,
      revokedAt: iso(t.revokedAt),
      secretSetAt: iso(t.secretSetAt),
      overScoped: false,
      status: t.revokedAt ? "revoked" : "active",
    });
  }

  // --- model-provider keys ---------------------------------------------------
  const agentRows = await db
    .select({ id: agents.id, name: agents.name, provider: agents.provider, customProviderId: agents.customProviderId })
    .from(agents);
  for (const c of await db
    .select({ id: modelCredentials.id, provider: modelCredentials.provider, createdAt: modelCredentials.createdAt, secretSetAt: modelCredentials.secretSetAt })
    .from(modelCredentials)) {
    drafts.push({
      id: `model_credential:${c.id}`,
      type: "model_credential",
      name: c.provider,
      ownerUserId: null,
      ownerKind: null,
      scope: `platform key for ${c.provider} agents (used when the caller has no key of their own)`,
      createdAt: c.createdAt.toISOString(),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      secretSetAt: iso(c.secretSetAt),
      overScoped: false,
      status: "active",
      linkedAgents: agentRows.filter((a) => a.provider === c.provider).map((a) => ({ id: a.id, name: a.name })),
    });
  }
  for (const c of await db
    .select({
      id: userModelCredentials.id,
      userId: userModelCredentials.userId,
      provider: userModelCredentials.provider,
      createdAt: userModelCredentials.createdAt,
      secretSetAt: userModelCredentials.secretSetAt,
    })
    .from(userModelCredentials)) {
    drafts.push({
      id: `user_model_credential:${c.id}`,
      type: "user_model_credential",
      name: `${c.provider} (personal)`,
      ownerUserId: c.userId,
      ownerKind: "owner",
      scope: `its owner's calls to ${c.provider} agents`,
      createdAt: c.createdAt.toISOString(),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      secretSetAt: iso(c.secretSetAt),
      overScoped: false,
      status: "active",
    });
  }
  const customRows = await db
    .select({
      id: customModelProviders.id,
      name: customModelProviders.name,
      enabled: customModelProviders.enabled,
      createdBy: customModelProviders.createdBy,
      createdAt: customModelProviders.createdAt,
      secretSetAt: customModelProviders.secretSetAt,
    })
    .from(customModelProviders)
    .where(isNotNull(customModelProviders.keyCiphertext));
  // ONE grouped, windowed read for every custom provider's bound agents
  const boundByProvider = groupBy(
    agentRows.filter((a) => a.customProviderId !== null),
    (a) => a.customProviderId,
  );
  const customAgentIds = customRows.flatMap((c) => (boundByProvider.get(c.id) ?? []).map((a) => a.id));
  const agentLast = new Map(
    (customAgentIds.length
      ? await db
          .select({ agentId: usageEvents.agentId, at: sql<Date>`max(${usageEvents.at})` })
          .from(usageEvents)
          .where(
            and(
              eq(usageEvents.objectType, "agent"),
              gte(usageEvents.at, usedSince),
              inArray(usageEvents.agentId, customAgentIds),
            ),
          )
          .groupBy(usageEvents.agentId)
      : []
    ).map((r) => [r.agentId, new Date(r.at).getTime()]),
  );
  for (const c of customRows) {
    const bound = boundByProvider.get(c.id) ?? [];
    const lastMs = Math.max(-Infinity, ...bound.map((a) => agentLast.get(a.id) ?? -Infinity));
    const last = Number.isFinite(lastMs) ? { at: new Date(lastMs) } : undefined;
    drafts.push({
      id: `custom_provider_key:${c.id}`,
      type: "custom_provider_key",
      name: c.name,
      ownerUserId: c.createdBy,
      ownerKind: c.createdBy ? "creator" : null,
      scope: "calls from the agents bound to this provider",
      createdAt: c.createdAt.toISOString(),
      lastUsedAt: last ? last.at.toISOString() : null,
      lastUsedWindowDays: ledgerWindowDays,
      expiresAt: null,
      revokedAt: null,
      secretSetAt: iso(c.secretSetAt),
      overScoped: false,
      status: c.enabled ? "active" : "disabled",
      linkedAgents: bound.map((a) => ({ id: a.id, name: a.name })),
    });
  }

  // --- integration credentials -----------------------------------------------
  for (const s of await db
    .select({
      id: externalScorers.id,
      name: externalScorers.name,
      enabled: externalScorers.enabled,
      createdBy: externalScorers.createdBy,
      createdAt: externalScorers.createdAt,
      secretSetAt: externalScorers.secretSetAt,
    })
    .from(externalScorers)
    .where(isNotNull(externalScorers.keyCiphertext))) {
    drafts.push({
      id: `external_scorer_key:${s.id}`,
      type: "external_scorer_key",
      name: s.name,
      ownerUserId: s.createdBy,
      ownerKind: s.createdBy ? "creator" : null,
      scope: "sent as the bearer to this scorer endpoint",
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      secretSetAt: iso(s.secretSetAt),
      overScoped: false,
      status: s.enabled ? "active" : "disabled",
    });
  }

  const connCreds = await db
    .select({
      id: connectorCredentials.id,
      connectorId: connectorCredentials.connectorId,
      name: connectors.name,
      kind: connectors.kind,
      createdAt: connectorCredentials.createdAt,
      secretSetAt: connectorCredentials.secretSetAt,
    })
    .from(connectorCredentials)
    .innerJoin(connectors, eq(connectors.id, connectorCredentials.connectorId));
  const credConnectorIds = [...new Set(connCreds.map((c) => c.connectorId))];
  // windowed, and only for connectors that hold a credential; served by
  // `usage_events_connector_at_idx` (connector_id, at)
  const connLast = new Map(
    (credConnectorIds.length ? await connectorLastUseQuery(db, credConnectorIds, usedSince) : []).map((r) => [
      r.connectorId,
      r.at,
    ]),
  );
  const connProjects = groupBy(
    credConnectorIds.length
      ? await db
          .select({ connectorId: usageEvents.connectorId, projectId: usageEvents.projectId })
          .from(usageEvents)
          .where(
            and(
              inArray(usageEvents.connectorId, credConnectorIds),
              eq(usageEvents.objectType, "connector"),
              isNotNull(usageEvents.projectId),
              gte(usageEvents.at, linkSince),
            ),
          )
          .groupBy(usageEvents.connectorId, usageEvents.projectId)
      : [],
    (p) => p.connectorId,
  );
  for (const c of connCreds) {
    const last = connLast.get(c.connectorId);
    drafts.push({
      id: `connector_credential:${c.id}`,
      type: "connector_credential",
      name: c.name,
      ownerUserId: null,
      ownerKind: null,
      scope: `governed calls of the ${c.kind} connector, within each caller's grant`,
      createdAt: c.createdAt.toISOString(),
      lastUsedAt: last ? new Date(last).toISOString() : null,
      lastUsedWindowDays: ledgerWindowDays,
      expiresAt: null,
      revokedAt: null,
      secretSetAt: iso(c.secretSetAt),
      overScoped: false,
      status: "active",
      linkedProjects: (connProjects.get(c.connectorId) ?? [])
        .filter((p) => p.projectId)
        .map((p) => ({ id: p.projectId!, name: p.projectId! })),
    });
  }

  for (const g of await db
    .select({ id: gitConnections.id, name: gitConnections.name, provider: gitConnections.provider, createdAt: gitConnections.createdAt, secretSetAt: gitConnections.secretSetAt })
    .from(gitConnections)) {
    drafts.push({
      id: `git_token:${g.id}`,
      type: "git_token",
      name: g.name,
      ownerUserId: null,
      ownerKind: null,
      scope: `${g.provider} repository operations in workflow stages that name this connection`,
      createdAt: g.createdAt.toISOString(),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      secretSetAt: iso(g.secretSetAt),
      overScoped: false,
      status: "active",
    });
  }

  for (const p of await db
    .select({
      id: pmConnections.id,
      name: pmConnections.name,
      provider: pmConnections.provider,
      project: pmConnections.project,
      createdAt: pmConnections.createdAt,
      secretSetAt: pmConnections.secretSetAt,
      webhookSecretSetAt: pmConnections.webhookSecretSetAt,
      hasWebhookSecret: sql<boolean>`${pmConnections.webhookSecretHash} IS NOT NULL`,
    })
    .from(pmConnections)) {
    drafts.push({
      id: `pm_token:${p.id}`,
      type: "pm_token",
      name: p.name,
      ownerUserId: null,
      ownerKind: null,
      scope: `${p.provider} work items in ${p.project}`,
      createdAt: p.createdAt.toISOString(),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      secretSetAt: iso(p.secretSetAt),
      overScoped: false,
      status: "active",
    });
    if (p.hasWebhookSecret) {
      drafts.push({
        id: `pm_webhook_secret:${p.id}`,
        type: "pm_webhook_secret",
        name: p.name,
        ownerUserId: null,
        ownerKind: null,
        scope: `verifies inbound ${p.provider} webhooks for this connection`,
        createdAt: p.createdAt.toISOString(),
        lastUsedAt: null,
        // a webhook secret has no lifetime of its own; it is replaced by rotation
        expiresAt: null,
        revokedAt: null,
        secretSetAt: iso(p.webhookSecretSetAt),
        overScoped: false,
        status: "active",
      });
    }
  }

  for (const d of await db
    .select({
      id: deployTargets.id,
      name: deployTargets.name,
      provider: deployTargets.provider,
      mode: deployTargets.mode,
      environment: deployTargets.environment,
      createdAt: deployTargets.createdAt,
      secretSetAt: deployTargets.secretSetAt,
      hasCredential: sql<boolean>`${deployTargets.credentialCiphertext} IS NOT NULL`,
      hasRole: sql<boolean>`${deployTargets.roleArn} IS NOT NULL`,
    })
    .from(deployTargets)) {
    const where = `${d.provider} ${d.mode.replace("_", "-")} target, environment ${d.environment ?? "unset"}`;
    if (d.hasCredential) {
      drafts.push({
        id: `deploy_credential:${d.id}`,
        type: "deploy_credential",
        name: d.name,
        ownerUserId: null,
        ownerKind: null,
        scope: `deploys to the ${where}`,
        createdAt: d.createdAt.toISOString(),
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        secretSetAt: iso(d.secretSetAt),
        overScoped: false,
        status: "active",
      });
    }
    if (d.hasRole) {
      drafts.push({
        id: `deploy_role:${d.id}`,
        type: "deploy_role",
        name: d.name,
        ownerUserId: null,
        ownerKind: null,
        scope: `role assumed for short-lived credentials on the ${where}`,
        createdAt: d.createdAt.toISOString(),
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        // no secret is stored: nothing here is ever "set" except the role name
        secretSetAt: null,
        overScoped: false,
        status: "active",
      });
    }
  }

  const chatLast = new Map(
    (
      await db
        .select({ connectionId: chatopsInteractions.connectionId, at: sql<Date>`max(${chatopsInteractions.createdAt})` })
        .from(chatopsInteractions)
        .where(gte(chatopsInteractions.createdAt, usedSince))
        .groupBy(chatopsInteractions.connectionId)
    ).map((r) => [r.connectionId, r.at]),
  );
  for (const c of await db
    .select({
      id: chatopsConnections.id,
      name: chatopsConnections.name,
      provider: chatopsConnections.provider,
      enabled: chatopsConnections.enabled,
      createdByUserId: chatopsConnections.createdByUserId,
      createdAt: chatopsConnections.createdAt,
      secretSetAt: chatopsConnections.secretSetAt,
    })
    .from(chatopsConnections)
    .where(isNotNull(chatopsConnections.signingSecretCiphertext))) {
    const last = chatLast.get(c.id);
    drafts.push({
      id: `chatops_signing_secret:${c.id}`,
      type: "chatops_signing_secret",
      name: c.name,
      ownerUserId: c.createdByUserId,
      ownerKind: c.createdByUserId ? "creator" : null,
      scope: `verifies inbound ${c.provider} approvals and messages for this workspace`,
      createdAt: c.createdAt.toISOString(),
      lastUsedAt: last ? new Date(last).toISOString() : null,
      lastUsedWindowDays: ledgerWindowDays,
      expiresAt: null,
      revokedAt: null,
      secretSetAt: iso(c.secretSetAt),
      overScoped: false,
      status: c.enabled ? "active" : "disabled",
    });
  }

  for (const o of await db
    .select({ id: oidcProviders.id, name: oidcProviders.name, enabled: oidcProviders.enabled, createdAt: oidcProviders.createdAt, secretSetAt: oidcProviders.secretSetAt })
    .from(oidcProviders)) {
    drafts.push({
      id: `oidc_client_secret:${o.id}`,
      type: "oidc_client_secret",
      name: o.name,
      ownerUserId: null,
      ownerKind: null,
      scope: "exchanges sign-in codes with this identity provider",
      createdAt: o.createdAt.toISOString(),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      secretSetAt: iso(o.secretSetAt),
      overScoped: false,
      status: o.enabled ? "active" : "disabled",
    });
  }
  for (const s of await db
    .select({ id: samlProviders.id, name: samlProviders.name, enabled: samlProviders.enabled, createdAt: samlProviders.createdAt, secretSetAt: samlProviders.secretSetAt })
    .from(samlProviders)
    .where(isNotNull(samlProviders.spPrivateKeyCiphertext))) {
    drafts.push({
      id: `saml_sp_key:${s.id}`,
      type: "saml_sp_key",
      name: s.name,
      ownerUserId: null,
      ownerKind: null,
      scope: "signs requests to (and decrypts assertions from) this identity provider",
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      secretSetAt: iso(s.secretSetAt),
      overScoped: false,
      status: s.enabled ? "active" : "disabled",
    });
  }

  for (const t of await db
    .select({
      id: trainingBackendConfigs.id,
      backend: trainingBackendConfigs.backend,
      enabled: trainingBackendConfigs.enabled,
      createdByUserId: trainingBackendConfigs.createdByUserId,
      createdAt: trainingBackendConfigs.createdAt,
      secretSetAt: trainingBackendConfigs.secretSetAt,
    })
    .from(trainingBackendConfigs)
    .where(isNotNull(trainingBackendConfigs.keyCiphertext))) {
    drafts.push({
      id: `training_backend_key:${t.id}`,
      type: "training_backend_key",
      name: t.backend,
      ownerUserId: t.createdByUserId,
      ownerKind: t.createdByUserId ? "creator" : null,
      scope: `submits training jobs to the ${t.backend} backend`,
      createdAt: t.createdAt.toISOString(),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      secretSetAt: iso(t.secretSetAt),
      overScoped: false,
      status: t.enabled ? "active" : "disabled",
    });
  }

  for (const o of await db
    .select({ id: orgSettings.id, createdAt: orgSettings.createdAt, setAt: orgSettings.tracingOtlpHeadersSetAt })
    .from(orgSettings)
    .where(isNotNull(orgSettings.tracingOtlpHeadersCiphertext))) {
    drafts.push({
      id: `otlp_headers:${o.id}`,
      type: "otlp_headers",
      name: "OTLP collector headers",
      ownerUserId: null,
      ownerKind: null,
      scope: "sent with every trace export to the configured collector",
      createdAt: (o.setAt ?? o.createdAt).toISOString(),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      secretSetAt: iso(o.setAt),
      overScoped: false,
      status: "active",
    });
  }

  // --- names for owners, linked agents and projects ---------------------------
  const userIds = [...new Set(drafts.map((d) => d.ownerUserId).filter((u): u is string => !!u))];
  const people = userIds.length
    ? await db
        .select({ id: users.id, displayName: users.displayName, disabledAt: users.disabledAt })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const person = new Map(people.map((p) => [p.id, p]));
  const projectIds = [...new Set(drafts.flatMap((d) => (d.linkedProjects ?? []).map((p) => p.id)))];
  const projectNames = new Map(
    (projectIds.length
      ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))
      : []
    ).map((p) => [p.id, p.name]),
  );
  const agentNames = new Map(agentRows.map((a) => [a.id, a.name]));

  const all: InventoryRow[] = drafts.map((d) => {
    const owner = d.ownerUserId ? person.get(d.ownerUserId) : undefined;
    const rec: CredentialRecord = {
      id: d.id,
      type: d.type,
      name: d.name,
      ownerUserId: d.ownerUserId,
      ownerKind: d.ownerKind,
      ownerDisabled: Boolean(owner?.disabledAt),
      scope: d.scope,
      createdAt: d.createdAt,
      lastUsedAt: d.lastUsedAt,
      expiresAt: d.expiresAt,
      revokedAt: d.revokedAt,
      secretSetAt: d.secretSetAt,
      overScoped: d.overScoped,
      lastUsedWindowDays: d.lastUsedWindowDays ?? null,
    };
    const info = CREDENTIAL_TYPES[d.type];
    const { flags, reasons } = credentialFlags(rec, now, org.credentialUnusedDays);
    const issuedOnce = d.type === "api_key" || d.type === "virtual_key";
    return {
      ...rec,
      typeLabel: info.label,
      manageAt: info.manageAt,
      ownerName: owner?.displayName ?? null,
      status: d.status,
      lastUsedSignal: info.lastUsed,
      expirySignal: info.issuedHere ? "recorded" : "not_tracked",
      rotationSignal: issuedOnce || d.secretSetAt ? "recorded" : "since_created",
      ageSinceRotationDays: rotationAgeDays(rec, now),
      linkedAgents: (d.linkedAgents ?? []).slice(0, LINK_CAP).map((a) => ({ id: a.id, name: agentNames.get(a.id) ?? a.name })),
      linkedProjects: (d.linkedProjects ?? []).slice(0, LINK_CAP).map((p) => ({ id: p.id, name: projectNames.get(p.id) ?? "(deleted project)" })),
      flags,
      flagReasons: reasons,
    };
  });

  const credentials = all
    .filter((r) => opts.includeRevoked || r.status !== "revoked")
    .sort((a, b) => b.flags.length - a.flags.length || a.typeLabel.localeCompare(b.typeLabel) || a.name.localeCompare(b.name));
  const byFlag = Object.fromEntries(CREDENTIAL_FLAGS.map((f) => [f, credentials.filter((c) => c.flags.includes(f)).length])) as Record<CredentialFlag, number>;
  return {
    generatedAt: now.toISOString(),
    unusedDays: org.credentialUnusedDays,
    alerting: org.staleCredentialAlerts,
    linkWindowDays: CREDENTIAL_LINK_WINDOW_DAYS,
    ledgerWindowDays,
    types: CREDENTIAL_TYPE_IDS.map((type) => {
      const info = CREDENTIAL_TYPES[type];
      return {
        type,
        label: info.label,
        manageAt: info.manageAt,
        lastUsed: info.lastUsed,
        lastUsedNote: info.lastUsedNote,
        overScoped: info.overScoped,
        count: credentials.filter((c) => c.type === type).length,
      };
    }),
    notStored: CREDENTIALS_NOT_STORED,
    flagLabels: CREDENTIAL_FLAG_LABELS,
    counts: { total: credentials.length, flagged: credentials.filter((c) => c.flags.length > 0).length, byFlag },
    alertPreview: {
      episodes: staleCredentialEpisodes(
        credentials.map((c) => ({ id: c.id, typeLabel: c.typeLabel, name: c.name, flags: c.flags, reasons: {}, manageAt: c.manageAt })),
      ).length,
      credentials: credentials.filter((c) => c.flags.length > 0).length,
    },
    credentials,
  };
}

const listQuery = z
  .object({
    type: z.enum(CREDENTIAL_TYPE_IDS as [CredentialType, ...CredentialType[]]).optional(),
    /** a flag, or `none` for credentials with no flag */
    flag: z.enum([...CREDENTIAL_FLAGS, "none"] as [CredentialFlag | "none", ...Array<CredentialFlag | "none">]).optional(),
    includeRevoked: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(CREDENTIAL_PAGE_MAX).default(CREDENTIAL_PAGE_DEFAULT),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export function registerCredentialInventoryRoutes(app: FastifyInstance, db: Db): void {
  /**
   * Filtered, then paged (ADR-0175 review fix): `counts`, `types` and the
   * flag counts describe the whole inventory; `credentials` is one page of
   * the filtered list, and `page.total` is how many the filter matched.
   */
  app.get("/v1/admin/credentials", async (req) => {
    const q = listQuery.parse(req.query);
    const inv = await computeCredentialInventory(db, { includeRevoked: q.includeRevoked === "true" });
    const matched = inv.credentials.filter(
      (c) =>
        (!q.type || c.type === q.type) &&
        (!q.flag || (q.flag === "none" ? c.flags.length === 0 : c.flags.includes(q.flag))),
    );
    return {
      ...inv,
      page: { total: matched.length, limit: q.limit, offset: q.offset },
      credentials: matched.slice(q.offset, q.offset + q.limit),
    };
  });
}
