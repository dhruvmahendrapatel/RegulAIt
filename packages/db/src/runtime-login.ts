/**
 * ADR-0234 batch 7b: the runtime login.
 *
 * The gateway serves requests on a dedicated login that is a member of `regulait_app` and cannot step out of the
 * row-level-security policies. `runtimeLoginProblems` names everything that would let it: being a superuser, having
 * BYPASSRLS or CREATEROLE, owning a table with row-level security, or being a MEMBER (directly or through other roles)
 * of a role that is any of those. Membership matters because a member may `SET ROLE` to the role it is a member of:
 * a login that is a member of the table owner could `SET ROLE` to it and turn the policies off. The same is checked
 * for `regulait_app` itself, which every RLS scope switches to. A login the check passes therefore has no `SET ROLE`
 * open to it that leaves the policies: not to the owner, not to a BYPASSRLS or superuser role.
 *
 * The owner (migrator) login keeps the schema and the two jobs that need it (the migrations and the audit prune).
 *
 * This module only talks to Postgres: `inspectRuntimeLogin` reads what the connected login is, `provisionRuntimeLogin`
 * creates (or re-keys and repairs) the login through the owner connection, and `withRuntimeLoginLock` serialises
 * provisioning across booting replicas. Where its connection string is kept is the gateway's business.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { RLS_APP_ROLE } from "./rls.js";
import { SESSION_LOCK_KEYS, withSessionAdvisoryLock, type RawQueryable } from "./session-lock.js";

export type { RawQueryable } from "./session-lock.js";

/** the runtime login's name is this prefix and the database it serves (`runtimeLoginRoleFor`) */
export const RUNTIME_LOGIN_ROLE_PREFIX = "regulait_runtime_";

const PG_NAME_MAX = 63;

/**
 * The runtime login for a database: one per database, so two databases on one cluster never re-key each other's
 * login (roles are cluster-wide). `regulait_runtime_<db>` with the name lowercased and reduced to [a-z0-9_]; when that
 * changed the name or it would pass Postgres's 63-byte limit, an 8-hex digest of the real name keeps it distinct.
 */
export function runtimeLoginRoleFor(database: string): string {
  const clean = database.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const room = PG_NAME_MAX - RUNTIME_LOGIN_ROLE_PREFIX.length;
  if (clean === database && clean.length <= room && clean.length > 0) return RUNTIME_LOGIN_ROLE_PREFIX + clean;
  const digest = createHash("sha256").update(database, "utf8").digest("hex").slice(0, 8);
  return `${RUNTIME_LOGIN_ROLE_PREFIX}${clean.slice(0, room - 9)}_${digest}`;
}

export interface RuntimeLoginFacts {
  /** current_user of the connection */
  login: string;
  superuser: boolean;
  bypassRls: boolean;
  /** CREATEROLE: could create or grant itself a privileged role */
  createRole: boolean;
  /** owns at least one table in `public` that has row-level security on (and could turn it off) */
  ownsRlsTable: boolean;
  /** roles other than itself the login is a member of (directly or not) that are superusers. Empty for a superuser. */
  memberOfSuperuser: string[];
  /** ... that have BYPASSRLS */
  memberOfBypassRls: string[];
  /** ... that own a row-level-security table */
  memberOfRlsOwner: string[];
  /** ... that have CREATEROLE */
  memberOfCreateRole: string[];
  /** may SET ROLE regulait_app (what every RLS scope does) */
  appMember: boolean;
  /** inherits regulait_app's grants without switching (what an unscoped statement relies on) */
  appInherited: boolean;
  /** what `regulait_app` itself is; null when the role does not exist */
  appRole: AppRoleFacts | null;
}

export interface AppRoleFacts {
  superuser: boolean;
  bypassRls: boolean;
  createRole: boolean;
  ownsRlsTable: boolean;
  memberOfSuperuser: string[];
  memberOfBypassRls: string[];
  memberOfRlsOwner: string[];
  memberOfCreateRole: string[];
}

const list = (names: string[]) => names.map((n) => `'${n}'`).join(", ");

function membershipProblems(who: string, f: Pick<AppRoleFacts, "memberOfSuperuser" | "memberOfBypassRls" | "memberOfRlsOwner" | "memberOfCreateRole">): string[] {
  const out: string[] = [];
  if (f.memberOfSuperuser.length) out.push(`${who} a member of superuser role ${list(f.memberOfSuperuser)} (SET ROLE would bypass every policy)`);
  if (f.memberOfBypassRls.length) out.push(`${who} a member of BYPASSRLS role ${list(f.memberOfBypassRls)} (SET ROLE would bypass every policy)`);
  if (f.memberOfRlsOwner.length) out.push(`${who} a member of ${list(f.memberOfRlsOwner)}, which owns a row-level-security table (SET ROLE could disable its policies)`);
  if (f.memberOfCreateRole.length) out.push(`${who} a member of CREATEROLE role ${list(f.memberOfCreateRole)} (could grant itself a privileged role)`);
  return out;
}

