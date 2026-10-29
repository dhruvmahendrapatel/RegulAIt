# ADR-0200: Engineering best-practice guidelines (owner, 2026-10-24)

- **Status:** Accepted
- **Date:** 2026-10-24
- **Deciders:** owner
- **Relates to:** ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0196 (enterprise UI harness),
  ADR-0198 (freeze-week CI settings)

## Context

On 2026-10-24 the owner gave a list of 27 engineering practices to follow across the project, in the master session
chat: "we don't need to force these but try to use these best practices wherever possible - add these in our rules".
The durable record is #453 comment 6389193296 (the guidelines) and comment 6389271693 (the security checklist below).
These are guidelines, not hard rules. Unlike ADR-0176 and ADR-0180, a missing practice is not by itself a review
blocker.

## Decision

Every session, agent brief and review applies the guidelines below **wherever practical**. A reviewer may raise a
missed guideline as a non-blocking finding. Where a guideline is skipped on purpose, a line in the PR body says why.
These two working rules, and the parenthetical details on each item below, are the master session's reading of the
owner's list, not the owner's words.

### Precedence
1. **Secure by default (ADR-0180) and open source first (ADR-0176) win.** For example, no response is cached across
   users or tenants, or past an authorisation decision. Caching, compression and pooling use existing validated
   libraries or platform features (the browser, Fastify plugins, Postgres, Vite) rather than hand-written ones.
2. **The demo freeze wins until 2026-11-03.** Between now and the external demo, nothing is refactored only to meet these
   guidelines. New code follows them; existing code adopts them when it is touched for another reason, and in planned
   batches after the demo.
3. **Product constraints win:** air-gapped operation, the exact-byte evidence formats and the bundle ceilings in ADR-0196.

### The guidelines
The owner's 27 items, grouped by area and keeping the owner's numbers. The wording is lightly edited; items 16, 17 and 24
are read as noted.

**Structure and code quality**
1. Organise the project into a clean folder structure.
2. Separate business logic from UI components (logic in models, hooks or services; components render).
3. Remove duplicate and dead code.
4. Use consistent naming conventions.
5. Always add proper error handling (no silent catch; a failed read shows an error with Retry, never an empty state).
6. Keep environment variables and secrets out of code (configuration from the environment; never hard-coded).
7. Modularise reusable components (the shared kit before a one-off).
8. Use proper state management (server state through the query cache; local UI state stays local).
9. Document the codebase (module headers, ADRs, runbooks).
10. Set up scalable APIs (versioned routes, bounded inputs, pagination, idempotency where it matters).

**Front-end performance**
11. Compress all images, unless asked not to.
12. Add lazy loading where possible (routes, heavy components, below-the-fold media).
13. Cache API responses on the client where safe (see Precedence 1).
14. Minify JS and CSS (production builds).
16. **Avoid unnecessary re-renders** (written "reduce unnecessary defenders"; read as re-renders): stable props and
    memoisation where profiling shows a cost.
17. **Debounce input handlers** (written "Denounce"; read as debounce) for search, filter and typeahead fields.
18. Paginate large lists.
19. Remove unused dependencies.
20. Defer non-critical scripts.
21. Add a loading skeleton for content that loads.
22. Compress API payloads (HTTP compression for responses above a size threshold).
27. Run a Lighthouse audit on the main screens. It runs locally against the production build, alongside the ADR-0196
    harness and its web-vitals budgets.

**Data and back end**
15. Index the database for the queries the product actually runs (each index in a hand-written migration).
23. Use database connection pooling (bounded pools, as today).
24. **Cache expensive computed results** (written "computer results"; read as computed), with an explicit
    invalidation rule.
25. Fix N+1 database queries (batch or join instead of per-row queries).
26. Enable server-side caching where safe (see Precedence 1), with a bounded size and lifetime.

### Security checklist (owner, 2026-10-24, second list; #453 comment 6389271693)

Later the same day the owner added 19 security practices. They differ from the guidelines above: a confirmed gap is a
vulnerability, and under ADR-0180 a vulnerability is a bug and a blocking review finding. Every build checks the
items its change touches, and every security review walks the whole list. Item 15 is read as noted.

