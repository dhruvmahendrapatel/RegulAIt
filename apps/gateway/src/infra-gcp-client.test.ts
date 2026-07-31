import { describe, expect, it } from "vitest";
import { buildGcpInfraLiveClient, type GcpInfraSdk } from "./infra-gcp-client.js";

/**
 * The REAL GCP infra live path — gateway wiring (Batch C breadth). Proves,
 * with fully fake SDK modules and never the network:
 *   · the factory is LAZY — no SDK module is loaded at construction, only on
 *     the first actual client call (flag-off gateways never touch
 *     @google-cloud/*);
 *   · openSession constructs the ADC-authenticated service clients once per
 *     opaque sessionId (credentials never leave the module);
 *   · every request carries the exact documented parent/name strings and every
 *     mapped field is the real SDK response field (osInfo, vulnerability
 *     details incl. protobuf Timestamp + enum-number normalization, cert
 *     managed/selfManaged oneof, Backup.state);
 *   · executePatchJob expands bare instance ids to zones/{zone}/instances/{id}
 *     and REFUSES bare ids with no zone;
 *   · triggerBackup/executePatchJob require a real name back — accepted with
 *     nothing is a throw, never a silent success.
 * Pure unit tests — no DB, no network, no real GCP.
 */

const PROJECT = "regulait-prod";
const ZONE = "us-central1-a";

interface Recorded {
  service: string;
  op: string;
  req: Record<string, unknown>;
}

function makeFakeSdk(respond: (service: string, op: string, req: Record<string, unknown>) => unknown) {
  const calls: Recorded[] = [];
  const constructed: string[] = [];
  const record = (service: string, op: string, req: Record<string, unknown>) => {
    calls.push({ service, op, req });
    return respond(service, op, req);
  };
  const sdk = {
    osConfig: {
      OsConfigZonalServiceClient: class {
        constructor() {
          constructed.push("zonal");
        }
        async listInventories(req: Record<string, unknown>) {
          return [record("zonal", "listInventories", req) ?? []];
        }
        async listVulnerabilityReports(req: Record<string, unknown>) {
          return [record("zonal", "listVulnerabilityReports", req) ?? []];
        }
      },
      OsConfigServiceClient: class {
        constructor() {
          constructed.push("osconfig");
        }
        async executePatchJob(req: Record<string, unknown>) {
          return [record("osconfig", "executePatchJob", req) ?? {}];
        }
      },
    },
    certificateManager: {
      CertificateManagerClient: class {
        constructor() {
          constructed.push("certs");
        }
        async listCertificates(req: Record<string, unknown>) {
          return [record("certs", "listCertificates", req) ?? []];
        }
      },
    },
    backupDr: {
      BackupDRClient: class {
        constructor() {
          constructed.push("backup");
        }
        async listBackups(req: Record<string, unknown>) {
          return [record("backup", "listBackups", req) ?? []];
        }
        async triggerBackup(req: Record<string, unknown>) {
          return [record("backup", "triggerBackup", req) ?? {}];
        }
      },
    },
  } as unknown as GcpInfraSdk;
  return { sdk, calls, constructed };
}

async function clientWithSession(
  respond: (service: string, op: string, req: Record<string, unknown>) => unknown,
) {
  const { sdk, calls, constructed } = makeFakeSdk(respond);
  const client = buildGcpInfraLiveClient(async () => sdk);
  const { sessionId } = await client.openSession({ projectId: PROJECT });
  return { client, calls, constructed, sessionId };
}

describe("buildGcpInfraLiveClient — lazy SDK loading + credential sessions", () => {
  it("never loads the SDK at factory-construction time, only on the first call, cached after", async () => {
    let loads = 0;
    const { sdk } = makeFakeSdk(() => []);
    const client = buildGcpInfraLiveClient(async () => {
      loads++;
      return sdk;
    });
    expect(loads).toBe(0); // constructing the client touched nothing
    await client.openSession({ projectId: PROJECT });
    expect(loads).toBe(1);
    await client.openSession({ projectId: PROJECT });
    expect(loads).toBe(1); // loaded once, cached
  });

  it("openSession constructs the four ADC service clients once; unknown sessionIds are a clear error", async () => {
    const { client, constructed, sessionId } = await clientWithSession(() => []);
    expect(constructed.sort()).toEqual(["backup", "certs", "osconfig", "zonal"]);
    await client.listInventories({ sessionId, projectId: PROJECT, zone: ZONE });
    await expect(
      client.listInventories({ sessionId: "never-opened", projectId: PROJECT, zone: ZONE }),
    ).rejects.toThrow(/unknown credential session/);
  });
});

