import { describe, expect, it } from "vitest";
import { buildAzureInfraLiveClient, type AzureInfraSdk } from "./infra-azure-client.js";

/**
 * The REAL Azure infra live path — gateway wiring (Batch C breadth). Proves,
 * with fully fake SDK modules and never the network:
 *   · the factory is LAZY — no SDK module is loaded at construction, only on
 *     the first actual client call (flag-off gateways never touch @azure/*);
 *   · openSession holds ONE DefaultAzureCredential per opaque sessionId and
 *     every per-call service client is constructed against it (never exposed);
 *   · Resource Graph queries carry the exact KQL + subscription scoping and
 *     paginate through skipToken;
 *   · every mapped field is the real projected column / SDK response field
 *     (VM instance-view, patch assessment counters incl. the Windows merged
 *     counter fallback, softwarepatches normalization, Key Vault cert
 *     properties+policy, statusless recovery points);
 *   · installPatches picks the right windows/linuxParameters oneof (looking
 *     the VM up when osType is unknown) and REFUSES to guess;
 *   · triggerBackup requires a job/operation id back — accepted-with-no-id
 *     throws, never a silent success.
 * Pure unit tests — no DB, no network, no real Azure.
 */

const SUB = "00000000-1111-2222-3333-444444444444";
const VAULT_URL = "https://regulait-vault.vault.azure.net";

interface Recorded {
  service: string;
  op: string;
  args: unknown[];
}

function makeFakeSdk(respond: (service: string, op: string, args: unknown[]) => unknown) {
  const calls: Recorded[] = [];
  const constructed: Array<{ service: string; args: unknown[] }> = [];
  const record = (service: string, op: string, args: unknown[]) => {
    calls.push({ service, op, args });
    return respond(service, op, args);
  };
  async function* iterate(items: unknown): AsyncIterable<Record<string, unknown>> {
    for (const item of (items as Record<string, unknown>[]) ?? []) yield item;
  }
  const sdk = {
    identity: {
      DefaultAzureCredential: class {
        readonly __kind = "default-azure-credential";
      },
    },
    resourceGraph: {
      ResourceGraphClient: class {
        constructor(readonly credential: unknown) {
          constructed.push({ service: "resourceGraph", args: [credential] });
        }
        async resources(query: unknown) {
          return record("resourceGraph", "resources", [query]) as {
            data?: unknown;
            skipToken?: string | null;
          };
        }
      },
    },
    keyvaultCertificates: {
      CertificateClient: class {
        constructor(
          readonly vaultUrl: string,
          readonly credential: unknown,
        ) {
          constructed.push({ service: "keyvault", args: [vaultUrl, credential] });
        }
        listPropertiesOfCertificates() {
          return iterate(record("keyvault", "listPropertiesOfCertificates", []));
        }
        async getCertificate(name: string) {
          return record("keyvault", "getCertificate", [name]) as Record<string, unknown>;
        }
        async getCertificatePolicy(name: string) {
          return record("keyvault", "getCertificatePolicy", [name]) as Record<string, unknown>;
        }
        async beginCreateCertificate(name: string, policy: Record<string, unknown>) {
          return record("keyvault", "beginCreateCertificate", [name, policy]);
        }
      },
    },
    recoveryServicesBackup: {
      RecoveryServicesBackupClient: class {
        recoveryPoints = {
          list: (...args: unknown[]) => iterate(record("recovery", "recoveryPoints.list", args)),
        };
        backups = {
          trigger: async (...args: unknown[]) => {
            const options = args[6] as
              | { onResponse?: (raw: { headers: { get(n: string): string | null } }) => void }
              | undefined;
            const resp = record("recovery", "backups.trigger", args) as {
              headers?: Record<string, string>;
            } | undefined;
            const headers = resp?.headers ?? {};
            options?.onResponse?.({
              headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
            });
          },
        };
        constructor(
          readonly credential: unknown,
          readonly subscriptionId: string,
        ) {
          constructed.push({ service: "recovery", args: [credential, subscriptionId] });
        }
      },
    },
    compute: {
      ComputeManagementClient: class {
        virtualMachines = {
          get: async (...args: unknown[]) =>
            record("compute", "virtualMachines.get", args) as Record<string, unknown>,
          beginInstallPatches: async (...args: unknown[]) => {
            const result = record("compute", "virtualMachines.beginInstallPatches", args);
            return { pollUntilDone: async () => result as Record<string, unknown> };
          },
        };
        constructor(
          readonly credential: unknown,
          readonly subscriptionId: string,
        ) {
          constructed.push({ service: "compute", args: [credential, subscriptionId] });
        }
      },
    },
  } as unknown as AzureInfraSdk;
  return { sdk, calls, constructed };
}

