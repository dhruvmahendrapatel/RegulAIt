<!-- fold: state-decisions -->
**ADR-0261 (builder, 2026-11-08): the CI split.** Fast, scope-gated checks on a pull request; the full suite on the
merge group, a push to `main`, nightly and manual runs. The `scope` job (`scripts/ci-scope.mjs`) fails closed and
writes `full`, `code`, `web`, `image` and `engines`; the six required checks report on every PR and merge group
(two aggregates that accept a skip only where the scope said `'false'`, CodeQL and Trivy gated fail-closed, gitleaks
and the dependency audit never trimmed). It supersedes the two 2026-11-07 addenda in ADR-0252. Check runs per PR push
went from about 37 to about 7 (docs), 19 (gateway) and 23 (web). No migration.
