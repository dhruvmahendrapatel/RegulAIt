/**
 * ADR-0310 (G2) — the "Managed" rung of the IDE ladder: compile a user's or role's effective MCP entitlements into
 * vendor-native managed settings and export them as a signed, versioned bundle an admin pushes through MDM.
 *
 * Pillar 1 stays the source of truth. The policy is resolved with the kernel's own `visibleTools` over the registry
 * (the same filter `tools/list` applies), so a bundle can never admit a server the gateway would not serve the subject.
 * Each entitled server is named by its governed gateway URL; the gateway still decides every call. A subject with no
 * entitled server gets an explicit deny-all (ADR-0180 secure default). This is a different mechanism from ADR-0298
 * (on-device hooks): nothing here runs on a device.
 *
 *   POST /v1/managed-settings/bundles                 {subject:{kind,id}, claudeCodeMinimumVersion?}  compile, sign, audit
 *   GET  /v1/managed-settings/bundles                 ?subjectKind&subjectId&limit&before  list (keyset, newest first)
 *   GET  /v1/managed-settings/bundles/:id/archive     the signed tar.gz (manifest.json, manifest.json.sig, vendor files)
 *
 * A bundle is signed with the export signing key (REGULAIT_EXPORT_SIGNING_KEY / _ID, ADR-0041 export-bundle.ts). With
 * no key configured the export is REFUSED: an unsigned bundle is exactly what an attacker would push. With no public
 * URL configured it is refused too, because the allowlist would have nothing true to name.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  managedSettingsBundleFiles,
  managedSettingsBundles,
  mcpServers,
  mcpTools,
  or,
  roles,
  roleServerGrants,
  roleToolGrants,
  sql,
  users,
  type Db,
} from "@regulait/db";
import {
  canonicalPolicyJson,
  compileManagedSettings,
  MANAGED_SETTINGS_SCHEMA,
  ManagedSettingsCompileError,
  type EffectiveMcpPolicy,
  type EffectiveMcpServer,
} from "@regulait/shared";
import { visibleTools, type Entitlements, type ToolRef } from "@regulait/policy-kernel";
import { loadEntitlements } from "./entitlements.js";
import { admissionHidesTools } from "./mcp-admission.js";
import { buildTarGz, resolveExportSigningKey } from "./export-bundle.js";
import { joinPublicUrl, resolvePublicUrl } from "./public-url.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export type ManagedSubject = { kind: "user" | "role"; id: string };

/** Where each vendor reads the file (documented in ADR-0310; carried in the manifest so the bundle is self-describing). */
export const MANAGED_SETTINGS_INSTALL = {
  "claude-code": {
    macos: "/Library/Application Support/ClaudeCode/managed-settings.json (or MDM domain com.anthropic.claudecode)",
    linux: "/etc/claude-code/managed-settings.json",
    windows: "C:\\Program Files\\ClaudeCode\\managed-settings.json (or HKLM\\SOFTWARE\\Policies\\ClaudeCode value Settings)",
  },
  "github-copilot": {
    server: ".github-private repository: copilot/managed-settings.json",
    macos: "/Library/Application Support/GitHubCopilot/managed-settings.json",
    linux: "/etc/github-copilot/managed-settings.json",
    windows: "%ProgramFiles%\\GitHubCopilot\\managed-settings.json",
  },
  "openai-codex": {
    macos: "/etc/codex/requirements.toml (or MDM domain com.openai.codex key requirements_toml_base64)",
    linux: "/etc/codex/requirements.toml",
    windows: "%ProgramData%\\OpenAI\\Codex\\requirements.toml",
  },
  cursor: { dashboard: "team dashboard > MCP Configuration (Enterprise); apply the worksheet by hand" },
} as const;

/**
 * The subject's effective MCP policy: every enabled, admitted server on which the kernel shows the subject at least one
 * un-halted tool, with those tool names. A disabled user resolves to nothing (deny all).
 *
 * One entitlement load per server that has tools: bounded by the registry size, the same cost `tools/list` pays.
 */
