package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Mode is the deployment mode, passed to the gateway as REGULAIT_DEPLOY_MODE (ADR-0062). `hosted` is our own SaaS
// shape and is not a self-install, so it is not a member.
// +kubebuilder:validation:Enum=byoc;air_gapped
type Mode string

const (
	ModeBYOC      Mode = "byoc"
	ModeAirGapped Mode = "air_gapped"
)

// SecretKeyRef names one key of a Secret in the installation's namespace. Only the name is ever in the spec: the
// operator has no permission to read Secrets, and the gateway pod reads the value through secretKeyRef.
type SecretKeyRef struct {
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`
	// +kubebuilder:validation:MaxLength=253
	Name string `json:"name"`
	// +kubebuilder:validation:Pattern=`^[-._a-zA-Z0-9]+$`
	// +kubebuilder:validation:MaxLength=253
	Key string `json:"key"`
}

// LocalObjectRef names an object in the installation's namespace.
type LocalObjectRef struct {
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`
	// +kubebuilder:validation:MaxLength=253
	Name string `json:"name"`
}

// ImageSpec is an image pinned by digest. A tag is never accepted.
type ImageSpec struct {
	// Repository without tag or digest, for example `registry.internal.example/regulait/gateway`.
	// +kubebuilder:validation:Pattern=`^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+$`
	// +kubebuilder:validation:MaxLength=255
	Repository string `json:"repository"`
	// +kubebuilder:validation:Pattern=`^sha256:[0-9a-f]{64}$`
	Digest string `json:"digest"`
	// Registry hosts the repository may live in. Required in air_gapped mode.
	// +optional
	// +kubebuilder:validation:MaxItems=16
	// +listType=set
	AllowedRegistries []string `json:"allowedRegistries,omitempty"`
}

// UpdateBundleSpec points at the signed update-bundle manifest for spec.version (ADR-0041).
type UpdateBundleSpec struct {
	// ConfigMap with the keys `manifest.json` and `manifest.json.sig`, copied byte for byte from the bundle.
	ManifestConfigMapRef LocalObjectRef `json:"manifestConfigMapRef"`
	// Optional ConfigMap of ADDITIONAL public keys, one `<keyId>.pub` entry (PEM) per key. The trust anchor is the
	// release keyring compiled into the operator; this opt-in can add key ids (a customer signing its own bundles) but
	// never replace a compiled-in one, and it is reported on every reconcile (ADR-0304 §2a).
	// +optional
	ExtraKeyringConfigMapRef *LocalObjectRef `json:"extraKeyringConfigMapRef,omitempty"`
}

// BackupSpec is the backup policy. Without a destination the installation is not Ready, unless backup is disabled
// explicitly, which the operator reports on every reconcile. The destination is a PersistentVolumeClaim or an S3 bucket
// in the customer's own AWS account (ADR-0305), never both.
// +kubebuilder:validation:XValidation:rule="!(has(self.destinationClaimName) && has(self.s3))",message="set backup.destinationClaimName or backup.s3, not both"
type BackupSpec struct {
	// +kubebuilder:default="17 2 * * *"
	// +kubebuilder:validation:MaxLength=64
	// +optional
	Schedule string `json:"schedule,omitempty"`
	// +kubebuilder:default=14
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=3650
	// +optional
	RetentionDays int32 `json:"retentionDays,omitempty"`
	// PersistentVolumeClaim that receives the dumps. retentionDays prunes it.
	// +optional
	DestinationClaimName string `json:"destinationClaimName,omitempty"`
	// S3 bucket in the customer's AWS account that receives the dumps (ADR-0305). Retention and versioning are the
	// bucket's own versioning and lifecycle rules; retentionDays does not apply.
	// +optional
	S3 *S3BackupDestination `json:"s3,omitempty"`
	// Image that provides pg_dump, pinned by digest. Required when a destination is set.
	// +optional
	Image *ImageSpec `json:"image,omitempty"`
	// Turns backup off. Recorded as a Warning event and a condition on every reconcile.
	// +optional
	Disabled bool `json:"disabled,omitempty"`
}

