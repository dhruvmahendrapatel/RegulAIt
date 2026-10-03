import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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

  // -------------------------------------------------------------------------
  // AER-018 — the STRUCTURAL classification, derived from the CONTRACTS the
  // gateway consumes rather than from a hand-typed method list. Every method
  // of each provider interface that is not a NAMED read is a write; a write
  // must be classified in EXTERNAL_WRITE_OPERATIONS under its adapter's prefix,
  // and every call of it on a raw provider anywhere in the gateway must sit
  // inside runExternalWrite with the matching operation literal. A new write
  // method on any provider package therefore fails here until it is
  // classified AND guarded — and a new gateway file that resolves a raw
  // provider fails until it is enrolled below.
  // -------------------------------------------------------------------------

  const CONTRACTS = [
    { adapter: "deploy", source: path.join(here, "deploy.ts"), iface: "DeployProvider", reads: [] as string[] },
    { adapter: "git", source: path.resolve(here, "../../../packages/git-provider/src/types.ts"), iface: "GitProvider", reads: ["getPullRequest", "listChecks"] },
    { adapter: "infra", source: path.resolve(here, "../../../packages/infra-provider/src/index.ts"), iface: "InfraProvider", reads: ["scan"] },
    { adapter: "pm", source: path.resolve(here, "../../../packages/pm-provider/src/index.ts"), iface: "PmProvider", reads: ["getWorkItem"] },
  ] as const;

  /** the gateway files allowed to hold a RAW provider, and how they guard it */
  interface CallSite {
    file: string;
    resolvers: readonly string[];
    expectWrites: readonly string[];
    /** the one function allowed to retain the raw provider; it must return a wrapper classifying every contract method */
    wrapperFactory?: string;
    wrapperContract?: string;
  }
  const CALL_SITES: readonly CallSite[] = [
    { file: "workflows.ts", resolvers: ["resolveProvider", "resolveDeployProvider"], expectWrites: ["deploy", "rollback", "createBranch", "openPullRequest", "mergePullRequest"] },
    { file: "infra.ts", resolvers: ["resolveInfraProvider"], expectWrites: ["remediate"] },
    // pm.ts resolves ONCE, inside providerFor, and hands every caller a
    // wrapper whose write methods are the barrier — so the raw provider's
    // write calls are checked inside that function and the wrapper literal
    // must classify every contract method
    { file: "pm.ts", resolvers: ["resolvePmProvider"], expectWrites: ["createWorkItem", "updateFields", "transitionState", "addComment"], wrapperFactory: "providerFor", wrapperContract: "pm" },
  ];
  const RESOLVERS = new Set<string>(CALL_SITES.flatMap((c) => c.resolvers));

  const parse = (file: string) =>
    ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const interfaceMethods = (source: ts.SourceFile, iface: string): string[] => {
    const found: string[][] = [];
    const visit = (node: ts.Node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === iface) {
        found.push(node.members.filter(ts.isMethodSignature).map((m) => (m.name as ts.Identifier).text));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (found.length !== 1) throw new Error(`${source.fileName}: expected one interface ${iface}, found ${found.length}`);
    return found[0]!;
  };
  const enclosingCall = (node: ts.Node, callee: string): ts.CallExpression | undefined => {
    let parent: ts.Node | undefined = node.parent;
    while (parent && !(ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === callee)) {
      parent = parent.parent;
    }
    return parent as ts.CallExpression | undefined;
  };
  const enclosingFunction = (node: ts.Node): string | null => {
    let parent: ts.Node | undefined = node.parent;
    while (parent) {
      if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
      parent = parent.parent;
    }
    return null;
  };

  /** method name → the operation it must be classified as, for every contract write */
  const classify = () => {
    const writes = new Map<string, { adapter: string; operation: string }>();
    const reads = new Set<string>();
    for (const c of CONTRACTS) {
      const methods = interfaceMethods(parse(c.source), c.iface);
      for (const r of c.reads) expect(methods, `${c.iface}: named read '${r}' is not on the contract`).toContain(r);
      for (const m of methods) {
        if ((c.reads as readonly string[]).includes(m)) { reads.add(m); continue; }
        expect(writes.has(m), `write method '${m}' appears on two contracts`).toBe(false);
        writes.set(m, { adapter: c.adapter, operation: `${c.adapter}.${snake(m)}` });
      }
    }
    return { writes, reads };
  };

  it("classifies every write method of every provider contract, and nothing else", () => {
    const { writes } = classify();
    expect(writes.size).toBeGreaterThan(0);
    // every contract write is a classified operation, under its adapter's prefix …
    for (const [method, { operation }] of writes) {
      expect(EXTERNAL_WRITE_OPERATIONS, `'${method}' is a write on its contract but is not classified`).toContain(operation);
    }
    // … and every classified operation names a write that still exists on a
    // contract (no stale or orphan operations, no unknown adapter prefix)
    const classified = new Set([...writes.values()].map((w) => w.operation));
    for (const op of EXTERNAL_WRITE_OPERATIONS) {
      expect(classified.has(op), `'${op}' names no write on any provider contract`).toBe(true);
    }
    expect(new Set(EXTERNAL_WRITE_OPERATIONS).size).toBe(classified.size);
  });

  it("keeps every raw-provider write, in every gateway file that resolves one, inside the final-call guard", () => {
    const { writes } = classify();
    const gatewaySources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));

    // enrolment: a file that CALLS a raw resolver must be one of CALL_SITES —
    // a new file that resolves a provider fails until it is enrolled and checked
    const enrolled = new Set<string>(CALL_SITES.map((c) => c.file));
    for (const file of gatewaySources) {
      const source = parse(path.join(here, file));
      let resolves = false;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && RESOLVERS.has(node.expression.text)) resolves = true;
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (resolves) expect(enrolled.has(file), `${file} resolves a raw provider but is not enrolled in CALL_SITES`).toBe(true);
    }

    const seenEverywhere = new Set<string>();
    for (const site of CALL_SITES) {
      const source = parse(path.join(here, site.file));
      const factory = site.wrapperFactory ?? null;
      const seen = new Set<string>();
      let resolverCalls = 0;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (site.resolvers as readonly string[]).includes(node.expression.text)) {
          resolverCalls++;
          if (factory && enclosingFunction(node) !== factory) {
            // outside the wrapper factory a raw provider may be CONSTRUCTED to
            // validate a connection, but never kept: the call must be a bare
            // expression statement whose result is discarded
            expect(ts.isExpressionStatement(node.parent), `${site.file}: ${node.expression.text} outside ${factory} must not retain the raw provider`).toBe(true);
          }
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && writes.has(node.expression.name.text)) {
          const method = node.expression.name.text;
          // outside the wrapper factory every provider in pm.ts IS the wrapper
          // (the only raw one is born inside it), so only calls inside the
          // factory are raw-provider calls
          const raw = !factory || enclosingFunction(node) === factory;
          if (raw) {
            seen.add(method);
            const guard = enclosingCall(node, "runExternalWrite");
            expect(guard, `${site.file}: raw ${node.expression.getText(source)} must be guarded`).toBeDefined();
            // the operation literal must be THIS method's classification, not
            // a neighbour's copied across
            const literal = guard!.arguments[1];
            expect(literal && ts.isStringLiteral(literal) ? literal.text : null, `${site.file}: ${method} is guarded under the wrong operation`)
              .toBe(writes.get(method)!.operation);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(resolverCalls, `${site.file}: no raw resolver call found`).toBeGreaterThan(0);
      expect([...seen].sort()).toEqual([...site.expectWrites].sort());
      for (const m of seen) seenEverywhere.add(m);

      if (factory) {
        // the wrapper literal classifies EVERY method of the contract: writes
        // through the barrier under their operation, reads as plain passthroughs
        const contract = CONTRACTS.find((c) => c.adapter === site.wrapperContract)!;
        const methods = interfaceMethods(parse(contract.source), contract.iface);
        const literals: ts.ObjectLiteralExpression[] = [];
        const find = (node: ts.Node) => {
          if (ts.isFunctionDeclaration(node) && node.name?.text === factory) {
            const inner = (n: ts.Node) => {
              if (ts.isReturnStatement(n) && n.expression) {
                const e = ts.isSatisfiesExpression(n.expression) ? n.expression.expression : n.expression;
                if (ts.isObjectLiteralExpression(e)) literals.push(e);
              }
              ts.forEachChild(n, inner);
            };
            inner(node);
          }
          ts.forEachChild(node, find);
        };
        find(source);
        expect(literals.length, `${site.file}: ${factory} must return one object literal`).toBe(1);
        const props = new Map(
          literals[0]!.properties.filter(ts.isPropertyAssignment).map((p) => [(p.name as ts.Identifier).text, p.initializer]),
        );
        for (const m of methods) {
          const init = props.get(m);
          expect(init, `${site.file}: ${factory} does not classify contract method '${m}'`).toBeDefined();
          const guards: string[] = [];
          const walk = (n: ts.Node) => {
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "runExternalWrite") {
              const lit = n.arguments[1];
              guards.push(lit && ts.isStringLiteral(lit) ? lit.text : "<non-literal>");
            }
            ts.forEachChild(n, walk);
          };
          walk(init!);
          if (writes.has(m)) expect(guards, `${site.file}: wrapper '${m}' must run through the barrier`).toEqual([writes.get(m)!.operation]);
          else expect(guards, `${site.file}: read '${m}' must not be classified as an external write`).toEqual([]);
        }
      }
    }
    // every classified write is actually reached from some gateway call site
    expect([...seenEverywhere].sort()).toEqual([...writes.keys()].sort());
  });
});
