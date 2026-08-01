# `scheduled-power`

Stop and start a fixed list of EC2 instances on an admin-configurable schedule,
with **no always-on compute of its own** — no Lambda, no container, no
maintenance window, nothing to patch.

Project-agnostic: it takes instance IDs and cron expressions and knows nothing
about what runs on the boxes. RegulAIt composes it in
[`infra/environments/regulait-dev-app`](../../environments/regulait-dev-app);
the decision record is [ADR-0032](../../../docs/decisions/0032-scheduled-power-off-dev-infra.md).

```hcl
module "power_schedule" {
  source = "../../modules/scheduled-power"

  name         = "my-dev-box"
  instance_ids = [module.app.instance_id]

  enabled    = true
  start_cron = "cron(0 8 ? * MON-FRI *)"   # 08:00 weekdays
  stop_cron  = "cron(0 20 ? * MON-FRI *)"  # 20:00 weekdays
  timezone   = "America/New_York"
}
```

---

## Mechanism: EventBridge Scheduler universal target

Two `aws_scheduler_schedule` resources whose target is the AWS SDK ("universal")
target `arn:aws:scheduler:::aws-sdk:ec2:stopInstances` /
`…:startInstances`. EventBridge Scheduler assumes a role this module creates and
makes the EC2 API call itself.

### Why, versus the alternatives

| Option | Verdict |
|---|---|
| **EventBridge Scheduler → EC2 universal target** (chosen) | No code, no packaging, no log group, no runtime to CVE-patch. Native `schedule_expression_timezone`, so **DST is handled by AWS** and a "business hours" window stays at the same *local* time all year. Whole mechanism is 4 Terraform resources. |
| EventBridge **Rule** + Lambda | Needs a function, a deployment artifact, a log group, a second IAM role, and a runtime that ages into a CVE finding on the very Security Hub dashboard this org runs. Worse: EventBridge *Rules* evaluate cron in **UTC only**, so a local-time window drifts by an hour twice a year unless someone edits the cron. Rejected. |
| SSM Automation (`AWS-StopEC2Instance`) + Maintenance Window | Works, but adds a Maintenance Window, an Automation execution role, and a second scheduling grammar (`cron(...)` with a different field count), for an identical outcome. More surface, no benefit. Rejected. |
| AWS **Instance Scheduler** solution | A whole CloudFormation stack with DynamoDB + a Lambda that runs every 5 minutes. It has a real running cost, which is absurd for a cost-savings feature on a single box. Rejected. |
| A cron job on the instance itself | Cannot start a machine that is off. Rejected on arithmetic. |

**Cost of the mechanism:** effectively zero. A weekday on/off pair is ~44
invocations/month against EventBridge Scheduler's 14,000,000/month free tier.

### IAM

The scheduler role grants exactly two actions —
`ec2:StartInstances` and `ec2:StopInstances` — on exactly the instance ARNs
built from `var.instance_ids`. There is **no `Resource: "*"`**, no `ec2:*`, and
crucially **no `ec2:TerminateInstances`**: a stateful box whose database lives on
its root volume must never be one typo away from deletion.

The trust policy carries both confused-deputy guards:
`aws:SourceAccount` = this account, and `aws:SourceArn` ArnLike the schedule-name
prefix this module owns.

---

## The public-IP trap (read this before scheduling anything with a hostname)

**An auto-assigned public IPv4 is released on every stop and a *different* one is
issued on the next start.** For a box whose DNS name, TLS certificate, or
allow-list entry is derived from its address, a nightly power cycle means a
different URL every morning and a certificate for a name that no longer points
at it.

RegulAIt hits this squarely: the dev stack serves HTTPS at
`<dashed-public-ip>.sslip.io` with a Let's Encrypt certificate (ADR-0029), so the
hostname *literally encodes* the IP.

The fix is an **Elastic IP**, exposed as `assign_elastic_ip` on the sibling
[`app-instance`](../app-instance) module. An EIP stays associated across
stop/start, so the address, the hostname, and the certificate all survive.

Since 2024-02-01 AWS charges ~**$0.005/hr for every public IPv4, idle or in
use** — so an EIP costs *nothing extra while the instance runs*; the only new
money is the hours it sits allocated to a stopped box. On the default window
that is ~469 idle hours ≈ **$2.35/month**, against ~$9.76/month of compute
saved. Good trade.

