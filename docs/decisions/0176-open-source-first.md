# ADR-0176: Open source first: reuse proven libraries instead of writing standard pieces ourselves

- **Status**: Accepted (owner, 2026-10-05: "if there is some parts of the code that are available outside, can we just reuse
  them instead of writing things afresh every time … we need to make use of open source stuff to make sure we can ship
  quicker and reliably")
- **Date**: 2026-10-05
- **Builds on**: PathForward "What to build, integrate, and defer" (adapter candidates need a licence, maintenance and egress
  review), ADR-0009 (stack)

## Context

RegulAIt already stands on a large open-source base:
- **Server and data:** Fastify, @fastify/rate-limit, Drizzle ORM and pg, Zod, Ajv, openid-client (OIDC), @node-saml/node-saml
  (SAML), the official MCP SDK, Cedar (policy engine, WASM), the official model-provider SDKs, and the AWS, Azure, Google
  Cloud and Kubernetes clients.
- **Web:** React, React Router and TanStack Query.
- **Infrastructure:** Postgres, MinIO, Caddy and Keycloak.
- **Tests:** Vitest and Playwright.

Some standard pieces were still written by hand, in places where mature libraries exist (for example, signing schemes and
graph layout). Hand-written versions of solved problems cost time, carry more defect risk, and get none of the ecosystem's
fixes.

## Decision

1. **Default to a library for standard problems.** These include cryptography and JWT/JWKS, webhook signing, retry and
   backoff, job scheduling, parsing, graph layout and rendering, diffing, date handling, and standard protocol clients.
   Write our own code only for RegulAIt's own logic: governance decisions, evidence, policy semantics and the product
   UI. Agent contracts state this, and a review that finds a hand-written version of a solved problem flags it.
2. **Admission rules for every new dependency:**
   - The licence is MIT, Apache-2.0, BSD or ISC. No GPL, AGPL, EPL, SSPL or BSL in shipped code.
   - It is actively maintained, with a release within about the last 12 months and no unpatched critical advisory.
   - The exact version is pinned through the lockfile.
   - It makes no runtime network calls and has no CDN dependency, so it works air-gapped (pillar 3).
   - It is recorded in `THIRD_PARTY.md` beside the package that uses it: package, version, licence and why.
   - It is covered by the existing dependency audit, and by the SBOM work in PF-04 when that lands.
3. **Standards over home-grown formats** when we expose an interface. For example, outbound webhooks follow the Standard
   Webhooks specification, so receivers can use off-the-shelf verifiers.
4. **Integrate engines, don't rebuild them** (as PathForward already says). Red-team and evaluation engines, PII
   classifiers, scanners, sandboxes and observability backends sit behind adapters. They are chosen per PathForward items
   PF-06, PF-08 and PF-10 to PF-12, with the same admission review.
5. **Replacing existing working code is a separate, case-by-case decision.** Swapping a mature, tested internal component
   (for example, the scheduler) for a library is justified only by a concrete gain. Each swap gets its own ADR, with a
   migration plan and its tests kept green.

## Applied immediately (batch 2b, 2026-10-05)

| Need | Library | Licence |
|---|---|---|
| Outbound webhook signing | `standardwebhooks` (Standard Webhooks spec) | MIT |
| Run-graph rendering and layout | `@xyflow/react` (React Flow) + `@dagrejs/dagre` | MIT |
| Teams Bot Framework JWT/JWKS validation | `jose` (already present through openid-client) | MIT |

`elkjs` was considered for graph layout and rejected: it is EPL-2.0 / GPL-3.0.

## Consequences

- Faster delivery and fewer defects in commodity code, at the cost of dependency hygiene: the licence, maintenance and
  audit work above.
- An audit of existing hand-written components against mature libraries follows. Each finding is either a replacement ADR
  or a recorded "keep, because …".

## Amendment — audit of existing hand-written code (2026-10-05)

A read-only audit compared existing hand-written components with mature libraries. The results below are the decisions;
each "replace" ships under this ADR with its own tests, and the larger ones get their own ADR.

**Security fixes found by the audit (scheduled first):**
1. **The MCP manifest digest is 64-bit FNV-1a.** Admin clearance and the release-age cooldown are pinned to it, so a
   server can swap in a colliding manifest after clearance. Move to SHA-256 (`node:crypto`), with a one-time re-pin
   migration so cleared servers are not mass re-held. Training dataset checksums move off 32-bit FNV too.
2. **Secret patterns used by the DLP guardrail and the audit scrub miss current token formats.** Missed: Anthropic
   `sk-ant-api03-`, OpenAI `sk-proj-`, GitHub `github_pat_`, Stripe `sk_live_`, Google `AIza`, GitLab `glpat-`. Patch now.
   Then vendor a maintained, permissively licensed rule set as pinned data, with the false-positive policy decided first
   (on the audit path, a redaction permanently changes evidence).
3. **The IP range classification behind the egress guard misses five special ranges:** IPv4-compatible `::a.b.c.d`, 6to4
   `2002::/16`, local NAT64 `64:ff9b:1::/48`, deprecated site-local `fec0::/10` and discard `100::/64`. Add them now. The
   parser swap (`ipaddr.js` or `net.BlockList`) gets its own ADR.

**Replace now (small, with tests):**
- one CSV writer and parser on `csv-stringify` / `csv-parse` with formula-injection escaping (unsigned downloads; the
  signed export bundle keeps its byte format unless a bundle schema bump is decided);
- SKILL.md frontmatter parsed with `yaml`;
- eval output schemas validated with Ajv (already pinned) instead of a partial hand-written subset;
- the Snowflake key-pair JWT signed with `jose`;
- month arithmetic clamped to the end of the month (31 Aug + 6 months landed on 3 Mar, past policy);
- the retrieval tokenizer made Unicode-aware (`\p{L}\p{N}`), since it dropped non-ASCII text;
- password hashing moved to async `scrypt`, so it no longer blocks the event loop.

**Replace with their own ADR:**
- an accessible dialog/tabs primitive for the shared Modal (Radix or React Aria): the shared Modal has no focus trap and no
  focus restore across 51 call sites;
- Standard Webhooks for the generic PM webhook, with a dual-signing window;
- `openapi-typescript` for the client generator;
- reconsidering `undici` for the DNS-pinned fetch.

**Keep, with reasons:**
- retry/backoff (one budget per sequence, no retry of our own refusals);
- the circuit breaker (Postgres-backed across replicas, audited);
- the scheduler (governance "skipped, and why" records);
- the rate-limit store (local-first);
- the OTLP encoder (stored rows, air-gapped);
- the licence and export-bundle formats (exact bytes, verifiable with openssl);
- chat/PM HMAC checks (vendor-exact; merge the duplicate constant-time compares);
- the PII detectors and MCP scanner (deterministic and offline; optional adapters per §4);
- token estimates (vendor tokenizers are not all public).

Admission notes:
- `dompurify` would be admitted only under its Apache-2.0 option, recorded explicitly;
- `react-markdown` fails the maintenance rule. If chat ever renders markdown, use `markdown-it` or `marked`.

## Amendment — the universal rule (owner, 2026-10-05)

> "if some program is available open source we will use it … First we will check if solution is available before trying to
> write new code for it … we need to replace our code with open source and validated modules/sections relevant to us."

This supersedes §5's "case by case":
- **Search before writing.** Every build checks for a validated, maintained open-source solution first and records the
  result.
- **Replacing existing hand-written code is the default.** Keeping our own code is a narrow exception. It is written down
  with the specific hard requirement no validated module meets, and re-checked when the ecosystem changes.

The rule is in `CLAUDE.md` ("Universal build rule") so it binds every session and agent.

**The audit's "keep" list, re-classified under the rule:**

| Component | Decision | Module, or the unmet requirement |
|---|---|---|
| Retry/backoff (`upstream-retry.ts`) | **Replace** | `cockatiel` (MIT) as the engine. Our policy stays as configuration: one budget per sequence, never retry our own refusals, never retry `tools/call`. |
| OTLP/JSON encoder (`shared/tracing.ts`) | **Replace** | `@opentelemetry/otlp-transformer` (Apache-2.0) to serialise stored rows; pure encoding, so it works air-gapped. |
| TOTP and base32 (`auth.ts`) | **Replace** | `otpauth` (MIT); our replay protection (`lastUsedStep`) stays in the wrapper; RFC 6238 test vectors added. |
| Scheduler (`scheduler.ts`) | **Replace (own ADR)** | A Postgres-backed queue (`pg-boss` or `graphile-worker`, MIT) for leasing, retries and multiple replicas; our "skipped, and why" governance records layered on top. |
| Constant-time compares (5 copies) | **Replace** | `crypto.timingSafeEqual` behind one shared helper. |
| Canonical JSON (6 non-audit copies) | **Replace** | One implementation conforming to RFC 8785 (JCS), differential-tested against `canonicalize` (Apache-2.0). |
| Circuit breaker (`upstream-breaker.ts`) | **Keep (exception)** | Unmet: breaker state shared across replicas in Postgres, with a single elected half-open probe and audited transitions; library breakers are per process. Re-check yearly. |
| Rate-limit store | **Keep (exception)** | Already `@fastify/rate-limit`. Only the store is ours. Unmet: local-first, so a request flood never becomes a database flood. |
| Audit chain canonical form, licence format, export-bundle bytes | **Keep (exception)** | Unmet: exact-byte, versioned evidence formats that customers verify with openssl alone (ADR-0116); changing them breaks verification of existing evidence. |
| Chat/PM webhook HMAC checks | **Keep (exception)** | Unmet: vendor-exact checks of a few lines; the vendor SDKs are heavy frameworks. They use `crypto.timingSafeEqual`. |
| PII detectors, MCP admission scanner | **Keep core (exception), add adapters** | Unmet: no maintained, deterministic, offline JS library; the validated tools are Python services. Integrated as optional adapters (ADR-0176 §4). |
| Token estimates | **Keep (exception)** | Unmet: vendor tokenizers are not all public; billing uses provider-reported usage. |

All "replace now" and "replace with ADR" rows from the audit stand. The work is scheduled as an open-source replacement
programme beside the roadmap. The security rows (manifest digest, secret patterns, IP ranges) go first.

## Amendment — the security items are done (2026-10-05)

Audit items 1–3 and 11 are built (migration 0145). An independent verification review found one high issue, two medium
issues and four low issues; all are fixed, each with a test that fails without its fix.

- **MCP manifest digest: FNV-1a 64 → SHA-256** (Node's crypto).
  - A real FNV collision pair is now a test.
  - **The re-pin:** existing pins are re-pinned once at boot, before the gateway listens, under an advisory lock.
    - It applies only where the stored tools reproduce the stored FNV digest. Anything unproven fails closed: it is
      re-held on its next sync.
    - Each row is a compare-and-set, so a concurrent writer is never overwritten.
    - If the re-pin fails, the gateway refuses to start rather than losing clearances.
    - Every re-pinned cleared server gets an audit row asking for re-review, because a collision exploited before the
      upgrade can't be detected.
  - **Upgrade note:** stop every older replica before the first upgraded one boots.
  - The review found that a `__proto__` key was invisible to the canonical JSON behind the digest (and behind two other
    helpers and a web checkpoint digest). Canonical objects now have a null prototype.
- **Secret patterns:** six current provider formats, derived from the gitleaks default rules (MIT, pinned to commit
  09242ce9c8a60d9b051fc2d166f9e849b88c7ac0). Stripe placeholders and its two published docs example keys are excluded.
  The JWT rule had a quadratic ReDoS on the audit write path and is now linear. Its accepted cost: a JWT directly after
  a `-` is not matched.
- **IP classification:** this replaces the "own ADR" planned above. We swapped to Node's built-in `net.BlockList` /
  `SocketAddress` rather than a library, because it parses addresses exactly as the socket does. `ipaddr.js` was
  rejected: it reads `::a.b.c.d` as IPv4-mapped and accepts octal and short IPv4 forms.
  - IPv4-compatible, 6to4 and IPv4-translated addresses are now classified by the IPv4 address they carry.
  - `64:ff9b:1::/48`, `fec0::/10` and `100::/64` are refused outright.
  - **Parity:** the only behaviour change is allowed→blocked inside those ranges (differential fuzz over 400k addresses).
    The `net-policy` allow-list is unchanged over 18.1M pairs.
  - Not covered: Teredo (`2001::/32`).
- **Constant-time compare:** one helper on `crypto.timingSafeEqual` (both sides hashed first) replaces five hand-written
  copies. An inventory test keeps it that way.
