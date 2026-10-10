# ADR-0192: Move the workspace to zod 4 directly, not through the `zod/v3` compatibility import

- **Status**: Accepted
- **Date**: 2026-10-10
- **Builds on**: ADR-0176 (open source first: a dependency needs a release within about the last 12 months), ADR-0180
  (secure by default)

## Context

Ten workspace packages depended on `zod` `^3.25.67`, locked at 3.25.76 (2025-07-08), the last 3.x release. Zod is
maintained only on the 4.x line (4.6.5, 2026-09-13), so 3.x fails ADR-0176's maintenance rule. The gateway also used
`zod-to-json-schema` 3.25.2 to render OpenAPI request bodies. That package is deprecated in favour of zod 4's native
`z.toJSONSchema`, and it does not read zod 4 schemas.

Usage at the time of the move (`from "zod"`): `shared` 58 files, `gateway` 131, and 1–4 files each in `pm-provider`,
`connector-provider`, `infra-provider`, `workflow-kernel`, `orchestration-kernel` and the three engine shims.

Two ways to move:
1. **Direct**: depend on 4.x and use its main API (`import { z } from "zod"`).
2. **Compatibility import**: depend on 4.x but rewrite every import to `zod/v3`, the frozen copy of the 3.x API that
   4.x ships.

## Decision

1. **Move directly to the zod 4 API, pinned exactly at `4.6.5`, in every package at once.** `zod/v3` is a frozen copy
   that receives no fixes, so it meets ADR-0176 only on paper. It would also need a second migration later.
2. **One PR for the whole workspace, not one per package.** The gateway composes `@regulait/shared` schemas
   (`.extend`, `.shape`, unions), and the engine shims parse with shared's schemas. A zod 3 schema cannot be composed
   with a zod 4 one, so a package-by-package move would have needed two zod versions in the graph and cross-version
   wrappers. The change is small: 47 call sites, about ten type annotations and three behaviour fixes.
3. **Remove `zod-to-json-schema`.** The gateway renders request bodies with
   `z.toJSONSchema(schema, { target: "openapi-3.0", io: "input", unrepresentable: "any" })`. The input side is what a
   caller sends, so a field with a default stays optional. `docs/api/openapi.json` and the generated client are
   re-rendered and checked byte for byte by `openapi.test.ts`.

### Behaviour that changed, and what we did

| zod 4 change | Effect here | Action |
|---|---|---|
| `z.record(v)` needs a key schema | 47 single-argument calls | Rewritten to `z.record(z.string(), v)`. Same behaviour. |
| `z.record(z.enum(...), v)` must have **every** key | BOM `renderings` would have refused a partial set | `z.partialRecord`, which keeps the 3.x meaning. |
| A `.default()` inside `.optional()` or `.partial()` is now **applied** | `PATCH` builder skill without `description` would have reset it to `""`. A rubric criterion would have gained `needles: []`, `anyOf: false`, `forbidden: []` and `caseSensitive: false` it never set. | `builderUpdateSkillSchema` is built from fields without the default. Rubric criteria use a default-free field set. A schema walker over every exported schema in every package found no other optional-wrapped default; a source scan of the gateway's local schemas found none. |
| `.uuid()` follows RFC 9562 (version 1–8, variant `10xx`; nil and max are allowed) | Stricter. Database ids come from `gen_random_uuid()` and are valid. The only non-RFC id in shipped code is the audit genesis row (`…0060`), and no validator reads it. | Kept strict (ADR-0180). Test fixtures with non-RFC ids were changed to RFC form. |
| Default messages changed (`"Required"` is now `"Invalid input: expected …"` or `"Invalid option: expected one of …"`) | One decision-regression golden reason embeds the message | Golden value updated. These messages are API detail text, not a contract. |
| Issue objects | 3.x `invalid_enum_value` issues carried the input as `received`. 4.x issues carry no input unless `reportInput` is set, which we never set. | Value-free messages hold, and in one case are stricter. Object **key names** still appear in `unrecognized_keys` and in a record-key path, as in 3.x. `invalid_format` issues now include the pattern source (our regex, not caller data). |
| `.strict()`, `.passthrough()`, `.superRefine`, `z.ZodIssueCode`, `.datetime()`, `message:` | Deprecated aliases, same behaviour | Left in place. Moving to `z.strictObject`, `error:` and `z.iso.datetime()` is a mechanical follow-up with no behaviour change. |
| `.errors` on `ZodError` | Not used (every caller reads `.issues`) | None |
| `.email()` / `.url()` | Same or stricter acceptance; the leak probe saw no input in the issue | None |
| Generic inference through `.refine(fn)` on arrays | Five `uniqueBy` callbacks lost their element type | Explicit parameter types. |

## Consequences

- zod is back on a maintained line (ADR-0176), and the workspace has one fewer dependency.
- New code must remember that a default inside `.optional()` or `.partial()` now applies. The rule for `PATCH`
  schemas: build them from default-free fields, never as `create.partial()` when the create schema has defaults.
- Refusal detail text from zod changed wording. Any test or client that matched `"Required"` must match the new
  text or, better, the issue `code`.
- **Re-check**: at each zod minor release, look at the changelog for message or issue-shape changes, because golden
  values and API detail text embed them. Move off the deprecated aliases (`.strict()` → `z.strictObject`, `message:` →
  `error:`) before any zod 5 alpha.
