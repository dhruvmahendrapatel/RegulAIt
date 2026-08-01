# Dev box power schedule — runbook

**What it is:** the `regulait-dev-app` EC2 instance is automatically **stopped at
20:00 and started at 08:00, Monday–Friday, America/New_York**, to stop paying for
a box nobody is using. See
[ADR-0032](../decisions/0032-scheduled-power-off-dev-infra.md) for why this shape.

**This is a stop/start, never a terminate.** The EBS root volume — which holds
the Postgres container volume — is preserved untouched. The IAM role that drives
the schedule is not even *granted* `ec2:TerminateInstances`.

**Authoritative values:** `terraform output power_window` in
`infra/environments/regulait-dev-app`.

---

## Quick reference

| I want to… | Do this |
| --- | --- |
| Start the box now | `terraform output -raw manual_start_command` → run it |
| Stop the box now | `terraform output -raw manual_stop_command` → run it |
| Keep it up past 20:00 tonight | `aws scheduler update-schedule --name regulait-dev-app-stop --group-name default --state DISABLED …` (reverted by the next apply) |
| Keep it up for days/weeks | set `power_schedule_enabled = false`, `terraform apply` |
| Change the window | set `power_schedule_start_cron` / `power_schedule_stop_cron` / `power_schedule_timezone`, `terraform apply` |
| Turn the whole thing off for good | delete the `power_schedule` module block (leaves the Elastic IP alone) |

All the `aws` commands want `--region us-east-1 --profile regulait-admin`.

---

## ⚠️ A manual start does not cancel the next scheduled stop

The schedules are unconditional wall-clock events. Nothing anywhere records "a
human started this on purpose". So:

- Started at **21:00 Monday** → stops at **20:00 Tuesday**.
- Started **Saturday** → runs all weekend, stops at **20:00 Monday**.
- Started at **19:50 on a weekday** → **stops ten minutes later.**

Check the clock before starting. If you need the box across a boundary, disable
the stop schedule rather than racing it.

---

## What happens on a start, and what you should NOT have to do

Roughly 60–90 seconds after `start-instances`:

1. The instance boots with **the same public IP** (an Elastic IP — this is the
   whole reason one exists; see below).
2. `docker.service` starts (`systemctl enable`d by user-data on first boot).
3. `db`, `gateway` and `caddy` all restart themselves — every one of them carries
   `restart: unless-stopped`, and a shutdown-initiated stop is not an operator
   `docker stop`, so the restart intent survives.
4. `regulait-boot-resync.service` runs, re-enables swap, and re-points Caddy if
   (and only if) the address has somehow drifted.

Then `https://<tls_hostname>/ui` answers. **No SSM session is required.**

Verify:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "https://$(terraform output -raw tls_hostname)/ui"
```

---

## The Elastic IP, and why it is not optional

An auto-assigned public IPv4 is **released on every stop** and a different one is
issued on the next start. This stack's hostname is `<dashed-public-ip>.sslip.io`
(ADR-0029) — it literally encodes the address — so without an Elastic IP a
nightly power cycle would change the URL every morning and invalidate the
certificate.

It has already happened once: state drifted to `98.86.163.252` while
`infra/caddy/Caddyfile`, the README and STATE.md all still said
`3.237.199.248`.

Cost: ~$0.005/hr for any public IPv4, idle or in use. So the EIP is free while
the box runs and costs ~$2.35/month for the stopped hours — against ~$9.76/month
of compute saved.

**Do not `terraform destroy` this stack casually.** Releasing the EIP loses the
address permanently; a new one is a *different* address and everything derived
from it has to be re-pointed.

---

## One-time setup: install `boot-resync.sh`

The instance's user-data runs **once, on first boot, ever** (cloud-init's
`scripts-user` is per-instance, not per-boot). Two things it set up therefore do
not survive a power cycle: the swapfile (no `/etc/fstab` entry) and Caddy's
`REGULAIT_TLS_HOST` (frozen at whatever the first boot saw).

[`infra/scripts/boot-resync.sh`](../../infra/scripts/boot-resync.sh) fixes both
and installs itself as a systemd unit so it never needs doing again. Run it once
per instance, with the box **running**:

Ship it via the source bucket the instance role can already read (no new IAM,
no pasting a 150-line script into a JSON parameter). From
`infra/environments/regulait-dev-app`:

```bash
INSTANCE=$(terraform output -raw instance_id)
BUCKET=$(terraform output -raw source_bucket)
REGION=us-east-1
PROFILE=regulait-admin

