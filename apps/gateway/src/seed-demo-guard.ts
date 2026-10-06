/**
 * ADR-0181 FX3 (security review finding 7) — the demo seed never reaches a
 * real install.
 *
 * `seed.ts` loads the demo dataset AND applies the demo's relaxations (trace
 * content capture on, demo allow-list entries, demo admissions, persona keys).
 * Every one of those is right for the laptop demo and wrong for a customer
 * database, and the seed used to run whenever a start script said
 * `SEED_DEMO=1` — which docker-compose and the hosted installer defaulted to.
 *
 * The seed now refuses unless BOTH hold:
 *
 *   1. an EXPLICIT demo signal: the `--seed-demo` argument (what `demo:prepare`,
 *      the image's start script with SEED_DEMO=1, the e2e harness and the
 *      `seed` package script pass), or `REGULAIT_DEMO_LICENSE=1` (the Docker
 *      demo's one switch; one trailing CR from a Windows .env is tolerated,
 *      exactly as `docker-start.sh` does);
 *   2. NO REAL ADMIN exists: every admin in the database is one of the seed's
 *      own personas. A database where someone has created their own admin is
 *      in use, and the seed will not touch it.
 *
 * Both are checked before anything is written (before migrations). The
 * refusal names what is missing; nothing about it is relaxable by flag,
 * because the safe way to demo is a fresh database.
 */
import { sql, type Db } from "@regulait/db";

/** the seed's own personas (seed.ts `ensureUser`). An admin outside this list
 * is a real admin. */
export const DEMO_SEED_PERSONA_EMAILS = [
  "admin@regulait.local",
  "dana@regulait.local",
  "avery@regulait.local",
] as const;

export const SEED_DEMO_FLAG = "--seed-demo";

/** the explicit demo signal, or null with the reason it is missing */
export function demoSeedSignal(argv: readonly string[], env: NodeJS.ProcessEnv): string | null {
  if (argv.includes(SEED_DEMO_FLAG)) return SEED_DEMO_FLAG;
  let lic = env.REGULAIT_DEMO_LICENSE ?? "";
  if (lic.endsWith("\r")) lic = lic.slice(0, -1);
  if (lic === "1") return "REGULAIT_DEMO_LICENSE=1";
  return null;
}

/** emails of admins that are not the seed's own personas. An empty database
 * (no users table yet) has none. */
export async function realAdminEmails(db: Db): Promise<string[]> {
  const exists = (await db.execute(sql`select to_regclass('public.users') is not null as present`)) as unknown as {
    rows: Array<{ present: boolean }>;
  };
  if (!exists.rows[0]?.present) return [];
  const personas = sql.join(
    DEMO_SEED_PERSONA_EMAILS.map((e) => sql`${e}`),
    sql`, `,
  );
  const res = (await db.execute(
    sql`select email from users where is_admin and lower(email) not in (${personas}) order by email`,
  )) as unknown as { rows: Array<{ email: string }> };
  return res.rows.map((r) => r.email);
}

/** null = the seed may run; otherwise the refusal to print */
export function demoSeedRefusal(signal: string | null, realAdmins: readonly string[]): string | null {
  if (!signal) {
    return (
      "Refusing to seed: the demo seed loads demo users, keys and demo-only relaxations, and runs only when asked " +
      `for explicitly. Pass ${SEED_DEMO_FLAG} (\`pnpm --filter @regulait/gateway seed\` and \`demo:prepare\` do), or ` +
      "set REGULAIT_DEMO_LICENSE=1 for the Docker demo. Nothing was written."
    );
  }
  if (realAdmins.length > 0) {
    const shown = realAdmins.slice(0, 3).join(", ") + (realAdmins.length > 3 ? `, and ${realAdmins.length - 3} more` : "");
    return (
      `Refusing to seed: this database has an admin who is not a demo persona (${shown}), so it is in real use. ` +
      "The demo seed only ever runs on a database whose admins are its own personas. Use a fresh database for the " +
      "demo. Nothing was written."
    );
  }
  return null;
}