/** what is wrong with a login as the runtime login; empty when it is fit */
export function runtimeLoginProblems(f: RuntimeLoginFacts): string[] {
  const out: string[] = [];
  if (f.superuser) out.push("is a superuser (bypasses every row-level security policy)");
  if (f.bypassRls) out.push("has BYPASSRLS (bypasses every row-level security policy)");
  if (f.createRole) out.push("has CREATEROLE (could grant itself a privileged role)");
  if (f.ownsRlsTable) out.push("owns a row-level-security table (could disable its policies)");
  out.push(...membershipProblems("is", f));
  if (!f.appMember) out.push(`is not a member of ${RLS_APP_ROLE} (no RLS scope could run)`);
  else if (!f.appInherited) out.push(`does not inherit ${RLS_APP_ROLE}'s privileges (NOINHERIT)`);
  const a = f.appRole;
  if (a) {
    const who = `its ${RLS_APP_ROLE} role`;
    if (a.superuser) out.push(`${who} is a superuser (every RLS scope would bypass the policies)`);
    if (a.bypassRls) out.push(`${who} has BYPASSRLS (every RLS scope would bypass the policies)`);
    if (a.createRole) out.push(`${who} has CREATEROLE (could grant itself a privileged role)`);
    if (a.ownsRlsTable) out.push(`${who} owns a row-level-security table (could disable its policies)`);
    out.push(...membershipProblems(`${who} is`, a));
  }
  return out;
}

type Exec = { execute: (q: ReturnType<typeof sql>) => PromiseLike<unknown> };

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/**
 * Read what the connected login is. One statement, no side effects. The row-level-security tables are every table in
 * `public` with `relrowsecurity` on, read from the catalogue (never a list kept here). A superuser is a member of every
 * role, so its membership lists are left empty: "is a superuser" already says it all.
 */
