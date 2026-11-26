/**
 * ADR-0351 slice 3 — the fleet-wide checks behind the `endpoint_benchmark_check` evidence collector.
 *
 * Each check is ONE read-only query over a ledger the endpoint agent (ADR-0298, ADR-0259, ADR-0332) or the MCP
 * definition pins (ADR-0246) already keep. A check answers 1 (pass) or 0 (fail). It fails when no unrevoked device is
 * enrolled, so an empty fleet never reads as hardened. "Recent" is the last 30 days by the database clock, and a
 * disabled MCP server entry is out of scope for the MCP checks. Nothing here writes.
 *
 * THE STATE WHEN THE REPORT IS GENERATED. The ledgers keep each device's and server's latest state, not its history,
 * so every window is measured back from now, not from the report's period end; the pack's evidence text says so.
 */

/** the registry admission states that count as admitted for 2.4: a scan verdict of clean, an audited admin clearance,
 * or a server that predates the scanner. `held` is refused by the gateway, and `unscanned` has no verdict yet, so
 * neither is evidence of admission (ADR-0180: fail closed) */
export const ENDPOINT_BENCHMARK_ADMITTED_STATES = ["clean", "cleared", "grandfathered"] as const;
import {
  and,
  count,
  endpointAddonSightings,
  endpointAddonSightingSecretTypes,
  endpointAgentIdentities,
  endpointDevices,
  endpointMcpServerLinks,
  endpointMcpServers,
  eq,
  isNull,
  mcpDefinitionPins,
  mcpServers,
  sql,
  type Db,
} from "@regulait/db";
import type { EndpointBenchmarkCheck } from "@regulait/shared";

export const ENDPOINT_BENCHMARK_RECENT_DAYS = 30;
export const ENDPOINT_BENCHMARK_REPORTING_DAYS = 7;

const recent = (col: unknown) => sql`${col} >= now() - make_interval(days => ${ENDPOINT_BENCHMARK_RECENT_DAYS})`;
const liveDevice = isNull(endpointDevices.revokedAt);

/** the enabled MCP server entries seen recently on an unrevoked device, narrowed by `extra` */
async function recentMcpServers(db: Db, extra: ReturnType<typeof sql>): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(endpointMcpServers)
    .innerJoin(endpointDevices, eq(endpointDevices.id, endpointMcpServers.deviceId))
    .where(and(liveDevice, eq(endpointMcpServers.disabled, false), recent(endpointMcpServers.lastSeenAt), extra));
  return r?.n ?? 0;
}

/** 1 when the named check passes over at least one enrolled, unrevoked device; 0 otherwise */
export async function runEndpointBenchmarkCheck(db: Db, check: EndpointBenchmarkCheck): Promise<number> {
  const [fleet] = await db.select({ n: count() }).from(endpointDevices).where(liveDevice);
  if (!fleet || fleet.n === 0) return 0;
  const none = (n: number) => (n === 0 ? 1 : 0);

  switch (check) {
    case "devices_reporting_7d": {
      const [stale] = await db
        .select({ n: count() })
        .from(endpointDevices)
        .where(
          and(
            liveDevice,
            sql`(${endpointDevices.lastReportAt} IS NULL OR ${endpointDevices.lastReportAt} < now() - make_interval(days => ${ENDPOINT_BENCHMARK_REPORTING_DAYS}))`,
          ),
        );
      return none(stale?.n ?? 0);
    }
    case "agent_keys_hardware": {
      const rows = await db
        .select({ protection: endpointAgentIdentities.keyProtection, n: count() })
        .from(endpointAgentIdentities)
        .innerJoin(endpointDevices, eq(endpointDevices.id, endpointAgentIdentities.deviceId))
        .where(liveDevice)
        .groupBy(endpointAgentIdentities.keyProtection);
      const total = rows.reduce((n, r) => n + r.n, 0);
      const software = rows.filter((r) => r.protection !== "hardware").reduce((n, r) => n + r.n, 0);
      return total > 0 && software === 0 ? 1 : 0;
    }
    case "mcp_no_auto_approved_tools":
      return none(await recentMcpServers(db, sql`${endpointMcpServers.autoApprovedTools} > 0`));
    case "mcp_no_inline_secrets":
      return none(await recentMcpServers(db, sql`cardinality(${endpointMcpServers.secretTypes}) > 0`));
    case "mcp_no_risky_servers":
      return none(await recentMcpServers(db, sql`cardinality(${endpointMcpServers.risks}) > 0`));
    case "mcp_servers_registered":
      // an entry with no usable identity cannot be linked, so it counts as unregistered; so does one linked only to a
      // registry server that is disabled or not admitted (held, or not yet scanned)
      return none(
        await recentMcpServers(
          db,
          sql`(${endpointMcpServers.identityKind} = 'unknown' OR NOT EXISTS (
            SELECT 1 FROM ${endpointMcpServerLinks}
            INNER JOIN ${mcpServers} ON ${mcpServers.id} = ${endpointMcpServerLinks.mcpServerId}
            WHERE ${endpointMcpServerLinks.identityKind} = ${endpointMcpServers.identityKind}
              AND ${endpointMcpServerLinks.identity} = ${endpointMcpServers.identity}
              AND ${mcpServers.disabledAt} IS NULL
              AND ${mcpServers.admissionState} IN (${sql.join(
                ENDPOINT_BENCHMARK_ADMITTED_STATES.map((s) => sql`${s}`),
                sql`, `,
              )})))`,
        ),
      );
    case "addons_no_secrets": {
      const [r] = await db
        .select({ n: count() })
        .from(endpointAddonSightingSecretTypes)
        .innerJoin(endpointAddonSightings, eq(endpointAddonSightings.id, endpointAddonSightingSecretTypes.sightingId))
        .innerJoin(endpointDevices, eq(endpointDevices.id, endpointAddonSightings.deviceId))
        .where(and(liveDevice, recent(endpointAddonSightings.lastSeenAt)));
      return none(r?.n ?? 0);
    }
    case "mcp_definitions_unchanged": {
      // only pins of servers in use: a disabled server's stale pin is not a definition anything runs
      const [r] = await db
        .select({
          pinned: count(),
          drifted: sql<number>`count(*) FILTER (WHERE ${mcpDefinitionPins.approvedDigest} IS NULL OR (${mcpDefinitionPins.observedDigest} IS NOT NULL AND ${mcpDefinitionPins.observedDigest} <> ${mcpDefinitionPins.approvedDigest}))`.mapWith(Number),
        })
        .from(mcpDefinitionPins)
        .innerJoin(mcpServers, eq(mcpServers.id, mcpDefinitionPins.serverId))
        .where(isNull(mcpServers.disabledAt));
      return (r?.pinned ?? 0) > 0 && (r?.drifted ?? 0) === 0 ? 1 : 0;
    }
    default: {
      // a check this build does not know is a hard failure, never a silent pass or zero (as an unknown collector is)
      throw new Error(`unknown endpoint benchmark check '${check as string}'`);
    }
  }
}
