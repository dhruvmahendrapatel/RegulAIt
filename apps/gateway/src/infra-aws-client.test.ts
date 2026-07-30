import { afterEach, describe, expect, it } from "vitest";
import { InfraProviderError, resolveInfraProvider } from "@regulait/infra-provider";
import { buildAwsInfraLiveClient, type AwsInfraSdk } from "./infra-aws-client.js";
import { providerConfig } from "./infra.js";

/**
 * The REAL AWS infra live path — gateway wiring (ADR-0017 follow-through).
 * Proves, with fully fake SDK modules and never the network:
 *   · the factory is LAZY — no SDK module is loaded at build time, only on the
 *     first actual client call (so a flag-off gateway never touches @aws-sdk);
 *   · sts:AssumeRole short-lived credentials are held per sessionId and
 *     threaded into every per-call service client (never exposed);
 *   · region resolution order: per-call region > factory regionDefault, and at
 *     the providerConfig level resource-row config > env fallback;
 *   · every SDK command carries the exact annotated input (patch filters,
 *     AWS-RunPatchBaseline Operation=Install, ByResourceArn, …), paginated;
 *   · infra.ts providerConfig(): REGULAIT_INFRA_LIVE off is byte-identical to
 *     the pre-live `{ kind }` (the adapter's 501 gate is the second lock);
 *     flag on threads roleArn/region and passes a live client through.
 * Pure unit tests — no DB, no network, no real AWS.
 */

const ROLE = "arn:aws:iam::123456789012:role/regulait-infra";

interface RecordedCall {
  service: string;
  clientConfig: { region: string; credentials?: Record<string, unknown> };
  command: string;
  input: Record<string, unknown>;
}

/** a fully fake AwsInfraSdk that records every construction + send */
function makeFakeSdk(respond: (command: string, input: Record<string, unknown>) => unknown) {
  const calls: RecordedCall[] = [];
  const cmd = (name: string) =>
    class {
      readonly __command = name;
      constructor(readonly input: Record<string, unknown>) {}
    };
  const client = (service: string) =>
    class {
      constructor(readonly config: RecordedCall["clientConfig"]) {}
      async send(c: { __command: string; input: Record<string, unknown> }) {
        calls.push({ service, clientConfig: this.config, command: c.__command, input: c.input });
        return (respond(c.__command, c.input) ?? {}) as Record<string, unknown>;
      }
    };
  const sdk = {
    sts: { STSClient: client("sts"), AssumeRoleCommand: cmd("AssumeRole") },
    ssm: {
      SSMClient: client("ssm"),
      DescribeInstanceInformationCommand: cmd("DescribeInstanceInformation"),
      DescribeInstancePatchStatesCommand: cmd("DescribeInstancePatchStates"),
      DescribeInstancePatchesCommand: cmd("DescribeInstancePatches"),
      SendCommandCommand: cmd("SendCommand"),
    },
    acm: {
      ACMClient: client("acm"),
      ListCertificatesCommand: cmd("ListCertificates"),
      DescribeCertificateCommand: cmd("DescribeCertificate"),
      RenewCertificateCommand: cmd("RenewCertificate"),
    },
    backup: {
      BackupClient: client("backup"),
      ListRecoveryPointsByBackupVaultCommand: cmd("ListRecoveryPointsByBackupVault"),
      StartBackupJobCommand: cmd("StartBackupJob"),
    },
  } as unknown as AwsInfraSdk;
  return { sdk, calls };
}

const assumeRoleResponse = {
  Credentials: {
    AccessKeyId: "ASIATEST",
    SecretAccessKey: "secret-short-lived",
    SessionToken: "tok-123",
    Expiration: new Date("2026-07-30T12:00:00Z"),
  },
  AssumedRoleUser: { AssumedRoleId: "AROATEST:regulait-infra-x" },
};

/** build a client over a fake sdk and complete an assumeRole first */
async function liveClientWithSession(
  respond: (command: string, input: Record<string, unknown>) => unknown,
  regionDefault?: string,
) {
  const responder = (command: string, input: Record<string, unknown>) =>
    command === "AssumeRole" ? assumeRoleResponse : respond(command, input);
  const { sdk, calls } = makeFakeSdk(responder);
  const client = buildAwsInfraLiveClient(regionDefault, async () => sdk);
  const { sessionId } = await client.assumeRole({
    roleArn: ROLE,
    roleSessionName: "regulait-infra-test",
    durationSeconds: 3600,
    region: "eu-west-1",
  });
  return { client, calls, sessionId };
}

