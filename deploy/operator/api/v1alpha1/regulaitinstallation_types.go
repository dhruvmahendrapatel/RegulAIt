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
// explicitly, which the operator reports on every reconcile.
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
	// PersistentVolumeClaim that receives the dumps.
	// +optional
	DestinationClaimName string `json:"destinationClaimName,omitempty"`
	// Image that provides pg_dump, pinned by digest. Required when a destination is set.
	// +optional
	Image *ImageSpec `json:"image,omitempty"`
	// Turns backup off. Recorded as a Warning event and a condition on every reconcile.
	// +optional
	Disabled bool `json:"disabled,omitempty"`
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

// IngressPeer is one source allowed to reach the gateway's port.
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