// S3BackupDestination uploads each dump with SSE-KMS under the customer's key, and refuses a bucket owned by another
// account (--expected-bucket-owner). Credentials come from the pod's AWS identity (IRSA or EKS Pod Identity), never from
// a key in the spec or a Secret. The CronJob needs s3:PutObject on the prefix and kms:GenerateDataKey on the key.
type S3BackupDestination struct {
	// +kubebuilder:validation:Pattern=`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`
	Bucket string `json:"bucket"`
	// +kubebuilder:validation:Pattern=`^[a-z]{2}(-[a-z]+)+-[0-9]+$`
	// +kubebuilder:validation:MaxLength=32
	Region string `json:"region"`
	// Key prefix, for example `regulait/prod-eu/`. Empty puts dumps at the bucket root.
	// +kubebuilder:validation:Pattern=`^([A-Za-z0-9!_.*'()-]+/)*$`
	// +kubebuilder:validation:MaxLength=256
	// +optional
	Prefix string `json:"prefix,omitempty"`
	// Customer-managed KMS key the dumps are encrypted with (SSE-KMS). A key ARN or an alias ARN.
	// +kubebuilder:validation:Pattern=`^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:(key|alias)/[A-Za-z0-9/_-]+$`
	// +kubebuilder:validation:MaxLength=2048
	KMSKeyARN string `json:"kmsKeyARN"`
	// The 12-digit account that must own the bucket. An upload to a bucket owned by anyone else fails.
	// +kubebuilder:validation:Pattern=`^[0-9]{12}$`
	ExpectedBucketOwner string `json:"expectedBucketOwner"`
	// Image that provides the AWS CLI, pinned by digest, from the same allowed registries as the other images.
	UploaderImage ImageSpec `json:"uploaderImage"`
	// IAM role for IRSA: set as the eks.amazonaws.com/role-arn annotation on the backup ServiceAccount. Leave empty
	// with EKS Pod Identity, whose association names the ServiceAccount instead.
	// +kubebuilder:validation:Pattern=`^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$`
	// +kubebuilder:validation:MaxLength=2048
	// +optional
	RoleARN string `json:"roleARN,omitempty"`
	// Opens TCP 80 to the EKS Pod Identity agent (169.254.170.23) for the backup pods only. Every other egress list
	// refuses link-local addresses; this exception is reported on every reconcile.
	// +optional
	PodIdentity bool `json:"podIdentity,omitempty"`
	// CIDRs of the S3 and STS endpoints (VPC interface endpoints, or the published S3 ranges), opened on 443 for the
	// backup pods only. In air_gapped mode every entry must be a private range.
	// +kubebuilder:validation:MinItems=1
	// +kubebuilder:validation:MaxItems=32
	// +listType=set
	EgressCIDRs []string `json:"egressCIDRs"`
}

// EgressSpec is the egress posture. The NetworkPolicy is always default-deny; these fields only open holes.
type EgressSpec struct {
	// CIDRs the gateway may reach on any port, for example a model endpoint inside the customer network.
	// In air_gapped mode every entry must be a private range.
	// +optional
	// +kubebuilder:validation:MaxItems=64
	// +listType=set
	AllowedCIDRs []string `json:"allowedCIDRs,omitempty"`
	// CIDRs of the database, opened on port 5432.
	// +optional
	// +kubebuilder:validation:MaxItems=16
	// +listType=set
	DatabaseCIDRs []string `json:"databaseCIDRs,omitempty"`
	// Where DNS is reached. Defaults to the k8s-app=kube-dns pods in kube-system; a cluster using NodeLocal DNSCache
	// (a link-local address) or a renamed CoreDNS names its own selector or CIDRs here.
	// +optional
	DNS *DNSEgress `json:"dns,omitempty"`
	// Opens egress to every public address on 443 (not private ranges). What a byoc install sets to reach model
	// vendors. Refused in air_gapped mode.
	// +optional
	AllowPublicEgress bool `json:"allowPublicEgress,omitempty"`
}

// DNSEgress overrides the DNS destination. Only 53/UDP and 53/TCP are ever opened.
type DNSEgress struct {
	// +optional
	NamespaceSelector *metav1.LabelSelector `json:"namespaceSelector,omitempty"`
	// +optional
	PodSelector *metav1.LabelSelector `json:"podSelector,omitempty"`
	// +optional
	// +kubebuilder:validation:MaxItems=8
	// +listType=set
	CIDRs []string `json:"cidrs,omitempty"`
}

// IngressPeer is one source allowed to reach the gateway's port. It names at least one selector, since the API server
// refuses an empty peer.
// +kubebuilder:validation:MinProperties=1
type IngressPeer struct {
	// +optional
	NamespaceSelector *metav1.LabelSelector `json:"namespaceSelector,omitempty"`
	// +optional
	PodSelector *metav1.LabelSelector `json:"podSelector,omitempty"`
}

