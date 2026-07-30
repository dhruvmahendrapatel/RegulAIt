/**
 * The REAL @aws-sdk implementation of @regulait/infra-provider's
 * AwsInfraLiveClient factory contract (see packages/infra-provider/src/aws.ts).
 * The gateway owns the @aws-sdk deps (@aws-sdk/client-sts + NEW client-ssm /
 * client-acm / client-backup); the infra-provider package deliberately has
 * none, so this file is where each of the 10 interface methods becomes its
 * annotated SDK command.
 *
 * Discipline (mirrors deploy.ts's REGULAIT_DEPLOY_LIVE / AwsLiveDeployClient
 * pattern, ADR-0015 A1 / ADR-0017):
 *  - LAZY: the SDK modules are loaded via dynamic import on the FIRST actual
 *    client call, never at module load or factory construction — the gateway
 *    boots (and every flag-off code path runs) without touching @aws-sdk code.
 *    Only `import type` from the SDK appears at the top of this file.
 *  - Short-lived credentials only: sts:AssumeRole into the customer's roleArn;
 *    the resulting credentials are held INSIDE this client keyed by the opaque
 *    sessionId (AssumedRoleUser.AssumedRoleId) and threaded into every
 *    per-call service client. Credentials never leave this module and no
 *    static key is ever read.
 *  - Region per call: params.region wins; the factory's `regionDefault` is the
 *    fallback (the caller — infra.ts providerConfig() — already resolved
 *    resource-row > env before handing a region in).
 *  - Injectable SDK loader (`loadSdk`) so unit tests drive fully fake modules
 *    and prove lazy-loading — never the network, matching the repo's
 *    injectable-client convention (deploy-byoc.test.ts / aws.test.ts).
 */

import type {
  AwsAcmCertificateDetail,
  AwsAcmCertificateSummary,
  AwsAssumedSession,
  AwsBackupRecoveryPoint,
  AwsInfraLiveClient,
  AwsSsmInstanceInfo,
  AwsSsmInstancePatchState,
  AwsSsmMissingPatch,
} from "@regulait/infra-provider";

/** short-lived assume-role credentials, held per sessionId — never exported,
 * never persisted, never a static key */
interface AwsSessionCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

interface AwsClientConfig {
  region: string;
  credentials?: AwsSessionCredentials;
}

/** the only surface we drive on any SDK client */
interface AwsSendClient {
  send(command: unknown): Promise<Record<string, unknown> & { [k: string]: unknown }>;
}

type ClientCtor = new (config: AwsClientConfig) => AwsSendClient;
type CommandCtor = new (input: Record<string, unknown>) => unknown;

/** Structural view of the four SDK modules — what the real packages provide
 * and exactly what a test fake must supply. Kept structural (not the SDK's own
 * types) so fakes stay tiny and the modules can be loaded lazily. */
export interface AwsInfraSdk {
  sts: { STSClient: ClientCtor; AssumeRoleCommand: CommandCtor };
  ssm: {
    SSMClient: ClientCtor;
    DescribeInstanceInformationCommand: CommandCtor;
    DescribeInstancePatchStatesCommand: CommandCtor;
    DescribeInstancePatchesCommand: CommandCtor;
    SendCommandCommand: CommandCtor;
  };
  acm: {
    ACMClient: ClientCtor;
    ListCertificatesCommand: CommandCtor;
    DescribeCertificateCommand: CommandCtor;
    RenewCertificateCommand: CommandCtor;
  };
  backup: {
    BackupClient: ClientCtor;
    ListRecoveryPointsByBackupVaultCommand: CommandCtor;
    StartBackupJobCommand: CommandCtor;
  };
}

/** REAL loader — dynamic imports so nothing under @aws-sdk/* is evaluated
 * until the first live call. Cached at module level: import() caching makes a
 * second load free anyway, but this keeps the Promise single too. */