function fakeResource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    kind: "agent_runtime",
    name: "iawc-resource",
    provider: "aws",
    config: null,
    classifications: null,
    deployTargetId: null,
    createdAt: new Date(),
    ...overrides,
  } as Parameters<typeof providerConfig>[0];
}

afterEach(() => {
  delete process.env.REGULAIT_INFRA_LIVE;
  delete process.env.REGULAIT_INFRA_ROLE_ARN;
  delete process.env.REGULAIT_INFRA_REGION;
});

describe("buildAwsInfraLiveClient — lazy SDK loading", () => {
  it("never loads the SDK at factory-construction time, only on the first call", async () => {
    let loads = 0;
    const { sdk } = makeFakeSdk(() => assumeRoleResponse);
    const client = buildAwsInfraLiveClient("us-east-1", async () => {
      loads++;
      return sdk;
    });
    expect(loads).toBe(0); // constructing the client touched nothing
    await client.assumeRole({ roleArn: ROLE, roleSessionName: "s", durationSeconds: 3600, region: "us-east-1" });
    expect(loads).toBe(1);
    await client.assumeRole({ roleArn: ROLE, roleSessionName: "s", durationSeconds: 3600, region: "us-east-1" });
    expect(loads).toBe(1); // loaded once, cached
  });
});

describe("buildAwsInfraLiveClient — assume-role credential threading", () => {
  it("holds the short-lived credentials per sessionId and binds every service client to them", async () => {
    const { client, calls, sessionId } = await liveClientWithSession(() => ({
      InstanceInformationList: [{ InstanceId: "i-1", PingStatus: "Online" }],
    }));
    expect(sessionId).toBe("AROATEST:regulait-infra-x");
    // the STS client itself carries region but NO credentials (ambient identity)
    const sts = calls.find((c) => c.service === "sts")!;
    expect(sts.clientConfig.region).toBe("eu-west-1");
    expect(sts.clientConfig.credentials).toBeUndefined();
    expect(sts.input).toMatchObject({ RoleArn: ROLE, RoleSessionName: "regulait-infra-test", DurationSeconds: 3600 });

    const instances = await client.describeInstanceInformation({ region: "eu-west-1", sessionId });
    expect(instances).toEqual([
      {
        instanceId: "i-1",
        pingStatus: "Online",
        agentVersion: null,
        isLatestVersion: null,
        associationStatus: null,
        platformName: null,
        platformVersion: null,
        lastPingDateTime: null,
      },
    ]);
    const ssm = calls.find((c) => c.service === "ssm")!;
    expect(ssm.clientConfig.region).toBe("eu-west-1");
    // the assumed session's short-lived credentials were threaded in
    expect(ssm.clientConfig.credentials).toMatchObject({
      accessKeyId: "ASIATEST",
      secretAccessKey: "secret-short-lived",
      sessionToken: "tok-123",
    });
  });

  it("an unknown sessionId is a clear error — no call runs without assumeRole first", async () => {
    const { client } = await liveClientWithSession(() => ({}));
    await expect(
      client.listCertificates({ region: "eu-west-1", sessionId: "never-assumed" }),
    ).rejects.toThrow(/unknown assume-role session/);
  });

  it("an AssumeRole response with no credentials is a clear error, never a silent session", async () => {
    const { sdk } = makeFakeSdk(() => ({ AssumedRoleUser: { AssumedRoleId: "ARO:no-creds" } }));
    const client = buildAwsInfraLiveClient("us-east-1", async () => sdk);
    await expect(
      client.assumeRole({ roleArn: ROLE, roleSessionName: "s", durationSeconds: 3600, region: "us-east-1" }),
    ).rejects.toThrow(/no Credentials/);
  });
});