describe("buildGcpInfraLiveClient — OS Config inventory + vulnerabilities", () => {
  it("listInventories uses the instances/- parent with view FULL and maps osInfo 1:1 (instanceId parsed from name)", async () => {
    const { client, calls, sessionId } = await clientWithSession((_s, op) =>
      op === "listInventories"
        ? [
            {
              name: `projects/${PROJECT}/locations/${ZONE}/instances/1234567890/inventory`,
              osInfo: {
                hostname: "web-1",
                longName: "Debian GNU/Linux 12 (bookworm)",
                shortName: "debian",
                version: "12",
                kernelVersion: "6.1.0-25",
                architecture: "x86_64",
                osconfigAgentVersion: "20260601.00",
              },
              updateTime: { seconds: 1785456000, nanos: 0 },
            },
          ]
        : [],
    );
    const out = await client.listInventories({ sessionId, projectId: PROJECT, zone: ZONE });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      instanceId: "1234567890",
      hostname: "web-1",
      osLongName: "Debian GNU/Linux 12 (bookworm)",
      kernelVersion: "6.1.0-25",
      osconfigAgentVersion: "20260601.00",
    });
    expect(out[0]!.updateTime).toBeInstanceOf(Date);
    expect(calls.find((c) => c.op === "listInventories")!.req).toEqual({
      parent: `projects/${PROJECT}/locations/${ZONE}/instances/-`,
      view: "FULL",
    });
  });

  it("listVulnerabilities flattens reports per (instance, vuln), maps real CVSS, normalizes enum numbers, derives fixAvailable", async () => {
    const { client, calls, sessionId } = await clientWithSession((_s, op) =>
      op === "listVulnerabilityReports"
        ? [
            {
              name: `projects/${PROJECT}/locations/${ZONE}/instances/111/vulnerabilityReport`,
              vulnerabilities: [
                {
                  details: {
                    cve: "CVE-2026-1111",
                    cvssV3: { baseScore: 9.8 },
                    severity: "CRITICAL",
                    description: "kernel bug",
                  },
                  availableInventoryItemIds: ["pkg-fixed"],
                  updateTime: "2026-07-29T00:00:00Z",
                },
                {
                  details: { cve: "CVE-2026-2222", severity: 2 }, // numeric enum → HIGH
                  items: [{ availableInventoryItemId: null }],
                },
              ],
            },
          ]
        : [],
    );
    const out = await client.listVulnerabilities({ sessionId, projectId: PROJECT, zone: ZONE });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      instanceId: "111",
      cve: "CVE-2026-1111",
      cvssBaseScore: 9.8,
      severity: "CRITICAL",
      fixAvailable: true,
    });
    expect(out[1]).toMatchObject({ cve: "CVE-2026-2222", severity: "HIGH", cvssBaseScore: null, fixAvailable: false });
    expect(calls.find((c) => c.op === "listVulnerabilityReports")!.req.parent).toBe(
      `projects/${PROJECT}/locations/${ZONE}/instances/-`,
    );
  });
});

