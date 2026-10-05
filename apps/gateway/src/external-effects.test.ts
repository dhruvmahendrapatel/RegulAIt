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
  // gateway consumes rather than from a hand-typed method list.
  //
  //  - Every member of each provider interface that is not `kind` or a NAMED
  //    read is a write, whatever its syntax (method OR property signature); a
  //    contract that inherits members (`extends`) cannot be read from its own
  //    declaration, so it is refused outright rather than under-classified.
  //  - A write must be classified in EXTERNAL_WRITE_OPERATIONS under its
  //    adapter's prefix, and nothing else may be.
  //  - ENROLMENT IS BY IMPORT, not by a hand list: every non-test file under
  //    src/ (recursively) that imports anything from a contract module — a
  //    provider package or deploy.js, by value, type, namespace, alias,
  //    re-export or import() — is enrolled, and EVERY call of a write name in
  //    it must sit inside runExternalWrite under that method's operation. A
  //    type-only import enrols too: it is exactly how a helper file receives
  //    a raw provider as a parameter.
  //  - The type checker backs this up across ALL of src/: a call that
  //    resolves to a contract member (or a member of a class implementing
  //    one) is checked even in a file that imports no contract at all.
  //  - The only escape from the guard is a wrapper whose own methods are the
  //    barrier — pm.ts providerFor — and there EVERY return must be that
  //    classified literal and the raw provider may only ever be dereferenced.
  //  - Every @regulait/*-provider package the gateway imports or depends on
  //    is either a CONTRACT here or on the commented exemption list below.
  // -------------------------------------------------------------------------

  const GATEWAY_ROOT = path.resolve(here, "..");
  const PACKAGES = path.resolve(here, "../../../packages");
  const BARRIER_FILE = path.join(here, "external-effects.ts");

  /** `module` is a package name, or the absolute path of a gateway-local contract module */
  const CONTRACTS = [
    { adapter: "deploy", module: path.join(here, "deploy.ts"), source: path.join(here, "deploy.ts"), iface: "DeployProvider", reads: [] as string[] },
    { adapter: "git", module: "@regulait/git-provider", source: path.join(PACKAGES, "git-provider/src/types.ts"), iface: "GitProvider", reads: ["getPullRequest", "listChecks"] },
    { adapter: "infra", module: "@regulait/infra-provider", source: path.join(PACKAGES, "infra-provider/src/index.ts"), iface: "InfraProvider", reads: ["scan"] },
    { adapter: "pm", module: "@regulait/pm-provider", source: path.join(PACKAGES, "pm-provider/src/index.ts"), iface: "PmProvider", reads: ["getWorkItem"] },
  ] as const;
  type Contract = (typeof CONTRACTS)[number];

  /**
   * The @regulait/*-provider packages the gateway uses that this barrier does
   * NOT classify, each with the reason. A provider package the gateway starts
   * importing or depending on that is neither here nor in CONTRACTS fails the
   * coverage test below until someone classifies its writes or records why it
   * is out of scope; an entry no file imports any more fails as stale.
   */
  const EXEMPT_PROVIDER_PACKAGES = new Map<string, string>([
    // Model dispatch. A model call is a governed agent call admitted by
    // evaluateAgent, whose REQUIRED `execution` input carries the ADR-0124
    // dial (§2) — the kernel gate, not this post-preparation barrier.
    ["@regulait/model-provider", "model dispatch — gated in the kernel by evaluateAgent's required execution input (ADR-0124 §2)"],
    // Connector invocations are admitted by evaluateConnector with the same
    // required dial (ADR-0124 §2). chatops.ts reuses the adapter as the
    // ADR-0061/0113 courier that posts the governance plane's own approval
    // cards and alerts.
    ["@regulait/connector-provider", "connector invocations — gated in the kernel by evaluateConnector's required execution input (ADR-0124 §2)"],
    // ADR-0065 training backends (RegulAIt-LLM). A training job is admitted
    // through evaluateAgent (the dial is a required input) when it is
    // created; it is not one of the four adapter contracts classified here.
    ["@regulait/training-provider", "RegulAIt-LLM training backends (ADR-0065) — admitted through evaluateAgent at job creation"],
  ]);

  /** the only functions allowed to hold a raw provider without guarding each call:
   * they return a wrapper whose write methods ARE the barrier */
  const WRAPPER_FACTORIES = [
    { file: path.join(here, "pm.ts"), factory: "providerFor", adapter: "pm", resolver: "resolvePmProvider" },
  ] as const;

  const PROVIDER_PACKAGE = /^(@regulait\/[a-z0-9-]+-provider)(?:\/|$)/;
  const CONTRACT_IFACES = new Set<string>(CONTRACTS.map((c) => c.iface));
  const isPackage = (module: string) => module.startsWith("@");
  /** where each contract's own implementations live (a package dir, or the local module file) */
  const CONTRACT_HOMES: ReadonlyArray<{ dir: string } | { file: string }> = CONTRACTS.map((c) =>
    isPackage(c.module) ? { dir: path.join(PACKAGES, c.module.slice("@regulait/".length)) + path.sep } : { file: c.module },
  );

  const parse = (file: string) =>
    ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const rel = (file: string) => path.relative(here, file).split(path.sep).join("/");

  /** every non-test TypeScript source under src/, recursively */
  const gatewaySources = (dir: string = here): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return gatewaySources(full);
      return /\.[cm]?tsx?$/.test(entry.name) && !/\.test\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
    });

  /** EVERY member of a contract interface, whatever its syntax */
  const contractMembers = (source: ts.SourceFile, iface: string): string[] => {
    const found: ts.InterfaceDeclaration[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === iface) found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (found.length !== 1) throw new Error(`${source.fileName}: expected one interface ${iface}, found ${found.length}`);
    const decl = found[0]!;
    // an inherited member is invisible to this read: refuse rather than under-classify
    if (decl.heritageClauses && decl.heritageClauses.length > 0) {
      throw new Error(
        `${source.fileName}: interface ${iface} has a heritage clause (${decl.heritageClauses.map((h) => h.getText(source)).join(" ")}) — ` +
        "its inherited members cannot be classified from this declaration; declare them on the contract itself",
      );
    }
    return [...new Set(decl.members.map((member) => {
      const name = member.name;
      if (!(ts.isMethodSignature(member) || ts.isPropertySignature(member)) || !name || !(ts.isIdentifier(name) || ts.isStringLiteral(name))) {
        throw new Error(`${source.fileName}: ${iface} member '${member.getText(source)}' cannot be classified — only named method or property signatures can`);
      }
      return name.text;
    }))];
  };

  /** method name → the operation it must be classified as, for every contract write */
  const classify = () => {
    const writes = new Map<string, { adapter: string; operation: string }>();
    const reads = new Set<string>();
    for (const c of CONTRACTS) {
      const members = contractMembers(parse(c.source), c.iface);
      expect(members, `${c.iface}: no 'kind' discriminant`).toContain("kind");
      for (const r of c.reads) expect(members, `${c.iface}: named read '${r}' is not on the contract`).toContain(r);
      for (const m of members) {
        if (m === "kind" || (c.reads as readonly string[]).includes(m)) { reads.add(m); continue; }
        expect(writes.has(m), `write member '${m}' appears on two contracts`).toBe(false);
        writes.set(m, { adapter: c.adapter, operation: `${c.adapter}.${snake(m)}` });
      }
    }
    // a name cannot be a read on one contract and a write on another: the
    // guard check below is by name in enrolled files
    for (const m of writes.keys()) expect(reads.has(m), `'${m}' is a read on one contract and a write on another`).toBe(false);
    return { writes, reads };
  };

  /** every module a file names, however it names it */
  interface ModuleRef { spec: string; typeOnly: boolean }
  const moduleRefs = (source: ts.SourceFile): ModuleRef[] => {
    const refs: ModuleRef[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
        const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.length > 0 && named.every((e) => e.isTypeOnly)));
        refs.push({ spec: node.moduleSpecifier.text, typeOnly });
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : undefined;
        refs.push({ spec: node.moduleSpecifier.text, typeOnly: node.isTypeOnly || (!!named && named.length > 0 && named.every((e) => e.isTypeOnly)) });
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const e = node.moduleReference.expression;
        if (!ts.isStringLiteralLike(e)) throw new Error(`${source.fileName}: import = require(<non-literal>) cannot be enrolled`);
        refs.push({ spec: e.text, typeOnly: node.isTypeOnly });
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const arg = node.arguments[0];
        // a module this test cannot name is a module it cannot enrol — fail closed
        if (!arg || !ts.isStringLiteralLike(arg)) throw new Error(`${source.fileName}: ${node.getText(source)} names its module dynamically and cannot be enrolled`);
        refs.push({ spec: arg.text, typeOnly: false });
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        refs.push({ spec: node.argument.literal.text, typeOnly: true });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return refs;
  };
  const contractOf = (file: string, spec: string): Contract | undefined =>
    CONTRACTS.find((c) =>
      isPackage(c.module)
        ? spec === c.module || spec.startsWith(`${c.module}/`)
        : spec.startsWith(".") && path.resolve(path.dirname(file), spec).replace(/\.[cm]?[jt]sx?$/, "") === c.module.replace(/\.ts$/, ""),
    );

  // --- the type checker, over every non-test gateway source (built once) ----
  let programMemo: { program: ts.Program; checker: ts.TypeChecker } | null = null;
  const gatewayProgram = () => {
    if (programMemo) return programMemo;
    const configPath = path.join(GATEWAY_ROOT, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, GATEWAY_ROOT);
    const program = ts.createProgram({ rootNames: gatewaySources(), options: { ...parsed.options, noEmit: true } });
    programMemo = { program, checker: program.getTypeChecker() };
    return programMemo;
  };
  const sourceOf = (program: ts.Program, file: string) => {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`${file} is not in the gateway program`);
    return source;
  };
  const declarationsOf = (checker: ts.TypeChecker, node: ts.Node): readonly ts.Declaration[] => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations ?? [];
  };
  /** a member of a contract interface, or of a class implementing one / living in a contract's home */
  const isRawDeclaration = (decl: ts.Declaration) => {
    const owner = decl.parent;
    if (ts.isInterfaceDeclaration(owner)) return CONTRACT_IFACES.has(owner.name.text);
    if (!ts.isClassLike(owner)) return false;
    const file = decl.getSourceFile().fileName;
    if (CONTRACT_HOMES.some((h) => ("dir" in h ? file.startsWith(h.dir) : file === h.file))) return true;
    return (owner.heritageClauses ?? []).some((h) =>
      h.types.some((t) => CONTRACT_IFACES.has(t.expression.getText(decl.getSourceFile()).split(".").pop()!)));
  };
  const isFunctionBoundary = (node: ts.Node) => ts.isFunctionLike(node) || ts.isClassLike(node);
  /** the runExternalWrite call whose THIRD argument is the function that directly contains `call` */
  const barrierOf = (checker: ts.TypeChecker, call: ts.CallExpression): ts.CallExpression | null => {
    let fn: ts.Node | undefined = call.parent;
    while (fn && !isFunctionBoundary(fn)) fn = fn.parent;
    const guard = fn?.parent;
    if (!fn || !guard || !ts.isCallExpression(guard) || guard.arguments[2] !== fn) return null;
    const callee = ts.isPropertyAccessExpression(guard.expression) ? guard.expression.name : guard.expression;
    const isBarrier = declarationsOf(checker, callee).some((d) =>
      ts.isFunctionDeclaration(d) && d.name?.text === "runExternalWrite" && d.getSourceFile().fileName === BARRIER_FILE);
    return isBarrier ? guard : null;
  };

  /** every reference to a write NAME in a file: calls, element access, destructuring */
  interface WriteRef { method: string; at: ts.Node; call: ts.CallExpression | null; declarations: readonly ts.Declaration[] }
  const writeReferences = (checker: ts.TypeChecker, source: ts.SourceFile, writes: ReadonlyMap<string, unknown>): WriteRef[] => {
    const refs: WriteRef[] = [];
    const calleeOf = (access: ts.Expression) =>
      ts.isCallExpression(access.parent) && access.parent.expression === access ? access.parent : null;
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && writes.has(node.name.text)) {
        refs.push({ method: node.name.text, at: node, call: calleeOf(node), declarations: declarationsOf(checker, node.name) });
      } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && writes.has(node.argumentExpression.text)) {
        refs.push({ method: node.argumentExpression.text, at: node, call: calleeOf(node), declarations: declarationsOf(checker, node.argumentExpression) });
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && writes.has(key.text)) {
          const property = checker.getTypeAtLocation(node.parent).getProperty(key.text);
          refs.push({ method: key.text, at: node, call: null, declarations: property?.declarations ?? [] });
        }
      } else if (
        ts.isObjectLiteralExpression(node) && ts.isBinaryExpression(node.parent) &&
        node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        // a destructuring ASSIGNMENT: ({ mergePullRequest } = provider)
        const from = checker.getTypeAtLocation(node.parent.right);
        for (const p of node.properties) {
          if ((ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && writes.has(p.name.text)) {
            refs.push({ method: p.name.text, at: p, call: null, declarations: from.getProperty(p.name.text)?.declarations ?? [] });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return refs;
  };

  /** the wrapper literals each factory returns — the ONLY declarations a write may resolve to unguarded */
  const factoryFunction = (source: ts.SourceFile, name: string) => {
    const found: ts.FunctionDeclaration[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (found.length !== 1) throw new Error(`${source.fileName}: expected one function ${name}, found ${found.length}`);
    return found[0]!;
  };
  /** the return statements of `fn` itself — not of the functions nested inside it */
  const ownReturns = (fn: ts.FunctionDeclaration): ts.ReturnStatement[] => {
    const out: ts.ReturnStatement[] = [];
    const visit = (node: ts.Node) => {
      if (isFunctionBoundary(node)) return;
      if (ts.isReturnStatement(node)) out.push(node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body!, visit);
    return out;
  };
  const unwrapExpression = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)
      ? unwrapExpression(e.expression)
      : e;
  const wrapperLiterals = (program: ts.Program) => {
    const literals = new Set<ts.ObjectLiteralExpression>();
    for (const w of WRAPPER_FACTORIES) {
      for (const r of ownReturns(factoryFunction(sourceOf(program, w.file), w.factory))) {
        const e = r.expression ? unwrapExpression(r.expression) : undefined;
        if (e && ts.isObjectLiteralExpression(e)) literals.add(e);
      }
    }
    return literals;
  };

  it("classifies every write member of every provider contract, and nothing else", () => {
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

  it("names every @regulait/*-provider package the gateway uses as a contract or an explicit exemption", () => {
    const used = new Map<string, Set<string>>();
    for (const file of gatewaySources()) {
      for (const ref of moduleRefs(parse(file))) {
        const pkg = PROVIDER_PACKAGE.exec(ref.spec)?.[1];
        if (pkg) used.set(pkg, (used.get(pkg) ?? new Set()).add(rel(file)));
      }
    }
    const manifest = JSON.parse(readFileSync(path.join(GATEWAY_ROOT, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const declared = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
      .flatMap((k) => Object.keys(manifest[k] ?? {}))
      .filter((name) => PROVIDER_PACKAGE.test(name));
    const contractPackages = new Set(CONTRACTS.map((c) => c.module).filter(isPackage));
    for (const pkg of new Set([...used.keys(), ...declared])) {
      expect(
        contractPackages.has(pkg) || EXEMPT_PROVIDER_PACKAGES.has(pkg),
        `${pkg} (${[...(used.get(pkg) ?? ["package.json"])].join(", ")}) is neither a CONTRACT nor an explicit exemption — classify its writes or record why it is out of scope`,
      ).toBe(true);
    }
    for (const pkg of EXEMPT_PROVIDER_PACKAGES.keys()) {
      expect(contractPackages.has(pkg), `${pkg} is both a contract and an exemption`).toBe(false);
      expect(used.has(pkg), `${pkg} is exempt but no gateway file imports it — drop the stale exemption`).toBe(true);
    }
    for (const pkg of contractPackages) expect(used.has(pkg), `contract ${pkg} is imported by no gateway file`).toBe(true);
  });

  it("keeps every write, in every file that imports a contract (and every raw-typed write anywhere), inside the final-call guard", { timeout: 120_000 }, () => {
    const { writes } = classify();
    const { program, checker } = gatewayProgram();
    const wrappers = wrapperLiterals(program);
    const isWrapperDeclaration = (d: ts.Declaration) => ts.isPropertyAssignment(d) && ts.isObjectLiteralExpression(d.parent) && wrappers.has(d.parent);

    const enrolled: string[] = [];
    const problems: string[] = [];
    const seenEverywhere = new Set<string>();
    for (const file of gatewaySources()) {
      const source = sourceOf(program, file);
      const isEnrolled = moduleRefs(source).some((ref) => contractOf(file, ref.spec) !== undefined);
      if (isEnrolled) enrolled.push(rel(file));
      for (const ref of writeReferences(checker, source, writes)) {
        // the wrapper's own methods ARE the barrier (verified in the next test)
        if (ref.declarations.length > 0 && ref.declarations.every(isWrapperDeclaration)) continue;
        const raw = ref.declarations.some(isRawDeclaration);
        const unresolved = ref.declarations.length === 0;
        // in an enrolled file EVERY write-named call is checked, whatever it
        // resolves to; elsewhere, whatever the checker proves raw
        if (!isEnrolled && !raw) continue;
        const where = `${rel(file)}:${source.getLineAndCharacterOfPosition(ref.at.getStart(source)).line + 1}`;
        if (!ref.call) {
          if (raw || unresolved) problems.push(`${where}: '${ref.at.getText(source)}' takes a write without calling it in place — a write must be CALLED inside runExternalWrite, never destructured, aliased or passed along`);
          continue;
        }
        const guard = barrierOf(checker, ref.call);
        if (!guard) {
          problems.push(`${where}: '${ref.call.getText(source).split("\n")[0]}' must be the direct body of runExternalWrite(db, "${writes.get(ref.method)!.operation}", () => …)`);
          continue;
        }
        // the operation literal must be THIS method's classification, not a
        // neighbour's copied across
        const literal = guard.arguments[1];
        const operation = literal && ts.isStringLiteralLike(literal) ? literal.text : "<non-literal>";
        if (operation !== writes.get(ref.method)!.operation) {
          problems.push(`${where}: ${ref.method} is guarded as '${operation}', not '${writes.get(ref.method)!.operation}'`);
          continue;
        }
        seenEverywhere.add(ref.method);
      }
    }
    expect(problems).toEqual([]);
    // the vacuity control: enrolment by import finds the three known call sites
    expect(enrolled, `enrolled: ${enrolled.join(", ")}`).toEqual(expect.arrayContaining(["workflows.ts", "infra.ts", "pm.ts"]));
    // every classified write is actually reached from some guarded call
    expect([...seenEverywhere].sort()).toEqual([...writes.keys()].sort());
  });

  it("lets the raw provider out of pm.ts providerFor only as the classified wrapper", { timeout: 120_000 }, () => {
    const { writes } = classify();
    const { program, checker } = gatewayProgram();
    for (const w of WRAPPER_FACTORIES) {
      const source = sourceOf(program, w.file);
      const fn = factoryFunction(source, w.factory);
      const contract = CONTRACTS.find((c) => c.adapter === w.adapter)!;
      const members = contractMembers(parse(contract.source), contract.iface);

      // (1) EVERY return of the factory itself is the classified literal — a
      // `return provider` on any branch hands a caller the raw adapter
      const returns = ownReturns(fn);
      expect(returns.length, `${rel(w.file)}: ${w.factory} has no return`).toBeGreaterThan(0);
      for (const r of returns) {
        const e = r.expression ? unwrapExpression(r.expression) : undefined;
        expect(e !== undefined && ts.isObjectLiteralExpression(e), `${rel(w.file)}: ${w.factory} has '${r.getText(source)}' — every return must be the classified wrapper literal`).toBe(true);
        const literal = e as ts.ObjectLiteralExpression;
        const names: string[] = [];
        for (const p of literal.properties) {
          expect(
            ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)),
            `${rel(w.file)}: wrapper member '${p.getText(source)}' is not a plain property assignment — a spread, shorthand or method cannot be classified`,
          ).toBe(true);
          const property = p as ts.PropertyAssignment;
          const name = (property.name as ts.Identifier).text;
          names.push(name);
          const guards: string[] = [];
          const walk = (n: ts.Node) => {
            if (ts.isCallExpression(n) && declarationsOf(checker, ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression)
              .some((d) => ts.isFunctionDeclaration(d) && d.name?.text === "runExternalWrite" && d.getSourceFile().fileName === BARRIER_FILE)) {
              const lit = n.arguments[1];
              guards.push(lit && ts.isStringLiteralLike(lit) ? lit.text : "<non-literal>");
            }
            ts.forEachChild(n, walk);
          };
          walk(property.initializer);
          if (writes.has(name)) expect(guards, `${rel(w.file)}: wrapper '${name}' must run through the barrier`).toEqual([writes.get(name)!.operation]);
          else expect(guards, `${rel(w.file)}: '${name}' is not a write and must not be classified as one`).toEqual([]);
        }
        // exactly the contract's members, each once
        expect([...names].sort(), `${rel(w.file)}: ${w.factory}'s wrapper must classify exactly the ${contract.iface} members`).toEqual([...members].sort());
      }

      // (2) the raw provider is born ONCE, bound to a const, and only ever
      // dereferenced — it cannot be returned, spread, passed or re-bound
      const resolverNames = new Set<string>();
      const namespaces = new Set<string>();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || contractOf(w.file, statement.moduleSpecifier.text) !== contract) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const e of bindings.elements) if ((e.propertyName ?? e.name).text === w.resolver) resolverNames.add(e.name.text);
        }
      }
      const isResolverCall = (n: ts.Node): n is ts.CallExpression =>
        ts.isCallExpression(n) && (
          (ts.isIdentifier(n.expression) && resolverNames.has(n.expression.text)) ||
          (ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && namespaces.has(n.expression.expression.text) && n.expression.name.text === w.resolver));
      const births: ts.CallExpression[] = [];
      const outside: ts.CallExpression[] = [];
      const collect = (n: ts.Node, inFactory: boolean) => {
        if (isResolverCall(n)) (inFactory ? births : outside).push(n);
        ts.forEachChild(n, (c) => collect(c, inFactory || n === fn));
      };
      collect(source, false);
      expect(births.length, `${rel(w.file)}: ${w.factory} must resolve the raw provider exactly once`).toBe(1);
      let holder: ts.Node = births[0]!.parent;
      while (ts.isAwaitExpression(holder) || ts.isParenthesizedExpression(holder) || ts.isAsExpression(holder) || ts.isNonNullExpression(holder)) holder = holder.parent;
      expect(
        ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) && ts.isVariableDeclarationList(holder.parent) && (holder.parent.flags & ts.NodeFlags.Const) !== 0,
        `${rel(w.file)}: the raw provider must be bound to a const in ${w.factory}`,
      ).toBe(true);
      const rawName = (holder as ts.VariableDeclaration).name as ts.Identifier;
      const rawSymbol = checker.getSymbolAtLocation(rawName);
      expect(rawSymbol).toBeDefined();
      const escapes: string[] = [];
      const memberSet = new Set(members);
      const scan = (n: ts.Node) => {
        if (ts.isIdentifier(n) && n !== rawName && checker.getSymbolAtLocation(n) === rawSymbol) {
          const deref = ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && memberSet.has(n.parent.name.text);
          if (!deref) escapes.push(`${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}: ${n.parent.getText(source).split("\n")[0]}`);
        }
        ts.forEachChild(n, scan);
      };
      scan(fn);
      expect(escapes, `${rel(w.file)}: the raw provider escapes ${w.factory} other than through a contract member`).toEqual([]);

      // (3) outside the factory a raw provider may be CONSTRUCTED to validate
      // a connection, but never kept: the call's result is discarded
      for (const call of outside) {
        expect(ts.isExpressionStatement(call.parent), `${rel(w.file)}: ${call.getText(source).split("\n")[0]} outside ${w.factory} must not retain the raw provider`).toBe(true);
      }
    }
  });
});
