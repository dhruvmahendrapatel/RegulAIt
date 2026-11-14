# ADR-0288: Provider-shaped 401s on the compat surfaces (P33 follow-up)

- **Status**: Accepted (builder lane L6, 2026-11-14; PENDING P33 follow-up named in ADR-0257)
- **Date**: 2026-11-14
- **Index**: Provider-shaped 401s on the compat surfaces, re-enveloped in onSend without touching the shared auth hook (P33 follow-up)
- **Amends**: [ADR-0020](0020-ide-interception-compat-endpoints.md) and [ADR-0066](0066-gateway-parity.md) by
  addition (the refusal body on their routes). The auth decision is unchanged.
- **Migration**: none.

## Context

ADR-0257's harness found that a bad key on `/v1/chat/completions`, `/v1/messages` or `/v1/models` gets RegulAIt's own
refusal body (`{"error":"unauthenticated"}`, or `{"error":"<code>","detail":…}` for an expired, revoked or deactivated
credential). The shared auth hook answers before any compat shim runs. The official SDKs read `error.message`
(Anthropic's also `type: "error"`), so the holder of a bad key saw an empty or generic error. The harness had to
special-case 401s to pass.

The constraint from the brief: fix the envelope **without weakening the shared auth hook**. Every refusal must still
be decided in one place, in the same order, for every route.

Open-source check (ADR-0176): this is a response-envelope mapping onto our own refusal codes. Fastify's `onSend`
hook is the framework's own mechanism for it. No library applies.

## Decision

1. **The auth hook is not changed.** A new module, `compat-auth-errors.ts`, re-envelopes an already-decided 401 in
   the existing `onSend` hook, the same place that adds the MCP route's RFC 9728 challenge.
2. **Scope.**
   - Only status 401. A 403 is an entitlement answer the shims already shape.
   - Only the compat routes, each with its dialect: `POST /v1/chat/completions` and `POST /v1/responses` (ADR-0287)
     are OpenAI; `POST /v1/messages` is Anthropic; `GET /v1/models` follows the `anthropic-version` header, as its
     handler does.
   - Only a RegulAIt refusal body (`error` is a string). A body that is already provider-shaped, or not JSON, passes
     through byte-identical.
3. **Nothing is lost.** The RegulAIt code is kept as `error.regulait_code` (and OpenAI's `error.code`). The refusal's
   own `detail` becomes `error.message`. `unauthenticated`, which has no detail, gets a fixed message naming how to
   send a key. Headers set by the hook (cookies, security headers, challenges) are untouched, and `content-length` is
   reset to the new body.
4. **The MCP route and every native route keep RegulAIt's body.** MCP is not a provider dialect, and its 401s
   already carry the RFC 9728 challenge.

## Consequences

- An off-the-shelf OpenAI or Anthropic SDK shows "invalid or missing API key", or the specific expiry or revocation
  reason, as its normal authentication error. The ADR-0257 harness now asserts the provider shape on 401
  (`code === "unauthenticated"` for the OpenAI SDK, `authentication_error` for the Anthropic SDK and laravel/ai)
  instead of special-casing it.
- A test that pinned `error === "virtual_key_revoked"` on a compat route now reads `error.regulait_code`.
- A client that parsed RegulAIt's flat `{"error": "<code>"}` from a compat route must read `error.regulait_code`
  instead. The repository has no such consumer (promptfoo's mapper matches the code inside the body text, which still
  contains it).