describe("buildGcpInfraLiveClient — Certificate Manager + Backup and DR", () => {
  it("listCertificates maps expireTime (protobuf Timestamp) and the managed/selfManaged oneof", async () => {
    const { client, calls, sessionId } = await clientWithSession((_s, op) =>
      op === "listCertificates"
        ? [
            {
              name: `projects/${PROJECT}/locations/global/certificates/api-tls`,
              expireTime: { seconds: "1785456000" }, // string seconds (Long-ish)
              sanDnsnames: ["api.example.com"],
              managed: { state: "ACTIVE" },
            },
            {
              name: `projects/${PROJECT}/locations/global/certificates/uploaded`,
              selfManaged: {},
            },
          ]
        : [],
    );
    const out = await client.listCertificates({ sessionId, projectId: PROJECT, location: "global" });
    expect(out[0]).toMatchObject({
      name: `projects/${PROJECT}/locations/global/certificates/api-tls`,
      sanDnsnames: ["api.example.com"],
      managementType: "managed",
      managedState: "ACTIVE",
    });
    expect(out[0]!.expireTime).toBeInstanceOf(Date);
    expect(out[1]).toMatchObject({ managementType: "self_managed", expireTime: null });
    expect(calls.find((c) => c.op === "listCertificates")!.req.parent).toBe(
      `projects/${PROJECT}/locations/global`,
    );
  });

  it("listBackups uses the full vault/dataSource parent and normalizes Backup.state enum numbers", async () => {
    const { client, calls, sessionId } = await clientWithSession((_s, op) =>
      op === "listBackups"
        ? [
            { name: "b-1", state: "ACTIVE", consistencyTime: "2026-07-29T00:00:00Z" },
            { name: "b-2", state: 4 }, // numeric ERROR
          ]
        : [],
    );
    const out = await client.listBackups({
      sessionId,
      projectId: PROJECT,
      location: "us-central1",
      backupVault: "bv-prod",
      dataSource: "ds-vm-1",
    });
    expect(out[0]).toMatchObject({ name: "b-1", state: "ACTIVE" });
    expect(out[1]).toMatchObject({ name: "b-2", state: "ERROR" });
    expect(calls.find((c) => c.op === "listBackups")!.req.parent).toBe(
      `projects/${PROJECT}/locations/us-central1/backupVaults/bv-prod/dataSources/ds-vm-1`,
    );
  });

  it("triggerBackup names the backupPlanAssociation + ruleId and requires the LRO operation name back", async () => {
    const { client, calls, sessionId } = await clientWithSession((_s, op) =>
      op === "triggerBackup" ? { name: "operations/op-1" } : [],
    );
    const out = await client.triggerBackup({
      sessionId,
      projectId: PROJECT,
      location: "us-central1",
      backupPlanAssociation: "bpa-vm-1",
      ruleId: "daily-rule",
    });
    expect(out).toEqual({ operationName: "operations/op-1" });
    expect(calls.find((c) => c.op === "triggerBackup")!.req).toEqual({
      name: `projects/${PROJECT}/locations/us-central1/backupPlanAssociations/bpa-vm-1`,
      ruleId: "daily-rule",
    });

    const bare = await clientWithSession((_s, op) => (op === "triggerBackup" ? {} : []));
    await expect(
      bare.client.triggerBackup({
        sessionId: bare.sessionId,
        projectId: PROJECT,
        location: "l",
        backupPlanAssociation: "b",
        ruleId: "r",
      }),
    ).rejects.toThrow(/no operation name/);
  });
});

describe("buildGcpInfraLiveClient — executePatchJob instance-URI honesty", () => {
  it("expands bare instance ids with the zone; passes full paths through; requires PatchJob.name back", async () => {
    const { client, calls, sessionId } = await clientWithSession((_s, op) =>
      op === "executePatchJob" ? { name: `projects/${PROJECT}/patchJobs/pj-1` } : [],
    );
    const out = await client.executePatchJob({
      sessionId,
      projectId: PROJECT,
      zone: ZONE,
      instances: ["111", `projects/${PROJECT}/zones/${ZONE}/instances/222`],
    });
    expect(out).toEqual({ patchJobName: `projects/${PROJECT}/patchJobs/pj-1` });
    const req = calls.find((c) => c.op === "executePatchJob")!.req;
    expect(req.parent).toBe(`projects/${PROJECT}`);
    expect((req.instanceFilter as { instances: string[] }).instances).toEqual([
      `zones/${ZONE}/instances/111`,
      `projects/${PROJECT}/zones/${ZONE}/instances/222`,
    ]);
  });

  it("a bare id with no zone is refused before any call; a nameless PatchJob is an unconfirmed run", async () => {
    const { client, calls, sessionId } = await clientWithSession((_s, op) =>
      op === "executePatchJob" ? {} : [],
    );
    await expect(
      client.executePatchJob({ sessionId, projectId: PROJECT, zone: null, instances: ["111"] }),
    ).rejects.toThrow(/no zone was provided/);
    expect(calls.some((c) => c.op === "executePatchJob")).toBe(false);
    await expect(
      client.executePatchJob({
        sessionId,
        projectId: PROJECT,
        zone: ZONE,
        instances: ["111"],
      }),
    ).rejects.toThrow(/no PatchJob.name/);
  });
});
