/**
 * JSON Schema checks on untrusted schemas and values, with linear-time regular expressions (moved out of
 * playground.ts for ADR-0353, so the OpenAPI tool server does not import the playground's dispatch path).
 */
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { RE2JS } from "re2js";
import { errMessage } from "./err-serializer.js";

/**
 * A user's schema is untrusted, and so is the model output it is matched
 * against. Ajv's default engine for `pattern`, `patternProperties` (and a
 * `propertyNames` pattern) is the native backtracking RegExp, which runs on the
 * event loop: `^(a+)+$` against a few dozen characters stalls the whole
 * gateway (ReDoS). Every pattern here runs in RE2's linear-time engine instead
 * (the `re2js` port: pure JavaScript, no native build, no runtime download).
 * RE2 has no lookaround or backreferences, so a schema that uses them does not
 * compile and is refused with 422 `invalid_json_schema` — at commit time in the
 * registry and before any call in the playground. (`format: "regex"` only
 * compiles the value, it never matches anything with it, so it is not a ReDoS
 * vector.)
 */
export const re2RegExpEngine = Object.assign(
  (pattern: string, _flags: string) => {
    const re = RE2JS.compile(RE2JS.translateRegExp(pattern));
    return { test: (s: string) => re.test(s) };
  },
  { code: "re2js" },
);

export function newAjv() {
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: true, code: { regExp: re2RegExpEngine } });
  addFormats.default(ajv);
  return ajv;
}

/** the problems with a JSON Schema document; [] = compiles */
export function validateJsonSchemaShape(schema: Record<string, unknown>): string[] {
  try {
    newAjv().compile(schema);
    return [];
  } catch (err) {
    return [errMessage(err).slice(0, 300)];
  }
}

/** validate a value against a schema with the same RE2-backed Ajv (ADR-0353: an OpenAPI tool's arguments) */
export function validateValueAgainstSchema(schema: Record<string, unknown>, value: unknown): { valid: boolean; errors: string[] } {
  const validate = newAjv().compile(schema);
  if (validate(value)) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: (validate.errors ?? []).slice(0, 20).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`),
  };
}

