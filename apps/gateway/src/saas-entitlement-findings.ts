/**
 * ADR-0337 §5 (lane E18, slice 3): SaaS entitlement findings, computed at read time.
 *
 * The frozen V1 rules (`SAAS_FINDING_RULES_V1`, @regulait/shared) run over the entitlement graph, the usage each
 * source's latest read observed, and the agent registry records. Nothing is stored and nothing calls a vendor:
 * computing the report writes no row and no audit entry. A finding is a recommendation a person decides; RegulAIt
 * never revokes a vendor-side grant.
 *
 * Disclosure (the ADR-0082 and ADR-0092 discipline): a source whose read could not observe use, or observed it over a
 * shorter window than asked, is listed under the rule's `notAssessable` with the reason. It is never reported as
 * "unused".
 *
 * The usage window is anchored at the source's latest usage read, not at "now": "no use in the N days before the read
 * that looked" is what the evidence shows, however long ago that read ran (its time is on every finding).
 */
import { sql, type Db } from "@regulait/db";
import {
  SAAS_ENTITLEMENT_SOURCE_PLATFORM,
  SAAS_FINDING_RULES_V1,
  SAAS_FINDING_RULES_VERSION,
  SAAS_SCOPE_CLASSIFIER_VERSION,
  classifySaasScope,
  copilotStudioExposure,
  renderRecommendationRationale,
  type SaasEntitlementPlatform,
  type SaasFindingRule,
  type SaasFindingRuleId,
  type SaasScopeAccess,
  type SaasUsageCoverage,
} from "@regulait/shared";

const DAY = 86_400_000;
/** grants examined per report; past this the report says so (`scanTruncated`) rather than reading without bound */
export const SAAS_FINDINGS_SCAN_MAX = 50_000;
export const SAAS_FINDINGS_PER_RULE_MAX = 1_000;

export interface SaasFindingSource {
  id: string;
  name: string;
  platform: SaasEntitlementPlatform | null;
  kind: string;
}

export interface SaasFinding {
  /** stable for the same rule and subject: rule + grant row, or rule + registry record */
  key: string;
  ruleId: SaasFindingRuleId;
  ruleVersion: number;
  rationale: string;
  source: SaasFindingSource;
  app: { id: string; externalId: string; displayName: string | null; agentId: string | null } | null;
  grant: { id: string; scope: string; resource: string; access: SaasScopeAccess; accessReason: string; grantType: string; consent: string } | null;
  agentRecord: { id: string; registry: string; externalId: string; displayName: string; agentId: string | null } | null;
  evidence: Record<string, string | number | boolean | null>;
  /** nothing here executes: the action is a person's, in the vendor's own console, decided through the approvals queue */
  action: { kind: "vendor-console"; note: string; raise: { method: "POST"; path: "/v1/discovery/entitlements/findings/reviews"; key: string } };
  /** the finding's latest review (slice 3b), when one was raised; set by the route, null otherwise */
  review?: { id: string; status: string; decidedAt: string | null } | null;
}

export interface SaasNotAssessable {
  source: SaasFindingSource;
  reason: string;
}

export interface SaasFindingRuleReport {
  id: SaasFindingRuleId;
  title: string;
  severity: string;
  limits: string;
  count: number;
  /** true when more findings exist than `findings` holds (the count is still exact) */
  truncated: boolean;
  findings: SaasFinding[];
  notAssessable: SaasNotAssessable[];
}

export interface SaasFindingsReport {
  rulesVersion: number;
  classifierVersion: number;
  windowDays: number;
  computedAt: string;
  /** true when the graph held more grants than one report examines; the findings then cover the first part only */
  scanTruncated: boolean;
  rules: SaasFindingRuleReport[];
}

