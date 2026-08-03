# The RegulAIt public API (ADR-0053)

## What is in this directory

| File | What it is | How it is produced |
| --- | --- | --- |
| `openapi.json` | The published OpenAPI 3.0.3 document — the `public-stable` and `public-beta` routes only. | **Generated.** Never edit it. |
| `VERSIONING.md` | The versioning and deprecation policy in prose. The machine-readable twin is `GET /v1/api/versioning`. | Hand-written; the numbers in it are asserted against the code by `openapi.test.ts`. |

## Where the document comes from

Nothing in the spec is typed twice. It is built from three things that already
exist in the gateway and are already load-bearing:

1. **`app.routeInventory`** — the live Fastify route list, collected by an
   `onRoute` hook registered before any route in `buildApp`. If a route exists,
   it is in there.
2. **`apps/gateway/src/route-classes.ts`** — the two sets the gateway's auth hook
   and admin gate actually branch on. Each route's documented credential is
   *computed* from them, so the document cannot claim "no auth" on a route the
   gate 403s.
3. **`apps/gateway/src/openapi-registry.ts`** — the one genuinely human decision
   per route: `public-stable`, `public-beta`, or `internal`.

Request bodies are converted from the same zod schemas the handlers call
`.parse()` with. A route whose body schema is not bound carries
`x-regulait-schema: "unspecified"` in the artifact rather than publishing an
empty object as if it were the contract.

## What stops it drifting

`apps/gateway/src/openapi.test.ts`. It fails when:

- a registered route has no entry in the stability registry (no default tag
  exists — you must classify it);
- the registry names a route the gateway no longer registers;
- the document's declared auth class disagrees with the gateway's real
  enforcement, asserted over real HTTP for an admin route, a non-admin route, a
  public route, and a SCIM route;
- `openapi.json` or the generated client on disk differs from a fresh render.

Regenerate the two build products after an intentional change:

```
REGULAIT_WRITE_API_ARTIFACTS=1 pnpm --filter @regulait/gateway exec vitest run src/openapi.test.ts
```

## SDK coverage — stated plainly

**What exists:** one supported client, `@regulait/api-client` (TypeScript). Its
method surface is generated from this document, checked in, compiled by
`pnpm -r build`, and round-tripped against a live gateway in the test suite.

**What does not exist:** Python, Go and Java clients. ADR-0053 proposes them via
`openapi-generator`; what is built here is the artifact those generators consume
plus the one client we can keep green in CI. A generated client nobody compiles
is a promise, not a deliverable — so the promise is named as follow-up rather
than counted as coverage.

**Response types are `unknown`.** The gateway's routes declare *request* schemas
but not *response* schemas, so there is nothing to derive a response type from.
Every client method takes a type parameter for the caller to assert the shape
they expect. Tightening the route response schemas is the prerequisite for typed
responses; inventing interfaces in the client would be exactly the
hand-maintained fiction ADR-0053 exists to prevent.

## Auth

The public API introduces **no new credential**. It is the ADR-0025 API key:

```
Authorization: Bearer rgl_...
```

Two other trust paths appear in the document and are *not* interchangeable with
it:

- **SCIM tokens** (`x-regulait-auth: scim-token`) authenticate only against
  `scim_tokens`. A user's API key is refused on `/scim/v2/*`, and a SCIM token is
  refused everywhere else. This is a separate trust path, not a stronger or
  weaker one.
- **Public routes** (`x-regulait-auth: public`) take no credential at all: the
  login surface, `/health`, the SPA shell, and the inbound PM webhook (which
  authenticates in-route on its own per-connection secret).

**Exposure is not entitlement.** Appearing in this document grants nothing.
Every call still passes the same policy kernel, the same metering, and the same
audit path as any other gateway request.
