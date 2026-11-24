/**
 * ADR-0360 slice 1c — delivering an update rollout to devices (gateway half; the agent half is
 * agents/endpoint/internal/agent: the per-user agent's spool writer and the root updater).
 *
 *   GET  /v1/endpoint-agent/update          the calling device's offer: a signed directive, the release manifest and
 *                                           where to download its binary, or `{update: null}`
 *   GET  /v1/endpoint-agent/update/binary   the binary of the device's open offer (its own platform, nothing else)
 *   POST /v1/endpoint-agent/update-results  the root updater's one outcome, which settles the attempt and can halt the
 *                                           rollout
 *
 * WHEN A DEVICE IS OFFERED THE UPDATE: its source has a `running` rollout; the first stage (in ordinal order) whose
 * ADR-0350 group holds the device has been reached (`active` or `done`) and that group's self-update is still on (read
 * at every offer, so turning it off stops the offer at once); the device does not already run the version; its attempt
 * for the rollout is not settled; the execution dial is `normal`; and the release is on the gateway and verifies. The
 * device's updater still refuses anything that is not newer than what runs (ADR-0360 §4), so the gateway never needs to
 * order versions itself.
 *
 * TRUST. The directive is signed by the device-policy signer (`device-policy-signer.ts`, ADR-0334 B4, rotatable) over
 * its own domain, `UPDATE_DIRECTIVE_SIGNATURE_DOMAIN` followed by the payload bytes (#1033), so it never verifies as a
 * policy or an ADR-0331 directive. The manifest is the release pipeline's own envelope, served byte for byte: the
 * gateway checks it against the configured release public keys and the binary's length and SHA-256 before offering it
 * (a broken or tampered release is never offered), and the device checks both again against its own pinned keys.
 *
 * RELEASES come from a read-only directory the operator deploys (`REGULAIT_AGENT_RELEASES_DIR`: `<version>/release.json`
 * and `<version>/regulait-agent-<os>-<arch>`), which works air-gapped and adds no upload surface. The release public
 * keys (`REGULAIT_AGENT_RELEASE_KEYS`, a JSON file of one or two `{keyId, x}`) rotate by overlap: add the next key,
 * publish releases signed with it, then drop the old one, the same at most two the device pins (§4). Both are read at
 * every offer, so a change applies without a restart. Open source first (ADR-0176): signing and verification are
 * node:crypto Ed25519; the envelope is the agent's own, already shipped (go-tuf was rejected in ADR-0360).
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  asc,
  auditLog,
  endpointDeviceGroupFleetSettings,
  endpointDeviceGroupMembers,
  endpointDevices,
  endpointUpdateAttempts,
  endpointUpdateRollouts,
  endpointUpdateRolloutStages,
  eq,
  inArray,
  lt,
  runWithRlsSystem,
  sql,
  type Db,
  type EndpointUpdateAttemptRow,
} from "@regulait/db";
import {
  ENDPOINT_ROLLOUT_DECISION_TTL_HOURS,
  ENDPOINT_ROLLOUT_MACHINE,
  ENDPOINT_UPDATE_ATTEMPT_MACHINE,
  ENDPOINT_UPDATE_ATTEMPT_TTL_HOURS,
  type EndpointUpdateAttemptEvent,
} from "@regulait/shared";
import { databaseNow } from "./db-clock.js";
import { resolveDirectiveSigner, type DirectiveSigner } from "./directive-signer.js";
import type { EndpointAgentContext } from "./endpoint-agent.js";
import { ExternalEffectBlockedError, runExternalWrite } from "./external-effects.js";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { whereFrom } from "./state-transition.js";

export const UPDATE_DIRECTIVE_SCHEMA = "regulait.endpoint-update-directive/1";
export const RELEASE_MANIFEST_SCHEMA = "regulait.endpoint-release/1";
export const UPDATE_RESULT_SCHEMA = "regulait.endpoint-update-result/1";
/** the device-policy key signs this prefix then the payload (agents/endpoint/internal/update: DirectiveSignatureDomain) */
export const UPDATE_DIRECTIVE_SIGNATURE_DOMAIN = Buffer.from(`${UPDATE_DIRECTIVE_SCHEMA}\u0000`, "utf8");
export const AGENT_RELEASES_DIR_ENV = "REGULAIT_AGENT_RELEASES_DIR";
export const AGENT_RELEASE_KEYS_ENV = "REGULAIT_AGENT_RELEASE_KEYS";