describe("buildAwsInfraLiveClient — region resolution (call > factory default)", () => {
  it("a per-call region wins; an empty one falls back to the factory regionDefault", async () => {
    const { client, calls, sessionId } = await liveClientWithSession(
      () => ({ CertificateSummaryList: [] }),
      "ap-south-1",
    );
    await client.listCertificates({ region: "us-west-2", sessionId });
    expect(calls.at(-1)!.clientConfig.region).toBe("us-west-2");
    await client.listCertificates({ region: "", sessionId });
    expect(calls.at(-1)!.clientConfig.region).toBe("ap-south-1");
  });

  it("no region anywhere is a clear error", async () => {
    const { sdk } = makeFakeSdk(() => assumeRoleResponse);
    const client = buildAwsInfraLiveClient(undefined, async () => sdk);
    await expect(
      client.assumeRole({ roleArn: ROLE, roleSessionName: "s", durationSeconds: 3600, region: "" }),
    ).rejects.toThrow(/no region/);
  });
});

describe("buildAwsInfraLiveClient — the annotated SDK commands", () => {
  it("describeInstanceInformation paginates through NextToken", async () => {
    let page = 0;
    const { client, sessionId } = await liveClientWithSession(() => {
      page++;
      return page === 1
        ? { InstanceInformationList: [{ InstanceId: "i-1" }], NextToken: "t2" }
        : { InstanceInformationList: [{ InstanceId: "i-2" }] };
    });
    const out = await client.describeInstanceInformation({ region: "eu-west-1", sessionId });
    expect(out.map((i) => i.instanceId)).toEqual(["i-1", "i-2"]);
  });

  it("describeInstancePatchStates chunks instance ids (≤50 per call) and maps the counters", async () => {
    const { client, calls, sessionId } = await liveClientWithSession((_c, input) => ({
      InstancePatchStates: (input.InstanceIds as string[]).map((id) => ({
        InstanceId: id,
        MissingCount: 2,
        FailedCount: 1,
        CriticalNonCompliantCount: 0,
      })),
    }));
    const ids = Array.from({ length: 60 }, (_, i) => `i-${i}`);
    const out = await client.describeInstancePatchStates({ region: "eu-west-1", sessionId, instanceIds: ids });
    expect(out).toHaveLength(60);
    expect(out[0]).toMatchObject({ instanceId: "i-0", missingCount: 2, failedCount: 1, criticalNonCompliantCount: 0 });
    const stateCalls = calls.filter((c) => c.command === "DescribeInstancePatchStates");
    expect(stateCalls).toHaveLength(2); // 50 + 10
    expect((stateCalls[0]!.input.InstanceIds as string[]).length).toBe(50);
    expect((stateCalls[1]!.input.InstanceIds as string[]).length).toBe(10);
  });

  it("describeInstanceMissingPatches filters State∈(Missing,Failed) and splits CVEIds on ','", async () => {
    const { client, calls, sessionId } = await liveClientWithSession(() => ({
      Patches: [
        {
          State: "Missing",
          Title: "kernel security update",
          KBId: "KB123",
          Classification: "SecurityUpdates",
          Severity: "Critical",
          CVEIds: "CVE-2026-0001, CVE-2026-0002",
        },
      ],
    }));
    const out = await client.describeInstanceMissingPatches({ region: "eu-west-1", sessionId, instanceId: "i-1" });
    expect(out).toEqual([
      {
        state: "Missing",
        title: "kernel security update",
        kbId: "KB123",
        classification: "SecurityUpdates",
        severity: "Critical",
        cveIds: ["CVE-2026-0001", "CVE-2026-0002"],
        cvssBaseScore: null, // honest gap: SSM has no CVSS — never invented
      },
    ]);
    const call = calls.find((c) => c.command === "DescribeInstancePatches")!;
    expect(call.input).toMatchObject({
      InstanceId: "i-1",
      Filters: [{ Key: "State", Values: ["Missing", "Failed"] }],
    });
  });

  it("listCertificates + describeCertificate map the ACM fields 1:1", async () => {
    const { client, sessionId } = await liveClientWithSession((command) =>
      command === "ListCertificates"
        ? { CertificateSummaryList: [{ CertificateArn: "arn:cert/1", DomainName: "x.example.com", Status: "ISSUED" }] }
        : {
            Certificate: {
              CertificateArn: "arn:cert/1",
              DomainName: "x.example.com",
              Issuer: "Amazon",
              Serial: "01:02",
              NotAfter: new Date("2026-08-10T00:00:00Z"),
              Status: "ISSUED",
              RenewalEligibility: "ELIGIBLE",
              Type: "AMAZON_ISSUED",
            },
          },
    );
    const list = await client.listCertificates({ region: "eu-west-1", sessionId });
    expect(list).toEqual([{ certificateArn: "arn:cert/1", domainName: "x.example.com", status: "ISSUED" }]);
    const cert = await client.describeCertificate({ region: "eu-west-1", sessionId, certificateArn: "arn:cert/1" });
    expect(cert).toMatchObject({
      certificateArn: "arn:cert/1",
      issuer: "Amazon",
      serial: "01:02",
      renewalEligibility: "ELIGIBLE",
      type: "AMAZON_ISSUED",
    });
    expect(cert.notAfter).toBeInstanceOf(Date);
  });

  it("listRecoveryPoints passes BackupVaultName (+ByResourceArn only when given)", async () => {
    const { client, calls, sessionId } = await liveClientWithSession(() => ({
      RecoveryPoints: [
        { RecoveryPointArn: "arn:rp/1", Status: "COMPLETED", CompletionDate: "2026-07-29T00:00:00Z", BackupSizeInBytes: 42 },
      ],
    }));
    const out = await client.listRecoveryPoints({ region: "eu-west-1", sessionId, backupVaultName: "vault-a" });
    expect(out).toEqual([
      {
        recoveryPointArn: "arn:rp/1",
        status: "COMPLETED",
        creationDate: null,
        completionDate: "2026-07-29T00:00:00Z",
        resourceArn: null,
        backupSizeInBytes: 42,
      },
    ]);
    expect(calls.at(-1)!.input).toEqual({ BackupVaultName: "vault-a" });
    await client.listRecoveryPoints({
      region: "eu-west-1",
      sessionId,
      backupVaultName: "vault-a",
      resourceArn: "arn:db/1",
    });
    expect(calls.at(-1)!.input).toEqual({ BackupVaultName: "vault-a", ByResourceArn: "arn:db/1" });
  });

  it("runPatchBaseline sends AWS-RunPatchBaseline Operation=Install and returns the CommandId", async () => {
    const { client, calls, sessionId } = await liveClientWithSession(() => ({ Command: { CommandId: "cmd-1" } }));
    const out = await client.runPatchBaseline({ region: "eu-west-1", sessionId, instanceIds: ["i-1", "i-2"] });
    expect(out).toEqual({ commandId: "cmd-1" });
    expect(calls.at(-1)!.input).toEqual({
      InstanceIds: ["i-1", "i-2"],
      DocumentName: "AWS-RunPatchBaseline",
      Parameters: { Operation: ["Install"] },
    });
  });

  it("renewCertificate succeeds on an empty 200; startBackupJob needs a BackupJobId back", async () => {
    const { client, calls, sessionId } = await liveClientWithSession((command) =>
      command === "StartBackupJob" ? { BackupJobId: "job-1" } : {},
    );
    await expect(
      client.renewCertificate({ region: "eu-west-1", sessionId, certificateArn: "arn:cert/1" }),
    ).resolves.toBeUndefined();
    expect(calls.at(-1)!.input).toEqual({ CertificateArn: "arn:cert/1" });
    const job = await client.startBackupJob({
      region: "eu-west-1",
      sessionId,
      backupVaultName: "vault-a",
      resourceArn: "arn:db/1",
      iamRoleArn: "arn:aws:iam::123456789012:role/backup",
    });
    expect(job).toEqual({ backupJobId: "job-1" });
    expect(calls.at(-1)!.input).toEqual({
      BackupVaultName: "vault-a",
      ResourceArn: "arn:db/1",
      IamRoleArn: "arn:aws:iam::123456789012:role/backup",
    });

    const noJob = await liveClientWithSession(() => ({}));
    await expect(
      noJob.client.startBackupJob({
        region: "eu-west-1",
        sessionId: noJob.sessionId,
        backupVaultName: "v",
        resourceArn: "r",
        iamRoleArn: "i",
      }),
    ).rejects.toThrow(/no BackupJobId/);
  });
});

