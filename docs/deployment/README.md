# Deploying RegulAIt in your own environment

[ADR-0041](../decisions/0041-byoc-primary-motion.md) makes **BYOC / air-gapped,
single-tenant-per-deployment** the primary motion: one deployment, one customer, one org. Your
control plane runs in your cloud or your air gap, under your IAM, holding your
`REGULAIT_DATA_KEY`. There is no shared SaaS control plane for your prompts, documents, policy
state or audit trail to live in.

That bet only pays off if you can stand the thing up without our engineers in the room. These
pages are how.

| | |
| --- | --- |
| **[INSTALL.md](INSTALL.md)** | one-command install, the three modes, TLS choices, the air-gapped image bundle, first-admin bootstrap |
| **[UPGRADE.md](UPGRADE.md)** | signed update bundles, what the verifier refuses and why, key custody and rotation, rollback |
| **[BACKUP_RESTORE.md](BACKUP_RESTORE.md)** | verified `pg_dump`, restore onto the same box and onto a new one, RPO/RTO, what is not covered |
| **[DATA_BOUNDARY.md](DATA_BOUNDARY.md)** | **the trust artifact** — every outbound surface in the product, per mode, verified against source, including the one gap between "air-gapped" as a word and as an enforced code property |

## The 60-second version

```sh
# BYOC, real TLS
./scripts/install.sh --mode byoc --domain regulait.acme.example --tls letsencrypt

# Air-gapped: build the image bundle on a connected host first
./scripts/build-image-bundle.sh --version 0.1.0 --out regulait-images-0.1.0.tar
# …carry it across…
./scripts/install.sh --mode air_gapped --domain regulait.corp.local --tls internal \
                     --version 0.1.0 --image-bundle regulait-images-0.1.0.tar

# Plan without touching containers
./scripts/install.sh --check --mode byoc --domain x.example --dir /tmp/plan

# Upgrade
./scripts/verify-update-bundle.sh regulait-update-0.2.0.tar.gz
./scripts/apply-update-bundle.sh  regulait-update-0.2.0.tar.gz
```

A full example environment file, annotated variable by variable, is at
[`infra/deploy/env.example`](../../infra/deploy/env.example). You should not normally write it by
hand — the installer renders the real one.

## The one thing to get right

`REGULAIT_DATA_KEY` encrypts every stored credential. **Record it out of band, on something that
is not this machine.** A restore onto a new host without it recovers every row and leaves every
connector token, model API key and TOTP secret permanently undecryptable. We do not hold a copy —
that is what BYOC means. See [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## What is not built yet

- **Offline licensing** — [ADR-0052](../decisions/0052-licensing-seats.md). There is no license
  check in the product today, which is why there is nothing to phone home about.
- **Non-AWS backup destination modules.** `infra/modules/backup-target-s3` is AWS-only; the posture
  it implements (versioned, write-only, no read-back, no delete) is portable, the module is not.
- **A mode-scoped egress posture** that would make air-gapped a code-enforced property for
  *compiled* vendor endpoints rather than a network-enforced one. See
  [DATA_BOUNDARY.md §4](DATA_BOUNDARY.md) — it is written down rather than left in a ticket.
- **Build provenance / reproducible builds.** An update bundle proves who signed it, not what it
  was built from.
