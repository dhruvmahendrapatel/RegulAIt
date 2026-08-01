# ADR-0032: Scheduled power-off of the dev EC2 stack, on an Elastic IP, via EventBridge Scheduler

- **Status**: Accepted
- **Date**: 2026-08-01

## Context

The `regulait-dev-app` stack is a single `t3.small` running `docker compose`
(Postgres + gateway + Caddy) in the workload account. It is a solo project's dev
box: nobody touches it overnight, at weekends, or on most of a given weekday.
It has nevertheless been billed 24/7, and the org's Budget is $5/month — the
compute line alone (~$15/month) blows through that on its own.

Four constraints shaped the design.

**1. Postgres lives on the instance's root EBS volume.** There is no RDS. A
*stop/start* preserves EBS and is safe. A *terminate/replace* is total data
loss, and this repo has already had one near-miss: a plan on 2026-08-01 proposed
replacing the instance purely because the SSM "latest AL2023 AMI" parameter had
moved (fixed by pinning `ami_id` and setting `user_data_replace_on_change =
false`; see `01be2e4`). Anything added here has to be provably incapable of
reintroducing that.

**2. The stack's entire public identity is derived from its public IPv4.**
ADR-0029 serves HTTPS at `<dashed-public-ip>.sslip.io` with a real Let's Encrypt
certificate — the hostname *literally encodes the address*. An EC2 instance's
auto-assigned public IPv4 is **released on every stop and a different one issued
on the next start**. A nightly power cycle would therefore change the URL every
morning, invalidate the certificate, and force a fresh ACME issuance daily. This
is not hypothetical either: while writing this ADR the box was already found
**stopped**, and Terraform state had drifted from the `3.237.199.248` still
written into `infra/caddy/Caddyfile` and the docs to `98.86.163.252`. The
hostname had already broken once, silently.

**3. The box must be usable after an automated start with no human step.** A
cost schedule that requires an SSM session every morning is not a cost schedule,
it is a chore.

**4. Whoever operates this must be able to change the window without editing a
module,** per the standing "admins get options wherever a choice is feasible"
mandate.

## Decision

### 1. Mechanism: EventBridge Scheduler with the EC2 universal target

A new project-agnostic module `infra/modules/scheduled-power/` creates two
`aws_scheduler_schedule` resources targeting
`arn:aws:scheduler:::aws-sdk:ec2:stopInstances` and `…:startInstances`, plus the
IAM role Scheduler assumes. **No Lambda, no container, no maintenance window —
no always-on compute at all.**

Rejected alternatives:

- **EventBridge *Rule* + Lambda.** Needs a function, an artifact, a log group, a
  second role, and a runtime that ages into a CVE finding on the very Security
  Hub dashboard this org runs. Decisively: EventBridge *Rules* evaluate cron in
  **UTC only**, so a local-time business-hours window silently drifts an hour
  twice a year. Scheduler has native `schedule_expression_timezone` and handles
  DST itself.
- **SSM Automation + Maintenance Window.** Identical outcome, more surface: an
  extra window resource, an automation role, and a second cron grammar.
- **AWS Instance Scheduler solution.** A CloudFormation stack with DynamoDB and
  a Lambda polling every 5 minutes. It has a real running cost, which is absurd
  as the implementation of a cost-savings feature on one box.
- **cron on the instance.** Cannot start a machine that is off.

**IAM is least-privilege by construction:** exactly `ec2:StartInstances` and
`ec2:StopInstances`, on exactly the instance ARNs passed in. No `Resource: "*"`,
no `ec2:*`, and deliberately **no `ec2:TerminateInstances`** — the schedule that
touches the database box must not be one typo away from deleting it. The trust
policy carries both confused-deputy guards (`aws:SourceAccount` and an
`ArnLike` `aws:SourceArn` on the schedule-name prefix).

### 2. Public IP: allocate an Elastic IP

`infra/modules/app-instance` gains `assign_elastic_ip` (default `false`,
preserving existing behaviour for any other consumer); the dev-app environment
sets it `true`. An EIP stays associated across stop/start, so the address, the
sslip.io hostname, and the Let's Encrypt certificate all survive the cycle.

**Cost, stated honestly.** Since 2024-02-01 AWS bills **every** public IPv4 at
~$0.005/hr, idle *or* in use. So an EIP costs nothing extra while the instance
runs; the only new money is the ~469 hours/month it sits allocated to a stopped
box — **≈$2.35/month**, against ≈$9.76/month of compute saved. The trade is
clearly worth it.

The alternative considered and rejected was **deriving the hostname dynamically
on every boot** and letting Caddy re-issue. It technically works, and the
boot-resync script below implements it as a *fallback*, but as the primary
design it burns a fresh ACME issuance every morning, changes the URL in every
bookmark, doc, README and API client daily, and reduces `terraform output
app_url` to a value with a one-day shelf life.

One-time cost accepted: AWS has no convert-to-EIP operation, so attaching an EIP
changes the public IP once. Moot in practice here — the box is currently stopped
and has *already* lost its address.

### 3. Default schedule, and every knob as a variable

**Default: `start cron(0 8 ? * MON-FRI *)`, `stop cron(0 20 ? * MON-FRI *)`,
timezone `America/New_York`** — i.e. 08:00–20:00 on weekdays, US Eastern, which
is also the stack's region (us-east-1). The timezone is a first-class input
stated explicitly, never an implicit UTC offset buried in a comment.

