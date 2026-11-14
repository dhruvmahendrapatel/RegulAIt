<!-- fold: state-decisions -->
**ADR-0304 (builder lane L12, 2026-11-14, Accepted; PENDING P22 and the Helm row): Kubernetes self-install.**
- **What:** a controller-runtime operator (`deploy/operator/`, CRD `RegulaitInstallation`, `deploy.regulait.ai/v1alpha1`)
  that rolls out only a version whose signed update-bundle manifest verifies (ADR-0041), migrates by Job before the
  image changes, corrects drift and reports it; and a Helm chart (`deploy/helm/regulait/`) with a migration hook Job.
- **Defaults:** non-root, read-only root filesystem, capabilities dropped, NetworkPolicy default-deny, images by digest
  only, Secret names only (the operator has no Secret RBAC), one replica until P2, air-gapped refuses public egress.
- **Open (owner):** image digests in the bundle (schema /2), the API group domain, the backup target, distribution.