export async function inspectRuntimeLogin(db: Exec): Promise<RuntimeLoginFacts> {
  const res = (await db.execute(sql`
    with rls_owner as (
      select distinct c.relowner as oid from pg_catalog.pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relrowsecurity and c.relkind in ('r', 'p')
    ), priv as (
      select x.oid, x.rolname::text as name, x.rolsuper, x.rolbypassrls, x.rolcreaterole,
             exists (select 1 from rls_owner o where o.oid = x.oid) as owns_rls
        from pg_catalog.pg_roles x
    ), who as (
      select r.oid, r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, 'login' as kind from pg_catalog.pg_roles r where r.rolname = current_user
      union all
      select a.oid, a.rolname, a.rolsuper, a.rolbypassrls, a.rolcreaterole, 'app' from pg_catalog.pg_roles a where a.rolname = ${RLS_APP_ROLE}
    )
    select w.kind, w.rolname::text as login, w.rolsuper as superuser, w.rolbypassrls as bypass_rls, w.rolcreaterole as create_role,
           exists (select 1 from rls_owner o where o.oid = w.oid) as owns_rls_table,
           coalesce((select array_agg(p.name order by p.name) from priv p where not w.rolsuper and p.oid <> w.oid and p.rolsuper and pg_catalog.pg_has_role(w.oid, p.oid, 'MEMBER')), '{}'::text[]) as m_super,
           coalesce((select array_agg(p.name order by p.name) from priv p where not w.rolsuper and p.oid <> w.oid and p.rolbypassrls and pg_catalog.pg_has_role(w.oid, p.oid, 'MEMBER')), '{}'::text[]) as m_bypass,
           coalesce((select array_agg(p.name order by p.name) from priv p where not w.rolsuper and p.oid <> w.oid and p.owns_rls and pg_catalog.pg_has_role(w.oid, p.oid, 'MEMBER')), '{}'::text[]) as m_owner,
           coalesce((select array_agg(p.name order by p.name) from priv p where not w.rolsuper and p.oid <> w.oid and p.rolcreaterole and pg_catalog.pg_has_role(w.oid, p.oid, 'MEMBER')), '{}'::text[]) as m_createrole,
           coalesce(pg_catalog.pg_has_role(w.oid, (select oid from pg_catalog.pg_roles where rolname = ${RLS_APP_ROLE}), 'MEMBER'), false) as app_member,
           coalesce(pg_catalog.pg_has_role(w.oid, (select oid from pg_catalog.pg_roles where rolname = ${RLS_APP_ROLE}), 'USAGE'), false) as app_inherited
      from who w
  `)) as { rows?: Array<Record<string, unknown>> };
  const rows = res.rows ?? [];
  const row = rows.find((r) => r.kind === "login");
  if (!row) throw new Error("runtime login: the connected role was not found in pg_roles");
  const app = rows.find((r) => r.kind === "app");
  const memberships = (r: Record<string, unknown>) => ({
    memberOfSuperuser: strs(r.m_super),
    memberOfBypassRls: strs(r.m_bypass),
    memberOfRlsOwner: strs(r.m_owner),
    memberOfCreateRole: strs(r.m_createrole),
  });
  return {
    login: String(row.login),
    superuser: row.superuser === true,
    bypassRls: row.bypass_rls === true,
    createRole: row.create_role === true,
    ownsRlsTable: row.owns_rls_table === true,
    ...memberships(row),
    appMember: row.app_member === true,
    appInherited: row.app_inherited === true,
    appRole: app
      ? {
          superuser: app.superuser === true,
          bypassRls: app.bypass_rls === true,
          createRole: app.create_role === true,
          ownsRlsTable: app.owns_rls_table === true,
          ...memberships(app),
        }
      : null,
  };
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `password` (RFC 5802 / RFC 7677, the `pg_authid.rolpassword` form):
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, base64. `CREATE/ALTER ROLE ... PASSWORD '<verifier>'`
 * stores it as given, so the plaintext never reaches the server, its statement log or an audit extension.
 *
 * Open source first (ADR-0176): `pg` implements only the client side of SCRAM (lib/crypto/sasl.js, not exported) and
 * the npm SCRAM packages are unmaintained or not under an allowed licence, so this is node:crypto per the RFCs. The
 * password is SASLprep'd by the server only when it is not ASCII; the generated passwords here are ASCII, and anything
 * else is refused, so no normalisation is needed.
 */
export function scramSha256Verifier(password: string, opts: { salt?: Buffer; iterations?: number } = {}): string {
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error("scram verifier: the password must be printable ASCII");
  const iterations = opts.iterations ?? 4096;
  const salt = opts.salt ?? randomBytes(16);
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** a generated password is URL-safe by construction; anything else is refused */
const PASSWORD_RE = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * Run `fn` holding a session advisory lock on one owner connection, so two booting replicas provision one login and
 * write one connection string. `fn` gets that connection: provisioning runs on it. ADR-0343: the shared helper.
 */
export async function withRuntimeLoginLock<T>(owner: { $client: unknown }, fn: (client: RawQueryable) => Promise<T>): Promise<T> {
  return withSessionAdvisoryLock(owner, SESSION_LOCK_KEYS.runtimeLogin, fn);
}

async function exec(c: RawQueryable, formatSql: string, args: unknown[]): Promise<void> {
  // every identifier and literal is quoted by the server (format %I / %L); DDL itself takes no bind parameters
  const r = await c.query(`select pg_catalog.format(${formatSql}) as stmt`, args);
  await c.query(String(r.rows[0]?.stmt));
}

/**
 * Create the runtime login for the connected database through the OWNER connection, or re-key and repair it when it
 * already exists, in one transaction. It ends LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
 * INHERIT, a member (inheriting) of `regulait_app` and of no other role (every other membership is revoked), with
 * CONNECT on this database only (it is a role of its own per database). The password is sent as a SCRAM-SHA-256
 * verifier computed here, never in plaintext. Needs a connection that may create roles (a superuser, or a role with
 * CREATEROLE such as a managed database's master user). Never logs or returns the password.
 */
export async function provisionRuntimeLogin(owner: RawQueryable, password: string): Promise<{ created: boolean; role: string }> {
  if (!PASSWORD_RE.test(password)) throw new Error("runtime login: the password must be 32-128 URL-safe characters");
  const dbRow = await owner.query("select pg_catalog.current_database()::text as db, pg_catalog.current_setting('server_version_num')::int as v");
  const role = runtimeLoginRoleFor(String(dbRow.rows[0]?.db));
  const v = Number(dbRow.rows[0]?.v);
  const verifier = scramSha256Verifier(password);
  const attrs = "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT";
  await owner.query("BEGIN");
  try {
    const res = await owner.query("select exists (select 1 from pg_catalog.pg_roles where rolname = $1) as present", [role]);
    const present = res.rows[0]?.present === true;
    await exec(owner, `'${present ? "ALTER" : "CREATE"} ROLE %I ${attrs} PASSWORD %L', $1::text, $2::text`, [role, verifier]);
    if (present) {
      // an existing login keeps no membership but regulait_app, whoever granted it
      const others = await owner.query(
        `select g.rolname::text as granted, pg_catalog.pg_get_userbyid(am.grantor)::text as grantor
           from pg_catalog.pg_auth_members am join pg_catalog.pg_roles g on g.oid = am.roleid
          where am.member = (select oid from pg_catalog.pg_roles where rolname = $1) and g.rolname <> $2`,
        [role, RLS_APP_ROLE],
      );
      for (const m of others.rows) {
        await exec(owner, `'REVOKE %I FROM %I GRANTED BY %I', $1::text, $2::text, $3::text`, [m.granted, role, m.grantor]);
      }
    }
    // Postgres 16 keeps INHERIT per grant: re-granting with INHERIT TRUE repairs a NOINHERIT membership
    await exec(owner, `'GRANT %I TO %I${v >= 160000 ? " WITH INHERIT TRUE, SET TRUE" : ""}', $1::text, $2::text`, [RLS_APP_ROLE, role]);
    await exec(owner, `'GRANT CONNECT ON DATABASE %I TO %I', pg_catalog.current_database(), $1::text`, [role]);
    await owner.query("COMMIT");
    return { created: !present, role };
  } catch (err) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}
