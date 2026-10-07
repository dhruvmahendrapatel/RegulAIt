/**
 * ADR-0060 §4 and §5 — ANCHORING and VERIFICATION.
 *
 * The chain itself (§1–§3) lives at the storage boundary, in `@regulait/db`.
 * This file is the half an operator and an auditor actually touch:
 *
 *   * `POST /v1/audit/anchor`   — pin the current chain head to WORM storage
 *   * `POST /v1/audit/anchors/flush` — externalize anchors buffered offline
 *   * `GET  /v1/audit/anchors`  — what has been pinned, where, and did it land
 *   * `GET  /v1/audit/verify`   — recompute the chain and say OK, or say which
 *                                 `seq` it breaks at
 *
 * WHY THE ANCHOR IS NOT DECORATION
 * --------------------------------
 * Hash-chaining is easy to over-sell. It catches any edit by someone who cannot
 * recompute the whole chain. It does NOT catch the adversary the ADR is most
 * worried about: a DB admin who rewrites every row can also rewrite every hash,
 * and the result is INTERNALLY CONSISTENT. `verifyAuditChain` will happily
 * report `ok` on it — there is a test that asserts exactly that, because a
 * control whose limits are not written down gets sold as covering things it
 * does not cover.
 *
 * The anchor is what closes it. The chain head is a commitment to the entire
 * history (that is why `prev_hash` names the predecessor's `row_hash` and not
 * its `content_hash`), so ANY edit anywhere moves the head. Pin the head
 * somewhere the DB admin cannot rewrite and the forgery becomes a divergence.
 *
 * Which is why `anchorSource` is reported on every verification, and why
 * "the anchor row in our own database" is reported as NOT tamper-resistant. An
 * adversary with total DB write owns `audit_anchors` too. Only an externalized
 * copy — S3 Object Lock in compliance mode, an independent transparency log, or
 * an auditor's own retained copy passed in as a query parameter — is evidence.
 *
 * RESIDUAL WINDOW, STATED EVERY TIME. Rows written after the last anchor are
 * not yet pinned. A forgery confined to them is internally consistent and
 * undetectable by this control until they are anchored. Anchor cadence BOUNDS
 * that window; it does not remove it. `unanchoredRows` is in every response.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import {
  and,
  asc,
  auditAnchors,
  auditLog,
  desc,
  eq,
  gt,
  isNotNull,
  lte,
  sql,
  type Db,
} from "@regulait/db";
import {
  AUDIT_CHAIN_ALGORITHM,
  AUDIT_GENESIS_CONTENT_HASH,
  AUDIT_GENESIS_PREV_HASH,
  AUDIT_GENESIS_ROW_HASH,
  AUDIT_GENESIS_SEQ,
  AUDIT_LEGACY_DISCLOSURE,
  AUDIT_PAYLOAD_VERSION,
  verifyChainBatch,
  type ChainBreak,
  type ChainedAuditRow,
} from "@regulait/shared";

import { anchorTimestamper as defaultAnchorTimestamper } from "./audit-timestamp.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// --- the WORM sink -----------------------------------------------------------

/** The tiny, immutable thing that gets externalized. Deliberately minimal:
 * three values plus provenance. It is meant to be cheap enough to write hourly
 * forever, and small enough for an auditor to keep a copy of by hand. */
export interface AnchorRecord {
  seq: number;
  rowHash: string;
  headAt: string;
  algorithm: string;
  payloadVersion: string;
  capturedAt: string;
}

/**
 * Where an anchor goes once it leaves the database.
 *
 * An interface rather than a hardcoded S3 call, for the reason ADR-0041 gives:
 * BYOC and air-gapped are the PRIMARY motion. The bucket lives in the
 * customer's account under their IAM, or there is no bucket at all and anchors
 * buffer to a local write-once volume until someone carries them out. One
 * interface, three postures.
 */
export interface AnchorSink {
  /** recorded on the anchor row, so "where is the immutable copy" is answerable
   * from the database without guessing at configuration */
  readonly destination: "local_worm" | "s3_object_lock" | "external_log";
  /** True only for a medium the DB admin provably cannot rewrite. A local
   * directory is NOT that — see `LocalWormSink`. */
  readonly tamperResistant: boolean;
  write(record: AnchorRecord): Promise<string>;
  /**
   * The highest-seq anchor in the sink — or, with `maxSeq`, the highest one
   * at or below it. The bound exists because an anchor store can hold anchors
   * from MORE THAN ONE CHAIN (a second database run from the same directory,
   * a planted record): verification asks for the latest anchor this chain can
   * have produced, and reports anything past the chain head separately.
   */
  readLatest(opts?: { maxSeq?: number }): Promise<AnchorRecord | null>;
  /**
   * OPTIONAL, and only implemented by a sink whose immutability is a property
   * of a REMOTE medium rather than of this process.
   *
   * `tamperResistant` above is a constant, which is right for a sink that knows
   * its own answer at construction (`LocalWormSink` is false, always, and no
   * amount of configuration changes that). It is exactly wrong for S3: whether
   * the bucket enforces anything is a fact about the bucket, not about our
   * config file, and the only honest way to know is to ASK the endpoint. A sink
   * that implements this method is saying "do not take my constant on trust,
   * await this and use what came back".
   */
  observe?(): Promise<AnchorSinkObservation>;
}

/** What a sink reports after asking its medium what it actually enforces. */
export interface AnchorSinkObservation {
  /** derived ONLY from what the medium answered — never from configuration */
  tamperResistant: boolean;
  /** the medium's answer in machine-readable form, so an operator can tell
   * "nobody can delete this" from "we could not find out" */
  mode: "compliance" | "governance" | "no_default_retention" | "object_lock_absent" | "unobserved";
  /** one paragraph, same voice as the verify report's other disclosures */
  disclosure: string;
}

/**
 * The air-gapped buffer: anchors written to a local directory as read-only
 * files, to be carried or synced out later (§8.5's buffer-and-flush).
 *
 * HONESTY ABOUT WHAT THIS IS. A directory on the same host is NOT WORM. `chmod
 * 0444` stops a fat-fingered overwrite; it stops root from nothing. This sink
 * reports `tamperResistant: false`, and verification says so in its response,
 * because the alternative — letting an operator believe a local folder is
 * Object Lock — is worse than having no anchor at all. It is a BUFFER whose
 * value is realised when its contents reach a medium that really is immutable.
 */
export class LocalWormSink implements AnchorSink {
  readonly destination = "local_worm" as const;
  readonly tamperResistant = false;
  constructor(private readonly dir: string) {}