export async function loadEffectiveMcpPolicy(db: Db, subject: ManagedSubject, publicUrl: string): Promise<EffectiveMcpPolicy> {
  const empty: EffectiveMcpPolicy = { subject, servers: [] };
  if (subject.kind === "user") {
    const [u] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, subject.id));
    if (!u || u.disabledAt) return empty;
  }
  const servers = await db
    .select({ id: mcpServers.id, name: mcpServers.name })
    .from(mcpServers)
    .where(isNull(mcpServers.disabledAt));
  if (servers.length === 0) return empty;
  const tools = await db
    .select({ serverId: mcpTools.serverId, name: mcpTools.name, kind: mcpTools.kind })
    .from(mcpTools)
    .where(and(inArray(mcpTools.serverId, servers.map((s) => s.id)), isNull(mcpTools.haltedAt)));
  const byServer = new Map<string, ToolRef[]>();
  for (const t of tools) byServer.set(t.serverId, [...(byServer.get(t.serverId) ?? []), { serverId: t.serverId, name: t.name, kind: t.kind }]);

  const out: EffectiveMcpServer[] = [];
  for (const s of servers) {
    const refs = byServer.get(s.id);
    if (!refs || refs.length === 0) continue;
    if (await admissionHidesTools(db, s.id)) continue;
    let visible: ToolRef[];
    if (subject.kind === "user") {
      visible = visibleTools(subject.id, s.id, refs, await loadEntitlements(db, subject.id, s.id));
    } else {
      // a role's own grants only: what every holder of the role gets, before their personal grants and revocations
      const [rt, rs] = await Promise.all([
        db.select().from(roleToolGrants).where(and(eq(roleToolGrants.roleId, subject.id), eq(roleToolGrants.serverId, s.id))),
        db.select().from(roleServerGrants).where(and(eq(roleServerGrants.roleId, subject.id), eq(roleServerGrants.serverId, s.id))),
      ]);
      const ent: Entitlements = {
        toolGrants: [],
        serverGrants: [],
        roleToolGrants: rt.map((g) => ({ ...g, roleName: null })),
        roleServerGrants: rs.map((g) => ({ ...g, roleName: null })),
        revocations: [],
      };
      visible = visibleTools(`role:${subject.id}`, s.id, refs, ent);
    }
    if (visible.length === 0) continue;
    out.push({ serverId: s.id, name: s.name, gatewayUrl: joinPublicUrl(publicUrl, `/mcp/${s.id}`), tools: visible.map((t) => t.name) });
  }
  return { subject, servers: out };
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export type BundleOutcome =
  | { ok: true; created: boolean; bundle: BundleView }
  | { ok: false; status: number; error: string; detail: string };

export interface BundleView {
  id: string;
  subject: ManagedSubject;
  version: number;
  policyDigest: string;
  keyId: string;
  serverCount: number;
  createdAt: string;
}

const view = (r: typeof managedSettingsBundles.$inferSelect): BundleView => {
  const m = JSON.parse(r.manifest) as { servers?: number };
  return {
    id: r.id,
    subject: { kind: r.subjectKind, id: (r.subjectKind === "user" ? r.userId : r.roleId) as string },
    version: r.version,
    policyDigest: r.policyDigest,
    keyId: r.keyId,
    serverCount: typeof m.servers === "number" ? m.servers : 0,
    createdAt: r.createdAt.toISOString(),
  };
};

/**
 * Compile, sign and store a bundle for `subject`, or return the latest one when the compiled policy is unchanged.
 * Serialised per subject (advisory lock) so two exports never take the same version.
 */
