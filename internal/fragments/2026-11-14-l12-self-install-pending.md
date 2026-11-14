<!-- fold: pending -->

**P22 and the Helm row: Kubernetes self-install (lane L12, 2026-11-14).** Built ([ADR-0304](../decisions/0304-kubernetes-operator-and-helm-chart.md)).
`deploy/operator/` is a controller-runtime operator. Its `RegulaitInstallation` CRD rolls out only a version whose signed
update-bundle manifest verifies, and it migrates by Job before the image moves. It corrects drift and reports it, keeps
the install-secrets claim when the CR is deleted, and has no Secret RBAC. `deploy/helm/regulait/` is the plain-Helm
path, with a pre-install/pre-upgrade migration Job, a hook default-deny NetworkPolicy and an opt-in operator. Both
are tested on envtest and render tests only; neither has been run on a real cluster.
Open, for the owner:
- image digests in the bundle manifest (schema `/2`);
- the API group domain;
- the backup target beyond a PVC (with P2);
- where the operator image and the chart are published;
- multi-replica HA (P2).