let realSdk: Promise<AwsInfraSdk> | undefined;
function loadRealSdk(): Promise<AwsInfraSdk> {
  realSdk ??= Promise.all([
    import("@aws-sdk/client-sts"),
    import("@aws-sdk/client-ssm"),
    import("@aws-sdk/client-acm"),
    import("@aws-sdk/client-backup"),
  ]).then(([sts, ssm, acm, backup]) => ({ sts, ssm, acm, backup }) as unknown as AwsInfraSdk);
  return realSdk;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function dateOrNull(v: unknown): string | Date | null {
  if (v instanceof Date) return v;
  return typeof v === "string" && v.length > 0 ? v : null;
}
function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}

/** ssm:DescribeInstancePatchStates accepts at most 50 instance ids per call */
const PATCH_STATE_CHUNK = 50;

/**
 * Build the real AwsInfraLiveClient the gateway injects (via infra.ts
 * providerConfig()) when REGULAIT_INFRA_LIVE is on. `regionDefault` is the
 * fallback region when a call arrives without one; `loadSdk` is the test seam
 * (defaults to the real lazy dynamic-import loader).
 */
export function buildAwsInfraLiveClient(
  regionDefault?: string,
  loadSdk: () => Promise<AwsInfraSdk> = loadRealSdk,
): AwsInfraLiveClient {
  // lazy: nothing is loaded until the first method call on the returned client
  let sdkPromise: Promise<AwsInfraSdk> | undefined;
  const sdk = () => (sdkPromise ??= loadSdk());

  // sessionId (AssumedRoleUser.AssumedRoleId) → held short-lived credentials
  const sessions = new Map<string, AwsSessionCredentials>();

  function resolveRegion(region: string): string {
    const r = region || regionDefault || "";
    if (!r) {
      throw new Error(
        "aws infra live client: no region — pass one per call or give the factory a regionDefault",
      );
    }
    return r;
  }

  function credentials(sessionId: string): AwsSessionCredentials {
    const c = sessions.get(sessionId);
    if (!c) {
      throw new Error(
        `aws infra live client: unknown assume-role session '${sessionId}' — call assumeRole first`,
      );
    }
    return c;
  }

  /** a per-call service client bound to the assumed session's credentials */
  async function serviceClient(
    pick: (s: AwsInfraSdk) => ClientCtor,
    region: string,
    sessionId: string,
  ): Promise<{ client: AwsSendClient; s: AwsInfraSdk }> {
    const s = await sdk();
    const Ctor = pick(s);
    return { client: new Ctor({ region: resolveRegion(region), credentials: credentials(sessionId) }), s };
  }

  /** drive an SDK list call through every NextToken page */
  async function paginate(
    client: AwsSendClient,
    makeCommand: (nextToken: string | undefined) => unknown,
    listKey: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await client.send(makeCommand(nextToken));
      items.push(...arr(resp[listKey]));
      nextToken = str(resp.NextToken) ?? undefined;
    } while (nextToken);
    return items;
  }

  return {
    /** REAL: sts:AssumeRole — short-lived creds held internally, only the
     * opaque AssumedRoleId crosses back (the factory contract). */
    async assumeRole(params): Promise<AwsAssumedSession> {
      const s = await sdk();
      const sts = new s.sts.STSClient({ region: resolveRegion(params.region) });
      const resp = await sts.send(
        new s.sts.AssumeRoleCommand({
          RoleArn: params.roleArn,
          RoleSessionName: params.roleSessionName,
          DurationSeconds: params.durationSeconds,
        }),
      );
      const creds = rec(resp.Credentials);
      const accessKeyId = str(creds.AccessKeyId);
      const secretAccessKey = str(creds.SecretAccessKey);
      const sessionId = str(rec(resp.AssumedRoleUser).AssumedRoleId);
      if (!accessKeyId || !secretAccessKey || !sessionId) {
        throw new Error(
          "sts:AssumeRole returned no Credentials/AssumedRoleUser.AssumedRoleId — cannot establish a live infra session",
        );
      }
      sessions.set(sessionId, {
        accessKeyId,
        secretAccessKey,
        sessionToken: str(creds.SessionToken) ?? undefined,
        expiration: creds.Expiration instanceof Date ? creds.Expiration : undefined,
      });
      return { sessionId };
    },

    /** REAL: ssm:DescribeInstanceInformation, paginated */
    async describeInstanceInformation(params): Promise<AwsSsmInstanceInfo[]> {
      const { client, s } = await serviceClient((x) => x.ssm.SSMClient, params.region, params.sessionId);
      const list = await paginate(
        client,
        (NextToken) => new s.ssm.DescribeInstanceInformationCommand(NextToken ? { NextToken } : {}),
        "InstanceInformationList",
      );
      return list
        .filter((i) => str(i.InstanceId) !== null)
        .map((i) => ({
          instanceId: str(i.InstanceId)!,
          pingStatus: str(i.PingStatus),
          agentVersion: str(i.AgentVersion),
          isLatestVersion: bool(i.IsLatestVersion),
          associationStatus: str(i.AssociationStatus),
          platformName: str(i.PlatformName),
          platformVersion: str(i.PlatformVersion),
          lastPingDateTime: dateOrNull(i.LastPingDateTime),
        }));
    },

    /** REAL: ssm:DescribeInstancePatchStates (≤50 ids per call, paginated) */
    async describeInstancePatchStates(params): Promise<AwsSsmInstancePatchState[]> {
      const { client, s } = await serviceClient((x) => x.ssm.SSMClient, params.region, params.sessionId);
      const out: AwsSsmInstancePatchState[] = [];
      for (let i = 0; i < params.instanceIds.length; i += PATCH_STATE_CHUNK) {
        const chunk = params.instanceIds.slice(i, i + PATCH_STATE_CHUNK);
        const states = await paginate(
          client,
          (NextToken) =>
            new s.ssm.DescribeInstancePatchStatesCommand({
              InstanceIds: chunk,
              ...(NextToken ? { NextToken } : {}),
            }),
          "InstancePatchStates",
        );
        for (const st of states) {
          const instanceId = str(st.InstanceId);
          if (!instanceId) continue;
          out.push({
            instanceId,
            missingCount: numOrNull(st.MissingCount),
            failedCount: numOrNull(st.FailedCount),
            installedPendingRebootCount: numOrNull(st.InstalledPendingRebootCount),
            criticalNonCompliantCount: numOrNull(st.CriticalNonCompliantCount),
            securityNonCompliantCount: numOrNull(st.SecurityNonCompliantCount),
            operationEndTime: dateOrNull(st.OperationEndTime),
          });
        }
      }
      return out;
    },

    /** REAL: ssm:DescribeInstancePatches filtered to State ∈ (Missing, Failed),
     * paginated; CVEIds split on ",". cvssBaseScore stays null — SSM carries no
     * CVSS (the adapter's documented honest gap; Inspector2 enrichment is a
     * possible later addition, never an invented number). */
    async describeInstanceMissingPatches(params): Promise<AwsSsmMissingPatch[]> {
      const { client, s } = await serviceClient((x) => x.ssm.SSMClient, params.region, params.sessionId);
      const patches = await paginate(
        client,
        (NextToken) =>
          new s.ssm.DescribeInstancePatchesCommand({
            InstanceId: params.instanceId,
            Filters: [{ Key: "State", Values: ["Missing", "Failed"] }],
            ...(NextToken ? { NextToken } : {}),
          }),
        "Patches",
      );
      return patches.map((p) => ({
        state: str(p.State) ?? "",
        title: str(p.Title),
        kbId: str(p.KBId),
        classification: str(p.Classification),
        severity: str(p.Severity),
        cveIds:
          str(p.CVEIds)
            ?.split(",")
            .map((c) => c.trim())
            .filter((c) => c.length > 0) ?? null,
        cvssBaseScore: null,
      }));
    },

    /** REAL: acm:ListCertificates, paginated */
    async listCertificates(params): Promise<AwsAcmCertificateSummary[]> {
      const { client, s } = await serviceClient((x) => x.acm.ACMClient, params.region, params.sessionId);
      const list = await paginate(
        client,
        (NextToken) => new s.acm.ListCertificatesCommand(NextToken ? { NextToken } : {}),
        "CertificateSummaryList",
      );
      return list
        .filter((c) => str(c.CertificateArn) !== null)
        .map((c) => ({
          certificateArn: str(c.CertificateArn)!,
          domainName: str(c.DomainName),
          status: str(c.Status),
        }));
    },

    /** REAL: acm:DescribeCertificate */
    async describeCertificate(params): Promise<AwsAcmCertificateDetail> {
      const { client, s } = await serviceClient((x) => x.acm.ACMClient, params.region, params.sessionId);
      const resp = await client.send(
        new s.acm.DescribeCertificateCommand({ CertificateArn: params.certificateArn }),
      );
      const cert = rec(resp.Certificate);
      const certificateArn = str(cert.CertificateArn) ?? params.certificateArn;
      return {
        certificateArn,
        domainName: str(cert.DomainName),
        issuer: str(cert.Issuer),
        serial: str(cert.Serial),
        notAfter: dateOrNull(cert.NotAfter),
        status: str(cert.Status),
        renewalEligibility: str(cert.RenewalEligibility),
        type: str(cert.Type),
      };
    },

    /** REAL: backup:ListRecoveryPointsByBackupVault, paginated */
    async listRecoveryPoints(params): Promise<AwsBackupRecoveryPoint[]> {
      const { client, s } = await serviceClient(
        (x) => x.backup.BackupClient,
        params.region,
        params.sessionId,
      );
      const points = await paginate(
        client,
        (NextToken) =>
          new s.backup.ListRecoveryPointsByBackupVaultCommand({
            BackupVaultName: params.backupVaultName,
            ...(params.resourceArn !== undefined ? { ByResourceArn: params.resourceArn } : {}),
            ...(NextToken ? { NextToken } : {}),
          }),
        "RecoveryPoints",
      );
      return points
        .filter((p) => str(p.RecoveryPointArn) !== null)
        .map((p) => ({
          recoveryPointArn: str(p.RecoveryPointArn)!,
          status: str(p.Status),
          creationDate: dateOrNull(p.CreationDate),
          completionDate: dateOrNull(p.CompletionDate),
          resourceArn: str(p.ResourceArn),
          backupSizeInBytes: numOrNull(p.BackupSizeInBytes),
        }));
    },

    /** REAL: ssm:SendCommand AWS-RunPatchBaseline Operation=Install */
    async runPatchBaseline(params): Promise<{ commandId: string }> {
      const { client, s } = await serviceClient((x) => x.ssm.SSMClient, params.region, params.sessionId);
      const resp = await client.send(
        new s.ssm.SendCommandCommand({
          InstanceIds: params.instanceIds,
          DocumentName: "AWS-RunPatchBaseline",
          Parameters: { Operation: ["Install"] },
        }),
      );
      const commandId = str(rec(resp.Command).CommandId);
      if (!commandId) {
        throw new Error("ssm:SendCommand returned no Command.CommandId — patch run not confirmed");
      }
      return { commandId };
    },

    /** REAL: acm:RenewCertificate — empty 200; success is the absence of a throw */
    async renewCertificate(params): Promise<void> {
      const { client, s } = await serviceClient((x) => x.acm.ACMClient, params.region, params.sessionId);
      await client.send(new s.acm.RenewCertificateCommand({ CertificateArn: params.certificateArn }));
    },

    /** REAL: backup:StartBackupJob */
    async startBackupJob(params): Promise<{ backupJobId: string }> {
      const { client, s } = await serviceClient(
        (x) => x.backup.BackupClient,
        params.region,
        params.sessionId,
      );
      const resp = await client.send(
        new s.backup.StartBackupJobCommand({
          BackupVaultName: params.backupVaultName,
          ResourceArn: params.resourceArn,
          IamRoleArn: params.iamRoleArn,
        }),
      );
      const backupJobId = str(resp.BackupJobId);
      if (!backupJobId) {
        throw new Error("backup:StartBackupJob returned no BackupJobId — backup not confirmed");
      }
      return { backupJobId };
    },
  };
}
