/**
 * The guard a real-stack e2e spec puts in front of `psql`, so its fixture SQL
 * can only ever reach the spec's own disposable database on this machine
 * (PR #359 review: a guard that checked only the URL's hostname and path let
 * `postgresql://127.0.0.1/regulait_x38?host=shared.db&dbname=regulait` through,
 * and psql then connected to the shared database).
 *
 *   disposableDatabase(url, namePattern)  -> { host, port, user, password, database } or throws
 *   psqlInvocation(target, query, env)    -> { args, env } for execFileSync("psql", args, { env })
 *
 * The rule is an allow-list over the WHOLE connection string, not a parse of
 * whatever libpq would accept: exactly `postgres[ql]://[user[:password]@]host[:port]/name`
 * with a loopback host, an optional numeric port, a plain user name and a
 * database name matching the caller's pattern. Anything else is refused: a query
 * string or fragment (libpq reads `host`, `hostaddr`, `dbname`, `service`, … from
 * it), several hosts, a socket path, percent-escapes, whitespace, a key=value
 * conninfo. pg-connection-string (MIT, node-postgres) was considered and not
 * used: it is a permissive parser that accepts exactly those forms, and this
 * check needs a refusal, not a parse.
 *
 * psql then gets the checked values as separate flags (-h -p -U -d) and an
 * environment with every PG* variable removed, so PGHOST, PGSERVICE,
 * PGSERVICEFILE, PGOPTIONS and friends cannot redirect it either. The password,
 * if any, goes in PGPASSWORD, never on the command line.
 */

const LOOPBACK = new Map([
  ["127.0.0.1", "127.0.0.1"],
  ["localhost", "localhost"],
  ["[::1]", "::1"],
]);
const SHAPE =
  /^postgres(?:ql)?:\/\/(?:(?<user>[a-z_][a-z0-9_]{0,62})(?::(?<password>[A-Za-z0-9._~!$&'()*+,;=-]{1,256}))?@)?(?<host>127\.0\.0\.1|localhost|\[::1\])(?::(?<port>[0-9]{1,5}))?\/(?<database>[a-z_][a-z0-9_]{0,62})$/;

/**
 * @param {string | undefined} url the DATABASE_URL to check
 * @param {RegExp} namePattern what the disposable database's name must match (anchor it)
 */
export function disposableDatabase(url, namePattern) {
  if (typeof url !== "string" || url.length === 0) throw new Error("a disposable database URL is required (DATABASE_URL)");
  const m = SHAPE.exec(url);
  if (!m?.groups) {
    throw new Error(
      "refused: the database URL must be exactly postgres[ql]://[user[:password]@]<loopback host>[:port]/<name>, with no query string, fragment, second host or escape",
    );
  }
  const { user, password, host, port, database } = m.groups;
  if (!namePattern.test(database)) throw new Error(`refused: database ${JSON.stringify(database)} is not a disposable database for this spec`);
  const portNumber = port === undefined ? 5432 : Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error("refused: the port is out of range");
  return {
    host: /** @type {string} */ (LOOPBACK.get(host)),
    port: portNumber,
    user: user ?? null,
    password: password ?? null,
    database,
  };
}

/**
 * @param {{ host: string; port: number; user: string | null; password: string | null; database: string }} target from disposableDatabase
 * @param {string} query
 * @param {Record<string, string | undefined>} env the caller's environment (process.env)
 */
export function psqlInvocation(target, query, env) {
  /** @type {Record<string, string>} */
  const clean = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^PG/i.test(k)) clean[k] = v;
  if (target.password !== null) clean.PGPASSWORD = target.password;
  const args = ["-X", "-v", "ON_ERROR_STOP=1", "-At", "-h", target.host, "-p", String(target.port)];
  if (target.user !== null) args.push("-U", target.user);
  args.push("-d", target.database, "-c", query);
  return { args, env: clean };
}