  async write(record: AnchorRecord): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `anchor-${String(record.seq).padStart(20, "0")}.json`);
    const body = JSON.stringify(record, null, 2);
    await writeFile(file, body, { encoding: "utf8", flag: "w" });
    // best-effort immutability; see the class comment for what this is worth
    await chmod(file, 0o444).catch(() => undefined);
    return file;
  }

  async readLatest(opts?: { maxSeq?: number }): Promise<AnchorRecord | null> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return null;
    }
    const anchors = names
      .filter((n) => n.startsWith("anchor-") && n.endsWith(".json"))
      .filter((n) => opts?.maxSeq === undefined || anchorSeqOfName(n) <= opts.maxSeq)
      .sort();
    const last = anchors.at(-1);
    if (!last) return null;
    try {
      return JSON.parse(await readFile(path.join(this.dir, last), "utf8")) as AnchorRecord;
    } catch {
      return null;
    }
  }
}

/** `anchor-00000000000000000567.json` (or its S3 key) → 567; NaN for anything else */
export function anchorSeqOfName(name: string): number {
  const m = /anchor-(\d+)\.json$/.exec(name);
  return m ? Number(m[1]) : Number.NaN;
}

/** where the local anchor buffer lands when nothing overrides it */
export const DEFAULT_ANCHOR_DIR = "./audit-anchors";

// --- the S3 Object Lock sink -------------------------------------------------

/**
 * The slice of `S3Client` this sink uses.
 *
 * Structural rather than the concrete class so a unit test can substitute a
 * transport that never leaves the process while still handing this code the
 * REAL command objects. What is under test here is how an answer from the
 * endpoint is GRADED, so a fake that also faked the commands would be marking
 * its own homework.
 */
export interface S3SendClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<any>;
}

export interface S3AnchorConfig {
  bucket: string;
  /** key prefix every anchor lives under — mirrors the terraform module's
   * `prefix`, whose writer grant is scoped to exactly this */
  prefix: string;
  region: string;
  /** set for any S3-COMPATIBLE endpoint (MinIO in the compose stack, a
   * customer's on-prem object store in an air-gapped install). Unset means
   * real AWS S3 and the SDK's own endpoint resolution. */
  endpoint?: string | undefined;
  forcePathStyle: boolean;
  retentionDays: number;
  /** unset falls through to the SDK's default provider chain — an instance
   * role in BYOC, which is the posture ADR-0060 actually wants, since it means
   * no long-lived key exists to steal */
  credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
}

/**
 * Matches `retention_days` in `infra/modules/audit-anchor-worm-s3/variables.tf`.
 *
 * The two numbers must not drift: an anchor that expires before the rows it
 * pins leaves those rows unprovable, and an install that gets one retention
 * from terraform and a different one from the writer has no single answer to
 * "how long is this evidence good for". 365 is a starting point, not a
 * recommendation for a regulated workload — the compliance cascade is where
 * this eventually belongs (ADR-0060 follow-up 5).
 */
export const DEFAULT_S3_ANCHOR_RETENTION_DAYS = 365;
export const DEFAULT_S3_ANCHOR_PREFIX = "audit-anchors";

/**
 * How long an observation of the bucket's lock configuration is trusted before
 * it is taken again.
 *
 * NOT an optimization. Caching the answer forever would mean a bucket whose
 * default retention was quietly changed from COMPLIANCE to GOVERNANCE keeps
 * being reported as tamper-resistant until someone restarts the gateway — a
 * `true` that has silently become false is precisely the lie this class exists
 * to prevent. Re-asking each minute bounds that window while keeping the cost
 * off the per-anchor path.
 */
export const S3_LOCK_OBSERVATION_TTL_MS = 60_000;

/**
 * Anchors to an S3 bucket with Object Lock — the sink that ADR-0060 says is the
 * one that actually earns `tamperResistant`.
 *
 * WHY THIS TALKS TO ANY S3-COMPATIBLE ENDPOINT, NOT TO AWS
 * -------------------------------------------------------
 * Endpoint, region, credentials and path-style are all configuration, so the
 * same code serves the MinIO container in `docker-compose.yml`, a customer's
 * on-prem object store in an air-gapped install (ADR-0041's primary motion),
 * and real AWS S3. Object Lock is an S3 API contract, not an AWS feature, and
 * anything implementing that contract is a valid destination. Hard-coding AWS
 * would have made the one deployment mode this product leads with — the
 * customer's own infrastructure — the one it could not serve.
 *
 * THE RULE THIS CLASS EXISTS TO ENFORCE: `tamperResistant` IS OBSERVED
 * -------------------------------------------------------------------
 * It is never read from configuration, an env var, or the fact that we ASKED
 * for COMPLIANCE on our own `PutObject`. Our own request proves nothing: it is
 * ours to lie about. The only evidence is what the bucket says when asked —
 * `GetObjectLockConfiguration` — and the grading is deliberately harsh:
 *
 *   Object Lock enabled + default retention COMPLIANCE  → true
 *   default retention GOVERNANCE                        → FALSE. A principal
 *       holding `s3:BypassGovernanceRetention` deletes anchors at will, and
 *       that is exactly the hostile administrator this control is for.
 *   Object Lock enabled, no default retention rule      → FALSE. Nothing on
 *       the bucket compels immutability; today's writer sets it per object,
 *       tomorrow's misconfigured one does not, and neither leaves a trace.
 *   Object Lock absent, or the call failed              → FALSE, fail closed.
 *       An unobserved medium is graded as a mutable one. Guessing upward here
 *       would ship the false assurance ADR-0060 exists to prevent.
 *
 * A boolean that lies here is worse than having no anchor at all: no anchor is
 * a disclosed gap an auditor can price, while a false `true` is a gap nobody
 * knows to look for.
 *
 * WHAT IT STILL DOES NOT BUY. Compliance-mode Object Lock stops an anchor being
 * EDITED or FORGED. It does not stop the store being DESTROYED — whoever owns
 * the host can drop the whole volume or close the account. Those are different
 * attacks with different signatures: destruction is loud (verification reports
 * the anchor missing and says so), forgery is silent. This closes the silent
 * one.
 */
/** REL-12: connect and whole-request deadlines for the anchor sink's S3 calls
 * (a plain handler-options object — the SDK builds its NodeHttpHandler from it) */
export const S3_REQUEST_HANDLER = Object.freeze({ connectionTimeout: 5_000, requestTimeout: 30_000 });

export class S3ObjectLockSink implements AnchorSink {
  readonly destination = "s3_object_lock" as const;
  private readonly client: S3SendClient;
  private observed: { at: number; observation: AnchorSinkObservation } | null = null;
  private inflight: Promise<AnchorSinkObservation> | null = null;

  constructor(
    private readonly config: S3AnchorConfig,
    client?: S3SendClient,
  ) {
    this.client =
      client ??
      new S3Client({
        region: config.region,
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        forcePathStyle: config.forcePathStyle,
        ...(config.credentials ? { credentials: config.credentials } : {}),
        // REL-12: the SDK's handler defaults BOTH timeouts to 0 = none, so a
        // sink that drops packets (a firewall, not a refusal) hung the anchor
        // capture — and the boot timer stacked a new one on it every 15 min.
        // Bounded here, and retried once at most: an anchor that fails is
        // recorded as `failed` with the reason, which is the honest outcome.
        requestHandler: S3_REQUEST_HANDLER,
        maxAttempts: 2,
      });
  }

