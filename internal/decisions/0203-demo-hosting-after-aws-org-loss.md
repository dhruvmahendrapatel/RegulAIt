# ADR-0203: Demo hosting and the AWS sandbox after the July AWS Organization was deleted

- **Status**: Accepted
- **Date**: 2026-10-26

## Context

The AWS Organization built in July (the management account plus the `regulait-dev` workload account; ADR-0002,
ADR-0004, ADR-0013) was on the owner's personal account and has been deleted. The owner reported this on #453
(c6406298827). With it went:

- the Terraform state bucket, the lock table and the KMS key;
- the dev demo server (EC2), its Elastic IP and SSM access, which ADR-0197 and ADR-0202 decision 3 named as the
  hosted demo;
- the AWS sandbox account that ADR-0197's live Shadow AI discovery uses.

As a result, STATE.md's EPIC-01 "applied, zero drift" and ADR-0013's "LIVE" entries no longer describe anything that
exists. A new company AWS account exists, with Organizations and IAM Identity Center not yet enabled. The code freeze
is 2026-10-29, and the demo is 2026-11-03.

## Decision

Owner decisions of 2026-10-26 (#453 c6406353285):

1. **Hosting.** The demo stack runs on the owner's laptop, published at `regulait.<domain>` through a Cloudflare
   Tunnel. The domain's DNS is already on Cloudflare.
   - The tunnel connects outbound only, so no inbound ports are opened. Cloudflare terminates the public TLS.
   - The tunnel token lives in environment config and the owner's password manager, never in the repo.
   - The tunnel reaches the gateway through lane H's Caddy routing, so the Keycloak path allow-list and the forwarded-
     header handling stay on a single path.
   - This replaces ADR-0202 decision 3's "existing AWS dev host". It stays a demo environment, with no production
     designation.
   - The laptop must be on and online for the 11-01 run-through and the 11-03 demo.
2. **Shadow AI discovery.** The live AWS discovery runs against a new sandbox account created under the company AWS
   account, with keyless federation from RegulAIt's public issuer (served through the tunnel).
   - ADR-0002/0004 still bind: IAM Identity Center only, and no long-lived access keys.
   - ADR-0197's USD 50 spending cap still applies.
   - Its seeded dataset and recording remain the fallback.
3. **AWS hosting of the control plane** (an ADR-0013 successor) is rebuilt in the company account after 2026-11-03 as
   a separate decision. Until then the `regulait-dev-app` Terraform is not applied anywhere.
4. **The freeze stands (ADR-0202 decision 6).** Everything is due by 2026-10-29. A beat that is not working live by
   then runs on its fallback.

## Consequences

- **Builder lanes.** Lane T adds an opt-in Cloudflare Tunnel compose profile. Lane S makes the demo-sandbox and
  bootstrap Terraform account-agnostic for the company account. The owner runs every plan and apply.
- **Owner setup** (#453): create the tunnel in the Cloudflare dashboard; enable Organizations and IAM Identity Center
  in the company account; install Terraform and the AWS CLI on the laptop. The old steps 6–7 (c6394628453) are
  cancelled.
- **Risk.** The demo now depends on the laptop and its network. The 11-01 run-through must use the same machine and
  network as 11-03. Every beat keeps its audited fallback.
- **Data boundary.** Cloudflare's edge sees the demo traffic in the clear. Only demo data and demo accounts pass
  through it.
- **Records.** ADR-0013 and ADR-0202 gain addenda that point here. STATE.md marks EPIC-01's live infrastructure as
  deleted.

## Addendum: 2026-10-29, one demo date, Saturday 2026-10-31, and two freeze exceptions

Owner decisions, #453 comment 6508111468:

- **The date moves to Saturday 2026-10-31.** The customer demo is on 10-31. The internal run-through on Sun 11-01 and
  the external demo on Tue 11-03 are both dropped: there is one date. Every "11-03" and "11-01 run-through" above now
  reads 10-31. The 10-29 freeze stands.
- **Single-date plan.** LIVE is prepared once and never re-prepared, so each state-changing step runs on it only once:
  at the demo. With no later run to spoil, every beat runs on LIVE as scripted. The FALLBACK laptop stack stays the
  failure fallback and the only place to rehearse a state-changing step (`DEMO_SCRIPT_2026-11-01.md`,
  `DEMO_RUNBOOK.md` §7.3).
- **Freeze exception (a):** Claude, through the Anthropic API, as the model and as the agent, pointed at our MCP
  endpoint.
- **Freeze exception (b):** the ABAP MCP server behind our MCP proxy, so a live SAP change runs through governance.

Both exceptions are built by their own PRs; this addendum only records them.
