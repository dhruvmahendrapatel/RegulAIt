# ADR-0138 - Govern semantic-cache hits through the dispatch core

- Status: Accepted
- Date: 2026-09-30
- Finding: AER-010

## Decision

A cache lookup returns only a candidate response. Both the native invoke and
compatibility paths pass that candidate to `executeGovernedDispatch` before
emitting cached text or recording a saving. The core rechecks the live agent
configuration/lifecycle, virtual-key ceiling, MRM, attribution, use-case and
project-budget gates, input PII and guardrails, then current output PII and
guardrails. A refusal emits no cached output and writes no cache saving or
provider usage. A permitted hit skips provider resolution and returns the
cached result; its trace records zero newly consumed tokens and marks the
cache hit, while the response may retain the original token counts for wire
compatibility.

This does not change cache identity or prove that every cached answer remains
semantically valid after a model or routing change. ADR-0136 covers compat
identity; native identity/version invalidation remains a separate review.

## Verification

The compat suite primes a real cache entry before tightening virtual-key
budget, MRM, mandatory attribution, use-case approval, project budget, input
PII, input guardrails, output PII and output guardrails. Each denial asserts
its wire-format code, no cached text, no new provider usage and no saving.
Native invoke separately tests a newly blocked cached-output PII case.
Permitted hit tests retain zero usage delta and one saving. The four adjacent
cache/interception files passed 93 tests on a disposable PostgreSQL database
with file parallelism disabled; gateway TypeScript and diff checks passed.

Commit `b33de7c` passed exact-head build-and-test, Docker build and Kong
integration checks. An explicit mutation run moving lookup above the gates is
still outstanding. Neither this ADR nor CI establishes production readiness.
