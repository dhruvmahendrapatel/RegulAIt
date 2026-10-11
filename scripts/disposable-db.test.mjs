import { describe, expect, it } from "vitest";
import { disposableDatabase, psqlInvocation } from "./disposable-db.mjs";

const X38 = /^regulait_(review_)?x38[a-z0-9_]*$/;

describe("disposableDatabase", () => {
  it.each([
    ["postgres://regulait:regulait@127.0.0.1:5432/regulait_review_x38_oct11", { host: "127.0.0.1", port: 5432, user: "regulait", password: "regulait", database: "regulait_review_x38_oct11" }],
    ["postgresql://localhost/regulait_x38", { host: "localhost", port: 5432, user: null, password: null, database: "regulait_x38" }],
    ["postgresql://u@[::1]:6543/regulait_review_x38", { host: "::1", port: 6543, user: "u", password: null, database: "regulait_review_x38" }],
  ])("admits %s", (url, want) => {
    expect(disposableDatabase(url, X38)).toEqual(want);
  });

  it.each([
    // the PR #359 review bypass: libpq reads host/dbname from the query string
    "postgresql://127.0.0.1/regulait_x38?host=shared.db&dbname=regulait",
    "postgresql://127.0.0.1/regulait_x38?sslmode=disable",
    "postgresql://127.0.0.1/regulait_x38?service=shared",
    "postgresql://127.0.0.1/regulait_x38?options=-csearch_path%3Dx",
    "postgresql://127.0.0.1/regulait_x38#x",
    // userinfo and host tricks
    "postgresql://127.0.0.1@shared.db/regulait_x38",
    "postgresql://u@127.0.0.1@shared.db/regulait_x38",
    "postgresql://u:p@ss@127.0.0.1/regulait_x38",
    "postgresql://127.0.0.1,shared.db/regulait_x38",
    "postgresql://127.0.0.1:5432,shared.db:5432/regulait_x38",
    "postgresql://%2Fvar%2Frun%2Fpostgresql/regulait_x38",
    "postgresql://127.0.0.1.shared.db/regulait_x38",
    "postgresql://127.0.0.2/regulait_x38",
    "postgresql://shared.db/regulait_x38",
    "postgresql:///regulait_x38",
    "postgresql://127.0.0.1:99999/regulait_x38",
    // the database name, and other connection-string forms psql accepts
    "postgresql://127.0.0.1/regulait",
    "postgresql://127.0.0.1/regulait_x38/extra",
    "postgresql://127.0.0.1/regulait_x38%3Fhost%3Dshared",
    "postgresql://127.0.0.1/REGULAIT_X38",
    "host=127.0.0.1 dbname=regulait_x38",
    "regulait_x38",
    "mysql://127.0.0.1/regulait_x38",
    " postgresql://127.0.0.1/regulait_x38",
    "postgresql://127.0.0.1/regulait_x38\n",
    "",
    undefined,
  ])("refuses %j", (url) => {
    expect(() => disposableDatabase(url, X38)).toThrow(/refused|required/);
  });
});

describe("psqlInvocation", () => {
  it("passes only the checked values as flags and strips every PG* variable", () => {
    const target = disposableDatabase("postgres://regulait:secret@127.0.0.1:5433/regulait_x38", X38);
    const { args, env } = psqlInvocation(target, "SELECT 1", {
      PATH: "/usr/bin",
      PGHOST: "shared.db",
      PGDATABASE: "regulait",
      PGSERVICE: "shared",
      PGSERVICEFILE: "/tmp/x",
      PGOPTIONS: "-c x=y",
      pgpassfile: "/tmp/y",
    });
    expect(args).toEqual(["-X", "-v", "ON_ERROR_STOP=1", "-At", "-h", "127.0.0.1", "-p", "5433", "-U", "regulait", "-d", "regulait_x38", "-c", "SELECT 1"]);
    expect(env).toEqual({ PATH: "/usr/bin", PGPASSWORD: "secret" });
  });

  it("omits -U and PGPASSWORD when the URL names no user", () => {
    const { args, env } = psqlInvocation(disposableDatabase("postgresql://localhost/regulait_x38", X38), "SELECT 1", { PGPASSWORD: "leak" });
    expect(args).not.toContain("-U");
    expect(env).toEqual({});
  });
});
