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
