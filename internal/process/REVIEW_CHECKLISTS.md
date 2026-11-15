# Reviewer checklists and briefs

> **For every independent reviewer session on RegulAIt** (Claude or Codex), dispatched by the master. Set up by
> [ADR-0260](../decisions/0260-review-workflow-patterns.md) (backlog P36, owner 2026-11-07). The verdict format and the
> independence rules in [AGENT_COORDINATION.md](AGENT_COORDINATION.md) §1 still bind; this file says *how* to review.
>
> **Source.** The two-loop review, the hierarchical code-review checklist, the security categories, the design-review
> phases and the Blocker / High / Medium / Nit triage are adapted from
> [OneRedOak/claude-code-workflows](https://github.com/OneRedOak/claude-code-workflows) (MIT, © 2025 Patrick Ellis, read
> at commit `29a34c725313c7621f426f838ed31cf482473fb4`). The text here is rewritten for this repository, not copied. The
> security review deliberately drops the source's exclusions (rate limiting, missing audit logs, missing hardening):
> under ADR-0180 and the CLAUDE.md security checklist those are findings here. Licence and notice:
> [apps/gateway/THIRD_PARTY.md](../../apps/gateway/THIRD_PARTY.md).

You are a reviewer, not the master. The only things you write are your review comments on the PR (and, if your brief
says so, a fixer's commits on a branch you were given). You never merge, mark ready, change a title or edit STATE.md.

## 1. The two loops

| Loop | Who | When | What it catches |
|---|---|---|---|
| **Inner** | The builder, in its own session | Before every push | Its own diff against §3 (and §4 or §5 when they apply), plus `pnpm -r build` and the touched tests. A builder never reports READY with an open item of its own checklist. |
| **Outer** | An independent reviewer session | After the builder reports READY at a full SHA | The whole PR diff against §3, §4 and §5 as they apply, starting from the ADR, the diff and the acceptance list, never from the builder's report (ADR-0191). |

The outer loop runs again, as a **delta review**, after every fix round (§6).

## 2. Findings — numbering, severity, verdict

1. **Every finding gets a number**, `[1]`, `[2]`, … in the order you file it. The numbers never restart within a PR:
   a delta review continues from the last number used, so `[7]` always means the same finding.
2. **Every finding carries one severity:**
   - **Blocker**: must be fixed before merge (a vulnerability, data loss, a broken acceptance item, an insecure default,
     an architectural regression, a hand-written solution to a solved problem under ADR-0176).
   - **High**: a significant problem to fix before merge.
   - **Medium**: a real improvement; fix in this PR unless the builder records a follow-up in PENDING.md.
   - **Nit**: optional polish, prefixed `Nit:`. A nit never blocks.
3. **Every finding is actionable:** `file:line`, what is wrong and why (the principle or the rule it breaks), a
   concrete fix, and for security findings an exploit path.
4. **Verdict comment:** one PR issue comment whose first line is exactly one of
   - `APPROVE at <full 40-char sha>`
   - `REQUEST CHANGES at <full 40-char sha>`
   - `SECURITY APPROVE at <full 40-char sha>` (the separate security review, §4; required for an external sign-in
     surface and for any PR whose ADR names one)

   then the numbered findings, Blockers and Highs first. An APPROVE may carry Mediums and Nits; it never carries an
   open Blocker or High. End with the Claude Code footer if you are Claude, or your own attribution line.
5. **Post without asking.** Do not wait for anyone's confirmation before posting the verdict, and do not ask whether to
   post it.

## 3. Code review (every PR)

Review in this order; stop treating a lower tier as important while a higher one has a Blocker.

1. **Architecture and integrity.** Fits the module boundaries in [ARCHITECTURE.md](../ARCHITECTURE.md); one cohesive
   purpose (one batch per PR); no needless complexity; business logic separate from UI.
2. **Correctness.** Does what the ADR and the acceptance list say; edge cases, error paths and unexpected input; races
   (claims, leases, row locks, `FOR UPDATE`); idempotent replays; database clock (`now()`) for anything stored or
   compared with a row.
3. **Secure by default (ADR-0180).** Every new setting defaults to its strict value; a relaxation is audited; nothing
   is grandfathered or warn-only without an ADR reason. A check that could not run fails, never passes.
4. **Open source first (ADR-0176).** A hand-written solution to a solved problem is a Blocker. A new dependency is
   MIT/Apache-2.0/BSD/ISC (or a public-domain dedication), maintained, exact-pinned, air-gap safe and listed in the
   package's `THIRD_PARTY.md`.
5. **Data (ADR-0200 addendum).** New and changed tables in third normal form, or the exception commented on the
   column. Indexes for the real queries; no N+1; caching never crosses users, tenants or an authorisation decision.
   Migrations: read `apps/gateway/src/zz-dbguard-0185.test.ts` first; number and `when` above main's watermark
   (CONTRIBUTING_PARALLEL_SESSIONS §4, M-108); never `drizzle-kit generate`.
6. **Tests.** Proportionate to risk; failure modes and security edge cases covered; integration tests run against real
   Postgres as CI does; nothing skipped or quarantined to get green.
7. **Maintainability.** Names, shallow control flow, comments that say why, no dead or duplicated code, copy changes
   grepped everywhere (M-rule on copy).
8. **Records.** ADR, decisions README row, STATE row, PENDING row as the brief requires; an ADR's owner text is never
   edited (deviations go in an "As built" section).

## 4. Security review (OWASP Top 10, plus our checklist)

Walk the OWASP Top 10 (2021) against the diff and the code it touches, then the CLAUDE.md security checklist line by
line. Report concrete weaknesses with an exploit path; an insecure default is a finding, not a style note.

| OWASP | Look for |
|---|---|
| A01 Broken access control | Object-level authorisation on every read and write; permissions enforced server side; tenant/user crossing; RLS on tenant tables (ADR-0234); a strict CORS allow-list |
| A02 Cryptographic failures | Secrets out of code and rotatable; JWT algorithm and audience pinned; memory-hard password hashing; no auth tokens in local storage |
| A03 Injection | Parameterised queries only; no raw untrusted HTML (strict CSP); command, path and template injection; user regexes through `re2js` |
| A04 Insecure design | Rate limits; approvals and step-up on sensitive actions; MFA for admins; fail-closed defaults |
| A05 Misconfiguration | No source maps in production; headers; debug output; offline/demo switches that a deployed box could honour |
| A06 Vulnerable components | Advisories patched, never allow-listed; every lockfile searched |
| A07 Authentication failures | Session handling, MFA bypass, token lifetimes and revocation |
| A08 Integrity failures | Webhook signatures verified with replay protection; signed evidence untouched |
| A09 Logging failures | Sensitive actions audited; no secrets or personal data in logs or error bodies |
| A10 SSRF | Every outbound fetch through the guarded fetch; host and protocol never caller-controlled |

Also: file-upload validation; CSRF on state-changing requests; API secrets server side only; prompt-injection paths
where untrusted content reaches an agent's instructions rather than its data.

## 5. Design / UI review (any PR that touches `apps/web`)

Live environment first: run the app (the `run` skill or the Playwright e2e setup) and exercise the change before
reading the code. Capture evidence with screenshots at deviceScaleFactor 1 for your own checks.

1. **Interaction and flow:** the primary flow; hover, active, disabled and focus states; destructive actions confirm.
2. **Responsiveness:** 1440px, 768px and 375px; no horizontal scroll or overlap.
3. **Visual polish:** [DESIGN_GUIDELINES.md](../DESIGN_GUIDELINES.md) tokens, spacing, typography, the shared kit.
4. **Accessibility (WCAG 2.1 AA):** keyboard order and operability, visible focus, semantic markup, labels, alt text,
   4.5:1 contrast.
5. **Robustness:** invalid input, long content, loading skeletons, empty and error states, paginated lists.
6. **Front-end guidelines (ADR-0200):** lazy loading, debounced inputs, no needless re-renders, the entry JS ceiling.
7. **Content and console:** clear copy; no console errors or warnings.

Describe the problem and its impact on the user, not a pixel prescription.

## 6. READY, fix rounds and delta reviews

- **READY** (the builder's or fixer's comment) starts with `READY at <full 40-char sha>` and lists **every** finding
  by its number with the commit that fixed it, or the PENDING.md row it was deferred to with the reviewer's agreement:
  `[3] fixed in <sha>` / `[5] deferred to PENDING P36 (reviewer agreed in <comment link>)`. A finding missing from
  the list is open.
- **Delta review:** after a fix round, review only the **non-merge commits since the last approval or verdict**
  (`git log --no-merges <last-verdict-sha>..<head>`), plus any file a merge from main changed that the PR also changes.
  Confirm each numbered finding is fixed as described, file new findings with the next numbers, and post a fresh
  verdict at the new head SHA.
- Compare SHAs in full or with `git merge-base --is-ancestor`, never a short prefix.

## 7. Briefs the master hands out

**Code reviewer brief (copy and fill):**

> You are an independent reviewer for PR #<n> (lane <lane>), not the master. Read CLAUDE.md, STATE.md, mistakes.md,
> CONTRIBUTING_PARALLEL_SESSIONS.md and internal/process/REVIEW_CHECKLISTS.md. Start from ADR-<nnnn>, the diff
> (`git diff origin/main...<full sha>`) and the acceptance list; do not read the builder's report until your findings
> are recorded. Review against §3<, §4><, §5>. Number every finding; give each a severity, file:line and a fix. Post
> one verdict comment starting `APPROVE at <full sha>` or `REQUEST CHANGES at <full sha>` without asking. Do not merge
> or edit the PR.

**Security reviewer brief:** the same, against §4 only, with the verdict `SECURITY APPROVE at <full sha>` or
`REQUEST CHANGES at <full sha>`.

**Delta reviewer brief:** the same, scoped to §6's delta, continuing the finding numbers from the last verdict.

The `regulait-review` skill (`.claude/skills/regulait-review/SKILL.md`) loads this procedure in a Claude session.