export const ENDPOINT_UPDATE_PATHS = {
  update: "/v1/endpoint-agent/update",
  binary: "/v1/endpoint-agent/update/binary",
  results: "/v1/endpoint-agent/update-results",
} as const;

// Bounds (secure by default, ADR-0180: compiled in; the device's updater holds the same, agents/endpoint/internal/update)
/** a directive lives this long, and never past its attempt's expiry (the device refuses one longer than 24 hours) */
export const UPDATE_DIRECTIVE_LIFETIME_MINUTES = 360;
const MAX_MANIFEST_BYTES = 64 << 10;
const MAX_BINARY_BYTES = 256 << 20;
const MAX_RELEASE_KEYS = 2;
const RESULTS_BODY_LIMIT = 4096;
const KEY_ID_SHAPE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const VERSION_SHAPE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,32})?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CODE_SHAPE = /^[a-z_]{1,64}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// The release catalogue (read-only, operator-deployed)
// ---------------------------------------------------------------------------

export type ReleaseRefusal = "release_keys_unavailable" | "release_not_found" | "manifest_invalid" | "no_target_for_platform" | "binary_mismatch";
export interface Release {
  /** the release pipeline's envelope, exactly as deployed */
  manifest: { keyId: string; payload: string; signature: string };
  target: { os: string; arch: string; sha256: string; length: number };
  binaryPath: string;
}

const envelopeSchema = z.object({ keyId: z.string().regex(KEY_ID_SHAPE), payload: z.string().min(1), signature: z.string().min(1) }).strict();
const manifestSchema = z
  .object({
    schema: z.literal(RELEASE_MANIFEST_SCHEMA),
    version: z.string().regex(VERSION_SHAPE),
    issuedAt: z.string().datetime({ offset: true }),
    targets: z
      .array(z.object({ os: z.enum(["linux", "darwin", "windows"]), arch: z.enum(["amd64", "arm64"]), sha256: z.string().regex(HEX64), length: z.number().int().min(1).max(MAX_BINARY_BYTES) }).strict())
      .min(1)
      .max(16),
  })
  .strict();