interface GrantRow {
  grant_id: string;
  grant_type: string;
  consent: string;
  grant_first_seen: Date;
  app_id: string;
  external_id: string;
  display_name: string | null;
  publisher: string | null;
  publisher_verified: boolean | null;
  agent_id: string | null;
  scope: string;
  resource: string;
  source_id: string;
  source_name: string;
  kind: string;
  last_use_at: Date | null;
  last_read_at: Date | null;
  last_write_at: Date | null;
  coverage: SaasUsageCoverage | null;
  window_start: Date | null;
  recorded_at: Date | null;
  note: string | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const days = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / DAY));
const platformOf = (kind: string): SaasEntitlementPlatform | null =>
  Object.hasOwn(SAAS_ENTITLEMENT_SOURCE_PLATFORM, kind) ? SAAS_ENTITLEMENT_SOURCE_PLATFORM[kind as keyof typeof SAAS_ENTITLEMENT_SOURCE_PLATFORM] : null;
const PLATFORM_WORD: Record<SaasEntitlementPlatform, string> = { m365: "Microsoft 365", google_workspace: "Google Workspace", salesforce: "Salesforce", slack: "Slack" };
const VENDOR_ACTION =
  "RegulAIt never revokes a vendor-side grant: review it with the app's owner, then remove or narrow it in the vendor's admin console (the next read shows the change)";

/**
 * Whether a source's usage read lets a usage rule judge this window: the coverage it needs, and a read that looked at
 * least `windowDays` back. Returns the reason when it does not.
 */
function usageProblem(r: Pick<GrantRow, "coverage" | "window_start" | "recorded_at" | "note">, need: "app" | "verb", windowDays: number): string | null {
  if (!r.coverage || !r.recorded_at) return "no read of this source has recorded usage yet";
  if (r.coverage === "none") return r.note ?? "the latest read could not observe use";
  if (need === "verb" && r.coverage !== "verb") return "the platform's usage source does not tell reads from writes (coverage: per app only)";
  if (r.window_start && new Date(r.recorded_at).getTime() - new Date(r.window_start).getTime() < windowDays * DAY) {
    return `the latest usage read covers only ${days(r.window_start, new Date(r.recorded_at))} days, shorter than the ${windowDays}-day window`;
  }
  return null;
}