Exposed at the environment level as `power_schedule_enabled`,
`power_schedule_start_cron`, `power_schedule_stop_cron`,
`power_schedule_timezone`, and `assign_elastic_ip`. `start_cron = null` yields a
useful stop-only mode (manual start, automatic evening sweep). `enabled = false`
puts both schedules in state `DISABLED` **without destroying them**, so pausing
the schedule is a one-line, fully reversible change rather than commenting out a
module and deleting its role.

### 4. Manual-override semantics, stated rather than discovered

A human starts the box with `aws ec2 start-instances` (or the console) at any
time. **The schedules are unconditional wall-clock events: there is no "someone
started this by hand, skip it" state.** An instance started at 21:00 Monday runs
until 20:00 Tuesday. One started on Saturday runs until 20:00 Monday. One
started at 19:50 on a weekday **stops ten minutes later.** This is written
plainly at the top of the module README's override section rather than left to
be discovered at 19:51. To hold the box across a boundary, disable the schedule
(Terraform `enabled = false`, or a time-boxed `aws scheduler update-schedule
--state DISABLED` that the next apply reverts).

### 5. Coming back up: what already worked, and the two things that did not

Audited across a stop/start:

- **Works already.** EBS root volume (stop is a graceful ACPI shutdown); the
  docker daemon (`systemctl enable --now docker` in user-data); all three
  containers (`db`, `gateway`, `caddy` all carry `restart: unless-stopped`, and
  a shutdown-initiated stop is not an operator `docker stop`, so restart intent
  survives); the Let's Encrypt cert and ACME account key (the `caddy_data` named
  volume persists, and Caddy re-checks on start — 60 h/week is ample renewal
  opportunity, with port 80 still open).
- **Improved.** `stop_grace_period: 60s` added to the `db` service. Docker's
  default 10 s risked SIGKILLing Postgres mid-checkpoint — crash-safe via WAL,
  but it pays a recovery pass and logs alarming lines every single evening.
- **Broken, now fixed.** (a) **Swap**: user-data does `fallocate` + `swapon` but
  writes no `/etc/fstab` entry, so a 2 GB box came back with zero swap. (b)
  **TLS hostname**: cloud-init's `scripts-user` is per-*instance*, not per-boot,
  so `REGULAIT_TLS_HOST` is frozen at whatever the first boot saw and cannot
  self-correct if the address ever moves.

Both are fixed by `infra/scripts/boot-resync.sh`: an idempotent script that
installs itself as a `oneshot` systemd unit ordered after `docker.service`,
re-enables and persists swap, and re-points Caddy at the current address only if
it has drifted.

**`user-data.sh.tftpl` was deliberately left byte-identical.** Editing it
changes the `aws_instance.user_data` attribute, which — with
`user_data_replace_on_change = false` — the AWS provider applies by *stopping
and starting the instance mid-apply*. Given constraint 1, this ADR keeps the
`aws_instance` diff at exactly zero and installs the fix out-of-band via SSM
instead. The logic should be folded into user-data at the next *deliberate*
instance rebuild, at which point the SSM step disappears.

## Consequences

**Verified.** `terraform plan` against real state reports **`Plan: 6 to add, 0 to
change, 0 to destroy`**, with **zero** `must be replaced` / `forces replacement`
lines and — the stronger proof — the string `aws_instance` does not appear in the
plan output *at all*. The six additions are `aws_eip`, `aws_eip_association`,
the scheduler role, its inline policy, and the two schedules. None of them is an
`aws_instance` attribute.

**Easier.** The dev bill drops from ≈$20.43/month to ≈$10.67/month (~48%), and
the floor with the instance never started is $5.25/month (EIP + EBS). The
hostname stops being a moving target — the class of bug that silently broke
`3-237-199-248.sslip.io` cannot recur. The box also becomes self-healing across
power cycles for the first time.

**Harder / given up.**

- The box is not reachable outside the window without a manual start plus ~60–90
  s of boot. Any always-on expectation (a webhook receiver, a demo link someone
  else might click at 22:00) is now wrong by default.
- Only the **compute** line scales with uptime. EBS ($1.60/mo) is billed
  stopped-or-running, and the IPv4 charge is billed idle-or-in-use. Claiming
  "64% off because it's off 64% of the time" would be false; the real figure is
  48%.
- An EIP is a scarce, account-limited resource, and `terraform destroy` releases
  it permanently — a re-created EIP is a *different* address, so the hostname and
  certificate would have to be re-pointed.
- The one-off `aws scheduler update-schedule --state DISABLED` override drifts
  from Terraform until the next apply. Accepted as a deliberate escape hatch,
  documented as time-boxed.

**Follow-up.**

1. Run the documented SSM install of `boot-resync.sh` once, on the next start.
   Until then the first start after the EIP attaches needs a manual Caddy
   re-point (the box is currently stopped and its old address is already gone).
2. `infra/caddy/Caddyfile`'s default `3-237-199-248.sslip.io` and the same string
   in README/STATE are stale. Once the EIP exists they should be updated to the
   EIP-derived name — one stable value, updated once, instead of a per-boot
   lottery.
3. Fold the boot-resync logic into `user-data.sh.tftpl` at the next deliberate
   instance rebuild.
4. This is **dev-only**. Nothing here is production, and the standing guardrail
   is untouched: no `prod`/`production` account, tag, or role was created or
   used.
