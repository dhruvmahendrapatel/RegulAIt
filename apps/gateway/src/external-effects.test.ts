import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import {
  EXTERNAL_WRITE_OPERATIONS,
  ExternalEffectBlockedError,
  runExternalWrite,
} from "./external-effects.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const BOOT = "external-effects-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let approverId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const user = await app.inject({
    method: "POST", url: "/v1/users", headers: AUTH,
    payload: { email: `external-effects-${Math.random().toString(36).slice(2, 8)}@example.com`, displayName: "Approver" },
  });
  expect(user.statusCode).toBe(201);
  approverId = user.json().id;
});

afterAll(async () => { await app.close(); });

describe("external provider mutation admission", () => {
  it("checks the current execution mode immediately before every classified write", async () => {
    const setMode = async (mode: "normal" | "halted" | "read_only" | "require_approval") => {
      const response = await app.inject({
        method: "PUT", url: "/v1/execution/mode", headers: AUTH,
        payload: {
          mode, reason: `external effects ${mode}`,
          ...(mode === "require_approval" ? { approverUserId: approverId } : {}),
        },
      });
      expect(response.statusCode).toBe(200);
    };
    let calls = 0;
    try {
      for (const mode of ["halted", "read_only", "require_approval"] as const) {
        await setMode(mode);
        for (const operation of EXTERNAL_WRITE_OPERATIONS) {
          await expect(runExternalWrite(db, operation, async () => { calls++; })).rejects.toBeInstanceOf(ExternalEffectBlockedError);
        }
      }
      expect(calls).toBe(0);
    } finally {
      await setMode("normal");
    }
    for (const operation of EXTERNAL_WRITE_OPERATIONS) {
      await runExternalWrite(db, operation, async () => { calls++; });
    }
    expect(calls).toBe(EXTERNAL_WRITE_OPERATIONS.length);
  });

  it("keeps direct deploy, Git and infra provider mutations inside the final-call guard", () => {
    const cases = [
      { file: "workflows.ts", methods: new Set(["deploy", "rollback", "createBranch", "openPullRequest", "mergePullRequest"]) },
      { file: "infra.ts", methods: new Set(["remediate"]) },
    ];
    for (const { file, methods } of cases) {
      const source = ts.createSourceFile(file, readFileSync(path.join(here, file), "utf8"), ts.ScriptTarget.Latest, true);
      const seen = new Set<string>();
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "provider" &&
          methods.has(node.expression.name.text)) {
          seen.add(node.expression.name.text);
          let parent: ts.Node | undefined = node.parent;
          while (parent && !(ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) &&
            parent.expression.text === "runExternalWrite")) parent = parent.parent;
          expect(parent, `${file}: provider.${node.expression.name.text} must be guarded`).toBeDefined();
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(seen).toEqual(methods);
    }
  });
});
