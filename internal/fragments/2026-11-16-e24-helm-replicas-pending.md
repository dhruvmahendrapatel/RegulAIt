<!-- fold: pending -->

- **Control-plane HA follow-ups (ADR-0343 §4 "As built", lane E24).** (1) The operator (`deploy/operator`) still caps
  `spec.replicas` at 1. Relax it with the chart's checks: a ReadWriteMany install-secrets claim, `RollingUpdate`, a
  PDB, zone spread and the `/ready` probe, with envtest coverage. (2) An opt-in CloudNativePG `Cluster` in the chart
  (3 instances, `synchronous: {method: any, number: 1, dataDurability: required}`, zone anti-affinity, the Barman Cloud
  plugin `ObjectStore` and a `ScheduledBackup`), with the NetworkPolicies its instances, operator and object store
  need under the default-deny baseline. Prove both on a kind cluster in CI before they ship.
