/**
 * ADR-0053 §5 — THE CLIENT GENERATOR.
 *
 * WHAT IS HONESTLY DELIVERED, AND WHAT IS NOT
 * -------------------------------------------
 * This emits ONE language: TypeScript. There is no Python client, no Go client
 * and no Java client in this repository, and nothing here should be read as
 * claiming otherwise. The ADR proposes Python/TS/Java via openapi-generator;
 * what is built is the artifact those generators consume (`docs/api/openapi.json`,
 * a valid OpenAPI 3.0.3 document) plus the one client we can actually keep green
 * in CI — because a generated client nobody compiles is a promise, not a
 * deliverable. Adding a language is running openapi-generator against the same
 * document; that pipeline is follow-up, and the ADR's amendment says so.
 *
 * WHAT MAKES THE EMITTED CLIENT NON-DRIFTING
 * ------------------------------------------
 * It is a pure function of the spec document, which is itself a pure function
 * of the live route inventory and the handlers' own zod schemas. The emitted
 * file is checked in (so `pnpm -r build` typechecks it and consumers can read
 * it), and `openapi.test.ts` re-runs this function and fails when the checked-in
 * file differs. A route added, removed, renamed or re-tagged shows up as a
 * failing test, not as a client that silently lost a method.
 *
 * REQUEST bodies are typed, because the routes declare zod schemas for them.
 * RESPONSES are `unknown` by default with a caller-supplied type parameter,
 * because the routes do NOT declare response schemas — inventing a response
 * interface here would be exactly the hand-maintained fiction this ADR exists
 * to prevent. Tightening the route response schemas is the prerequisite for
 * typed responses, and it is named as follow-up rather than faked.
 */

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  additionalProperties?: boolean | JsonSchemaNode;
  format?: string;
  description?: string;
}

/** JSON Schema -> a TypeScript type expression. Deliberately total: anything
 * this does not understand becomes `unknown`, which is honest, rather than
 * `any`, which is a lie a compiler will not catch. */
