import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dmlOffenders, migrationsAfter0272, readOffenders } from "./rls-slice1-migration-scan.js";

const TABLES = ["users", "auth_mfa_pending", "approvals", "audit_log"] as const;
const CONTEXT = "select set_config('regulait.system_context', 'migration', true);\n";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function folder(files: Record<string, string>, withPending = true): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "rls-scan-"));
  dirs.push(d);
  if (withPending) mkdirSync(path.join(d, "pending"));
  for (const [f, text] of Object.entries(files)) writeFileSync(path.join(d, f), text);
  return d;
}

describe("the slice-1 migration-context scan (ADR-0234) covers pending migrations (ADR-0252)", () => {
  it("lists numbered files after 0272, then every pending/*.sql as pending/<name>", () => {
    const d = folder({ "0272_a.sql": "", "0273_b.sql": "", "pending/c.sql": "", "pending/README.md": "" });
    expect(migrationsAfter0272(d).map((m) => m.name)).toEqual(["0273_b.sql", "pending/c.sql"]);
  });

  it("a folder without pending/ still scans its numbered files", () => {
    expect(migrationsAfter0272(folder({ "0300_x.sql": "" }, false)).map((m) => m.name)).toEqual(["0300_x.sql"]);
  });

  it("names a pending file with DML on a slice-1 table and no migration context; passes it once the context is set", () => {
    const d = folder({ "pending/bad.sql": "update users set name = 'x';\n", "pending/good.sql": `${CONTEXT}delete from approvals;\n` });
    expect(dmlOffenders(d, TABLES)).toEqual(["pending/bad.sql"]);
  });

  it("names a pending file whose data step reads a slice-1 table without the context", () => {
    const d = folder({
      "pending/orphans.sql": "delete from team_members t where not exists (select 1 from users u where u.id = t.user_id);\n",
      "0271_old.sql": "delete from team_members t where not exists (select 1 from users u where u.id = t.user_id);\n",
    });
    expect(readOffenders(d, TABLES)).toEqual(["pending/orphans.sql"]);
  });
});
