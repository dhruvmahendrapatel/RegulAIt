# ADR-0225: Outward trust pages — a public trust centre, per-system AI cards and an auditor portal

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

PENDING.md §2c P13 asked the owner four scope questions. Part (d) was outward trust pages: a trust centre, a per-system
AI card and an auditor portal. Until now everything RegulAIt knows about an organisation's controls, evidence and AI
systems stays inside the admin console. The organisation has no governed way to show chosen parts of it to customers or
to give an external auditor time-limited read access.

## Decision

Owner decision, 2026-10-30 (#453 c6527069781): build all four P13 parts, each as its own default-off lane. Reservation
for this lane (#453 c6527158879): migration 0247, ADR 0225, branch `builder/p13d-trust-pages`. The brief's scope:

> admins choose exactly which controls, evidence summaries and AI-system cards to publish (nothing published by default;
> each publish/unpublish audited with step-up). (1) Trust center: a public, read-only, cacheable page per org showing
> only published items, with no internal ids, no tenant data beyond what was published, strict CSP, no auth tokens.
> (2) Per-system AI card: model/system card fields (purpose, limits, oversight, data use, evaluation summary) generated
> from the register and edited before publishing. (3) Auditor portal: time-boxed, scoped, revocable read-only access for
> a named external auditor to selected evidence (default-deny, hashed invite tokens, MFA or short-TTL magic link, every
> view audited, no download of unselected material). Never claim certification or compliance; wording is factual.
> Behind a default-off org setting.

## As built

**One org setting, off.** `trust_pages_enabled` (migration 0247, strict default `false`, ADR-0180). It rides the audited
`PUT /v1/org/settings`; turning it on is a relaxation in the strictness registry, so it needs the `settings_relax`
step-up. While it is off, the public routes answer 404 (indistinguishable from no route), and publishing and granting
answer 409 `trust_pages_disabled`. Drafting still works, so an admin can prepare before turning it on. Turning it off
closes the trust centre and every auditor session on the next request.

**Publications are reviewed snapshots.** `trust_publications` holds what an admin chose. Each row has a kind (control,
evidence summary, AI system card), a title and content fields, a status (`draft` or `published`) and an audience
(`public` or `auditors`). Every row starts as a draft.
- A control or evidence-summary draft is filled from one control of an active compliance pack. Its evidence line counts
  the last 30 days of ledger evidence through the pack's own evaluator.
- An AI system card is filled from the use-case register and the model cards of the systems it names. The fields are
  purpose, known limits, human oversight, data use and evaluation summary. Provider statements are labelled as the
  provider's, and evidence references (which can be internal ids) are left out.
- The admin edits the draft, then publishes it. Publishing and unpublishing each need the `settings_relax` step-up and
  write their audit row in the same transaction.
- A published item is never edited in place. The admin unpublishes it (a new draft version), edits it and publishes it
  again. Every write compares the version the editor read (409 `version_conflict` otherwise).

The public pages never read the register, the packs or the ledgers. They read only published snapshots, so nothing
reaches them that an admin did not publish.

**The wording guard.** Publishing refuses text that claims a certification or compliance: certified, compliant,
non-compliant, accredited, guarantee, complies with, in compliance with, fully meets (422 `claim_wording`, audited as a
denial). The word "certification" alone is allowed, because it also names an access review. The admin page flags the
same words while editing, so the requirement is visible where the decision is made. Every public page carries a
footnote: the pages are not a certification and do not state compliance.

**The trust centre (public).** `GET /v1/trust-center` returns the heading, the published `public` items and the
footnote, and nothing else.
- An item carries only a random public slug (title words plus 6 random hex), its kind, title, content and publication
  date: no internal id, no source reference and no person.
- It is cacheable (`public, max-age=300`, so an unpublished item leaves shared caches within five minutes), sets no
  cookie and is rate-limited per address.
- It inherits the gateway's strict CSP and security headers. The SPA route `/ui/trust` is a separate lazy chunk outside
  the app shell.

**The auditor portal (public, scoped).**
- *The grant.* An admin creates a grant naming the auditor (name, email, optional firm). The window is at most 90 days,
  and the grant lists the published items the auditor may read: default-deny, so a published item not listed is a 404.
  Creating a grant needs the step-up. So does issuing a new sign-in link, which revokes earlier unused links. Revoking
  a grant needs no step-up, because it only removes access. It ends the grant's links and sessions at once.
- *The sign-in link.* The brief allowed "MFA or short-TTL magic link"; this slice builds the link. It is single use,
  carries 256 random bits and is valid for 1 to 72 hours (24 by default). Only its SHA-256 is stored, and the admin
  sees it once. The token travels in the URL fragment (`/ui/audit#rgal_…`), which browsers never send to a server, so
  it reaches no access log and no Referer. Redeeming it needs the CSRF header and opens a session of at most an hour
  (never past the grant's end). The session token is stored only as its SHA-256 and held in an HttpOnly, SameSite=Strict
  cookie scoped to `Path=/v1/auditor`. No token is kept in browser storage.
- *What the auditor can see.* Responses are `no-store`. The auditor sees the grant's items while they stay published.
  Unpublishing an item hides it from the auditor at once. Every portal open, item view and refused view is audited
  under objectType `auditor_grant`, and the admin's grant view lists them. The portal serves the same text snapshots as
  the trust centre: there is no file, export or ledger row to download.

**Who may call what.** Everything under `/v1/trust/*` is admin-only through the default admin gate. The five public
routes are in `AUTH_EXEMPT_ROUTES` and `NON_ADMIN_ROUTES`, so their class is `public`, and they authenticate in the route
(the setting, the rate limit, then the token or cookie).

**Placement (posted on #453 before UI work, c6527272646).** Admin side: **Compliance & infra → Trust publishing**,
beside Compliance packs, with tabs for controls and evidence, AI system cards, auditor access and the trust centre
heading. Public side: `/ui/trust` and `/ui/audit`, lazy routes with no app chrome, like the signed feedback link.

**Single-tenant note.** A deployment is one organisation (ADR-0041), so "a page per org" is one page per deployment.
RegulAIt has no tenant tables, so Postgres row-level security does not apply (ARCHITECTURE.md, the RLS follow-up of
ADR-0060).

**Shared pattern, later consolidation.** The auditor portal and the supplier portal (P4, `builder/p4-supplier-portal`,
running in parallel) both give an outside person scoped read access through a hashed single-use link and a short cookie
session. This lane keeps its own small module, as the brief asked. Moving both onto one external-access helper (link
issue and redeem, session cookie, scoped-read audit) is a named later step once both have merged. Neither lane edits
the other's files.

**Open source first (ADR-0176).** We searched npm for trust-centre and auditor-portal packages, and for magic-link and
passwordless libraries that work without a hosted service. Nothing fits:
- the content is the organisation's own governance records, written in our audit format;
- the magic-link packages assume an email service or a third-party identity provider, and the deployment must work
  air-gapped.

Token generation and hashing, cookies, rate limiting and validation reuse what the gateway already ships: `node:crypto`,
the existing `@fastify/rate-limit` buckets, zod, and the CSRF header convention. No new dependency, so THIRD_PARTY.md is
unchanged.

## Consequences

- An organisation can publish a factual, admin-reviewed view of chosen controls, evidence and AI systems. It can also
  give a named auditor read access with every view on record, without opening the admin console.
- Off by default, and every relaxation and publication is audited. The wording guard keeps the pages from making
  claims the organisation has not had judged.
- The public trust centre may be cached for up to five minutes after an unpublish. The auditor portal is never cached.

### Follow-ups (not in this slice)

1. MFA for auditors (a one-time code by email, or a passkey) as an alternative to the single-use link. It needs an
   outbound mail path that works air-gapped, or auditor passkey enrolment.
2. Sending the sign-in link from the product, through the existing mail couriers (`REGULAIT_PUBLIC_URL`, ADR-0121
   amendment). Today the admin copies the link and sends it.
3. Consolidating the external-access pattern with P4's supplier portal (above).
4. Showing on the published page when an item was last reviewed, and prompting re-review after N days.
5. A mocked end-to-end spec for the admin journey (draft, edit, publish, grant, auditor view). The gateway integration
   suite and the enterprise UI harness cover it today.