export async function exportManagedSettingsBundle(
  db: Db,
  subject: ManagedSubject,
  opts: { actorUserId: string | null; claudeCodeMinimumVersion?: string },
): Promise<BundleOutcome> {
  const publicUrl = resolvePublicUrl();
  if (!publicUrl) {
    return { ok: false, status: 409, error: "public_url_unset", detail: "REGULAIT_PUBLIC_URL is not set, so the gateway URL a managed allowlist must name is unknown" };
  }
  const key = resolveExportSigningKey();
  if (!key.ok) return { ok: false, status: 409, error: key.ruleId, detail: key.reason };

  if (subject.kind === "user") {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, subject.id));
    if (!u) return { ok: false, status: 404, error: "subject_not_found", detail: "no user with that id" };
  } else {
    const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, subject.id));
    if (!r) return { ok: false, status: 404, error: "subject_not_found", detail: "no role with that id" };
  }

  const policy = await loadEffectiveMcpPolicy(db, subject, publicUrl);
  let files;
  try {
    files = compileManagedSettings(policy, { claudeCodeMinimumVersion: opts.claudeCodeMinimumVersion });
  } catch (e) {
    // only the compiler's own fixed messages are returned; anything else is a bug and propagates (500, no text)
    if (e instanceof ManagedSettingsCompileError) return { ok: false, status: 422, error: "compile_refused", detail: e.message };
    throw e;
  }
  // the digest covers the options too: a new minimum version is a new bundle
  const policyDigest = `sha256:${sha256(`${canonicalPolicyJson(policy)}\n${opts.claudeCodeMinimumVersion ?? ""}`)}`;
  const subjectCol = subject.kind === "user" ? managedSettingsBundles.userId : managedSettingsBundles.roleId;

  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`managed-settings:${subject.kind}:${subject.id}`}))`);
    const [latest] = await t.select().from(managedSettingsBundles).where(eq(subjectCol, subject.id)).orderBy(desc(managedSettingsBundles.version)).limit(1);
    if (latest && latest.policyDigest === policyDigest) return { ok: true as const, created: false, bundle: view(latest) };

    const version = (latest?.version ?? 0) + 1;
    // the database clock, never the process clock (mistakes ledger: timestamps on rows come from now())
    const clock = (await t.execute(
      sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now, gen_random_uuid()::text AS id`,
    )) as unknown as { rows: Array<{ now: string; id: string }> };
    const { now, id } = clock.rows[0]!;
    const manifest = `${JSON.stringify(
      {
        schema: MANAGED_SETTINGS_SCHEMA,
        bundleId: id,
        subject,
        version,
        generatedAt: now,
        policyDigest,
        servers: policy.servers.length,
        signing: { alg: "Ed25519", keyId: key.keyId, publicKeyFingerprint: key.fingerprint },
        files: files.map((f) => ({ path: f.path, vendor: f.vendor, delivery: f.delivery, sha256: sha256(f.body), bytes: Buffer.byteLength(f.body) })),
        install: MANAGED_SETTINGS_INSTALL,
      },
      null,
      2,
    )}\n`;
    const signature = key.sign(Buffer.from(manifest, "utf8")).toString("base64");
    const [row] = await t
      .insert(managedSettingsBundles)
      .values({
        id,
        subjectKind: subject.kind,
        userId: subject.kind === "user" ? subject.id : null,
        roleId: subject.kind === "role" ? subject.id : null,
        version,
        policyDigest,
        manifest,
        signature,
        keyId: key.keyId,
        createdBy: opts.actorUserId,
      })
      .returning();
    await t.insert(managedSettingsBundleFiles).values(files.map((f) => ({ bundleId: id, path: f.path, body: f.body, sha256: sha256(f.body) })));
    await t.insert(auditLog).values({
      userId: opts.actorUserId ?? NIL_UUID,
      objectType: "managed_settings_bundle",
      objectId: id,
      detail: { subsystem: "managed-settings", adr: "0310", subjectKind: subject.kind, subjectId: subject.id, version, policyDigest, keyId: key.keyId, servers: policy.servers.length },
      effect: "allow",
      ruleId: "managed-settings-bundle-exported",
      ruleChain: [],
      reason: `managed-settings bundle v${version} for ${subject.kind} ${subject.id} compiled from ${policy.servers.length} entitled MCP server(s) and signed with key '${key.keyId}' (ADR-0310)`,
    });
    return { ok: true as const, created: true, bundle: view(row!) };
  });
}

