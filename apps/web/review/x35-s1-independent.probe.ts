/** X35 independent negative probes. Copied temporarily to gateway src for execution; no product changes. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, runMigrations, sql, auditLog, type Db } from "@regulait/db";
import { verifyAuditChain } from "./audit-chain.js";
let db: Db;
beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!);
  await runMigrations(db, "../../packages/db/migrations");
});
afterAll(async () => { await db.$client.end(); });
class Rollback extends Error {}
async function rolledBack(body: (tx: Db) => Promise<void>) {
  await db.transaction(async (tx) => { await body(tx as unknown as Db); throw new Rollback(); }).catch(e => { if (!(e instanceof Rollback)) throw e; });
}
const row = () => ({ userId:"00000000-0000-0000-0000-000000000000", effect:"allow" as const, ruleId:"x35-independent", ruleChain:[], reason:"synthetic S1 review" });
it("I7S-01: adding unhashed actor attribution to a v1 row must fail verification", async () => {
  await rolledBack(async tx => {
    const [before] = await tx.insert(auditLog).values(row()).returning();
    expect((await verifyAuditChain(tx, null)).status).toBe("ok");
    await tx.execute(sql`UPDATE audit_log SET actor_identity_id=${randomUUID()}, delegation_grant_id=${randomUUID()}, actor_chain=${JSON.stringify([randomUUID()])}::jsonb WHERE id=${before!.id}`);
    const report = await verifyAuditChain(tx, null);
    console.log("I7S-01", JSON.stringify({status:report.status,firstBreak:report.firstBreak, originalContentHash:before!.contentHash}));
    expect(report.status).toBe("broken");
  });
});
it("I7S-02: a future unsupported serialisation boundary must fail closed", async () => {
  await rolledBack(async tx => {
    // Simulate a future migration adding version 3; S1 itself permits only 2.
    await tx.execute(sql`ALTER TABLE audit_chain_versions DROP CONSTRAINT audit_chain_versions_version_check`);
    await tx.execute(sql`INSERT INTO audit_chain_versions(version,from_seq) VALUES(3,2)`);
    const report = await verifyAuditChain(tx,null);
    console.log("I7S-02",JSON.stringify({status:report.status,firstBreak:report.firstBreak}));
    expect(report.status).toBe("broken");
  });
});
it("positive control: changing a v2 actor chain must fail verification", async () => {
  await rolledBack(async tx => {
    const tip = await tx.execute(sql`SELECT MAX(seq)::bigint AS seq FROM audit_log`);
    await tx.execute(sql`INSERT INTO audit_chain_versions(version,from_seq) VALUES(2,${Number(tip.rows[0].seq)+1})`);
    const [before] = await tx.insert(auditLog).values({...row(), actorIdentityId:randomUUID(),delegationGrantId:randomUUID(),actorChain:[randomUUID()]}).returning();
    expect((await verifyAuditChain(tx,null)).status).toBe("ok");
    await tx.execute(sql`UPDATE audit_log SET actor_chain=${JSON.stringify([randomUUID()])}::jsonb WHERE id=${before!.id}`);
    expect((await verifyAuditChain(tx,null)).firstBreak?.kind).toBe("content_mismatch");
  });
});