The alternative — re-deriving the hostname on every boot and letting Caddy
re-issue — was rejected: it burns a fresh ACME issuance every single morning,
changes the URL in every bookmark, doc and API client daily, and makes
`terraform output app_url` a value with a shelf life of one day.

---

## Coming back up cleanly

A stop/start is only a cost win if the box is *usable* afterwards with no human
step. For the RegulAIt dev stack the audit came out as:

| Thing | Survives stop/start? |
|---|---|
| EBS root volume (and the Postgres container volume on it) | **Yes.** `StopInstances` is a graceful ACPI shutdown; the volume is untouched. |
| Docker daemon | **Yes** — user-data runs `systemctl enable --now docker`. |
| `db`, `gateway`, `caddy` containers | **Yes** — all three carry `restart: unless-stopped`, which restarts them when the daemon starts. A shutdown-initiated stop is not an operator `docker stop`, so the restart intent is preserved. |
| Let's Encrypt cert + ACME account | **Yes** — the `caddy_data` named volume persists. Caddy re-checks on start and renews at ~30 days before expiry, so a box up 60 h/week has ample renewal opportunity. Port 80 must stay open (it does). |
| Postgres clean shutdown | **Improved.** `stop_grace_period: 60s` was added to the `db` service; the default 10 s risked a SIGKILL and a crash-recovery pass (safe, but noisy). |
| **Swap** | **No.** user-data does `fallocate` + `swapon` and writes **no `/etc/fstab` entry**, so a 2 GB `t3.small` comes back with zero swap. |
| **TLS hostname** | **No, if the IP ever changes.** user-data runs *once per instance*, never per boot, so `REGULAIT_TLS_HOST` is frozen at whatever the first boot saw. |

The last two are handled by
[`infra/scripts/boot-resync.sh`](../../scripts/boot-resync.sh): an idempotent
script that installs itself as a `oneshot` systemd unit ordered after
`docker.service`, re-enables swap, persists it in `/etc/fstab`, and re-points
Caddy at the current address if (and only if) it has drifted. Install it once
per box via SSM — see the environment README/ADR-0032 for the exact command. It
is a no-op on every boot where nothing has changed.

> **Note for whoever next rebuilds the instance:** `user-data.sh.tftpl` was left
> byte-identical on purpose — editing it changes the `aws_instance.user_data`
> attribute, which the AWS provider applies by stopping and starting the box
> mid-apply. The same logic should be folded into user-data at the next
> *deliberate* instance rebuild, at which point the SSM install step disappears.

---

## Manual override — and the thing that will surprise you

**Start the box outside the window** (both are equivalent; neither touches
Terraform state):

```bash
aws ec2 start-instances --instance-ids i-… --region us-east-1 --profile <sso-profile>
# or the console: EC2 → Instances → Instance state → Start instance
```

Give it ~60–90 s: docker starts, the three containers restart themselves, and
`boot-resync.sh` fixes swap and the hostname if needed.

**Stop it early:**

```bash
aws ec2 stop-instances --instance-ids i-… --region us-east-1 --profile <sso-profile>
```

### ⚠️ A manual start does NOT suppress the next scheduled stop

The schedules are unconditional wall-clock events. They do not look at *why* an
instance is running, and there is no "someone started this by hand, skip it"
state anywhere.

So, concretely, on the default `stop cron(0 20 ? * MON-FRI *)` window:

- Started manually at **21:00 Monday** → runs until **20:00 Tuesday**, then stops.
- Started manually on **Saturday afternoon** → runs all weekend, and stops at
  **20:00 Monday**.
- Started manually at **19:50 on a weekday** → **stops ten minutes later.** This
  is the one that catches people. Check the clock before starting.

If you need the box up across a stop boundary, suppress the schedule rather than
racing it. Two ways, in order of preference:

1. **Terraform (durable, visible in code):** set `enabled = false` (in this
   stack, `power_schedule_enabled = false`) and apply. Both schedules stay
   defined but go to state `DISABLED`. Nothing is destroyed; the Elastic IP is
   untouched; flipping back to `true` restores the identical window.
