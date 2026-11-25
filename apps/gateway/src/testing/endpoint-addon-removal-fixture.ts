/**
 * ADR-0331 test fixture: an enrolled endpoint agent (a discovery source, an enrolment token, a ticket and a DPoP-bound
 * registration, as a real agent makes them) and MCP server evidence as an accepted report leaves it. Shared by the
 * ADR-0331 suite and the external-effects barrier matrix, so both drive the same agent routes the same way.
 */
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { discoverySources, endpointAgentReports, endpointMcpServers, eq, type Db } from "@regulait/db";
import type { buildApp } from "../app.js";
import { endpointAgentKeys } from "./endpoint-agent-client.js";

type App = ReturnType<typeof buildApp>;
type Keys = ReturnType<typeof endpointAgentKeys>;
export type EnrolledAgent = { sourceId: string; deviceId: string; identityId: string; key: Awaited<ReturnType<Keys["make"]>>; ticket: string };

let seq = 0;

/** enrol one endpoint agent through the real routes; the source is enabled directly (SD0's step-up route has its own suite) */
export async function enrolEndpointAgent(
  app: App,
  db: Db,
  keys: Keys,
  o: { auth: Record<string, string>; run: string; enabledBy: string; deviceUser?: string; sourceIds?: string[] },
): Promise<EnrolledAgent> {
  const inject = (method: "POST", url: string, headers: Record<string, string>, payload: unknown) => app.inject({ method, url, headers, payload: payload as object });
  const n = ++seq;
  const r = await inject("POST", "/v1/discovery/sources", o.auth, { name: `a331-agent-${o.run}-${n}`, kind: "endpoint_agent", target: { fleet: `fleet-${o.run}` }, scope: { orgLevel: true, include: [] } });
  expect(r.statusCode, r.body).toBe(201);
  const sourceId = r.json().id as string;
  o.sourceIds?.push(sourceId);
  await db.update(discoverySources).set({ enabled: true, enabledAt: new Date(), enabledBy: o.enabledBy }).where(eq(discoverySources.id, sourceId));
  const tok = await inject("POST", `/v1/discovery/sources/${sourceId}/enrolment-tokens`, o.auth, { label: `a331-${o.run}`, deviceCap: 5 });
  expect(tok.statusCode, tok.body).toBe(201);
  const t = await inject("POST", "/v1/endpoint-agent/enrolment-tickets", { authorization: `Bearer ${tok.json().enrolFile.token}` }, { hostname: `a331-host-${o.run}-${n}`, os: "linux", arch: "amd64", agentVersion: "0.1.0" });
  expect(t.statusCode, t.body).toBe(201);
  const key = await keys.make();
  const reg = await inject("POST", "/v1/endpoint-agent/register", { authorization: `Bearer ${t.json().ticket}` }, {
    publicJwk: key.jwk,
    keyProtection: "hardware",
    keyProvider: "tpm",
    agentVersion: "0.1.0",
    os: "linux",
    arch: "amd64",
    deviceUser: o.deviceUser ?? `a331user${o.run}`,
  });
  expect(reg.statusCode, reg.body).toBe(201);
  return { sourceId, deviceId: t.json().ticketId as string, identityId: reg.json().identityId as string, key, ticket: t.json().ticket as string };
}

/** a signed report of `a` as the ingest leaves it (refused status, so no ingest pass in another suite picks it up) */
export async function endpointReportOf(db: Db, a: Pick<EnrolledAgent, "identityId" | "deviceId" | "sourceId">): Promise<string> {
  const [r] = await db
    .insert(endpointAgentReports)
    .values({
      identityId: a.identityId,
      deviceId: a.deviceId,
      sourceId: a.sourceId,
      snapshotId: randomUUID(),
      collectedAt: new Date(),
      bodySha256: "a".repeat(64),
      factsDigest: "b".repeat(64),
      manifestVersion: "1.0.0",
      manifestDigest: "c".repeat(64),
      factsReceived: 0,
      factsEnvRefused: 0,
      factsUnmatched: 0,
      droppedSnapshots: 0,
      status: "refused",
      runId: randomUUID(),
      committedAt: new Date(),
    })
    .returning({ id: endpointAgentReports.id });
  return r!.id;
}

/** MCP server evidence as an accepted report leaves it (ADR-0259's table), written directly so each case is exact */
export async function seenMcpServer(
  db: Db,
  a: Pick<EnrolledAgent, "identityId" | "deviceId" | "sourceId">,
  o: { pkg: string; path: string; root?: string; serverName?: string; version?: string | null; daysAgo?: number; noReport?: boolean },
): Promise<void> {
  const at = new Date(Date.now() - (o.daysAgo ?? 0) * 86_400_000);
  await db.insert(endpointMcpServers).values({
    deviceId: a.deviceId,
    // the identity whose report last showed it; `noReport`: that report is gone
    lastReportId: o.noReport ? randomUUID() : await endpointReportOf(db, a),
    signatureId: "sig.a331.host",
    provider: "a331prov",
    configRoot: (o.root ?? "home") as "home",
    configPath: o.path,
    serverName: o.serverName ?? "flagged",
    transport: "stdio",
    command: "npx",
    package: o.pkg,
    packageVersion: o.version === undefined ? "1.2.3" : o.version,
    identityKind: "package",
    identity: o.pkg,
    firstSeenAt: at,
    lastSeenAt: at,
  });
}