1. Check for SQL injection: parameterised queries through the ORM or the driver only, never string-built SQL.
2. Block cross-site scripting: no raw HTML injection of untrusted content, output encoding, and a strict Content
   Security Policy.
3. Add CSRF protection on every state-changing request that a browser authenticates automatically.
4. Validate file uploads: type by content, size limits, safe names and storage, and no execution.
5. Fix broken object-level authorisation: every read and write checks that the caller may act on *that* object
   (tenant and owner), not only on the route.
6. Add rate limiting, per identity and per address, on authentication and expensive routes.
7. Secure JWT and signing secrets: from a secret store or environment, never in code, rotatable, and with algorithm
   and audience pinned on verification.
8. Keep API secrets server side: no provider key or secret ever reaches the browser bundle.
9. Hash passwords securely, with a memory-hard algorithm (Argon2id, or scrypt/bcrypt) and per-password salts.
10. Add MFA: available for every account and required for administrators and step-up actions.
11. Tighten CORS: an explicit origin allow-list, never `*` with credentials.
12. Remove auth tokens from local storage: session tokens live in `HttpOnly`, `Secure`, `SameSite` cookies or in
    memory.
13. Enforce permissions server side; the UI only hides what the server already refuses.
14. Enable row-level security in Postgres for tenant-scoped tables, as defence in depth behind the application
    checks.
15. **Verify webhook signatures** (written "verify we hook signature"; read as webhook): an HMAC or signature over the
    raw body, a timestamp window and replay protection, with a constant-time comparison.
16. Check for SSRF: outbound requests to user-supplied URLs go through the guarded fetch (allow-list, no private or
    metadata addresses, no redirects to them).
17. Remove exposed source maps from production builds and images.
18. Keep sensitive data out of logs: secrets, tokens, passwords and personal data are redacted at the logger.
19. Update vulnerable dependencies: patch, never allow-list (ADR-0199), with the dependency audit gate in CI.

Several items are already built in part (rate-limit tiers, step-up and MFA, DPoP-bound tokens, the guarded fetch,
signed webhooks and logger redaction). A post-demo security audit maps every item to code and tests; a gap found
before 2026-11-03 that is exploitable on the demo path is fixed before the demo, like any other security bug.

## Consequences

- CLAUDE.md gains two short sections that point here, "Engineering guidelines" and "Security checklist". Lane briefs and reviewer prompts cite it.
- Several items already hold in part: Vite minifies and splits production builds, gateway pools are bounded, size-limit
  and web-vitals budgets run in CI (ADR-0196), and the full-scan lanes of 2026-10-24 added error states with Retry,
  pagination guards and loading states. A post-demo audit batch maps each guideline to its gaps.
- Nothing here changes behaviour before 2026-11-03, except a security fix under ADR-0180.

## Addendum — 2026-10-29: UX best practices are the default for every screen (owner)

**Owner, 2026-10-29 (#453):** "I want the absolute best of the best … make sure we follow the best practices unless I
ask." The owner shared three articles to read first:
- "10 UX Best Practices to Follow in 2026" (uxpilot.ai, 2026-02-09);
- "UI UX Best Practices: 12 Principles for Better UX" (upslidedesignstudio.com);
- "Designing for the User: Best Practices in UX/UI" (LinkedIn Pulse).

The master session read all three and folded them into `internal/DESIGN_GUIDELINES.md`, in a new section, "UX best
practices (owner, 2026-10-29)". Each practice is written as an imperative rule there, beside the rules it extends.

- **Stronger than "wherever practical".** For UI work these practices are the default, not a guideline. A screen
  departs from one only when the owner asks for that. The PR body names the owner's comment, and a skip is not
  self-granted.
- **Precedence is unchanged.**
  - Secure by default (ADR-0180) still wins. For example, a "smart default" never pre-selects a permissive or
    sanctioning outcome, and remembered state never holds a credential or crosses users.
  - The freeze still wins until 2026-11-03 (ADR-0198). New and touched UI follows the practices now. Existing screens
    are audited against them in a post-demo batch.
  - The bundle ceilings and air-gapped constraints still win. No practice adds a CDN, an analytics tracker or a
    third-party heatmap.
- **Reviews.** A missed UX practice on new or touched UI is a review finding, not a nit.