2. **One-off (fast, drifts from Terraform):**
   ```bash
   aws scheduler update-schedule --name <name>-stop --group-name default \
     --state DISABLED --profile <sso-profile> --region us-east-1
   ```
   The next `terraform apply` puts it back to `ENABLED`. Treat this as a
   time-boxed override, and prefer option 1 for anything longer than a day.

`enabled = false` is also the correct way to pause the schedule long-term.
Commenting the module out would **delete** the role and both schedules.

---

## Cost estimate

List prices, **us-east-1, on-demand**, at the time of writing (2026-08-01) — check
current pricing before quoting these anywhere that matters. A 730-hour month.

Default window (Mon–Fri 08:00–20:00 America/New_York) = 60 h/week
= 730 × 60/168 ≈ **261 running hours/month**, i.e. the box is off ~64% of the time.

| Line item | 24/7 | Default schedule | Note |
|---|---|---|---|
| `t3.small` compute @ $0.0208/h | $15.18 | **$5.42** | The only thing the schedule actually saves. |
| Public IPv4 @ $0.005/h | $3.65 | $3.65 | An EIP is billed idle *or* in use, so this line does not shrink. |
| 20 GB gp3 root volume @ $0.08/GB-mo | $1.60 | $1.60 | **EBS is billed whether the instance runs or not.** No saving here — the volume is the whole point (it holds the database). |
| EventBridge Scheduler | — | $0.00 | ~44 invocations/mo vs a 14 M/mo free tier. |
| **Total** | **≈ $20.43/mo** | **≈ $10.67/mo** | |

**Estimated saving ≈ $9.76/month (~48%).**

Honest breakdown of where that number comes from and what it costs:

- Compute avoided: 469 h × $0.0208 = **$9.76 saved**.
- EIP idle hours: 469 h × $0.005 = **$2.35 spent** — this is *new* money that
  would not exist without the schedule, and it is already netted out above
  (without an EIP the total would be ~$8.32/mo, but the URL and certificate
  would break every morning).
- EBS and the IPv4 base charge do not move at all. Anyone quoting "we cut the
  dev bill by 64% because the box is off 64% of the time" is wrong: only the
  compute line scales with uptime.

Tighter windows, if the saving matters more than the convenience:

| Window | Running h/mo | Compute | Total | Saving vs 24/7 |
|---|---|---|---|---|
| 24/7 | 730 | $15.18 | $20.43 | — |
| Mon–Fri 08:00–20:00 (default) | 261 | $5.42 | $10.67 | $9.76 |
| Mon–Fri 09:00–18:00 | 196 | $4.07 | $9.32 | $11.11 |
| Mon–Fri 09:00–17:00 | 174 | $3.62 | $8.87 | $11.56 |
| Stop-only (`start_cron = null`) | on demand | ≥ $0 | ≥ $5.25 | up to $15.18 |

The floor for this stack is **$5.25/month** (EIP + EBS) with the instance never
started. That is the number to compare against before adding anything that
"only costs a little".

---

## Inputs

| Name | Type | Default | Notes |
|---|---|---|---|
| `name` | string | — | Prefix for the role and both schedules. |
| `instance_ids` | list(string) | — | Must be non-empty; each becomes a concrete ARN in the IAM policy. |
| `start_cron` | string | `cron(0 8 ? * MON-FRI *)` | `null` ⇒ no start schedule (stop-only backstop). |
| `stop_cron` | string | `cron(0 20 ? * MON-FRI *)` | `null` ⇒ no stop schedule. |
| `timezone` | string | `America/New_York` | IANA name. DST handled by AWS. |
| `enabled` | bool | `true` | `false` ⇒ both schedules `DISABLED`, nothing destroyed. |
| `retry_max_attempts` | number | `3` | |
| `retry_max_event_age_seconds` | number | `600` | Deliberately short — see `variables.tf`. |
| `schedule_group_name` | string | `default` | |
| `tags` | map(string) | `{}` | |

Cron grammar is EventBridge Scheduler's **six** fields:
`cron(minutes hours day-of-month month day-of-week year)`. Exactly one of
day-of-month / day-of-week must be `?`. `rate(...)` and `at(...)` are also
accepted.

## Outputs

`scheduler_role_arn`, `start_schedule_name`, `stop_schedule_name`,
`start_schedule_arn`, `stop_schedule_arn`, `governed_instance_arns`, and
`window_summary` — a one-line human-readable statement of the effective window,
so nobody has to re-derive it from crons.