async function clientWithSession(
  respond: (service: string, op: string, args: unknown[]) => unknown,
) {
  const { sdk, calls, constructed } = makeFakeSdk(respond);
  const client = buildAzureInfraLiveClient(async () => sdk);
  const { sessionId } = await client.openSession({ subscriptionId: SUB });
  return { client, calls, constructed, sessionId };
}

describe("buildAzureInfraLiveClient — lazy SDK loading + credential sessions", () => {
  it("never loads the SDK at factory-construction time, only on the first call, cached after", async () => {
    let loads = 0;
    const { sdk } = makeFakeSdk(() => ({}));
    const client = buildAzureInfraLiveClient(async () => {
      loads++;
      return sdk;
    });
    expect(loads).toBe(0); // constructing the client touched nothing
    await client.openSession({ subscriptionId: SUB });
    expect(loads).toBe(1);
    await client.openSession({ subscriptionId: SUB });
    expect(loads).toBe(1); // loaded once, cached
  });

  it("an unknown sessionId is a clear error — no call runs without openSession first", async () => {
    const { client } = await clientWithSession(() => ({}));
    await expect(
      client.listVirtualMachines({ sessionId: "never-opened", subscriptionId: SUB }),
    ).rejects.toThrow(/unknown credential session/);
  });

  it("the held DefaultAzureCredential is threaded into every service client, never exposed", async () => {
    const { client, constructed, sessionId } = await clientWithSession((service, op) =>
      op === "resources" ? { data: [] } : [],
    );
    await client.listVirtualMachines({ sessionId, subscriptionId: SUB });
    await client.listKeyVaultCertificates({ sessionId, vaultUrl: VAULT_URL });
    const rg = constructed.find((c) => c.service === "resourceGraph")!;
    const kv = constructed.find((c) => c.service === "keyvault")!;
    expect(rec(rg.args[0]).__kind).toBe("default-azure-credential");
    expect(kv.args[0]).toBe(VAULT_URL);
    expect(rec(kv.args[1]).__kind).toBe("default-azure-credential");
  });
});

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

describe("buildAzureInfraLiveClient — Resource Graph queries", () => {
  it("listVirtualMachines scopes by subscription (+resource group), paginates skipToken, maps projected columns 1:1", async () => {
    let page = 0;
    const { client, calls, sessionId } = await clientWithSession((_s, op) => {
      if (op !== "resources") return [];
      page++;
      return page === 1
        ? {
            data: [
              {
                id: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-1",
                name: "vm-1",
                location: "eastus",
                powerState: "PowerState/running",
                provisioningState: "Succeeded",
                vmSize: "Standard_D2s_v5",
                osType: "Linux",
                osName: "ubuntu",
                osVersion: "24.04",
              },
            ],
            skipToken: "t2",
          }
        : { data: [{ id: "/x/virtualMachines/vm-2", name: "vm-2" }] };
    });
    const vms = await client.listVirtualMachines({
      sessionId,
      subscriptionId: SUB,
      resourceGroup: "rg-prod",
    });
    expect(vms.map((v) => v.name)).toEqual(["vm-1", "vm-2"]);
    expect(vms[0]).toMatchObject({
      powerState: "PowerState/running",
      provisioningState: "Succeeded",
      vmSize: "Standard_D2s_v5",
      osType: "Linux",
    });
    const [first, second] = calls.filter((c) => c.op === "resources");
    const q1 = rec(first!.args[0]);
    expect(q1.subscriptions).toEqual([SUB]);
    expect(String(q1.query)).toContain("microsoft.compute/virtualmachines");
    expect(String(q1.query)).toContain("resourceGroup =~ 'rg-prod'");
    expect(rec(rec(second!.args[0]).options).skipToken).toBe("t2");
  });

  it("listPatchAssessments maps availablePatchCountByClassification, falling back to the Windows merged counter", async () => {
    const vmId =
      "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-1";
    const { client, sessionId } = await clientWithSession((_s, op) =>
      op === "resources"
        ? {
            data: [
              {
                id: `${vmId}/patchAssessmentResults/latest`,
                properties: {
                  status: "Succeeded",
                  rebootPending: false,
                  availablePatchCountByClassification: { critical: 1, security: 2, other: 3 },
                  lastModifiedDateTime: "2026-07-29T00:00:00Z",
                },
              },
              {
                id: `${vmId.replace("vm-1", "vm-2")}/patchAssessmentResults/latest`,
                properties: {
                  status: "Succeeded",
                  criticalAndSecurityPatchCount: 4, // Windows merged counter
                  otherPatchCount: 1,
                },
              },
            ],
          }
        : [],
    );
    const out = await client.listPatchAssessments({ sessionId, subscriptionId: SUB });
    expect(out[0]).toMatchObject({
      vmName: "vm-1",
      vmId,
      criticalPatchCount: 1,
      securityPatchCount: 2,
      otherPatchCount: 3,
    });
    // the merged Windows counter maps into the security bucket when no split exists
    expect(out[1]).toMatchObject({
      vmName: "vm-2",
      criticalPatchCount: null,
      securityPatchCount: 4,
      otherPatchCount: 1,
    });
  });

  it("listMissingPatches scopes to the VM id and normalizes classifications/cveNumbers (string or array)", async () => {
    const vmId =
      "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-1";
    const { client, calls, sessionId } = await clientWithSession((_s, op) =>
      op === "resources"
        ? {
            data: [
              {
                id: `${vmId}/patchAssessmentResults/latest/softwarePatches/p1`,
                properties: {
                  patchName: "2026-07 Cumulative Update",
                  kbId: "KB5044444",
                  classifications: "Security", // single string form
                  msrcSeverity: "Important",
                  cveNumbers: ["CVE-2026-1", "CVE-2026-2"],
                  rebootBehavior: "CanRequestReboot",
                },
              },
            ],
          }
        : [],
    );
    const out = await client.listMissingPatches({ sessionId, subscriptionId: SUB, vmId });
    expect(out).toEqual([
      {
        patchName: "2026-07 Cumulative Update",
        version: null,
        kbId: "KB5044444",
        classifications: ["Security"],
        msrcSeverity: "Important",
        cveNumbers: ["CVE-2026-1", "CVE-2026-2"],
        publishedDate: null,
        rebootBehavior: "CanRequestReboot",
      },
    ]);
    const q = rec(calls.find((c) => c.op === "resources")!.args[0]);
    expect(String(q.query)).toContain("softwarepatches");
    expect(String(q.query).toLowerCase()).toContain(vmId.toLowerCase());
  });
});

