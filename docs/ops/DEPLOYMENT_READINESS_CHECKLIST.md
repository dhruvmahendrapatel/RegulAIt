# Deployment Readiness Checklist

**Status:** parked gate · **Owner decision (2026-08-01):** *"Park reliability of operations…
it doesn't make sense for that unnecessary cost right now"* while the product is still being made
good. This is the **pre-production gate**, not current work.

These are the reliability/operations items that were deliberately NOT turned into ADRs, because
they cost real money to stand up and buy nothing until the product itself is enterprise-grade. The
dev stack today is a **single EC2 instance + container Postgres** (with a nightly S3 backup,
ADR-0035, and a nightly power schedule, ADR-0032) — appropriate for a dev/demo box, not for a
signed SLA.

**Do not check these off casually.** Each one crosses the line into ongoing cost and, in most
cases, the production guardrail (nothing gets a `prod` designation without the owner's explicit,
in-session sign-off — see CLAUDE.md).

## Gate — every box must be true before a production SLA is offered

### Compute & availability
- [ ] Gateway is stateless and horizontal — multiple instances behind an ALB across ≥2 AZs
- [ ] Autoscaling group (or ECS/EKS service) with health-gated scaling
- [ ] Zero-downtime deploy proven (connection draining, readiness gates, no on-box `tar`-build)
- [ ] Blue/green or rolling deploy with **automatic rollback** on health failure

### Data
- [ ] Postgres on **RDS/Aurora Multi-AZ** with automated PITR (retire the container volume)
- [ ] S3 backup retained as belt-and-suspenders; **cross-region copy (CRR)** enabled
- [ ] Restore drill automated and run on a schedule (not just the one-time proof in ADR-0035)
- [ ] `REGULAIT_DATA_KEY` in KMS/Secrets Manager, **recorded out-of-band** (deferred security D1)
- [ ] …and **attested** — `POST /v1/security/data-key/attestations`, or Admin → Settings → Data key
      custody ([ADR-0063](../decisions/0063-data-key-custody.md)). Until somebody does, every backup
      run reports `custody=UNATTESTED` and publishes `Backup/DataKeyAttested=0`.
- [ ] The key's fingerprint (`dk1:…`, from the gateway boot line or `GET /v1/security/data-key`)
      recorded **alongside** the key. It is not secret, and it is what a future restore compares
      against the dump's `manifest.json` / S3 `datakey` metadata before restoring anything.

### Observability & response
- [ ] OpenTelemetry traces across gateway → kernels → providers
- [ ] Metrics (RED per route) + dashboards (Grafana/CloudWatch)
- [ ] **SNS → PagerDuty/Opsgenie wired** — the ADR-0035 backup alarm currently
      pages nobody (`backup_alarm_notifies_anyone = false`); this is the cheapest box to check and
      should be first
- [ ] Alarms: 5xx rate, p99 latency, DB connections/CPU, cert expiry, backup-stale
- [ ] Centralized structured logs with retention

### Edge & network
- [ ] Real domain + ACM cert (retire the sslip.io name; then HSTS max-age can ramp — see ADR-0029)
- [ ] CloudFront + AWS WAF (deferred security D5); rate limiting already exists in-app (ADR-0031)
- [ ] Status page + published SLO / error budget (target 99.9% once the above hold)

### Cost note
The reason this is parked: standing up HA compute, Multi-AZ RDS, and an observability stack is a
material monthly increase over the current ~$10/mo dev box. It is the right spend **when there is a
customer to serve**, not before. Revisit at the first serious pilot.

---

Related, tracked elsewhere:
- The **product** readiness plan (identity, guardrails, differentiators, commercial):
  [docs/product/ENTERPRISE_READINESS_PLAN.md](../product/ENTERPRISE_READINESS_PLAN.md)
- Deferred **security hardening** and **compliance** lists: in the plan above (Bucket 3).
