// ADR-0234 — the measured cost of row-level security, slice 1.
//
// Usage (a Postgres 16 with a scratch database you may fill):
//   pnpm --filter @regulait/db build
//   REGULAIT_DATABASE_SSL=disable node packages/db/bench/rls-cost.mjs postgres://user:pw@localhost:5432/scratch
//
// It needs a FRESH database (it does not clean up). It migrates the database to the head, seeds USERS users, APPROVALS approvals and AUDIT audit rows (spread
// across the users, with role routing and delegations so every policy branch has data), then times the same
// statements three ways: the superuser login (no RLS: today's runtime), a non-admin principal, and an admin
// principal. Each timing is the median of RUNS runs after WARM warm-ups. It also times the wrapper itself
// (BEGIN + one set_config statement + COMMIT) against a bare statement.
import { createDb, runMigrations, withPrincipal, runWithRlsPrincipal, sql } from "../dist/index.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const url = process.argv[2];
if (!url) throw new Error("usage: node rls-cost.mjs <scratch database url>");
const USERS = Number(process.env.USERS ?? 500);
const APPROVALS = Number(process.env.APPROVALS ?? 100_000);
const AUDIT = Number(process.env.AUDIT ?? 100_000);
const RUNS = Number(process.env.RUNS ?? 25);
const WARM = 5;

const db = createDb(url);
await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations"));

const userIds = Array.from({ length: USERS }, () => randomUUID());
const admin = randomUUID();
const role = randomUUID();
await db.execute(sql.raw(`insert into users (id, email, display_name, is_admin) values ('${admin}', 'bench-admin-${admin}@b.test', 'Admin', true)`));
for (let i = 0; i < userIds.length; i += 500) {
  const chunk = userIds.slice(i, i + 500).map((id) => `('${id}', 'bench-${id}@b.test', 'U')`).join(",");
  await db.execute(sql.raw(`insert into users (id, email, display_name) values ${chunk}`));
}
await db.execute(sql.raw(`insert into roles (id, name) values ('${role}', 'bench-role-${role}')`));
await db.execute(sql.raw(`insert into role_assignments (user_id, role_id) select id, '${role}' from users where id in (${userIds.slice(0, 20).map((u) => `'${u}'`).join(",")})`));
await db.execute(sql.raw(`
  insert into approvals (user_id, approver_user_id, requested_at, approver_role_id)
  select u[1 + (g % ${USERS})], u[1 + ((g * 7) % ${USERS})], now() - (g || ' seconds')::interval,
         case when g % 50 = 0 then '${role}'::uuid end
    from generate_series(1, ${APPROVALS}) g, (select array_agg(id) u from users where email like 'bench-%' and not is_admin) s`));
await db.execute(sql.raw(`insert into approval_assignments (approval_id, assignee_kind, assignee_id)
  select id, 'role', '${role}' from approvals where approver_role_id is not null`));
await db.execute(sql.raw(`insert into approval_delegations (from_user_id, to_user_id, starts_at, ends_at)
  values ('${userIds[1]}', '${userIds[0]}', now() - interval '1 day', now() + interval '1 day')`));
// audit rows bypass the chain writer on purpose (bulk fixture; the chain is not what is measured)
await db.execute(sql.raw(`alter table audit_log disable trigger user`));
await db.execute(sql.raw(`
  insert into audit_log (user_id, effect, rule_id, rule_chain, reason)
  select u[1 + (g % ${USERS})], 'allow', 'bench', '[]'::jsonb, 'bench'
    from generate_series(1, ${AUDIT}) g, (select array_agg(id) u from users where email like 'bench-%' and not is_admin) s`));
await db.execute(sql.raw(`alter table audit_log enable trigger user`));
await db.execute(sql`analyze`);

const viewer = userIds[0]; // a role member with a delegation: the most expensive non-admin
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function time(fn) {
  for (let i = 0; i < WARM; i++) await fn();
  const out = [];
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    await fn();
    out.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return median(out);
}

const statements = {
  "approvals: newest 100 (the queue page)": sql`select * from approvals order by requested_at desc, id desc limit 100`,
  "approvals: count(*)": sql`select count(*) from approvals`,
  "approvals: by primary key": null, // filled below
  "audit_log: newest 100": sql`select * from audit_log order by seq desc nulls last limit 100`,
  "audit_log: count(*)": sql`select count(*) from audit_log`,
  "users: by email": sql.raw(`select * from users where email = 'bench-${userIds[3]}@b.test'`),
};
const someApproval = (await db.execute(sql.raw(`select id from approvals where user_id = '${viewer}' limit 1`))).rows[0].id;
statements["approvals: by primary key"] = sql.raw(`select * from approvals where id = '${someApproval}'`);

const rows = [];
for (const [name, q] of Object.entries(statements)) {
  const base = await time(() => db.execute(q));
  const user = await time(() => withPrincipal(db, { userId: viewer }, (tx) => tx.execute(q)));
  const adm = await time(() => withPrincipal(db, { userId: admin }, (tx) => tx.execute(q)));
  // batch 2: the request scope (AsyncLocalStorage + the scoped pool), as the gateway now runs every request
  const scoped = await time(() => runWithRlsPrincipal({ userId: viewer }, () => db.execute(q)));
  rows.push({ statement: name, "superuser ms": base.toFixed(2), "principal ms": user.toFixed(2), "request scope ms": scoped.toFixed(2), "admin ms": adm.toFixed(2) });
}
const bare = await time(() => db.execute(sql`select 1`));
const wrapped = await time(() => withPrincipal(db, { userId: viewer }, (tx) => tx.execute(sql`select 1`)));
const scopedBare = await time(() => runWithRlsPrincipal({ userId: viewer }, () => db.execute(sql`select 1`)));
rows.push({ statement: "wrapper only: select 1", "superuser ms": bare.toFixed(2), "principal ms": wrapped.toFixed(2), "request scope ms": scopedBare.toFixed(2), "admin ms": "-" });
// batch 2: a request-shaped burst, 20 point reads in one scope (what a typical route does)
const burst = async () => { for (let i = 0; i < 20; i++) await db.execute(statements["approvals: by primary key"]); };
const burstBase = await time(burst);
const burstScoped = await time(() => runWithRlsPrincipal({ userId: viewer }, burst));
rows.push({ statement: "request burst: 20 point reads", "superuser ms": burstBase.toFixed(2), "principal ms": "-", "request scope ms": burstScoped.toFixed(2), "admin ms": "-" });

console.log(`USERS=${USERS} APPROVALS=${APPROVALS} AUDIT=${AUDIT} RUNS=${RUNS} (median)`);
console.table(rows);
const plan = await withPrincipal(db, { userId: viewer }, (tx) =>
  tx.execute(sql`explain (analyze, costs off, timing off, summary off) select * from approvals order by requested_at desc, id desc limit 100`),
);
console.log(plan.rows.map((r) => r["QUERY PLAN"]).join("\n"));
await db.$client.end();