describe("buildAzureInfraLiveClient — Key Vault certificates", () => {
  it("lists properties then maps getCertificate's properties+policy 1:1 (thumbprint hex-rendered)", async () => {
    const { client, sessionId } = await clientWithSession((_s, op) => {
      if (op === "listPropertiesOfCertificates") {
        return [{ name: "api-tls", id: `${VAULT_URL}/certificates/api-tls`, enabled: true }];
      }
      if (op === "getCertificate") {
        return {
          name: "api-tls",
          properties: {
            id: `${VAULT_URL}/certificates/api-tls`,
            enabled: true,
            expiresOn: new Date("2026-08-10T00:00:00Z"),
            x509Thumbprint: new Uint8Array([0xab, 0xcd]),
          },
          policy: { subject: "CN=api.example.com", issuerName: "Self" },
        };
      }
      return [];
    });
    const list = await client.listKeyVaultCertificates({ sessionId, vaultUrl: VAULT_URL });
    expect(list).toEqual([
      { name: "api-tls", id: `${VAULT_URL}/certificates/api-tls`, enabled: true, expiresOn: null },
    ]);
    const cert = await client.getKeyVaultCertificate({ sessionId, vaultUrl: VAULT_URL, name: "api-tls" });
    expect(cert).toMatchObject({
      name: "api-tls",
      subject: "CN=api.example.com",
      issuerName: "Self",
      thumbprint: "ABCD",
    });
    expect(cert.expiresOn).toBeInstanceOf(Date);
  });

  it("renewKeyVaultCertificate re-issues on the EXISTING policy (getCertificatePolicy → beginCreateCertificate)", async () => {
    const policy = { issuerName: "Self", subject: "CN=api.example.com" };
    const { client, calls, sessionId } = await clientWithSession((_s, op) =>
      op === "getCertificatePolicy" ? policy : [],
    );
    await client.renewKeyVaultCertificate({ sessionId, vaultUrl: VAULT_URL, name: "api-tls" });
    const begin = calls.find((c) => c.op === "beginCreateCertificate")!;
    expect(begin.args[0]).toBe("api-tls");
    expect(begin.args[1]).toEqual(policy); // the SAME policy — a renewal, not a new cert
  });
});

