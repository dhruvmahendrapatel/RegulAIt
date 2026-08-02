# API versioning and deprecation policy (ADR-0053 §3)

The machine-readable twin of this page is `GET /v1/api/versioning`. Both are
rendered from the same object (`VERSIONING_POLICY` in
`apps/gateway/src/openapi.ts`), so they cannot disagree.

## 1. The major version lives in the path

`/v1` is the only major currently served. A **breaking** change to a
`public-stable` route requires a new major path — `/v2` — served **alongside**
`/v1`, never a silent change to `/v1`.

## 2. Stability tags

Every route carries exactly one tag. There is no default: a route with no tag
fails the test suite.

| Tag | In the published spec & SDK? | The promise |
| --- | --- | --- |
| `public-stable` | Yes | Breaking changes require a new major path. A deprecated route or field emits `Deprecation` / `Sunset` headers for **at least 365 days** before removal. |
| `public-beta` | Yes, clearly labelled | May change inside the major, with notice. Deprecation window is **90 days**. |
| `internal` | **No** | **No compatibility guarantee at all.** May change or be removed in any release. Visible to an administrator via `GET /v1/openapi.json?include=all`, marked `x-regulait-guarantee: none`. |

Tagging a route `public-stable` is a commitment a reviewer takes on
deliberately — which is why `internal` is the default in the registry and why
promoting a route is a one-line, reviewable diff.

## 3. What counts as a breaking change

- removing a route, or changing its method or path
- removing a response field, or narrowing its type
- adding a **required** request field, or narrowing an existing field's type
- changing the meaning of an existing field without changing its name
- changing a route's auth class to a **stricter** one (e.g. `user` → `admin`)
- changing an error code a documented failure mode returns

## 4. What is *not* breaking (ships within the major)

- adding a new route
- adding an **optional** request field
- adding a response field
- adding an enum member to a field that already documents an open set
- **relaxing** a route's auth class (e.g. `admin` → `user`)

## 5. The deprecation path

1. A route is added to `DEPRECATIONS` in `apps/gateway/src/openapi.ts` with a
   `since` date, a `sunset` date, and a replacement.
2. From that moment every response on that route carries RFC 8594
   `Deprecation: @<unix-seconds>` and `Sunset: <HTTP-date>`, plus a
   `Link: <replacement>; rel="successor-version"` when there is one. This is
   automatic — the same edit produces the headers and the spec entry, so a
   deprecation cannot be applied quietly.
3. The entry appears in the document's `x-regulait-deprecations` section and on
   the operation as `x-regulait-deprecation`, and the generated TypeScript client
   emits a `@deprecated` JSDoc tag so an integrator's editor says so.
4. `@regulait/api-client` records every `Deprecation` header it observes in
   `client.observedDeprecations`, so a long-running integration can alert on a
   sunset rather than discover it when the route disappears.
5. Removal is permitted only after the window elapses, and only in a new major
   for `public-stable`.

## 6. Changelog

A spec release's changelog is derived by diffing two `docs/api/openapi.json`
versions, not written by hand, so a deprecation cannot be undocumented. Wiring
that diff into a release job is follow-up (see ADR-0053).