describe("infra.ts providerConfig — the REGULAIT_INFRA_LIVE gate", () => {
  it("flag OFF: byte-identical to the pre-live contract — a bare { kind }, no client, no SDK", () => {
    delete process.env.REGULAIT_INFRA_LIVE;
    const cfg = providerConfig(fakeResource({ config: { roleArn: ROLE, region: "eu-west-1" } }));
    expect(cfg).toEqual({ kind: "aws" }); // deep-equal: no roleArn/region/awsLiveClient keys at all
    // and the resolver behaves exactly as today: the adapter's own 501 gate
    expect(() => resolveInfraProvider(cfg)).toThrow(InfraProviderError);
    try {
      resolveInfraProvider(cfg);
    } catch (err) {
      expect((err as InfraProviderError).status).toBe(501);
    }
  });

  it("flag OFF: a mock resource resolves exactly as before", () => {
    delete process.env.REGULAIT_INFRA_LIVE;
    const cfg = providerConfig(fakeResource({ provider: "mock" }));
    expect(cfg).toEqual({ kind: "mock" });
    expect(resolveInfraProvider(cfg).kind).toBe("mock");
  });

  it("flag ON: a non-aws resource still gets the bare { kind } — the live path is aws-only", () => {
    process.env.REGULAIT_INFRA_LIVE = "1";
    expect(providerConfig(fakeResource({ provider: "mock" }))).toEqual({ kind: "mock" });
  });

  it("flag ON: threads roleArn/region from the resource row's config jsonb and injects a live client", () => {
    process.env.REGULAIT_INFRA_LIVE = "1";
    const cfg = providerConfig(fakeResource({ config: { roleArn: ROLE, region: "eu-central-1" } }));
    expect(cfg.roleArn).toBe(ROLE);
    expect(cfg.region).toBe("eu-central-1");
    expect(cfg.awsLiveClient).toBeDefined();
    // the injected client implements the full 10-method AwsInfraLiveClient contract
    for (const method of [
      "assumeRole",
      "describeInstanceInformation",
      "describeInstancePatchStates",
      "describeInstanceMissingPatches",
      "listCertificates",
      "describeCertificate",
      "listRecoveryPoints",
      "runPatchBaseline",
      "renewCertificate",
      "startBackupJob",
    ] as const) {
      expect(typeof cfg.awsLiveClient![method]).toBe("function");
    }
    // and resolveInfraProvider now passes it through to a real aws adapter
    expect(resolveInfraProvider(cfg).kind).toBe("aws");
  });

  it("flag ON: env vars are the fallback, the resource row overrides them (row > env)", () => {
    process.env.REGULAIT_INFRA_LIVE = "true";
    process.env.REGULAIT_INFRA_ROLE_ARN = "arn:aws:iam::999999999999:role/env-fallback";
    process.env.REGULAIT_INFRA_REGION = "us-east-2";
    // no row config → env fallback
    const envCfg = providerConfig(fakeResource({ config: null }));
    expect(envCfg.roleArn).toBe("arn:aws:iam::999999999999:role/env-fallback");
    expect(envCfg.region).toBe("us-east-2");
    // row config present → it wins over the env
    const rowCfg = providerConfig(fakeResource({ config: { roleArn: ROLE, region: "eu-west-3" } }));
    expect(rowCfg.roleArn).toBe(ROLE);
    expect(rowCfg.region).toBe("eu-west-3");
    // partial row config → per-field precedence
    const mixed = providerConfig(fakeResource({ config: { region: "sa-east-1" } }));
    expect(mixed.roleArn).toBe("arn:aws:iam::999999999999:role/env-fallback");
    expect(mixed.region).toBe("sa-east-1");
  });

  it("flag ON with no roleArn anywhere still resolves — the adapter's own needs-config error is the guard", () => {
    process.env.REGULAIT_INFRA_LIVE = "1";
    const cfg = providerConfig(fakeResource({ config: null }));
    expect(cfg.roleArn).toBeNull();
    const provider = resolveInfraProvider(cfg);
    expect(provider.kind).toBe("aws");
  });
});
