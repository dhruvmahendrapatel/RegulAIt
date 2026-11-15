<!-- fold: state-recap -->
**2026-11-15, lane E10 PR 1: the BYOC rehearsal role (ADR-0325).** `infra/modules/github-oidc-role` gains environment
roles (trust pinned by `StringEquals` to one repository and one GitHub environment); the new
`infra/modules/aws-byoc-deployer-policy` gives the boundary and deployer policy for installing the BYOC stack (stack
services only, one region, `<prefix>-*` IAM and S3, root resources tagged, no escalation, nothing tagged production);
`infra/environments/regulait-dev-rehearsal-role` composes them for regulait-dev. Not applied: the owner applies it once
(`docs/ops/BYOC_REHEARSAL_ROLE.md`). New CI `infra-terraform.yml` (fmt, validate, offline `terraform test`). Next: PR 2,
the BYOC AWS module.
