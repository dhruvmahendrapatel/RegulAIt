<!-- fold: state-recap -->
**2026-11-15, lane E10 PR 1: the BYOC rehearsal role (ADR-0325).** `infra/modules/github-oidc-role` gains environment
roles (trust pinned by `StringEquals` to one repository and one GitHub environment); the new
`infra/modules/aws-byoc-deployer-policy` gives a deployer boundary (IAM only under `<prefix>-*`, new roles only with
the workload boundary, no trust edits or keys), a workload boundary for every role it creates (no IAM writes, nothing
in a federated session), and a deployer policy that limits data and mutation to the stack's own resources (by name,
or by the `purpose=rehearsal` tag) and makes every create carry the tag (revised after the #854 reviews);
`infra/environments/regulait-dev-rehearsal-role` composes them for regulait-dev. Not applied: the owner applies it once
(`docs/ops/BYOC_REHEARSAL_ROLE.md`). New CI `infra-terraform.yml` (fmt, validate, offline `terraform test`). Next: PR 2,
the BYOC AWS module.
