/** R21-07: a new audit writer cannot silently enter the receipt stream.
 * TypeScript resolves helper/union object types; database tests cover signed output. */
import { expect, it } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
it("every gateway audit writer capable of receipt object types explicitly classifies its row",()=>{
 const root=path.resolve("src"), files=readdirSync(root).filter(f=>f.endsWith(".ts")&&!f.endsWith(".test.ts")).map(f=>path.join(root,f));
 const config=ts.readConfigFile("tsconfig.json",ts.sys.readFile);
 const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,path.resolve("."));
 const program=ts.createProgram(files,parsed.options),checker=program.getTypeChecker();
 const missing:string[]=[];let classified=0;
 for(const file of files){const source=program.getSourceFile(file)!;function visit(node:ts.Node){
  if(ts.isCallExpression(node)&&node.expression.getText(source).replace(/\s+/g,"").endsWith("insert(auditLog).values")){
   for(const arg of node.arguments){if(!ts.isObjectLiteralExpression(arg))continue;
    const property=checker.getPropertyOfType(checker.getTypeAtLocation(arg),"objectType");
    const type=property&&checker.getTypeOfSymbolAtLocation(property,arg);
    const members=type?.isUnion()?type.types:type?[type]:[];
    const eligible=!property||members.some(t=>t.isStringLiteral()&&["agent","mcp_tool","connector","approval"].includes(t.value));
    if(!eligible)continue;
    const detail=arg.properties.find(p=>p.name?.getText(source)==="detail");
    const text=detail?.getText(source)??"";
    if(!/receiptClass:\s*"(?:decision|configuration)"/.test(text))missing.push(`${path.basename(file)}:${source.getLineAndCharacterOfPosition(arg.getStart()).line+1}`);
    else classified++;
   }
  }ts.forEachChild(node,visit);
 }visit(source);}
 expect(classified).toBeGreaterThan(50);expect(missing).toEqual([]);
},60000);