aws s3 cp ../../scripts/boot-resync.sh "s3://$BUCKET/boot-resync.sh" --profile "$PROFILE"

CMD=$(aws ssm send-command \
  --region "$REGION" --profile "$PROFILE" \
  --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --comment "install regulait boot-resync (ADR-0032)" \
  --parameters "commands=[\"aws s3 cp s3://$BUCKET/boot-resync.sh /tmp/boot-resync.sh\",\"bash /tmp/boot-resync.sh\"]" \
  --query 'Command.CommandId' --output text)

aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" \
  --region "$REGION" --profile "$PROFILE" --query 'StandardOutputContent' --output text
```

Or, if you already have an interactive session (`aws ssm start-session
--target "$INSTANCE"`), just paste the file to `/tmp/boot-resync.sh` and:

```bash
sudo bash /tmp/boot-resync.sh          # installs the unit, then resyncs now
sudo cat /var/log/regulait-boot-resync.log
```

Confirm afterwards:

```bash
systemctl is-enabled regulait-boot-resync.service   # -> enabled
swapon --show                                       # -> /swapfile listed
grep swapfile /etc/fstab                            # -> present
```

The script is idempotent — re-running it on an already-correct box prints
"already pointed at …, no change" and exits.

---

## Cost

us-east-1 list prices, 730-hour month. Full table and the tighter-window options
are in [`infra/modules/scheduled-power/README.md`](../../infra/modules/scheduled-power/README.md).

| | 24/7 | Default schedule |
| --- | --- | --- |
| `t3.small` compute | $15.18 | **$5.42** |
| Public IPv4 (EIP) | $3.65 | $3.65 |
| 20 GB gp3 root volume | $1.60 | $1.60 |
| EventBridge Scheduler | — | $0.00 |
| **Total** | **≈$20.43/mo** | **≈$10.67/mo** |

**≈$9.76/month saved (~48%).** Note it is *not* 64% just because the box is off
64% of the time: **EBS is billed whether the instance runs or not**, and the
IPv4 charge applies idle or in use. Only the compute line scales with uptime.

Floor for this stack with the instance never started: **$5.25/month.**

---

## Troubleshooting

**The box didn't start this morning.** Check the schedule fired:

```bash
aws scheduler get-schedule --name regulait-dev-app-start --group-name default \
  --region us-east-1 --profile regulait-admin
```

`State` must be `ENABLED`. EventBridge Scheduler does not write CloudWatch logs
for universal targets, so the evidence of the call is the CloudTrail
`StartInstances` event with the scheduler role as the principal:

```bash
aws cloudtrail lookup-events --lookup-attributes \
  AttributeKey=EventName,AttributeValue=StartInstances \
  --region us-east-1 --profile regulait-admin --max-results 5
```

**It started but HTTPS doesn't answer.** Almost certainly the hostname:

```bash
terraform output -raw tls_hostname     # what Terraform thinks
# on the box, via SSM:
grep REGULAIT_TLS_HOST /opt/app/docker-compose.override.yml
sudo systemctl start regulait-boot-resync && sudo tail -30 /var/log/regulait-boot-resync.log
```

**Postgres logged a crash recovery.** Safe (WAL replay), but it means the
container was SIGKILLed. `docker-compose.yml` sets `stop_grace_period: 60s` on
`db` — confirm the running stack actually picked that up (`docker inspect` the
db container's `StopTimeout`); if not, redeploy the compose stack.

**Terraform wants to replace the instance.** Stop. Read
[ADR-0032](../decisions/0032-scheduled-power-off-dev-infra.md) and the `ami_id`
comment in `infra/modules/app-instance/variables.tf`. Nothing in the power
schedule touches `aws_instance`; a replacement proposal means something else
drifted, and applying it destroys the database.