/** compute every V1 rule; reads only, writes nothing */
export async function computeSaasFindings(db: Db, opts: { windowDays: number; perRule?: number; now?: Date; key?: string }): Promise<SaasFindingsReport> {
  const now = opts.now ?? new Date();
  const perRule = Math.min(opts.perRule ?? SAAS_FINDINGS_PER_RULE_MAX, SAAS_FINDINGS_PER_RULE_MAX);
  const windowDays = opts.windowDays;
  const kinds = Object.keys(SAAS_ENTITLEMENT_SOURCE_PLATFORM);

  const res = await db.execute(sql`
    SELECT g.id AS grant_id, g.grant_type, g.consent, g.first_seen_at AS grant_first_seen,
           a.id AS app_id, a.external_id, a.display_name, a.publisher, a.publisher_verified, a.agent_id,
           sc.name AS scope, sc.resource,
           s.id AS source_id, s.name AS source_name, s.kind,
           u.last_use_at, u.last_read_at, u.last_write_at,
           r.coverage, r.window_start, r.recorded_at, r.note
      FROM saas_entitlement_grants g
      JOIN saas_entitlement_apps a ON a.id = g.app_id
      JOIN saas_entitlement_scopes sc ON sc.id = g.scope_id
      JOIN discovery_sources s ON s.id = a.source_id
      LEFT JOIN saas_entitlement_app_usage u ON u.app_id = a.id
      LEFT JOIN saas_entitlement_usage_reads r ON r.source_id = s.id
     WHERE s.kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})
     ORDER BY s.name, s.id, a.external_id, sc.resource, sc.name, g.grant_type
     LIMIT ${SAAS_FINDINGS_SCAN_MAX + 1}`);
  const rows = res.rows as unknown as GrantRow[];
  const scanTruncated = rows.length > SAAS_FINDINGS_SCAN_MAX;
  if (scanTruncated) rows.length = SAAS_FINDINGS_SCAN_MAX;

  const rule = (id: SaasFindingRuleId): SaasFindingRule => SAAS_FINDING_RULES_V1.find((r) => r.id === id)!;
  const reports = new Map<SaasFindingRuleId, SaasFindingRuleReport>(
    SAAS_FINDING_RULES_V1.map((r) => [r.id, { id: r.id, title: r.title, severity: r.severity, limits: r.limits, count: 0, truncated: false, findings: [], notAssessable: [] }]),
  );
  const add = (f: Omit<SaasFinding, "ruleVersion" | "rationale" | "action">, params: Record<string, string | number>) => {
    const rep = reports.get(f.ruleId)!;
    rep.count += 1;
    // one finding asked for by key (raising a review): every other finding is counted, not kept
    if (opts.key !== undefined && f.key !== opts.key) return;
    if (rep.findings.length >= perRule) {
      rep.truncated = true;
      return;
    }
    rep.findings.push({ ...f, ruleVersion: SAAS_FINDING_RULES_VERSION, rationale: renderRecommendationRationale(rule(f.ruleId), params), action: { kind: "vendor-console", note: VENDOR_ACTION, raise: { method: "POST", path: "/v1/discovery/entitlements/findings/reviews", key: f.key } } });
  };
  // one not-assessable entry per rule and source
  const notAssessed = new Map<string, true>();
  const notAssessable = (ruleId: SaasFindingRuleId, source: SaasFindingSource, reason: string) => {
    const k = `${ruleId}\u0000${source.id}`;
    if (notAssessed.has(k)) return;
    notAssessed.set(k, true);
    reports.get(ruleId)!.notAssessable.push({ source, reason });
  };

  for (const r of rows) {
    const platform = platformOf(r.kind);
    if (!platform) continue;
    const source: SaasFindingSource = { id: r.source_id, name: r.source_name, platform, kind: r.kind };
    const cls = classifySaasScope(platform, r.scope);
    const appRef = { id: r.app_id, externalId: r.external_id, displayName: r.display_name, agentId: r.agent_id };
    const grantRef = { id: r.grant_id, scope: r.scope, resource: r.resource, access: cls.access, accessReason: cls.reason, grantType: r.grant_type, consent: r.consent };
    const appName = r.display_name ?? r.external_id;
    const base = { source, app: appRef, grant: grantRef, agentRecord: null };
    const readAt = r.recorded_at ? new Date(r.recorded_at) : null;
    const cutoff = readAt ? new Date(readAt.getTime() - windowDays * DAY) : null;
    const oldEnough = cutoff !== null && new Date(r.grant_first_seen).getTime() <= cutoff.getTime();
    const usageEvidence = {
      usageCoverage: r.coverage ?? "none",
      usageReadAt: iso(readAt),
      usageWindowStart: iso(r.window_start),
      windowDays,
      grantFirstSeenAt: iso(r.grant_first_seen),
      lastUseAt: iso(r.last_use_at),
    };

    // unused-grant: an app with no observed use in the window, holding a grant old enough to judge
    const unusedProblem = usageProblem(r, "app", windowDays);
    if (unusedProblem) notAssessable("unused-grant", source, unusedProblem);
    else if (oldEnough && (!r.last_use_at || new Date(r.last_use_at).getTime() < cutoff!.getTime())) {
      add(
        { ...base, key: `unused-grant:grant:${r.grant_id}`, ruleId: "unused-grant", evidence: { ...usageEvidence, access: cls.access } },
        {
          app: appName,
          scope: r.scope,
          access: cls.access,
          source: r.source_name,
          ageDays: days(r.grant_first_seen, readAt!),
          platform: PLATFORM_WORD[platform],
          windowDays,
          lastUse: iso(r.last_use_at) ?? "none in what the read could see",
        },
      );
    }

    // excessive-scope: a write, admin or unrecognised scope, held by an app that only read in the window
    if (cls.access !== "read") {
      const verbProblem = usageProblem(r, "verb", windowDays);
      if (verbProblem) notAssessable("excessive-scope", source, verbProblem);
      else if (
        oldEnough &&
        r.last_read_at &&
        new Date(r.last_read_at).getTime() >= cutoff!.getTime() &&
        (!r.last_write_at || new Date(r.last_write_at).getTime() < cutoff!.getTime())
      ) {
        add(
          {
            ...base,
            key: `excessive-scope:grant:${r.grant_id}`,
            ruleId: "excessive-scope",
            evidence: { ...usageEvidence, access: cls.access, lastReadAt: iso(r.last_read_at), lastWriteAt: iso(r.last_write_at) },
          },
          {
            app: appName,
            scope: r.scope,
            access: cls.access,
            reason: cls.reason,
            source: r.source_name,
            platform: PLATFORM_WORD[platform],
            windowDays,
            lastRead: iso(r.last_read_at)!,
            lastWrite: iso(r.last_write_at) ?? "none in what the read could see",
          },
        );
      }
    }

    // oversharing: a tenant-wide consent to anything but a read
    if (r.consent === "tenant" && cls.access !== "read") {
      const publisher =
        r.publisher_verified === true ? `${r.publisher ?? "named"} (verified)` : r.publisher_verified === false ? `${r.publisher ?? "unnamed"} (NOT verified)` : r.publisher ? `${r.publisher} (verification not stated)` : "not stated";
      add(
        { ...base, key: `oversharing:grant:${r.grant_id}`, ruleId: "oversharing", evidence: { access: cls.access, consent: r.consent, grantType: r.grant_type, publisher: r.publisher, publisherVerified: r.publisher_verified } },
        { app: appName, scope: r.scope, access: cls.access, reason: cls.reason, source: r.source_name, publisher },
      );
    }
  }

  // publicly-exposed-agent: Copilot Studio records carry the audience; the other registries do not
  const recs = await db.execute(sql`
    SELECT rec.id, rec.registry, rec.external_id, rec.display_name, rec.vendor_attributes, rec.agent_id,
           s.id AS source_id, s.name AS source_name, s.kind
      FROM agent_registry_records rec
      JOIN discovery_sources s ON s.id = rec.source_id
     WHERE rec.absent_since IS NULL
     ORDER BY s.name, s.id, rec.external_id
     LIMIT ${SAAS_FINDINGS_SCAN_MAX}`);
  for (const rec of recs.rows as Array<{ id: string; registry: string; external_id: string; display_name: string; vendor_attributes: Record<string, unknown>; agent_id: string | null; source_id: string; source_name: string; kind: string }>) {
    const source: SaasFindingSource = { id: rec.source_id, name: rec.source_name, platform: null, kind: rec.kind };
    if (rec.registry !== "copilot_studio") {
      notAssessable("publicly-exposed-agent", source, `the ${rec.registry} registry reader records no publication audience`);
      continue;
    }
    const exposed = copilotStudioExposure(rec.vendor_attributes ?? {});
    if (!exposed) continue;
    add(
      {
        key: `publicly-exposed-agent:record:${rec.id}`,
        ruleId: "publicly-exposed-agent",
        source,
        app: null,
        grant: null,
        agentRecord: { id: rec.id, registry: rec.registry, externalId: rec.external_id, displayName: rec.display_name, agentId: rec.agent_id },
        evidence: {
          authenticationMode: typeof rec.vendor_attributes?.authenticationMode === "string" ? rec.vendor_attributes.authenticationMode : null,
          accessControlPolicy: typeof rec.vendor_attributes?.accessControlPolicy === "string" ? rec.vendor_attributes.accessControlPolicy : null,
          publishedOn: typeof rec.vendor_attributes?.publishedOn === "string" ? rec.vendor_attributes.publishedOn : null,
        },
      },
      { agent: rec.display_name, source: rec.source_name, exposure: exposed.exposure, audience: exposed.audience },
    );
  }

  return {
    rulesVersion: SAAS_FINDING_RULES_VERSION,
    classifierVersion: SAAS_SCOPE_CLASSIFIER_VERSION,
    windowDays,
    computedAt: now.toISOString(),
    scanTruncated,
    rules: [...reports.values()],
  };
}