const releaseKeysSchema = z
  .array(z.object({ keyId: z.string().regex(KEY_ID_SHAPE), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict())
  .min(1)
  .max(MAX_RELEASE_KEYS);

/** the configured release public keys by id, or null when none (or a malformed file: never a guess) */
export async function loadReleaseKeys(env: NodeJS.ProcessEnv = process.env): Promise<Map<string, KeyObject> | null> {
  const file = env[AGENT_RELEASE_KEYS_ENV]?.trim();
  if (!file) return null;
  try {
    const parsed = releaseKeysSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success || new Set(parsed.data.map((k) => k.keyId)).size !== parsed.data.length) return null;
    return new Map(parsed.data.map((k) => [k.keyId, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" })]));
  } catch {
    return null;
  }
}

/** sha256 of a binary, cached by its path and file identity (size, mtime, inode): one hash per deployed file */
const hashCache = new Map<string, string>();
async function sha256File(p: string, ident: string): Promise<string> {
  const key = `${p}\u0000${ident}`;
  const hit = hashCache.get(key);
  if (hit) return hit;
  const h = createHash("sha256");
  await pipeline(createReadStream(p), h);
  const out = h.digest("hex");
  if (hashCache.size > 64) hashCache.clear();
  hashCache.set(key, out);
  return out;
}

/** one version's release for one platform, verified against the release keys, or why it cannot be offered */
export async function loadRelease(version: string, os: string, arch: string, env: NodeJS.ProcessEnv = process.env): Promise<Release | ReleaseRefusal> {
  const dir = env[AGENT_RELEASES_DIR_ENV]?.trim();
  const keys = await loadReleaseKeys(env);
  if (!dir || !keys) return "release_keys_unavailable";
  // the version is validated before it names a path, so no request reaches outside the release directory
  if (!VERSION_SHAPE.test(version) || !["linux", "darwin", "windows"].includes(os) || !["amd64", "arm64"].includes(arch)) return "release_not_found";
  const root = path.resolve(dir);
  const manifestPath = path.join(root, version, "release.json");
  let raw: string;
  try {
    const st = await lstat(manifestPath);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return "manifest_invalid";
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return "release_not_found";
  }
  let env1: z.infer<typeof envelopeSchema>;
  let payload: Buffer;
  try {
    const e = envelopeSchema.safeParse(JSON.parse(raw));
    if (!e.success) return "manifest_invalid";
    env1 = e.data;
    payload = Buffer.from(env1.payload, "base64");
    const sig = Buffer.from(env1.signature, "base64");
    const key = keys.get(env1.keyId);
    if (!key || sig.length !== 64 || payload.toString("base64") !== env1.payload || !verify(null, payload, key, sig)) return "manifest_invalid";
  } catch {
    return "manifest_invalid";
  }
  let manifest: z.infer<typeof manifestSchema>;
  try {
    const m = manifestSchema.safeParse(JSON.parse(payload.toString("utf8")));
    if (!m.success || m.data.version !== version) return "manifest_invalid";
    manifest = m.data;
  } catch {
    return "manifest_invalid";
  }
  const targets = manifest.targets.filter((t) => t.os === os && t.arch === arch);
  if (targets.length !== 1) return targets.length === 0 ? "no_target_for_platform" : "manifest_invalid";
  const target = targets[0]!;
  const binaryPath = path.join(root, version, `regulait-agent-${os}-${arch}`);
  try {
    const st = await lstat(binaryPath);
    if (!st.isFile() || st.size !== target.length) return "binary_mismatch";
    if ((await sha256File(binaryPath, `${st.size}:${st.mtimeMs}:${st.ino}`)) !== target.sha256) return "binary_mismatch";
  } catch {
    return "binary_mismatch";
  }
  return { manifest: env1, target, binaryPath };
}

// ---------------------------------------------------------------------------
// The directive
// ---------------------------------------------------------------------------

export interface UpdateDirectivePayload {
  schema: typeof UPDATE_DIRECTIVE_SCHEMA;
  deviceId: string;
  rolloutId: string;
  targetVersion: string;
  issuedAt: string;
  notAfter: string;
}

/** the exact payload bytes (the agent decodes strictly, so the member set is closed) */
export const updateDirectiveBytes = (d: Omit<UpdateDirectivePayload, "schema">): Buffer =>
  Buffer.from(JSON.stringify({ schema: UPDATE_DIRECTIVE_SCHEMA, deviceId: d.deviceId, rolloutId: d.rolloutId, targetVersion: d.targetVersion, issuedAt: d.issuedAt, notAfter: d.notAfter }), "utf8");
export const updateDirectiveSigningInput = (payload: Buffer): Buffer => Buffer.concat([UPDATE_DIRECTIVE_SIGNATURE_DOMAIN, payload]);

// ---------------------------------------------------------------------------
// Which rollout offers a device the update
// ---------------------------------------------------------------------------

interface Offer {
  rollout: typeof endpointUpdateRollouts.$inferSelect;
  device: typeof endpointDevices.$inferSelect;
}

/** the rollout that offers this device the update now, or null (every condition in the header) */
async function offerFor(db: Db, agent: EndpointAgentContext): Promise<Offer | null> {
  const [device] = await db.select().from(endpointDevices).where(eq(endpointDevices.id, agent.deviceId));
  if (!device || device.revokedAt) return null;
  const [rollout] = await db
    .select()
    .from(endpointUpdateRollouts)
    .where(and(eq(endpointUpdateRollouts.sourceId, agent.sourceId), eq(endpointUpdateRollouts.state, "running")));
  if (!rollout || device.agentVersion === rollout.targetVersion) return null;
  const stages = await db.select().from(endpointUpdateRolloutStages).where(eq(endpointUpdateRolloutStages.rolloutId, rollout.id)).orderBy(asc(endpointUpdateRolloutStages.ordinal));
  const groupIds = stages.map((s) => s.groupId).filter((g): g is string => g !== null);
  if (groupIds.length === 0) return null;
  const mine = new Set(
    (await db.select({ g: endpointDeviceGroupMembers.groupId }).from(endpointDeviceGroupMembers).where(and(eq(endpointDeviceGroupMembers.deviceId, device.id), inArray(endpointDeviceGroupMembers.groupId, groupIds)))).map((r) => r.g),
  );
  // a device is offered the update by the first stage, in ordinal order, whose group holds it (ADR-0360 §3)
  const stage = stages.find((s) => s.groupId !== null && mine.has(s.groupId));
  if (!stage || (stage.state !== "active" && stage.state !== "done")) return null;
  const [on] = await db
    .select({ on: endpointDeviceGroupFleetSettings.selfUpdate })
    .from(endpointDeviceGroupFleetSettings)
    .where(eq(endpointDeviceGroupFleetSettings.groupId, stage.groupId!));
  if (!on?.on) return null;
  return { rollout, device };
}

/** a guarded attempt write: only from the event's declared source states; null when the row moved underneath */
/** a column value or a SQL expression (now(), an interval from now) */
type AttemptSet = { [K in keyof typeof endpointUpdateAttempts.$inferInsert]?: (typeof endpointUpdateAttempts.$inferInsert)[K] | ReturnType<typeof sql> };
async function moveAttempt(db: Db, id: string, event: EndpointUpdateAttemptEvent, set: AttemptSet = {}): Promise<EndpointUpdateAttemptRow | null> {
  const [row] = await db
    .update(endpointUpdateAttempts)
    .set({ ...set, state: ENDPOINT_UPDATE_ATTEMPT_MACHINE.def.transitions[event].to, updatedAt: sql`now()` })
    .where(and(eq(endpointUpdateAttempts.id, id), whereFrom(endpointUpdateAttempts.state, ENDPOINT_UPDATE_ATTEMPT_MACHINE, event)))
    .returning();
  return row ?? null;
}

const expiresIn = sql`now() + make_interval(hours => ${ENDPOINT_UPDATE_ATTEMPT_TTL_HOURS})`;

/** the device's open attempt for the rollout: created, re-offered after expiry, or null once it is settled */
async function openAttempt(db: Db, offer: Offer): Promise<EndpointUpdateAttemptRow | null> {
  const where = and(eq(endpointUpdateAttempts.rolloutId, offer.rollout.id), eq(endpointUpdateAttempts.deviceId, offer.device.id));
  await db
    .insert(endpointUpdateAttempts)
    .values({ rolloutId: offer.rollout.id, deviceId: offer.device.id, fromVersion: offer.device.agentVersion, os: offer.device.os, arch: offer.device.arch, expiresAt: expiresIn })
    .onConflictDoNothing();
  const [a] = await db.select().from(endpointUpdateAttempts).where(where);
  if (!a) return null;
  if (a.state === "expired") return moveAttempt(db, a.id, "redirect", { expiresAt: expiresIn, fromVersion: offer.device.agentVersion, code: null });
  return a.state === "directed" && a.expiresAt.getTime() > Date.now() ? a : null;
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

export interface UpdateRouteDeps {
  agentOf: (req: FastifyRequest, reply: FastifyReply) => Promise<EndpointAgentContext | null>;
  refuse: (reply: FastifyReply, status: number, code: string) => FastifyReply | Promise<FastifyReply>;
  jsonOf: (body: unknown) => unknown;
  /** `(db, sourceId, ruleId, effect, reason, detail)`: one audit row (the agent scope's writer, with the device's actor) */
  audit: (t: Db, sourceId: string, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) => Promise<unknown>;
  /** injected for tests; otherwise the device-policy key as configured now (a rotation applies at once) */
  signer?: DirectiveSigner | null | undefined;
  env?: NodeJS.ProcessEnv;
}

const OUTCOME_EVENT = {
  installed: "report_installed",
  up_to_date: "report_current",
  refused: "report_refused",
  not_configured: "report_refused",
  nothing_to_do: "report_refused",
  failed: "report_failed",
  rolled_back: "report_rolled_back",
} as const satisfies Record<string, EndpointUpdateAttemptEvent>;
const resultSchema = z
  .object({
    attemptId: z.string().uuid(),
    result: z
      .object({
        schema: z.literal(UPDATE_RESULT_SCHEMA),
        outcome: z.enum(Object.keys(OUTCOME_EVENT) as [keyof typeof OUTCOME_EVENT, ...(keyof typeof OUTCOME_EVENT)[]]),
        code: z.string().regex(CODE_SHAPE).optional(),
        rolloutId: z.string().uuid().optional(),
        fromVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
        toVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).optional(),
        at: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();
/** the outcomes that count toward the rollout's halt threshold */
const HALTING = ["failed", "rolled_back"] as const;

export function registerEndpointUpdateRoutes(scope: FastifyInstance, db: Db, deps: UpdateRouteDeps): void {
  // RLS (ADR-0234): the rollout and attempt tables admit an admin or `system_task`; each device route enters
  // `system_task` and every query is scoped to the calling device (from its token, never a parameter)
  const asSystem = <T>(label: string, fn: () => Promise<T>) => runWithRlsSystem("system_task", `endpoint-update.${label}`, fn);
  const env = () => deps.env ?? process.env;

  scope.get(ENDPOINT_UPDATE_PATHS.update, async (req, reply) => {
    const agent = await deps.agentOf(req, reply);
    if (!agent) return reply;
    return asSystem("offer", async () => {
      const offer = await offerFor(db, agent);
      // nothing to offer is the common answer on every sync, and is not audited
      if (!offer) return reply.send({ update: null });
      const release = await loadRelease(offer.rollout.targetVersion, offer.device.os, offer.device.arch, env());
      const detail = { deviceId: agent.deviceId, rolloutId: offer.rollout.id, targetVersion: offer.rollout.targetVersion };
      if (typeof release === "string") {
        // a release that is missing or does not verify is never offered; the admin sees why in the audit stream
        await deps.audit(db, agent.sourceId, "endpoint-update-offer-refused", "deny", `an update was not offered to a device: ${release} (ADR-0360)`, { ...detail, code: release });
        return reply.send({ update: null });
      }
      const signer = deps.signer !== undefined ? deps.signer : await resolveDirectiveSigner(env());
      if (!signer || !KEY_ID_SHAPE.test(signer.keyId)) {
        await deps.audit(db, agent.sourceId, "endpoint-update-offer-refused", "deny", "an update was not offered to a device: update_signer_unavailable (ADR-0360)", { ...detail, code: "update_signer_unavailable" });
        return deps.refuse(reply, 503, "update_signer_unavailable");
      }
      const attempt = await openAttempt(db, offer);
      if (!attempt) return reply.send({ update: null });
      const now = await databaseNow(db);
      const notAfter = new Date(Math.min(now.getTime() + UPDATE_DIRECTIVE_LIFETIME_MINUTES * 60_000, attempt.expiresAt.getTime()));
      const bytes = updateDirectiveBytes({ deviceId: offer.device.id, rolloutId: offer.rollout.id, targetVersion: offer.rollout.targetVersion, issuedAt: now.toISOString(), notAfter: notAfter.toISOString() });
      let signature: Buffer;
      try {
        // signing is the external write: the execution dial is re-read immediately before it (ADR-0338)
        signature = await runExternalWrite(db, "device_policy.sign_payload", () => signer.signPayload(updateDirectiveSigningInput(bytes)));
      } catch (e) {
        if (e instanceof ExternalEffectBlockedError) {
          await deps.audit(db, agent.sourceId, "endpoint-update-offer-refused", "deny", `an update was not offered to a device: ${e.code}, the execution dial stops delivery (ADR-0360)`, { ...detail, code: e.code });
          return reply.send({ update: null });
        }
        throw e;
      }
      if (!Buffer.isBuffer(signature) || signature.length !== 64) throw new Error("the device-policy signer returned no Ed25519 signature");
      await deps.audit(db, agent.sourceId, "endpoint-update-offered", "allow", `a device was offered the agent update to ${offer.rollout.targetVersion} (ADR-0360)`, { ...detail, attemptId: attempt.id, keyId: signer.keyId, notAfter: notAfter.toISOString() });
      reply.header("cache-control", "no-store");
      return reply.send({
        update: {
          attemptId: attempt.id,
          directive: { keyId: signer.keyId, payload: bytes.toString("base64"), signature: signature.toString("base64") },
          manifest: release.manifest,
          binary: { path: ENDPOINT_UPDATE_PATHS.binary, os: release.target.os, arch: release.target.arch, length: release.target.length, sha256: release.target.sha256 },
        },
      });
    });
  });

  scope.get(ENDPOINT_UPDATE_PATHS.binary, async (req, reply) => {
    const agent = await deps.agentOf(req, reply);
    if (!agent) return reply;
    return asSystem("binary", async () => {
      // only the binary of the device's own open offer: its rollout, its platform
      const offer = await offerFor(db, agent);
      const [attempt] = offer
        ? await db.select().from(endpointUpdateAttempts).where(and(eq(endpointUpdateAttempts.rolloutId, offer.rollout.id), eq(endpointUpdateAttempts.deviceId, agent.deviceId), eq(endpointUpdateAttempts.state, "directed")))
        : [];
      if (!offer || !attempt || attempt.expiresAt.getTime() <= Date.now()) return deps.refuse(reply, 404, "no_open_update");
      const release = await loadRelease(offer.rollout.targetVersion, offer.device.os, offer.device.arch, env());
      if (typeof release === "string") return deps.refuse(reply, 404, "no_open_update");
      const fh = await open(release.binaryPath, "r");
      await deps.audit(db, agent.sourceId, "endpoint-update-binary-served", "allow", `a device downloaded the agent binary ${offer.rollout.targetVersion} (ADR-0360)`, { deviceId: agent.deviceId, rolloutId: offer.rollout.id, attemptId: attempt.id, length: release.target.length });
      reply.header("content-type", "application/octet-stream");
      reply.header("content-length", String(release.target.length));
      reply.header("cache-control", "no-store");
      return reply.send(fh.createReadStream({ start: 0, end: release.target.length - 1 }));
    });
  });

  scope.post(ENDPOINT_UPDATE_PATHS.results, { bodyLimit: RESULTS_BODY_LIMIT }, async (req, reply) => {
    const agent = await deps.agentOf(req, reply);
    if (!agent) return reply;
    const parsed = resultSchema.safeParse(deps.jsonOf(req.body));
    if (!parsed.success) {
      await deps.audit(db, agent.sourceId, "endpoint-update-result-refused", "deny", "an endpoint agent's update result was refused: invalid_body (ADR-0360)", { deviceId: agent.deviceId, code: "invalid_body" });
      return deps.refuse(reply, 400, "invalid_body");
    }
    const { attemptId, result } = parsed.data;
    type Answer = { status: number; body: Record<string, unknown> };
    const answer: Answer = await asSystem("result", () =>
      db.transaction(async (rawTx): Promise<Answer> => {
        const tx = rawTx as unknown as Db;
        const [a] = await tx.select().from(endpointUpdateAttempts).where(and(eq(endpointUpdateAttempts.id, attemptId), eq(endpointUpdateAttempts.deviceId, agent.deviceId))).for("update");
        // another device's attempt reads as no attempt at all
        if (!a) return { status: 404, body: { error: "no_such_attempt" } };
        const [r] = await tx.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, a.rolloutId)).for("update");
        if (result.rolloutId && result.rolloutId !== a.rolloutId) return { status: 400, body: { error: "rollout_mismatch" } };
        if (result.outcome === "installed" && result.toVersion !== r!.targetVersion) return { status: 400, body: { error: "version_mismatch" } };
        const event = OUTCOME_EVENT[result.outcome];
        if (!ENDPOINT_UPDATE_ATTEMPT_MACHINE.can(a.state as (typeof a)["state"], event)) return { status: 409, body: { error: "already_reported", state: a.state } };
        const code = result.code ?? (result.outcome === "not_configured" || result.outcome === "nothing_to_do" ? result.outcome : null);
        const moved = await moveAttempt(tx, a.id, event, { code, reportedAt: sql`now()` });
        if (!moved) return { status: 409, body: { error: "already_reported" } };
        const halting = (HALTING as readonly string[]).includes(moved.state);
        await deps.audit(tx, agent.sourceId, `endpoint-update-${moved.state.replace("_", "-")}`, halting ? "deny" : "allow", `a device reported its agent update to ${r!.targetVersion}: ${moved.state}${code ? ` (${code})` : ""} (ADR-0360)`, {
          deviceId: agent.deviceId,
          rolloutId: a.rolloutId,
          attemptId: a.id,
          event,
          from: a.state,
          to: moved.state,
          ...(code ? { code } : {}),
        });
        let halted = false;
        if (halting && r!.state === "running") {
          const [{ n }] = (await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(endpointUpdateAttempts)
            .where(and(eq(endpointUpdateAttempts.rolloutId, a.rolloutId), inArray(endpointUpdateAttempts.state, [...HALTING])))) as [{ n: number }];
          if (n >= r!.haltThreshold) {
            const stopped = await tx
              .update(endpointUpdateRollouts)
              .set({ state: ENDPOINT_ROLLOUT_MACHINE.def.transitions.halt.to, updatedAt: sql`now()` })
              .where(and(eq(endpointUpdateRollouts.id, a.rolloutId), whereFrom(endpointUpdateRollouts.state, ENDPOINT_ROLLOUT_MACHINE, "halt")))
              .returning({ id: endpointUpdateRollouts.id });
            if (stopped.length === 1) {
              halted = true;
              await deps.audit(tx, r!.sourceId, "endpoint-update-rollout-halt", "deny", `update rollout to ${r!.targetVersion} halted: ${n} failed install(s) or rollback(s) reached its threshold of ${r!.haltThreshold} (ADR-0360)`, {
                rolloutId: a.rolloutId,
                event: "halt",
                from: "running",
                to: "halted",
                failures: n,
                haltThreshold: r!.haltThreshold,
              });
            }
          }
        }
        return { status: 200, body: { recorded: true, state: moved.state, ...(halted ? { rolloutHalted: true } : {}) } };
      }),
    );
    if (answer.status !== 200) {
      await deps.audit(db, agent.sourceId, "endpoint-update-result-refused", "deny", `an endpoint agent's update result was refused: ${String(answer.body.error)} (ADR-0360)`, { deviceId: agent.deviceId, attemptId, code: answer.body.error });
    }
    return reply.status(answer.status).send(answer.body);
  });
}

// ---------------------------------------------------------------------------
// The expiry job: nothing waits for ever (review lessons of #979)
// ---------------------------------------------------------------------------

async function auditSystem(db: Db, sourceId: string, ruleId: string, reason: string, detail: Record<string, unknown>) {
  await db.insert(auditLog).values({ userId: NIL_UUID, objectType: "discovery_source", objectId: sourceId, detail: { subsystem: "endpoint-fleet", adr: "0360", ...detail }, effect: "allow", ruleId, ruleChain: [], reason });
}

/** expire attempts no device reported, and start or resume requests nobody decided; returns how many moved */
export async function expireEndpointUpdates(db: Db): Promise<{ attempts: number; requests: number }> {
  let attempts = 0;
  const due = await db
    .select({ a: endpointUpdateAttempts, sourceId: endpointUpdateRollouts.sourceId })
    .from(endpointUpdateAttempts)
    .innerJoin(endpointUpdateRollouts, eq(endpointUpdateRollouts.id, endpointUpdateAttempts.rolloutId))
    .where(and(eq(endpointUpdateAttempts.state, "directed"), lt(endpointUpdateAttempts.expiresAt, sql`now()`)))
    .limit(500);
  for (const { a, sourceId } of due) {
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      if (await moveAttempt(tx, a.id, "expire")) {
        attempts++;
        await auditSystem(tx, sourceId, "endpoint-update-attempt-expired", `a device reported nothing for its agent update within ${ENDPOINT_UPDATE_ATTEMPT_TTL_HOURS} hours (ADR-0360)`, { deviceId: a.deviceId, rolloutId: a.rolloutId, attemptId: a.id, event: "expire" });
      }
    });
  }
  let requests = 0;
  const waiting = await db
    .select()
    .from(endpointUpdateRollouts)
    .where(and(inArray(endpointUpdateRollouts.state, ["start_requested", "resume_requested"]), lt(endpointUpdateRollouts.approvalRequestedAt, sql`now() - make_interval(hours => ${ENDPOINT_ROLLOUT_DECISION_TTL_HOURS})`)))
    .limit(100);
  for (const r of waiting) {
    const event = r.state === "start_requested" ? "expire_start" : "expire_resume";
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const moved = await tx
        .update(endpointUpdateRollouts)
        .set({ state: ENDPOINT_ROLLOUT_MACHINE.def.transitions[event].to, updatedAt: sql`now()` })
        .where(and(eq(endpointUpdateRollouts.id, r.id), whereFrom(endpointUpdateRollouts.state, ENDPOINT_ROLLOUT_MACHINE, event)))
        .returning({ id: endpointUpdateRollouts.id });
      if (moved.length === 1) {
        requests++;
        await auditSystem(tx, r.sourceId, `endpoint-update-rollout-${event.replace("_", "-")}`, `update rollout to ${r.targetVersion}: the ${event === "expire_start" ? "start" : "resume"} request expired undecided after ${ENDPOINT_ROLLOUT_DECISION_TTL_HOURS} hours (ADR-0360)`, {
          rolloutId: r.id,
          event,
          from: r.state,
          to: ENDPOINT_ROLLOUT_MACHINE.def.transitions[event].to,
          requestedBy: r.approvalRequestedBy,
        });
      }
    });
  }
  return { attempts, requests };
}

export function endpointUpdateJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: "endpoint-update-expiry",
      description: "ADR-0360: expire update attempts no device reported, and rollout start or resume requests nobody decided",
      adr: "ADR-0360",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const out = await expireEndpointUpdates(ctx.db);
        return { itemsProcessed: out.attempts + out.requests, detail: out };
      },
    },
  ];
}