  /**
   * The last OBSERVED answer, and `false` until there is one.
   *
   * `AnchorSink.tamperResistant` is synchronous, so this getter cannot go and
   * ask. It therefore reports the conservative value until `observe()` has run,
   * and every path that publishes it — `write`, `readLatest`, the verify report
   * — awaits `observe()` first. An un-awaited read can be too pessimistic; by
   * construction it can never be too generous.
   */
  get tamperResistant(): boolean {
    return this.observed?.observation.tamperResistant ?? false;
  }

  /** the observed mode, for callers that want more than a boolean */
  get lockMode(): AnchorSinkObservation["mode"] {
    return this.observed?.observation.mode ?? "unobserved";
  }

  async observe(): Promise<AnchorSinkObservation> {
    const fresh = this.observed && Date.now() - this.observed.at < S3_LOCK_OBSERVATION_TTL_MS;
    if (fresh && this.observed) return this.observed.observation;
    // one probe in flight at a time: an anchor burst must not turn into a burst
    // of identical GetObjectLockConfiguration calls
    this.inflight ??= this.probe().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** the same answer whether the bucket said "no lock configuration" by
   * returning nothing or by raising the not-found error for it */
  private static absentObservation(where: string): AnchorSinkObservation {
    return {
      tamperResistant: false,
      mode: "object_lock_absent",
      disclosure: `The bucket ${where} does NOT have Object Lock enabled, so anything written to it can be overwritten or deleted by whoever holds this credential — the same posture as a local directory, just further away. Object Lock is a CREATE-TIME property of a bucket and cannot be turned on afterwards, so fixing this means a new bucket.`,
    };
  }

  private async probe(): Promise<AnchorSinkObservation> {
    const where = `${this.config.bucket}${this.config.endpoint ? ` at ${this.config.endpoint}` : ""}`;
    try {
      const res = await this.client.send(new GetObjectLockConfigurationCommand({ Bucket: this.config.bucket }));
      const cfg = res?.ObjectLockConfiguration;
      const enabled = cfg?.ObjectLockEnabled === "Enabled";
      const mode = cfg?.Rule?.DefaultRetention?.Mode;

      let observation: AnchorSinkObservation;
      if (enabled && mode === "COMPLIANCE") {
        observation = {
          tamperResistant: true,
          mode: "compliance",
          disclosure: `Anchors are written to S3 Object Lock in COMPLIANCE mode on ${where}, as reported by the bucket itself (GetObjectLockConfiguration), not as configured here. For the retention period no principal — not this gateway's credential, not an administrator, not the account root — can delete or alter the anchor version that was written, so a full-recompute forgery diverges from a head nobody can rewrite. A later write to the same name adds a version rather than replacing it, and verification reads the original version, so a masking write cannot substitute a forged head either. It does NOT stop the anchor store being DESTROYED wholesale; that is a different attack, and a loud one, because verification then reports the anchor missing instead of matching.`,
        };
      } else if (enabled && mode === "GOVERNANCE") {
        observation = {
          tamperResistant: false,
          mode: "governance",
          disclosure: `The bucket ${where} has Object Lock in GOVERNANCE mode. A principal holding s3:BypassGovernanceRetention — which an administrator can grant themselves — can still delete or shorten a locked anchor, so this stops accidents and casual insiders but NOT the hostile administrator ADR-0060 is written against. Reported as NOT tamper-resistant for that reason. COMPLIANCE mode is what makes it evidence.`,
        };
      } else if (enabled) {
        observation = {
          tamperResistant: false,
          mode: "no_default_retention",
          disclosure: `The bucket ${where} has Object Lock enabled but NO default retention rule, so the bucket compels nothing: immutability depends entirely on every writer remembering to ask for it, and a writer that forgets leaves no trace. Reported as NOT tamper-resistant until a COMPLIANCE-mode default retention is set on the bucket.`,
        };
      } else {
        observation = S3ObjectLockSink.absentObservation(where);
      }
      // cache only a real answer, and only for a bounded time — see the TTL
      this.observed = { at: Date.now(), observation };
      return observation;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A bucket with no Object Lock does not answer with an empty
      // configuration — it ERRORS, with this code, on both AWS S3 and MinIO
      // (measured). That is a definite answer, not a failure to get one, and
      // the difference matters twice: an admin needs "there is no lock here"
      // rather than "we could not tell", and `write` must drop the lock
      // headers, because S3 rejects a locked PUT to an unlocked bucket and
      // every anchor would fail instead of landing weak-but-disclosed.
      const code = (err as { name?: string; Code?: string })?.name ?? (err as { Code?: string })?.Code ?? "";
      if (/ObjectLockConfigurationNotFound|NoSuchObjectLockConfiguration/i.test(code)) {
        const observation = S3ObjectLockSink.absentObservation(where);
        this.observed = { at: Date.now(), observation };
        return observation;
      }
      // NOT cached: a failed probe is usually "the endpoint is not up yet"
      // (compose starts the gateway alongside MinIO), and freezing a `false`
      // from a boot-time race would understate the medium forever.
      return {
        tamperResistant: false,
        mode: "unobserved",
        disclosure: `Could not read the Object Lock configuration of ${where} (${message}). Reported as NOT tamper-resistant: an unobserved medium is graded as a mutable one, because claiming an immutability nobody verified is the false assurance ADR-0060 exists to prevent.`,
      };
    }
  }

  /** same name shape as `LocalWormSink` — zero-padded so lexicographic key
   * order IS chain order, which is what makes `readLatest` a list-and-take-last
   * rather than a full scan and a sort */
  private keyFor(seq: number): string {
    return `${this.config.prefix}/anchor-${String(seq).padStart(20, "0")}.json`;
  }

  async write(record: AnchorRecord): Promise<string> {
    const observation = await this.observe();
    const key = this.keyFor(record.seq);
    // Only omit the lock headers when the bucket POSITIVELY said it has no
    // Object Lock: S3 rejects a locked PUT to an unlocked bucket, and failing
    // every write there would trade a disclosed-weak anchor for no anchor. On
    // an unobserved bucket we still ask for the lock — if the bucket does have
    // it, the object is protected; if it does not, the write fails loudly and
    // the anchor row records `failed` with the reason.
    const lockHeaders =
      observation.mode === "object_lock_absent"
        ? {}
        : {
            ObjectLockMode: "COMPLIANCE" as const,
            ObjectLockRetainUntilDate: new Date(Date.now() + this.config.retentionDays * 86_400_000),
          };
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: JSON.stringify(record, null, 2),
        ContentType: "application/json",
        ...lockHeaders,
      }),
    );
    return `s3://${this.config.bucket}/${key}`;
  }

  /**
   * The newest anchor in the bucket, or `null`.
   *
   * IT READS VERSIONS, AND IT READS THE OLDEST ONE. This is not fussiness, it
   * closes a hole that a plain `GetObject` leaves wide open, measured against a
   * real COMPLIANCE-locked bucket:
   *
   *   * `DeleteObject` on the locked VERSION is refused — that is the guarantee.
   *   * `PutObject` to the SAME KEY is ALLOWED. Object Lock protects a version,
   *     not a name, so a new version becomes current and a plain `GetObject`
   *     returns the ATTACKER'S bytes while the locked original sits underneath.
   *   * `DeleteObject` without a version id is ALLOWED too: it writes a delete
   *     marker, and a plain `ListObjectsV2` then cannot see the key at all, so
   *     verification would silently fall back to an OLDER anchor.
   *
   * Both of those turn the sink built to stop silent forgery into a vehicle for
   * it. Reading the FIRST version of each key removes them: our writer emits a
   * given `seq` exactly once (seq is monotonic and gapless), so the earliest
   * version of a key is by definition the one written under lock, and it is the
   * one nobody — including us — can change.
   *
   * What an adversary CAN still do is add a NEW key with a fabricated higher
   * `seq`. That anchor is locked too, so it cannot be withdrawn, and it will not
   * match the table — verification reports a MISMATCH. They can raise a false
   * alarm; they cannot manufacture a false pass. That asymmetry is the right way
   * round for an integrity control.
   *
   * `null` on ANY failure, deliberately, and that is not an edge case: the
   * terraform writer grant denies `s3:GetObject` on purpose, so an install
   * following ADR-0060's least-privilege posture is WRITE-ONLY and lands here
   * every time. Verification then falls back to the database anchor row and
   * reports `source: "database", tamperResistant: false` — weaker, but HONEST.
   * Throwing would turn "the writer cannot read back" into a 500 on the one
   * endpoint that must always be able to say something.
   */
  async readLatest(opts?: { maxSeq?: number }): Promise<AnchorRecord | null> {
    try {
      await this.observe();
      const prefix = `${this.config.prefix}/anchor-`;
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      // key → the oldest version seen for it. Versions come back newest-first
      // per key, so the last one written down for a key is the earliest.
      const firstVersionOf = new Map<string, string | undefined>();
      for (;;) {
        const page = await this.client.send(
          new ListObjectVersionsCommand({
            Bucket: this.config.bucket,
            Prefix: prefix,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
          }),
        );
        // Delete markers are deliberately IGNORED: on a locked bucket a delete
        // marker is a claim that an anchor is gone, not the fact of it.
        const versions: Array<{ Key?: string; VersionId?: string }> = page?.Versions ?? [];
        for (const v of versions) {
          if (!v.Key) continue;
          if (opts?.maxSeq !== undefined && !(anchorSeqOfName(v.Key) <= opts.maxSeq)) continue;
          firstVersionOf.set(v.Key, v.VersionId);
        }
        if (!page?.IsTruncated) break;
        keyMarker = page.NextKeyMarker as string | undefined;
        versionIdMarker = page.NextVersionIdMarker as string | undefined;
        if (!keyMarker && !versionIdMarker) break;
      }
      if (firstVersionOf.size === 0) return null;
      // seq is zero-padded in the key, so lexicographic max IS the highest seq.
      const lastKey = [...firstVersionOf.keys()].sort().at(-1)!;
      const versionId = firstVersionOf.get(lastKey);
      const obj = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: lastKey,
          // "null" is what a never-versioned bucket reports; asking for it by
          // name is not universally accepted, so drop it and take the object.
          ...(versionId && versionId !== "null" ? { VersionId: versionId } : {}),
        }),
      );
      const body = obj?.Body;
      const text: string = typeof body?.transformToString === "function" ? await body.transformToString() : String(body ?? "");
      return JSON.parse(text) as AnchorRecord;
    } catch {
      return null;
    }
  }
}

