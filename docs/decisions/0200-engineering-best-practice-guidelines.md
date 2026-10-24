# ADR-0200: Engineering best-practice guidelines (owner, 2026-10-24)

- **Status:** Accepted
- **Date:** 2026-10-24
- **Deciders:** owner
- **Relates to:** ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0196 (enterprise UI harness),
  ADR-0198 (freeze-week CI settings)

## Context

On 2026-10-24 the owner gave a list of 27 engineering practices to follow across the project, in the master session
chat: "we don't need to force these but try to use these best practices wherever possible - add these in our rules".
These are guidelines, not hard rules. Unlike ADR-0176 and ADR-0180, a missing practice is not by itself a review
blocker.

## Decision

Every session, agent brief and review applies the guidelines below **wherever practical**. A reviewer may raise a
missed guideline as a non-blocking finding. Where a guideline is skipped on purpose, a line in the PR body says why.

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

## Consequences

- CLAUDE.md gains a short "Engineering guidelines" section that points here. Lane briefs and reviewer prompts cite it.
- Several items already hold in part: Vite minifies and splits production builds, gateway pools are bounded, size-limit
  and web-vitals budgets run in CI (ADR-0196), and the full-scan lanes of 2026-10-24 added error states with Retry,
  pagination guards and loading states. A post-demo audit batch maps each guideline to its gaps.
- Nothing here changes behaviour before 2026-11-03.
