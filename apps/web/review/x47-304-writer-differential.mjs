/** Independent X47 source review: old/new eligibility on real writers plus a renamed-class negative. */
import assert from "node:assert/strict";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";

const gateway = path.resolve(process.env.X47_GATEWAY_ROOT ?? "apps/gateway");
const files = readdirSync(path.join(gateway, "src"))
  .filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map(name => path.join(gateway, "src", name));
const config = ts.readConfigFile(path.join(gateway, "tsconfig.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, gateway);
const receiptTypes = new Set(["agent", "mcp_tool", "connector", "approval"]);
const classPattern = /receiptClass:\s*"(?:decision|configuration|excluded)"/;

function programFor(overrides = new Map()) {
  const host = ts.createCompilerHost(parsed.options);
  const original = host.readFile;
  host.readFile = file => overrides.get(path.resolve(file)) ?? original(file);
  return ts.createProgram(files, parsed.options, host);
}
function scan(program) {
  const checker = program.getTypeChecker(), rows = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source).replace(/\s+/g, "").endsWith("insert(auditLog).values")) {
        for (const arg of node.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) continue;
          const oldProperty = checker.getPropertyOfType(checker.getTypeAtLocation(arg), "objectType");
          const oldType = oldProperty && checker.getTypeOfSymbolAtLocation(oldProperty, arg);
          const direct = arg.properties.find(property => property.name?.getText(source) === "objectType");
          const spread = arg.properties.some(ts.isSpreadAssignment);
          const newPresent = spread ? Boolean(oldProperty) : Boolean(direct);
          const newType = spread ? oldType : direct && checker.getTypeAtLocation(ts.isPropertyAssignment(direct) ? direct.initializer : direct.name);
          const eligible = (present, type) => !present || (type?.isUnion() ? type.types : type ? [type] : [])
            .some(member => member.isStringLiteral() && receiptTypes.has(member.value));
          const detail = arg.properties.find(property => property.name?.getText(source) === "detail");
          rows.push({
            site: `${path.basename(file)}:${source.getLineAndCharacterOfPosition(arg.getStart()).line + 1}`,
            file, start: arg.getStart(), end: arg.getEnd(),
            old: eligible(Boolean(oldProperty), oldType), next: eligible(newPresent, newType),
            classified: classPattern.test(detail?.getText(source) ?? ""), spread,
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return rows;
}

const actual = scan(programFor());
assert(actual.length > 400, "the review must include the real gateway writer inventory");
assert.deepEqual(actual.filter(row => row.old !== row.next).map(row => row.site), [], "old/new eligibility changed");
assert.deepEqual(actual.filter(row => row.next && !row.classified).map(row => row.site), [], "unclassified real eligible writer");
const selected = actual.find(row => row.next && row.classified && !row.spread);
assert(selected, "need a real classified literal as a negative control");
const text = readFileSync(selected.file, "utf8");
const literal = text.slice(selected.start, selected.end);
assert(literal.includes("receiptClass:"));
const changed = text.slice(0, selected.start) + literal.replace("receiptClass:", "renamedReceiptClass:") + text.slice(selected.end);
const negative = scan(programFor(new Map([[path.resolve(selected.file), changed]])));
assert.deepEqual(negative.filter(row => row.old && !row.classified).map(row => row.site), [selected.site]);
assert.deepEqual(negative.filter(row => row.next && !row.classified).map(row => row.site), [selected.site]);
console.log(JSON.stringify({ writers: actual.length, eligible: actual.filter(row => row.next).length,
  spreadFallbacks: actual.filter(row => row.spread).length, changedEligibility: 0,
  renamedRealWriter: selected.site, oldAndNewRejectRenamedClass: true }));