/**
 * Read the S3 destination out of the environment, or `null` for "not
 * configured".
 *
 * The BUCKET is the switch. Everything else has a default, because an operator
 * who has named a bucket has stated an intent, and refusing to anchor because
 * they did not also set a region would leave the install with no external
 * anchor over a detail we can pick. A wrong region or a wrong endpoint surfaces
 * as a `failed` anchor row with the endpoint's own error on it, which is a far
 * better failure than silence.
 */
export function resolveS3AnchorConfig(env: NodeJS.ProcessEnv): S3AnchorConfig | null {
  const bucket = env.REGULAIT_AUDIT_ANCHOR_S3_BUCKET?.trim();
  if (!bucket) return null;

  const endpoint = env.REGULAIT_AUDIT_ANCHOR_S3_ENDPOINT?.trim() || undefined;
  const accessKeyId = env.REGULAIT_AUDIT_ANCHOR_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.REGULAIT_AUDIT_ANCHOR_S3_SECRET_ACCESS_KEY?.trim();
  const pathStyle = env.REGULAIT_AUDIT_ANCHOR_S3_FORCE_PATH_STYLE?.trim().toLowerCase();
  const days = Number(env.REGULAIT_AUDIT_ANCHOR_S3_RETENTION_DAYS?.trim() || "");

  return {
    bucket,
    prefix: env.REGULAIT_AUDIT_ANCHOR_S3_PREFIX?.trim() || DEFAULT_S3_ANCHOR_PREFIX,
    // AWS_REGION is honoured second so a BYOC host that already declares its
    // region does not have to declare it twice.
    region: env.REGULAIT_AUDIT_ANCHOR_S3_REGION?.trim() || env.AWS_REGION?.trim() || "us-east-1",
    endpoint,
    // Virtual-host addressing needs DNS for `<bucket>.<host>`, which a
    // container named `minio` on a compose network does not have. So a custom
    // endpoint defaults to path style and AWS defaults to virtual-host, and
    // either can be overridden for an S3-compatible store that insists.
    forcePathStyle: pathStyle ? pathStyle === "1" || pathStyle === "true" || pathStyle === "yes" : endpoint !== undefined,
    retentionDays: Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_S3_ANCHOR_RETENTION_DAYS,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  };
}