// RegulaitInstallationSpec is the desired state of one self-installed RegulAIt (ADR-0304).
// +kubebuilder:validation:XValidation:rule="self.mode != 'air_gapped' || (has(self.image.allowedRegistries) && size(self.image.allowedRegistries) > 0)",message="air_gapped requires image.allowedRegistries"
// +kubebuilder:validation:XValidation:rule="self.mode != 'air_gapped' || !has(self.egress) || !has(self.egress.allowPublicEgress) || !self.egress.allowPublicEgress",message="air_gapped refuses egress.allowPublicEgress"
type RegulaitInstallationSpec struct {
	// +kubebuilder:validation:Pattern=`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`
	Version string    `json:"version"`
	Mode    Mode      `json:"mode"`
	Image   ImageSpec `json:"image"`

	UpdateBundle UpdateBundleSpec `json:"updateBundle"`

	DataKeySecretRef        SecretKeyRef `json:"dataKeySecretRef"`
	DatabaseURLSecretRef    SecretKeyRef `json:"databaseUrlSecretRef"`
	BootstrapTokenSecretRef SecretKeyRef `json:"bootstrapTokenSecretRef"`

	// PVC mounted at /app/install-secrets. When empty the operator creates one without an owner reference, so
	// deleting the installation never deletes the keys.
	// +optional
	InstallSecretsClaimName string `json:"installSecretsClaimName,omitempty"`
	// StorageClass for the claim the operator creates. The claim holds signing keys unencrypted, so name an encrypted
	// class. Empty uses the cluster default.
	// +optional
	// +kubebuilder:validation:MaxLength=253
	InstallSecretsStorageClassName string `json:"installSecretsStorageClassName,omitempty"`

	// +optional
	Backup BackupSpec `json:"backup,omitempty"`
	// +optional
	Egress EgressSpec `json:"egress,omitempty"`
	// Sources allowed to reach port 3000. Empty means nothing can.
	// +optional
	// +kubebuilder:validation:MaxItems=16
	IngressFrom []IngressPeer `json:"ingressFrom,omitempty"`

	// One replica until P2 (HA) records the replica story.
	// +kubebuilder:default=1
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=1
	// +optional
	Replicas *int32 `json:"replicas,omitempty"`
}

// Condition types.
const (
	ConditionSpecValid        = "SpecValid"
	ConditionBundleVerified   = "BundleVerified"
	ConditionMigrated         = "Migrated"
	ConditionBackupConfigured = "BackupConfigured"
	ConditionEgressRestricted = "EgressRestricted"
	ConditionAvailable        = "Available"
	ConditionReady            = "Ready"
	// ConditionStorageClassNamed is informational and not part of Ready: False when the operator creates the
	// install-secrets claim on the cluster's default StorageClass, whose encryption at rest the operator cannot see.
	ConditionStorageClassNamed = "StorageClassNamed"
	// ConditionPublicEgress is informational and not part of Ready: True, with a Warning event on every reconcile,
	// while the spec opens anything beyond private ranges (allowPublicEgress or a public CIDR).
	ConditionPublicEgress = "PublicEgress"
	// ConditionImageProvenance is informational and not part of Ready: bundle schema /1 signs the version, not the
	// image digest, so it stays False (DigestNotSigned) until a schema binds the digest (ADR-0304 owner question 1).
	ConditionImageProvenance = "ImageProvenance"
	// ConditionReleaseKeyring is informational and not part of Ready: False while every compiled-in key is a
	// development key (a key id containing "-dev-").
	ConditionReleaseKeyring = "ReleaseKeyring"
)

// RegulaitInstallationStatus is the observed state.
type RegulaitInstallationStatus struct {
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// The version whose migration succeeded and whose Deployment became available.
	// +optional
	InstalledVersion string `json:"installedVersion,omitempty"`
	// The image (repository@digest) that version runs from.
	// +optional
	InstalledImage string `json:"installedImage,omitempty"`
	// SHA-256 of the manifest bytes that last verified.
	// +optional
	VerifiedManifestSHA256 string `json:"verifiedManifestSHA256,omitempty"`
	// Number of times an owned object was found changed and put back.
	// +optional
	DriftCorrections int64 `json:"driftCorrections,omitempty"`
	// +optional
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// RegulaitInstallation is one self-installed RegulAIt.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=rgi
// +kubebuilder:printcolumn:name="Version",type=string,JSONPath=`.spec.version`
// +kubebuilder:printcolumn:name="Installed",type=string,JSONPath=`.status.installedVersion`
// +kubebuilder:printcolumn:name="Mode",type=string,JSONPath=`.spec.mode`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
type RegulaitInstallation struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   RegulaitInstallationSpec   `json:"spec,omitempty"`
	Status RegulaitInstallationStatus `json:"status,omitempty"`
}

// RegulaitInstallationList is a list of installations.
// +kubebuilder:object:root=true
type RegulaitInstallationList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []RegulaitInstallation `json:"items"`
}

func init() {
	SchemeBuilder.Register(&RegulaitInstallation{}, &RegulaitInstallationList{})
}
