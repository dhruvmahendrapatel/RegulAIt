/**
 * ADR-0234 batch 7b: the runtime login.
 *
 * The gateway serves requests on a dedicated login that is a member of `regulait_app` and is neither a superuser, nor
 * BYPASSRLS, nor the owner of the row-level-security tables. Such a login cannot step out of the policies: it cannot
 * disable RLS (not the owner), cannot bypass it (no BYPASSRLS), and `SET ROLE` back to the owner is not open to it.
 * The owner (migrator) login keeps the schema and the two jobs that need it (the migrations and the audit prune).
 *
 * This module only talks to Postgres: `inspectRuntimeLogin` reads what the connected login is, and
 * `provisionRuntimeLogin` creates (or re-keys) the login through the owner connection. Where its password is kept is
 * the gateway's business (the install secrets directory, or an operator-managed connection string).
 */
import { sql } from "drizzle-orm";
import { RLS_APP_ROLE } from "./rls.js";

/** the login the installer provisions for the request pool */
export const RUNTIME_LOGIN_ROLE = "regulait_runtime";

/** the tables with FORCE row-level security the runtime login must not own */
const RLS_TABLES = ["users", "auth_mfa_pending", "approvals", "audit_log"] as const;

export interface RuntimeLoginFacts {
  /** current_user of the connection */
  login: string;
  superuser: boolean;
  bypassRls: boolean;
  /** owns at least one table that has row-level security on (and could turn it off) */
  ownsRlsTable: boolean;
  /** may SET ROLE regulait_app (what every RLS scope does) */
  appMember: boolean;
  /** inherits regulait_app's grants without switching (what an unscoped statement relies on) */
  appInherited: boolean;
}

/** what is wrong with a login as the runtime login; empty when it is fit */
export function runtimeLoginProblems(f: RuntimeLoginFacts): string[] {
  const out: string[] = [];
  if (f.superuser) out.push("is a superuser (bypasses every row-level security policy)");
  if (f.bypassRls) out.push("has BYPASSRLS (bypasses every row-level security policy)");
  if (f.ownsRlsTable) out.push("owns a row-level-security table (could disable its policies)");
  if (!f.appMember) out.push(`is not a member of ${RLS_APP_ROLE} (no RLS scope could run)`);
  else if (!f.appInherited) out.push(`does not inherit ${RLS_APP_ROLE}'s privileges (NOINHERIT)`);
  return out;
}

type Exec = { execute: (q: ReturnType<typeof sql>) => PromiseLike<unknown> };

/** read what the connected login is. One statement, no side effects. */
export async function inspectRuntimeLogin(db: Exec): Promise<RuntimeLoginFacts> {
  const res = (await db.execute(sql`
    select r.rolname as login,
           r.rolsuper as superuser,
           r.rolbypassrls as bypass_rls,
           exists (
             select 1 from pg_catalog.pg_class c
              where c.relowner = r.oid
                and c.relnamespace = 'public'::regnamespace
                and c.relname = any (${sql.raw(`array['${RLS_TABLES.join("','")}']`)})
                and c.relrowsecurity
           ) as owns_rls_table,
           coalesce(pg_catalog.pg_has_role(r.oid, (select oid from pg_catalog.pg_roles where rolname = ${RLS_APP_ROLE}), 'MEMBER'), false) as app_member,
           coalesce(pg_catalog.pg_has_role(r.oid, (select oid from pg_catalog.pg_roles where rolname = ${RLS_APP_ROLE}), 'USAGE'), false) as app_inherited
      from pg_catalog.pg_roles r
     where r.rolname = current_user
  `)) as { rows?: Array<Record<string, unknown>> };
  const row = res.rows?.[0];
  if (!row) throw new Error("runtime login: the connected role was not found in pg_roles");
  return {
    login: String(row.login),
    superuser: row.superuser === true,
    bypassRls: row.bypass_rls === true,
    ownsRlsTable: row.owns_rls_table === true,
    appMember: row.app_member === true,
    appInherited: row.app_inherited === true,
  };
}

/** a generated password is URL- and SQL-literal-safe by construction; anything else is refused */
const PASSWORD_RE = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * Create the runtime login through the OWNER connection, or re-key it when it already exists. It is created
 * LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT and a member of `regulait_app`, and is
 * given CONNECT on the current database. Needs a connection that may create roles (a superuser, or a role with
 * CREATEROLE such as a managed database's master user). Never logs or returns the password.
 */
export async function provisionRuntimeLogin(owner: Exec, password: string): Promise<{ created: boolean }> {
  if (!PASSWORD_RE.test(password)) throw new Error("runtime login: the password must be 32-128 URL-safe characters");
  const attrs = "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT";
  const res = (await owner.execute(sql`select exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN_ROLE}) as present`)) as {
    rows?: Array<{ present: boolean }>;
  };
  const present = res.rows?.[0]?.present === true;
  // the role name is a constant and the password matched PASSWORD_RE, so both are safe to inline (DDL takes no binds)
  if (present) {
    await owner.execute(sql.raw(`ALTER ROLE ${RUNTIME_LOGIN_ROLE} ${attrs} PASSWORD '${password}'`));
  } else {
    await owner.execute(sql.raw(`CREATE ROLE ${RUNTIME_LOGIN_ROLE} ${attrs} PASSWORD '${password}'`));
  }
  await owner.execute(sql.raw(`GRANT ${RLS_APP_ROLE} TO ${RUNTIME_LOGIN_ROLE}`));
  await owner.execute(
    sql.raw(`DO $do$ BEGIN EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO ${RUNTIME_LOGIN_ROLE}', pg_catalog.current_database()); END $do$`),
  );
  return { created: !present };
}
