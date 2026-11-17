<!-- fold: state-recap -->
**2026-11-15, lane E10 PR 3: the BYOC install runbook and the rehearsal workflow (ADR-0325).** The customer runbook
`docs/deployment/BYOC_AWS_INSTALL.md` takes under a day: preflight, one `terraform apply`, the chart, Entra ID OIDC, a
smoke test, upgrade, rollback, uninstall and a support bundle. `byoc-rehearsal.yml` (manual, `rehearsal` environment)
assumes the OIDC role without a stored key, applies the customer root into regulait-dev and smoke-tests it, then
always destroys and reports leftovers. Known gaps, all in the chart (ADR-0304): `ingressFrom` has no `ipBlock` for
the ALB, there are no S3 anchor env values, and egress to the Pod Identity agent may be blocked.
