/** R21-07: a new audit writer cannot silently enter the receipt stream.
 * TypeScript resolves helper/union object types; database tests cover signed output. */
import { expect, it } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const NON_DECISION:RegExp[]=[
 /ruleId:\s*"approval-(?:routed|sla-breached|sla-warning|claimed|bulk-item-refused|signature-refused|assignment-rule-[a-z]+|delegation-[a-z]+)"/,
 /phase:\s*"(?:routing|sla|builder-resume|redteam-adjudication|evaluate)"/,
 /subsystem:\s*"(?:chatops|approval-signature)"/,
 /ruleId:\s*`external-effect:/,
 /via:\s*"evaluate"/,
 /\.\.\.actor\.detail/,
];
/** Files whose every audit writer records an operator control, a channel event or an effect, never a decision. */
const NON_DECISION_FILES=new Set(["execution-control.ts","chatops.ts","external-effects.ts"]);
it("every gateway audit writer capable of receipt object types explicitly classifies its row",()=>{
 const root=path.resolve("src"), files=readdirSync(root).filter(f=>f.endsWith(".ts")&&!f.endsWith(".test.ts")).map(f=>path.join(root,f));
 const config=ts.readConfigFile("tsconfig.json",ts.sys.readFile);
 const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,path.resolve("."));
 const program=ts.createProgram(files,parsed.options),checker=program.getTypeChecker();
 const missing:string[]=[],misclassified:string[]=[];let classified=0;
 for(const file of files){const source=program.getSourceFile(file)!;function visit(node:ts.Node){
  if(ts.isCallExpression(node)&&node.expression.getText(source).replace(/\s+/g,"").endsWith("insert(auditLog).values")){
   for(const arg of node.arguments){if(!ts.isObjectLiteralExpression(arg))continue;
    // Type only the `objectType` initializer, not the whole literal: typing the literal makes the
    // checker resolve it against drizzle's `values()` overloads, ~90% of this test's cost (measured
    // 18.5 s vs 1.5 s over 489 writers, identical eligibility at every site). A literal with a spread
    // can take objectType from the spread, so it keeps the whole-literal form.
    const explicit=arg.properties.find(p=>p.name?.getText(source)==="objectType");
    let present:boolean,type:ts.Type|undefined;
    if(arg.properties.some(ts.isSpreadAssignment)){
     const property=checker.getPropertyOfType(checker.getTypeAtLocation(arg),"objectType");
     present=!!property;type=property&&checker.getTypeOfSymbolAtLocation(property,arg);
    }else{
     present=!!explicit;
     type=explicit&&checker.getTypeAtLocation(ts.isPropertyAssignment(explicit)?explicit.initializer:explicit.name!);
    }
    const members=type?.isUnion()?type.types:type?[type]:[];
    const eligible=!present||members.some(t=>t.isStringLiteral()&&["agent","mcp_tool","connector","approval"].includes(t.value));
    if(!eligible)continue;
    const detail=arg.properties.find(p=>p.name?.getText(source)==="detail");
    const text=detail?.getText(source)??"";
    const where=`${path.basename(file)}:${source.getLineAndCharacterOfPosition(arg.getStart()).line+1}`;
    if(!/receiptClass:\s*"(?:decision|configuration|excluded)"/.test(text))missing.push(where);
    else classified++;
    // ADR-0186 decision 30 (PR #234 item 1): only governed-call allow/deny/refuse and approval
    // approve/deny/expire outcomes are decisions. A writer that is one of the known non-decision event
    // families (routing, SLA, claims, refused decide attempts, advisory previews, effect records,
    // red-team adjudications, playground summaries, operator controls) may not be signed as one.
    if(/receiptClass:\s*"decision"/.test(text)){
     const whole=arg.getText(source);
     const hit=NON_DECISION_FILES.has(path.basename(file))?"file":NON_DECISION.find(r=>r.test(whole));
     if(hit)misclassified.push(`${where} ${hit}`);
    }
   }
  }ts.forEachChild(node,visit);
 }visit(source);}
 expect(classified).toBeGreaterThan(50);expect(missing).toEqual([]);expect(misclassified).toEqual([]);
},60000);