export function tsTypeOf(node: JsonSchemaNode | undefined, indent = 2): string {
  if (!node) return "unknown";
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  const union = node.anyOf ?? node.oneOf;
  if (union && union.length > 0) {
    return union.map((n) => tsTypeOf(n, indent)).join(" | ");
  }
  if (node.allOf && node.allOf.length > 0) {
    return node.allOf.map((n) => tsTypeOf(n, indent)).join(" & ");
  }
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${tsTypeOf(node.items, indent)}>`;
    case "object": {
      const props = node.properties ?? {};
      const names = Object.keys(props);
      if (names.length === 0) {
        const extra = typeof node.additionalProperties === "object"
          ? tsTypeOf(node.additionalProperties, indent)
          : "unknown";
        return `Record<string, ${extra}>`;
      }
      const req = new Set(node.required ?? []);
      const pad = " ".repeat(indent + 2);
      const body = names
        .map((n) => {
          const child = props[n]!;
          const doc = child.description ? `${pad}/** ${child.description} */\n` : "";
          return `${doc}${pad}${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n) ? n : JSON.stringify(n)}${req.has(n) ? "" : "?"}: ${tsTypeOf(child, indent + 2)};`;
        })
        .join("\n");
      return `{\n${body}\n${" ".repeat(indent)}}`;
    }
    default:
      return "unknown";
  }
}

interface Operation {
  operationId?: string;
  summary?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  requestBody?: { content?: Record<string, { schema?: JsonSchemaNode }> };
  "x-regulait-stability"?: string;
  "x-regulait-auth"?: string;
  "x-regulait-deprecation"?: { since: string; sunset: string; replacement: string | null };
  "x-regulait-compat-surface"?: string;
  "x-regulait-schema"?: string;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * Emit the generated half of `@regulait/api-client`. Pure: same spec in, same
 * bytes out, so the checked-in file can be diffed against a fresh render.
 */
export function generateTypeScriptClient(spec: Record<string, unknown>): string {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, Operation>>;
  const info = (spec.info ?? {}) as { version?: string };

  const methods: string[] = [];
  const types: string[] = [];
  const ops: Array<{ id: string; method: string; path: string }> = [];

  for (const path of Object.keys(paths).sort()) {
    for (const httpMethod of METHODS) {
      const op = paths[path]![httpMethod];
      if (!op) continue;
      const id = op.operationId ?? `${httpMethod}${path.replace(/[^A-Za-z0-9]/g, "")}`;
      ops.push({ id, method: httpMethod.toUpperCase(), path });

      const pathParams = (op.parameters ?? []).filter((p) => p.in === "path");
      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;

      const args: string[] = [];
      for (const p of pathParams) args.push(`${p.name}: string`);
      if (bodySchema) {
        const typeName = id.slice(0, 1).toUpperCase() + id.slice(1) + "Body";
        types.push(`export type ${typeName} = ${tsTypeOf(bodySchema)};`);
        args.push(`body: ${typeName}`);
      } else if (op["x-regulait-compat-surface"]) {
        args.push("body: unknown");
      } else if (op["x-regulait-schema"] === "unspecified") {
        args.push("body?: unknown");
      }
      args.push("options?: RequestOptions");

      const template = path.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, n) => "${encodeURIComponent(" + n + ")}");
      const passesBody = args.some((a) => a.startsWith("body"));
      const docLines = [
        op.summary ? ` * ${op.summary}` : null,
        ` * @stability ${op["x-regulait-stability"] ?? "unknown"} — auth: ${op["x-regulait-auth"] ?? "unknown"}`,
        op["x-regulait-compat-surface"]
          ? ` * @compat body/response shaped by the upstream vendor: ${op["x-regulait-compat-surface"]}`
          : null,
        op["x-regulait-schema"] === "unspecified"
          ? " * @remarks this route declares no request schema in the spec, so `body` is untyped."
          : null,
        op["x-regulait-deprecation"]
          ? ` * @deprecated since ${op["x-regulait-deprecation"].since}; sunset ${op["x-regulait-deprecation"].sunset}` +
            (op["x-regulait-deprecation"].replacement ? ` — use ${op["x-regulait-deprecation"].replacement}` : "")
          : null,
      ].filter((l): l is string => l !== null);

      methods.push(
        `  /**\n${docLines.join("\n")}\n   */\n` +
          `  ${id}<T = unknown>(${args.join(", ")}): Promise<T> {\n` +
          `    return this.request<T>(${JSON.stringify(op["x-regulait-compat-surface"] ? httpMethod.toUpperCase() : httpMethod.toUpperCase())}, \`${template}\`, ${passesBody ? "body" : "undefined"}, options);\n` +
          `  }`,
      );
    }
  }

  return `// ============================================================================
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Emitted by apps/gateway/src/openapi-client-gen.ts from the OpenAPI document,
// which is itself generated from the gateway's live route inventory and the zod
// schemas its handlers enforce. Editing this file is how the client starts
// lying about the API; apps/gateway/src/openapi.test.ts re-renders it and fails
// when the checked-in bytes differ.
//
// Regenerate with:  REGULAIT_WRITE_API_ARTIFACTS=1 pnpm --filter @regulait/gateway exec vitest run src/openapi.test.ts
//
// Spec version: ${info.version ?? "unknown"}
// Operations:   ${ops.length}
//
// RESPONSES ARE \`unknown\` BY DESIGN. The gateway's routes declare request
// schemas but not response schemas, so there is nothing to derive a response
// type FROM. Each method takes a type parameter so a caller can assert the
// shape they expect; inventing one here would be a hand-maintained fiction.
// ============================================================================
import { BaseClient, type RequestOptions } from "./base-client.js";

${types.sort().join("\n\n")}

export class GeneratedRegulAItClient extends BaseClient {
${methods.join("\n\n")}
}

/** every operation the published spec carries, as data — useful for tooling
 * that wants to enumerate the surface without parsing the document. */
export const OPERATIONS: ReadonlyArray<{ id: string; method: string; path: string }> = ${JSON.stringify(ops, null, 2)};
`;
}