/**
 * Resolve the configured sink, or `null` for "no sink".
 *
 * DEFAULT-ON, AND HONEST ABOUT WHAT THAT DOES NOT BUY. The local buffer is now
 * the default rather than opt-in, because an install that anchors nothing keeps
 * its only integrity evidence inside the very table an attacker edits. Writing
 * the head to a second artifact raises the bar from "rewrite one table" to
 * "rewrite one table AND the anchor rows AND the anchor files".
 *
 * It does NOT make the trail tamper-RESISTANT, and this function must never be
 * read as if it did. `LocalWormSink.tamperResistant` is `false` and says why: a
 * directory on the same host stops a fat-fingered overwrite, and stops root from
 * nothing. Against an adversary with total database and filesystem write, a full
 * recompute still passes verification. The verify report says exactly that, and
 * turning this default on does not change one word of it.
 *
 * The value that IS real: the buffer exists from the first boot, so pointing an
 * install at a medium that genuinely is immutable becomes a configuration change
 * rather than a code change and a backfill.
 *
 * `REGULAIT_AUDIT_ANCHOR_DIR` moves the buffer. `REGULAIT_AUDIT_ANCHOR=off`
 * restores the previous `null` posture, which remains a legitimate, DISCLOSED
 * state — every anchor written without a sink records `destination: 'none'` so
 * nobody can mistake it for externalized.
 *
 * PRECEDENCE, and why the S3 sink does not need to be "enabled":
 *
 *   1. `REGULAIT_AUDIT_ANCHOR=off`  → no sink at all, disclosed as such.
 *   2. an S3 bucket is configured   → `S3ObjectLockSink`. Naming a bucket IS
 *      the opt-in; a second "and I mean it" flag would only create a state
 *      where an operator believes they configured WORM and did not.
 *   3. otherwise                    → the local buffer, as before.
 *
 * Choosing S3 does NOT by itself make the trail tamper-resistant. The sink
 * grades the bucket by asking it, and reports `false` for a GOVERNANCE-mode,
 * unlocked or unreachable bucket. Configuration cannot set that boolean; only
 * the medium's own answer can.
 */
export function resolveAnchorSink(env: NodeJS.ProcessEnv = process.env): AnchorSink | null {
  if ((env.REGULAIT_AUDIT_ANCHOR ?? "").trim().toLowerCase() === "off") return null;
  const s3 = resolveS3AnchorConfig(env);
  if (s3) return new S3ObjectLockSink(s3);
  const dir = env.REGULAIT_AUDIT_ANCHOR_DIR?.trim();
  return new LocalWormSink(dir && dir.length > 0 ? dir : DEFAULT_ANCHOR_DIR);
}

// --- reading the chain head --------------------------------------------------

export interface ChainHead {
  seq: number;
  rowHash: string;
  headAt: Date;
}

/** The current tip: the highest CHAINED row. Legacy rows carry a NULL `seq` and
 * are excluded — a plain `order by seq desc` would sort NULLs first and return
 * a pre-genesis row as the "head". */
export async function readChainHead(db: Db): Promise<ChainHead | null> {
  const rows = await db
    .select({ seq: auditLog.seq, rowHash: auditLog.rowHash, at: auditLog.at })
    .from(auditLog)
    .where(isNotNull(auditLog.seq))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  const head = rows[0];
  if (!head?.seq || !head.rowHash) return null;
  return { seq: head.seq, rowHash: head.rowHash, headAt: head.at };
}

// --- ADR-0186 S: the trusted-timestamp seam ----------------------------------

/**
 * Called after EVERY anchor flush attempt — `captureAnchor` (the admin route
 * and the boot path) and `flushPendingAnchors` alike — with the anchor's id,
 * the exact record that was (or would have been) externalised, and how the
 * flush went. The implementation (slice S, `audit-timestamp.ts`) obtains an
 * RFC 3161 token over the anchor's canonical bytes and records it on the
 * anchor's `tsa_*` columns, or records why not.
 *
 * Contract: it never changes the anchor's flush outcome. A throw is caught here
 * and recorded on the anchor (`tsa_last_error`); it does not fail the capture or
 * the flush. The foundation's implementation does nothing.
 */
export interface AnchorTimestamper {
  afterFlush(
    db: Db,
    anchor: { id: string; record: AnchorRecord; flushStatus: "pending" | "flushed" | "failed" },
  ): Promise<void>;
}

async function timestampAfterFlush(
  db: Db,
  timestamper: AnchorTimestamper,
  anchor: { id: string; record: AnchorRecord; flushStatus: "pending" | "flushed" | "failed" },
): Promise<void> {
  try {
    await timestamper.afterFlush(db, anchor);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await db
      .update(auditAnchors)
      .set({ tsaLastError: message })
      .where(eq(auditAnchors.id, anchor.id))
      .catch(() => undefined);
  }
}

// --- capturing and flushing anchors -----------------------------------------

export interface CaptureResult {
  anchorId: string;
  seq: number;
  rowHash: string;
  destination: "local_worm" | "s3_object_lock" | "external_log" | "none";
  status: "pending" | "flushed" | "failed";
  externalRef: string | null;
  tamperResistant: boolean;
  error: string | null;
}