describe("buildAzureInfraLiveClient — Recovery Services", () => {
  it("listRecoveryPoints drives fabric 'Azure' with the full vault/container/item path and maps statusless points", async () => {
    const { client, calls, sessionId } = await clientWithSession((_s, op) =>
      op === "recoveryPoints.list"
        ? [
            {
              name: "rp-1",
              properties: { recoveryPointTime: "2026-07-29T00:00:00Z", recoveryPointType: "AppConsistent" },
            },
          ]
        : [],
    );
    const out = await client.listRecoveryPoints({
      sessionId,
      subscriptionId: SUB,
      resourceGroup: "rg-prod",
      vaultName: "rsv-prod",
      containerName: "iaasvmcontainer;vm-1",
      protectedItemName: "vm;vm-1",
    });
    expect(out).toEqual([
      { recoveryPointId: "rp-1", recoveryPointTime: "2026-07-29T00:00:00Z", recoveryPointType: "AppConsistent" },
    ]);
    expect(calls.find((c) => c.op === "recoveryPoints.list")!.args).toEqual([
      "rsv-prod",
      "rg-prod",
      "Azure",
      "iaasvmcontainer;vm-1",
      "vm;vm-1",
    ]);
  });

  it("triggerBackup extracts the job id from the Azure-AsyncOperation header; accepted-with-no-id throws", async () => {
    const { client, calls, sessionId } = await clientWithSession((_s, op) =>
      op === "backups.trigger"
        ? { headers: { "azure-asyncoperation": "https://mgmt/.../operationResults/op-guid-42?api-version=x" } }
        : [],
    );
    const out = await client.triggerBackup({
      sessionId,
      subscriptionId: SUB,
      resourceGroup: "rg-prod",
      vaultName: "rsv-prod",
      containerName: "c",
      protectedItemName: "i",
    });
    expect(out).toEqual({ jobId: "op-guid-42" });
    const trigger = calls.find((c) => c.op === "backups.trigger")!;
    expect(trigger.args.slice(0, 5)).toEqual(["rsv-prod", "rg-prod", "Azure", "c", "i"]);
    expect(rec(rec(trigger.args[5]).properties).objectType).toBe("IaasVMBackupRequest");

    const bare = await clientWithSession((_s, op) => (op === "backups.trigger" ? {} : []));
    await expect(
      bare.client.triggerBackup({
        sessionId: bare.sessionId,
        subscriptionId: SUB,
        resourceGroup: "rg",
        vaultName: "v",
        containerName: "c",
        protectedItemName: "i",
      }),
    ).rejects.toThrow(/no Azure-AsyncOperation/);
  });
});

describe("buildAzureInfraLiveClient — installPatches OS-oneof honesty", () => {
  it("Windows osType → windowsParameters only; Linux → linuxParameters only; result id required", async () => {
    const { client, calls, sessionId } = await clientWithSession((_s, op) =>
      op === "virtualMachines.beginInstallPatches" ? { installationActivityId: "act-1", status: "Succeeded" } : {},
    );
    await client.installPatches({
      sessionId,
      subscriptionId: SUB,
      resourceGroup: "rg",
      vmName: "vm-w",
      osType: "Windows",
    });
    const win = rec(calls.at(-1)!.args[2]);
    expect(win.windowsParameters).toEqual({ classificationsToInclude: ["Critical", "Security"] });
    expect(win.linuxParameters).toBeUndefined();
    expect(win.rebootSetting).toBe("IfRequired");

    await client.installPatches({
      sessionId,
      subscriptionId: SUB,
      resourceGroup: "rg",
      vmName: "vm-l",
      osType: "Linux",
    });
    const lin = rec(calls.at(-1)!.args[2]);
    expect(lin.linuxParameters).toEqual({ classificationsToInclude: ["Critical", "Security"] });
    expect(lin.windowsParameters).toBeUndefined();
  });

  it("unknown osType → looks the VM up (a real call); still-unknown refuses to guess", async () => {
    const { client, calls, sessionId } = await clientWithSession((_s, op) => {
      if (op === "virtualMachines.get") return { storageProfile: { osDisk: { osType: "Linux" } } };
      if (op === "virtualMachines.beginInstallPatches") return { installationActivityId: "act-2" };
      return {};
    });
    const out = await client.installPatches({
      sessionId,
      subscriptionId: SUB,
      resourceGroup: "rg",
      vmName: "vm-x",
      osType: null,
    });
    expect(out).toEqual({ installationActivityId: "act-2" });
    expect(calls.map((c) => c.op)).toContain("virtualMachines.get");
    expect(rec(calls.at(-1)!.args[2]).linuxParameters).toBeDefined();

    const dark = await clientWithSession((_s, op) =>
      op === "virtualMachines.get" ? {} : { installationActivityId: "never" },
    );
    await expect(
      dark.client.installPatches({
        sessionId: dark.sessionId,
        subscriptionId: SUB,
        resourceGroup: "rg",
        vmName: "vm-dark",
        osType: null,
      }),
    ).rejects.toThrow(/refusing to guess/);
  });

  it("a missing installationActivityId in the LRO result is an unconfirmed patch run — throws", async () => {
    const { client, sessionId } = await clientWithSession((_s, op) =>
      op === "virtualMachines.beginInstallPatches" ? { status: "Succeeded" } : {},
    );
    await expect(
      client.installPatches({
        sessionId,
        subscriptionId: SUB,
        resourceGroup: "rg",
        vmName: "vm-1",
        osType: "Linux",
      }),
    ).rejects.toThrow(/no installationActivityId/);
  });
});
