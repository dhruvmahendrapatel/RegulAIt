<!-- fold: pending -->

- **Control-plane HA, slices 2 and 3 (ADR-0343, lane E24).** Slice 2: Postgres HA Terraform modules for AWS, Azure and
  GCP (synchronous zone-redundant standby, PITR, CMK, TLS only), and the chart's CloudNativePG cluster with the
  replica cap lifted once the install-secrets volume is shared and the artifact store is S3; a boot check refuses N > 1
  without them. Slice 3: the Compose failover suite (kill a replica, then the primary; no committed decision or audit
  row lost; the hash chain verifies). Owner questions: the hosted SLA figure, manual or automatic cross-region
  failover, and synchronous replication's write latency as the default.