function anchorRecordOf(head: ChainHead): AnchorRecord {
  return {
    seq: head.seq,
    rowHash: head.rowHash,
    headAt: head.headAt.toISOString(),
    algorithm: AUDIT_CHAIN_ALGORITHM,
    payloadVersion: AUDIT_PAYLOAD_VERSION,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Pin the current chain head.
 *
 * ORDER MATTERS, and it is the opposite of the obvious one: the audit row for
 * "an anchor was taken" is written FIRST, and the head is read AFTER. Reading
 * the head first would produce an anchor that is stale the instant it is
 * created — it would not cover its own audit row — and every verification would
 * report one unanchored row forever, training the reader to ignore the number.
 */
export async function captureAnchor(
  db: Db,
  sink: AnchorSink | null,
  actorUserId: string | null,
  timestamper: AnchorTimestamper = defaultAnchorTimestamper,
): Promise<CaptureResult | null> {
  await db.insert(auditLog).values({
    userId: actorUserId ?? NIL_UUID,
    objectType: "audit_chain",
    effect: "allow",
    ruleId: "audit-anchor-captured",
    ruleChain: ["audit-anchor-captured"],
    reason: "admin pinned the audit-log chain head to WORM storage",
    detail: { phase: "anchor", destination: sink?.destination ?? "none" },
  });

  const head = await readChainHead(db);
  if (!head) return null;

  const id = randomUUID();
  const destination = sink?.destination ?? "none";
  await db.insert(auditAnchors).values({
    id,
    seq: head.seq,
    rowHash: head.rowHash,
    headAt: head.headAt,
    algorithm: AUDIT_CHAIN_ALGORITHM,
    destination,
    status: "pending",
  });

  const record = anchorRecordOf(head);
  const flushed = await flushAnchorRow(db, sink, { id, record });
  // ADR-0186 S: a trusted timestamp for this anchor (never changes the flush outcome)
  await timestampAfterFlush(db, timestamper, { id, record, flushStatus: flushed.status });
  // Observed, not declared — the caller of POST /v1/audit/anchor is being told
  // whether what they just wrote is evidence, and only the medium can answer.
  const observed = sink ? ((await sink.observe?.()) ?? null) : null;
  return {
    anchorId: id,
    seq: head.seq,
    rowHash: head.rowHash,
    destination,
    status: flushed.status,
    externalRef: flushed.externalRef,
    tamperResistant: observed?.tamperResistant ?? sink?.tamperResistant ?? false,
    error: flushed.error,
  };
}

async function flushAnchorRow(
  db: Db,
  sink: AnchorSink | null,
  anchor: { id: string; record: AnchorRecord },
): Promise<{ status: "pending" | "flushed" | "failed"; externalRef: string | null; error: string | null }> {
  // No sink is not a failure. It is the disclosed "buffered locally, nothing
  // externalized" state that an air-gapped install sits in by design.
  if (!sink) return { status: "pending", externalRef: null, error: null };
  try {
    const ref = await sink.write(anchor.record);
    await db
      .update(auditAnchors)
      .set({ status: "flushed", externalRef: ref, flushedAt: new Date(), lastError: null })
      .where(eq(auditAnchors.id, anchor.id));
    return { status: "flushed", externalRef: ref, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // FAILED, not silently retried. An anchor that did not reach WORM must not
    // look like one that did.
    await db.update(auditAnchors).set({ status: "failed", lastError: message }).where(eq(auditAnchors.id, anchor.id));
    return { status: "failed", externalRef: null, error: message };
  }
}

/** §8.5 buffer-and-flush: push everything still buffered to the sink now that
 * there is a connection. Idempotent — an anchor already `flushed` is skipped. */
export async function flushPendingAnchors(
  db: Db,
  sink: AnchorSink | null,
  timestamper: AnchorTimestamper = defaultAnchorTimestamper,
): Promise<{ attempted: number; flushed: number; failed: number }> {
  const pending = await db
    .select()
    .from(auditAnchors)
    .where(sql`${auditAnchors.status} in ('pending','failed')`)
    .orderBy(asc(auditAnchors.seq));
  let flushed = 0;
  let failed = 0;
  for (const row of pending) {
    const record: AnchorRecord = {
      seq: row.seq,
      rowHash: row.rowHash,
      headAt: row.headAt.toISOString(),
      algorithm: row.algorithm,
      payloadVersion: AUDIT_PAYLOAD_VERSION,
      capturedAt: row.createdAt.toISOString(),
    };
    const res = await flushAnchorRow(db, sink, { id: row.id, record });
    // ADR-0186 S: a trusted timestamp for this anchor (never changes the flush outcome)
    await timestampAfterFlush(db, timestamper, { id: row.id, record, flushStatus: res.status });
    if (res.status === "flushed") flushed += 1;
    else if (res.status === "failed") failed += 1;
  }
  return { attempted: pending.length, flushed, failed };
}

// --- verification ------------------------------------------------------------

/** ADR-0031: verification NEVER loads the table. It walks it in keyset pages
 * over the unique `seq` index and holds one page at a time. `audit_log` grows a
 * row per governed call; a verification that materialised it would be an OOM of
 * the container with a compliance label on it. */
export const VERIFY_DEFAULT_BATCH = 500;
export const VERIFY_MAX_BATCH = 5000;

export interface VerifyOptions {
  fromSeq?: number;
  toSeq?: number;
  batchSize?: number;
  /** an anchor the CALLER retained out-of-band (an auditor's own copy). Beats
   * both the sink and the database, because its trustworthiness is the
   * auditor's own problem rather than ours. */
  anchor?: { seq: number; rowHash: string } | undefined;
}

export interface VerifyReport {
  status: "ok" | "broken" | "empty";
  algorithm: string;
  payloadVersion: string;
  genesis: { present: boolean; seq: number; expectedRowHash: string; actualRowHash: string | null; matches: boolean };
  scanned: { fromSeq: number; toSeq: number | null; rows: number; batches: number; batchSize: number; bounded: boolean };
  legacy: { unchainedRowsBeforeGenesis: number; covered: false; disclosure: string };
  firstBreak: ChainBreak | null;
  anchor: {
    checked: boolean;
    source: "caller_supplied" | "worm_sink" | "database" | "none";
    tamperResistant: boolean;
    /** What the sink's medium answered when asked what it enforces, for a sink
     * that can be asked (S3). `null` for every other source, because "we did
     * not ask" and "it answered GOVERNANCE" must not look the same. */
    sinkMode: AnchorSinkObservation["mode"] | null;
    seq: number | null;
    expectedRowHash: string | null;
    actualRowHash: string | null;
    matches: boolean | null;
    unanchoredRows: number | null;
    disclosure: string;
    /**
     * An anchor in the sink whose seq is PAST this chain's head. A chain never
     * shrinks, so such an anchor was either captured from a different chain
     * that shares the store (a second database run from the same anchor
     * directory) or is evidence that rows were removed after it was taken.
     * It is reported here, never graded as a hash mismatch — `matches` above
     * is computed against the latest anchor this chain can have produced.
     */
    aheadOfHead: { seq: number; rowHash: string; capturedAt: string; disclosure: string } | null;
  };
  limits: string[];
}

/**
 * Recompute the chain and report `ok`, or the FIRST `seq` at which it breaks.
 *
 * A bounded range (`fromSeq` > genesis) cannot recompute the history in front of
 * it, so it TRUSTS the stored `prev_hash` of its first row as a starting point.
 * That is a real weakening — an adversary who rewrote everything before
 * `fromSeq` would not be caught by a bounded scan — so `scanned.bounded` is
 * reported and the limitation is spelled out in `limits`. A bounded verify is a
 * triage tool; a full verify from genesis is the evidence.
 */
export async function verifyAuditChain(db: Db, sink: AnchorSink | null, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const batchSize = Math.min(Math.max(opts.batchSize ?? VERIFY_DEFAULT_BATCH, 1), VERIFY_MAX_BATCH);
  const fromSeq = Math.max(opts.fromSeq ?? AUDIT_GENESIS_SEQ, 1);
  const bounded = fromSeq > AUDIT_GENESIS_SEQ;

  // The un-chained legacy population, counted live rather than baked into the
  // genesis row (which must stay byte-identical across installs so its hash is
  // a product constant). This number is the honest boundary of the guarantee.
  const legacyCount = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(sql`${auditLog.seq} is null`)) as Array<{ n: number }>;
  const legacyRows = legacyCount[0]?.n ?? 0;

  const genesisRows = await db
    .select({ seq: auditLog.seq, rowHash: auditLog.rowHash, contentHash: auditLog.contentHash })
    .from(auditLog)
    .where(eq(auditLog.seq, AUDIT_GENESIS_SEQ));
  const genesisRow = genesisRows[0];
  const genesis = {
    present: Boolean(genesisRow),
    seq: AUDIT_GENESIS_SEQ,
    expectedRowHash: AUDIT_GENESIS_ROW_HASH,
    actualRowHash: genesisRow?.rowHash ?? null,
    matches: genesisRow?.rowHash === AUDIT_GENESIS_ROW_HASH && genesisRow?.contentHash === AUDIT_GENESIS_CONTENT_HASH,
  };

  // Walk state. From genesis, the predecessor hash is the fixed zero constant.
  // From a bounded start, it is whatever the first row claims — see the doc
  // comment for why that is weaker and reported as such.
  let expectedSeq = fromSeq;
  let prevRowHash = AUDIT_GENESIS_PREV_HASH;
  if (bounded) {
    const before = await db
      .select({ rowHash: auditLog.rowHash })
      .from(auditLog)
      .where(eq(auditLog.seq, fromSeq - 1));
    prevRowHash = before[0]?.rowHash ?? AUDIT_GENESIS_PREV_HASH;
  }

  let cursor = fromSeq - 1;
  let rowsScanned = 0;
  let batches = 0;
  let lastSeq: number | null = null;
  let lastRowHash: string | null = null;
  let firstBreak: ChainBreak | null = null;

  for (;;) {
    const where = [isNotNull(auditLog.seq), gt(auditLog.seq, cursor)];
    if (opts.toSeq !== undefined) where.push(lte(auditLog.seq, opts.toSeq));
    const page = (await db
      .select({
        seq: auditLog.seq,
        id: auditLog.id,
        at: auditLog.at,
        userId: auditLog.userId,
        objectType: auditLog.objectType,
        objectId: auditLog.objectId,
        detail: auditLog.detail,
        serverId: auditLog.serverId,
        toolName: auditLog.toolName,
        effect: auditLog.effect,
        ruleId: auditLog.ruleId,
        ruleChain: auditLog.ruleChain,
        reason: auditLog.reason,
        deployMode: auditLog.deployMode,
        contentHash: auditLog.contentHash,
        prevHash: auditLog.prevHash,
        rowHash: auditLog.rowHash,
      })
      .from(auditLog)
      .where(and(...where))
      .orderBy(asc(auditLog.seq))
      .limit(batchSize)) as unknown as ChainedAuditRow[];

    if (page.length === 0) break;
    batches += 1;
    rowsScanned += page.length;

    const res = verifyChainBatch(page, { expectedSeq, prevRowHash });
    if (res.break) {
      firstBreak = res.break;
      break;
    }
    expectedSeq = res.expectedSeq;
    prevRowHash = res.prevRowHash;
    const last = page[page.length - 1]!;
    cursor = last.seq;
    lastSeq = last.seq;
    lastRowHash = last.rowHash;
    if (page.length < batchSize) break;
  }

  const anchor = await compareAgainstAnchor(db, sink, opts.anchor, { lastSeq, firstBreak });

  const limits = [
    "Local recomputation cannot detect an adversary with total database write who rewrites every row AND every hash: that forgery is internally consistent. Only an externalized anchor catches it.",
    "Rows written after the newest anchor are not yet pinned; tampering confined to them can be made internally consistent. Anchor cadence bounds this window, it does not remove it.",
    "This is detection and evidence, not prevention. It does not block writes, and it provides no confidentiality — a hash is not encryption.",
  ];
  if (bounded) {
    limits.unshift(
      `Bounded scan: rows before seq ${fromSeq} were NOT recomputed. The starting prev_hash was taken on trust from the stored chain, so tampering before seq ${fromSeq} is outside this result. Verify from genesis for evidence.`,
    );
  }
  if (!genesis.present) {
    limits.unshift("The genesis row is ABSENT — the boundary marker itself is missing, which is a break in its own right.");
  } else if (!genesis.matches) {
    limits.unshift("The genesis row does not match its published constant — the chain was seeded from a doctored starting point.");
  }

  const status: VerifyReport["status"] = firstBreak ? "broken" : rowsScanned === 0 ? "empty" : "ok";

  return {
    status,
    algorithm: AUDIT_CHAIN_ALGORITHM,
    payloadVersion: AUDIT_PAYLOAD_VERSION,
    genesis,
    scanned: { fromSeq, toSeq: lastSeq, rows: rowsScanned, batches, batchSize, bounded },
    legacy: {
      unchainedRowsBeforeGenesis: legacyRows ?? 0,
      covered: false,
      disclosure: AUDIT_LEGACY_DISCLOSURE,
    },
    firstBreak,
    anchor,
    limits,
  };
}

async function compareAgainstAnchor(
  db: Db,
  sink: AnchorSink | null,
  supplied: { seq: number; rowHash: string } | undefined,
  ctx: { lastSeq: number | null; firstBreak: ChainBreak | null },
): Promise<VerifyReport["anchor"]> {
  let source: VerifyReport["anchor"]["source"] = "none";
  let tamperResistant = false;
  let expected: { seq: number; rowHash: string } | null = null;
  // Set only by a sink that can be ASKED what its medium enforces. When it is
  // set it OVERRIDES the generic text below, because "the bucket answered
  // GOVERNANCE, so a privileged user can still delete this" is a materially
  // different fact from "this is not tamper-resistant", and the reader needs
  // the specific one.
  let observation: AnchorSinkObservation | null = null;
  let ahead: AnchorRecord | null = null;
  // Read at return time, after `tamperResistant` is known: the same fact has
  // two different weights. On a local buffer an anchor past the head is most
  // likely another database that ran from the same directory, and the
  // comparison below was never evidence anyway. On a WORM store it is one of
  // two things — a shared store, or rows removed after the anchor was taken —
  // and verification cannot tell which, so the chain is NOT reported as
  // verified (`matches: null`), never as a clean pass.
  const aheadOfHead = (): VerifyReport["anchor"]["aheadOfHead"] =>
    ahead
      ? {
          seq: ahead.seq,
          rowHash: ahead.rowHash,
          capturedAt: ahead.capturedAt,
          disclosure: tamperResistant
            ? `The tamper-resistant anchor store holds an anchor at seq ${ahead.seq}, past this chain's head` +
              `${ctx.lastSeq !== null ? ` (seq ${ctx.lastSeq})` : ""}. A chain never shrinks: either rows after the head were ` +
              "removed from this chain — a break — or another chain shares this store. Verification cannot tell which, " +
              `so this chain is NOT reported as verified. Compare the anchor's capture time (${ahead.capturedAt}) with this ` +
              "chain's history and the store's other anchors before treating it as either."
            : `The anchor store also holds an anchor at seq ${ahead.seq}, past this chain's head` +
              `${ctx.lastSeq !== null ? ` (seq ${ctx.lastSeq})` : ""}. A chain never shrinks, so it was either captured ` +
              "from a different chain that shares this store (another database run from the same anchor location) " +
              "or rows after it were removed from this one. Verification cannot tell which; compare its capture time " +
              `(${ahead.capturedAt}) with this chain's history before treating it as a break.`,
        }
      : null;

  if (supplied) {
    source = "caller_supplied";
    // The auditor vouches for their own copy; we do not get to grade it.
    tamperResistant = true;
    expected = supplied;
  } else if (sink) {
    let record = await sink.readLatest();
    // The highest anchor in the store may not be THIS chain's: a store shared
    // by two databases holds both chains' anchors, and the higher one used to
    // be graded against a row this chain never had — a red "mismatch" over a
    // row that does not exist. It is set aside and reported on its own; the
    // comparison uses the latest anchor at or below the head.
    if (record && ctx.lastSeq !== null && record.seq > ctx.lastSeq) {
      ahead = record;
      record = await sink.readLatest({ maxSeq: ctx.lastSeq });
    }
    if (record) {
      source = "worm_sink";
      observation = (await sink.observe?.()) ?? null;
      // the observed answer wins over the declared constant, always: the
      // constant is what we configured, the observation is what is true
      tamperResistant = observation?.tamperResistant ?? sink.tamperResistant;
      expected = { seq: record.seq, rowHash: record.rowHash };
    }
  }

  if (!expected) {
    // Last resort: our own table. Recorded, but explicitly NOT evidence — an
    // adversary with database write owns this row too.
    const rows = await db.select().from(auditAnchors).orderBy(desc(auditAnchors.seq)).limit(1);
    const row = rows[0];
    if (row) {
      source = "database";
      tamperResistant = false;
      expected = { seq: row.seq, rowHash: row.rowHash };
    }
  }

  const disclosureFor = (s: VerifyReport["anchor"]["source"], resistant: boolean): string => {
    if (s === "none") {
      return "No anchor exists. The chain still detects any edit by someone who cannot recompute it, but a full recompute by an adversary with total database write would pass this verification undetected.";
    }
    if (!resistant) {
      return "The anchor compared against is NOT held on tamper-resistant storage (it is in this database, or in a local buffer on this host). An adversary who can rewrite audit_log can rewrite it too, so this comparison is a consistency check, not evidence.";
    }
    return "The anchor compared against is held outside this database. A divergence here is what catches a full-recompute forgery.";
  };

  if (!expected) {
    return {
      checked: false,
      source: "none",
      tamperResistant: false,
      sinkMode: null,
      seq: null,
      expectedRowHash: null,
      actualRowHash: null,
      matches: null,
      unanchoredRows: null,
      disclosure: disclosureFor("none", false),
      aheadOfHead: aheadOfHead(),
    };
  }

  // What does the CURRENT table say the row at the anchored seq hashes to?
  const rows = await db
    .select({ rowHash: auditLog.rowHash })
    .from(auditLog)
    .where(eq(auditLog.seq, expected.seq));
  const actual = rows[0]?.rowHash ?? null;

  return {
    checked: true,
    source,
    tamperResistant,
    sinkMode: observation?.mode ?? null,
    seq: expected.seq,
    expectedRowHash: expected.rowHash,
    actualRowHash: actual,
    // an anchor past the head on a WORM store withholds the verdict: the
    // genuine anchor may match, but the rows after it may be gone
    matches: ahead && tamperResistant ? null : actual !== null && actual === expected.rowHash,
    unanchoredRows: ctx.lastSeq !== null ? Math.max(ctx.lastSeq - expected.seq, 0) : null,
    aheadOfHead: aheadOfHead(),
    // the medium's own account of what it enforces beats the generic text
    disclosure: observation?.disclosure ?? disclosureFor(source, tamperResistant),
  };
}

// --- routes ------------------------------------------------------------------

const verifyQuery = z.object({
  fromSeq: z.coerce.number().int().min(1).optional(),
  toSeq: z.coerce.number().int().min(1).optional(),
  batchSize: z.coerce.number().int().min(1).max(VERIFY_MAX_BATCH).optional(),
  /** an auditor's own retained anchor, both halves or neither */
  anchorSeq: z.coerce.number().int().min(1).optional(),
  anchorRowHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

/**
 * All four routes are ADMIN-ONLY, by the gateway's default posture (every route
 * not in `NON_ADMIN_ROUTES` requires `isAdmin`). Deliberately not relaxed:
 * verification reports the shape of the whole trail, and anchoring is a
 * governed act that itself lands in the trail.
 */
export function registerAuditChainRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { sink?: AnchorSink | null; timestamper?: AnchorTimestamper } = {},
): void {
  const sink = opts.sink === undefined ? resolveAnchorSink() : opts.sink;
  const timestamper = opts.timestamper ?? defaultAnchorTimestamper;

  app.get("/v1/audit/verify", async (req, reply) => {
    const q = verifyQuery.parse(req.query);
    if ((q.anchorSeq === undefined) !== (q.anchorRowHash === undefined)) {
      return reply.status(400).send({ error: "anchor_incomplete", detail: "supply anchorSeq AND anchorRowHash, or neither" });
    }
    return verifyAuditChain(db, sink, {
      ...(q.fromSeq !== undefined ? { fromSeq: q.fromSeq } : {}),
      ...(q.toSeq !== undefined ? { toSeq: q.toSeq } : {}),
      ...(q.batchSize !== undefined ? { batchSize: q.batchSize } : {}),
      anchor: q.anchorSeq !== undefined && q.anchorRowHash !== undefined ? { seq: q.anchorSeq, rowHash: q.anchorRowHash } : undefined,
    });
  });

  app.post("/v1/audit/anchor", async (req, reply) => {
    const result = await captureAnchor(db, sink, req.authCtx?.userId ?? null, timestamper);
    if (!result) return reply.status(409).send({ error: "no_chain", detail: "there is no chained row to anchor" });
    return reply.status(201).send(result);
  });

  app.post("/v1/audit/anchors/flush", async () => flushPendingAnchors(db, sink, timestamper));

  app.get("/v1/audit/anchors", async () => {
    const rows = await db.select().from(auditAnchors).orderBy(desc(auditAnchors.seq)).limit(100);
    // ASK the sink, do not read its constant. For S3 the honest answer lives on
    // the bucket, and an admin reading this screen to decide whether the trail
    // is evidence must not be shown what we configured in place of what is.
    const observation = sink ? ((await sink.observe?.()) ?? null) : null;
    const tamperResistant = observation?.tamperResistant ?? sink?.tamperResistant ?? false;
    return {
      anchors: rows,
      sink: sink
        ? { destination: sink.destination, tamperResistant, mode: observation?.mode ?? null }
        : null,
      disclosure: sink
        ? (observation?.disclosure ??
          (tamperResistant
            ? "Anchors are externalized to tamper-resistant storage."
            : "Anchors are buffered to a medium this host can still rewrite. Until they reach WORM storage they are a consistency check, not evidence."))
        : "No anchor sink is configured: anchors exist only in this database and are NOT tamper-resistant.",
    };
  });
}

/** Exported for the throughput harness and for tests that need a stable digest
 * of the whole chain without re-reading it row by row. */
export function fingerprintOf(values: string[]): string {
  const h = createHash("sha256");
  for (const v of values) h.update(v);
  return h.digest("hex");
}