/** The signed archive: manifest.json, manifest.json.sig and every vendor file, byte-identical on every download. */
export async function managedSettingsArchive(db: Db, bundleId: string): Promise<{ name: string; body: Buffer } | null> {
  const [b] = await db.select().from(managedSettingsBundles).where(eq(managedSettingsBundles.id, bundleId));
  if (!b) return null;
  const files = await db.select().from(managedSettingsBundleFiles).where(eq(managedSettingsBundleFiles.bundleId, bundleId)).orderBy(managedSettingsBundleFiles.path);
  const body = buildTarGz([
    { path: "manifest.json", body: Buffer.from(b.manifest, "utf8") },
    { path: "manifest.json.sig", body: Buffer.from(`${b.signature}\n`, "utf8") },
    ...files.map((f) => ({ path: f.path, body: Buffer.from(f.body, "utf8") })),
  ]);
  return { name: `regulait-managed-settings-${b.subjectKind}-v${b.version}.tar.gz`, body };
}

const subjectSchema = z.object({ kind: z.enum(["user", "role"]), id: z.string().uuid() }).strict();
const exportBody = z
  .object({ subject: subjectSchema, claudeCodeMinimumVersion: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/).optional() })
  .strict();
const listQuery = z
  .object({
    subjectKind: z.enum(["user", "role"]).optional(),
    subjectId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().uuid().optional(),
  })
  .strict()
  .refine((q) => (q.subjectId === undefined) === (q.subjectKind === undefined), { message: "subjectKind and subjectId go together" });
const idParams = z.object({ id: z.string().uuid() }).strict();

const refuse = (reply: FastifyReply, status: number, error: string, detail: string) => reply.status(status).send({ error, detail });
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

/** Admin-only by the app-level default (none of these is in NON_ADMIN_ROUTES). */
export function registerManagedSettingsRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? null;

  app.post("/v1/managed-settings/bundles", async (req, reply) => {
    const b = exportBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_body", issues(b.error));
    const out = await exportManagedSettingsBundle(db, b.data.subject, { actorUserId: actor(req), claudeCodeMinimumVersion: b.data.claudeCodeMinimumVersion });
    if (!out.ok) return refuse(reply, out.status, out.error, out.detail);
    return reply.status(out.created ? 201 : 200).send({ ...out.bundle, created: out.created });
  });

  app.get("/v1/managed-settings/bundles", async (req, reply) => {
    const q = listQuery.safeParse(req.query ?? {});
    if (!q.success) return refuse(reply, 400, "invalid_query", issues(q.error));
    const { subjectKind, subjectId, limit, before } = q.data;
    const conds = [];
    if (subjectKind && subjectId) conds.push(eq(subjectKind === "user" ? managedSettingsBundles.userId : managedSettingsBundles.roleId, subjectId));
    if (before) {
      const [cur] = await db.select({ createdAt: managedSettingsBundles.createdAt }).from(managedSettingsBundles).where(eq(managedSettingsBundles.id, before));
      if (!cur) return refuse(reply, 400, "invalid_cursor", "the 'before' bundle does not exist");
      conds.push(
        or(
          lt(managedSettingsBundles.createdAt, cur.createdAt),
          and(eq(managedSettingsBundles.createdAt, cur.createdAt), lt(managedSettingsBundles.id, before)),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(managedSettingsBundles)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(managedSettingsBundles.createdAt), desc(managedSettingsBundles.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return { bundles: page.map(view), next: rows.length > limit ? page[page.length - 1]!.id : null };
  });

  app.get("/v1/managed-settings/bundles/:id/archive", async (req, reply) => {
    const p = idParams.safeParse(req.params ?? {});
    if (!p.success) return refuse(reply, 400, "invalid_params", issues(p.error));
    const a = await managedSettingsArchive(db, p.data.id);
    if (!a) return refuse(reply, 404, "bundle_not_found", "no managed-settings bundle with that id");
    return reply
      .header("content-type", "application/gzip")
      .header("content-disposition", `attachment; filename="${a.name}"`)
      .header("cache-control", "no-store")
      .send(a.body);
  });
}
