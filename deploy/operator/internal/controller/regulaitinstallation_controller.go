// Package controller reconciles RegulaitInstallation objects (ADR-0304).
package controller

import (
	"context"
	"errors"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/events"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	v1alpha1 "github.com/dhruvmahendrapatel/regulait/deploy/operator/api/v1alpha1"
	"github.com/dhruvmahendrapatel/regulait/deploy/operator/internal/bundle"
)

// FieldOwner is the server-side-apply manager name of every object the operator writes.
const FieldOwner = "regulait-operator"

// Reconciler reconciles a RegulaitInstallation.
type Reconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder events.EventRecorder
	// Keyring is the pinned release keyring: bundle.EmbeddedKeyring() in the binary, a test key in tests.
	Keyring map[string]string
}

// The operator gets no permission on Secrets: the gateway pod reads them through secretKeyRef (ADR-0304 §3).
// +kubebuilder:rbac:groups=deploy.regulait.ai,namespace=regulait-system,resources=regulaitinstallations,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=deploy.regulait.ai,namespace=regulait-system,resources=regulaitinstallations/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps,namespace=regulait-system,resources=deployments,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=batch,namespace=regulait-system,resources=jobs;cronjobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=networking.k8s.io,namespace=regulait-system,resources=networkpolicies,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="",namespace=regulait-system,resources=services;serviceaccounts,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="",namespace=regulait-system,resources=persistentvolumeclaims,verbs=get;list;watch;create
// +kubebuilder:rbac:groups="",namespace=regulait-system,resources=configmaps,verbs=get;list;watch
// +kubebuilder:rbac:groups=events.k8s.io,namespace=regulait-system,resources=events,verbs=create;patch

// Reconcile converges one installation. Every refusal leaves running workloads unchanged.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	in := &v1alpha1.RegulaitInstallation{}
	if err := r.Get(ctx, req.NamespacedName, in); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	orig := in.DeepCopy()
	specChanged := in.Generation != in.Status.ObservedGeneration

	result, rerr := r.reconcile(ctx, in, specChanged)

	in.Status.ObservedGeneration = in.Generation
	ready := metav1.ConditionTrue
	reason, msg := "Converged", "the installation runs the verified version"
	for _, t := range []string{v1alpha1.ConditionSpecValid, v1alpha1.ConditionBundleVerified, v1alpha1.ConditionEgressRestricted, v1alpha1.ConditionMigrated, v1alpha1.ConditionBackupConfigured, v1alpha1.ConditionAvailable} {
		c := meta.FindStatusCondition(in.Status.Conditions, t)
		if c == nil || c.Status != metav1.ConditionTrue {
			ready, reason, msg = metav1.ConditionFalse, "Waiting"+t, fmt.Sprintf("condition %s is not True", t)
			if c != nil {
				msg = c.Message
			}
			break
		}
	}
	r.setCondition(in, v1alpha1.ConditionReady, ready, reason, msg)

	if err := r.Status().Patch(ctx, in, client.MergeFrom(orig)); err != nil && !apierrors.IsNotFound(err) {
		logger.Error(err, "status update failed")
		if rerr == nil {
			rerr = err
		}
	}
	return result, rerr
}

func (r *Reconciler) setCondition(in *v1alpha1.RegulaitInstallation, t string, s metav1.ConditionStatus, reason, msg string) {
	meta.SetStatusCondition(&in.Status.Conditions, metav1.Condition{Type: t, Status: s, Reason: reason, Message: msg, ObservedGeneration: in.Generation})
}

func (r *Reconciler) warn(in *v1alpha1.RegulaitInstallation, reason, action, msg string) {
	if r.Recorder != nil {
		r.Recorder.Eventf(in, nil, corev1.EventTypeWarning, reason, action, "%s", msg)
	}
}

func (r *Reconciler) normal(in *v1alpha1.RegulaitInstallation, reason, action, msg string) {
	if r.Recorder != nil {
		r.Recorder.Eventf(in, nil, corev1.EventTypeNormal, reason, action, "%s", msg)
	}
}

func (r *Reconciler) reconcile(ctx context.Context, in *v1alpha1.RegulaitInstallation, specChanged bool) (ctrl.Result, error) {
	// 1. The spec, beyond the schema.
	if reason, msg, ok := Validate(in); !ok {
		r.setCondition(in, v1alpha1.ConditionSpecValid, metav1.ConditionFalse, reason, msg)
		r.warn(in, reason, "Validate", msg)
		return ctrl.Result{}, nil
	}
	r.setCondition(in, v1alpha1.ConditionSpecValid, metav1.ConditionTrue, "Valid", "the spec passes the operator's checks")
	r.setCondition(in, v1alpha1.ConditionEgressRestricted, metav1.ConditionTrue, "DefaultDeny", "NetworkPolicy is default-deny; only the spec's holes are open")

	// 2. The signed manifest for spec.version.
	res, err := r.verifyBundle(ctx, in)
	if err != nil {
		var ref *bundle.Refusal
		if errors.As(err, &ref) {
			r.setCondition(in, v1alpha1.ConditionBundleVerified, metav1.ConditionFalse, ref.Reason, ref.Message)
			r.warn(in, ref.Reason, "VerifyBundle", ref.Message)
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}
	if in.Spec.UpdateBundle.ExtraKeyringConfigMapRef != nil {
		// The opt-in is reported on every reconcile, whichever key signed this manifest.
		msg := fmt.Sprintf("manifest %s signed by key %s; an extra keyring (%s) is trusted besides the compiled-in release keys",
			res.Manifest.Version, res.Manifest.SigningKeyID, in.Spec.UpdateBundle.ExtraKeyringConfigMapRef.Name)
		r.setCondition(in, v1alpha1.ConditionBundleVerified, metav1.ConditionTrue, "ExtraKeyringInUse", msg)
		r.warn(in, "ExtraKeyringInUse", "VerifyBundle", msg)
	} else {
		r.setCondition(in, v1alpha1.ConditionBundleVerified, metav1.ConditionTrue, "SignatureVerified",
			fmt.Sprintf("manifest %s signed by compiled-in release key %s", res.Manifest.Version, res.Manifest.SigningKeyID))
	}
	in.Status.VerifiedManifestSHA256 = res.SHA256

	// 3. Owned objects, with drift counted.
	owned := []client.Object{ServiceAccount(in), Service(in)}
	for _, np := range NetworkPolicies(in) {
		owned = append(owned, np)
	}
	for _, obj := range owned {
		if err := r.apply(ctx, in, obj, specChanged); err != nil {
			return ctrl.Result{}, err
		}
	}
	if err := r.ensureInstallSecretsClaim(ctx, in); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileBackup(ctx, in, specChanged); err != nil {
		return ctrl.Result{}, err
	}

	// 4. Migrate before the image moves.
	target := imageRef(in.Spec.Image)
	image := target
	if in.Status.InstalledImage != target {
		done, err := r.migrate(ctx, in)
		if err != nil {
			return ctrl.Result{}, err
		}
		if !done {
			image = in.Status.InstalledImage
		}
	} else {
		r.setCondition(in, v1alpha1.ConditionMigrated, metav1.ConditionTrue, "Migrated", "the running image has been migrated")
	}

	if image == "" {
		// First install, migration still running: nothing to run yet.
		r.setCondition(in, v1alpha1.ConditionAvailable, metav1.ConditionFalse, "WaitingForMigration", "the first migration has not finished")
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}
	dep := Deployment(in, image)
	// A rollout to a newly migrated image is an intended change, not drift.
	rolling := specChanged || image != in.Status.InstalledImage
	if err := r.apply(ctx, in, dep, rolling); err != nil {
		return ctrl.Result{}, err
	}

	// 5. Record the installed version once the target is available.
	live := &appsv1.Deployment{}
	if err := r.Get(ctx, client.ObjectKeyFromObject(dep), live); err != nil {
		return ctrl.Result{}, err
	}
	if deploymentAvailable(live) {
		r.setCondition(in, v1alpha1.ConditionAvailable, metav1.ConditionTrue, "Available", "the gateway Deployment is available")
		if image == target && in.Status.InstalledImage != target {
			in.Status.InstalledImage = target
			in.Status.InstalledVersion = in.Spec.Version
			r.normal(in, "Installed", "Rollout", fmt.Sprintf("version %s is running", in.Spec.Version))
		}
		if image != target {
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		return ctrl.Result{}, nil
	}
	r.setCondition(in, v1alpha1.ConditionAvailable, metav1.ConditionFalse, "Progressing", "the gateway Deployment is not available yet")
	return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
}

func deploymentAvailable(d *appsv1.Deployment) bool {
	if d.Status.ObservedGeneration < d.Generation {
		return false
	}
	want := int32(1)
	if d.Spec.Replicas != nil {
		want = *d.Spec.Replicas
	}
	return d.Status.UpdatedReplicas >= want && d.Status.AvailableReplicas >= want
}

func (r *Reconciler) verifyBundle(ctx context.Context, in *v1alpha1.RegulaitInstallation) (*bundle.Result, error) {
	ns := in.Namespace
	mcm := &corev1.ConfigMap{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: in.Spec.UpdateBundle.ManifestConfigMapRef.Name}, mcm); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, &bundle.Refusal{Reason: "ManifestMissing", Message: "the manifest ConfigMap does not exist"}
		}
		return nil, err
	}
	keyring := r.Keyring
	if ref := in.Spec.UpdateBundle.ExtraKeyringConfigMapRef; ref != nil {
		kcm := &corev1.ConfigMap{}
		if err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: ref.Name}, kcm); err != nil {
			if apierrors.IsNotFound(err) {
				return nil, &bundle.Refusal{Reason: "ExtraKeyringMissing", Message: "the extra keyring ConfigMap named in the spec does not exist"}
			}
			return nil, err
		}
		merged, err := bundle.MergeKeyrings(r.Keyring, kcm.Data)
		if err != nil {
			return nil, err
		}
		keyring = merged
	}
	return bundle.Verify(bundle.Input{
		Manifest:         []byte(cmValue(mcm, "manifest.json")),
		Signature:        []byte(cmValue(mcm, "manifest.json.sig")),
		Keyring:          keyring,
		WantVersion:      in.Spec.Version,
		InstalledVersion: in.Status.InstalledVersion,
	})
}

// cmValue reads a key from data or, for a manifest stored byte for byte, binaryData.
func cmValue(cm *corev1.ConfigMap, key string) string {
	if v, ok := cm.Data[key]; ok {
		return v
	}
	return string(cm.BinaryData[key])
}

// apply server-side-applies obj as the operator's field manager and counts a change to an existing object made
// while the spec did not change as drift.
func (r *Reconciler) apply(ctx context.Context, in *v1alpha1.RegulaitInstallation, obj client.Object, specChanged bool) error {
	if err := controllerutil.SetControllerReference(in, obj, r.Scheme); err != nil {
		return err
	}
	existing, ok := obj.DeepCopyObject().(client.Object)
	if !ok {
		return fmt.Errorf("%T is not a client.Object", obj)
	}
	before := ""
	if err := r.Get(ctx, client.ObjectKeyFromObject(obj), existing); err == nil {
		before = existing.GetResourceVersion()
	} else if !apierrors.IsNotFound(err) {
		return err
	}

	m, err := runtime.DefaultUnstructuredConverter.ToUnstructured(obj)
	if err != nil {
		return err
	}
	delete(m, "status")
	if md, ok := m["metadata"].(map[string]any); ok {
		delete(md, "creationTimestamp")
	}
	u := &unstructured.Unstructured{Object: m}
	if err := r.Client.Apply(ctx, client.ApplyConfigurationFromUnstructured(u), client.FieldOwner(FieldOwner), client.ForceOwnership); err != nil {
		return err
	}
	if before != "" && u.GetResourceVersion() != before && !specChanged {
		in.Status.DriftCorrections++
		r.warn(in, "DriftCorrected", "Reconcile", fmt.Sprintf("%s %s had changed and was put back", u.GetKind(), u.GetName()))
	}
	return nil
}

func (r *Reconciler) ensureInstallSecretsClaim(ctx context.Context, in *v1alpha1.RegulaitInstallation) error {
	if in.Spec.InstallSecretsClaimName != "" {
		return nil // the customer's own claim
	}
	pvc := InstallSecretsClaim(in)
	err := r.Get(ctx, client.ObjectKeyFromObject(pvc), &corev1.PersistentVolumeClaim{})
	if apierrors.IsNotFound(err) {
		// No owner reference on purpose: deleting the installation never deletes the signing keys.
		return client.IgnoreAlreadyExists(r.Create(ctx, pvc))
	}
	return err
}

func (r *Reconciler) reconcileBackup(ctx context.Context, in *v1alpha1.RegulaitInstallation, specChanged bool) error {
	b := in.Spec.Backup
	cj := &batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: in.Name + "-backup", Namespace: in.Namespace}}
	switch {
	case b.Disabled:
		r.setCondition(in, v1alpha1.ConditionBackupConfigured, metav1.ConditionTrue, "BackupDisabled", "backup was turned off in the spec (backup.disabled: true)")
		r.warn(in, "BackupDisabled", "Reconcile", "backup is disabled for this installation")
		return client.IgnoreNotFound(r.Delete(ctx, cj))
	case b.DestinationClaimName == "":
		r.setCondition(in, v1alpha1.ConditionBackupConfigured, metav1.ConditionFalse, "NoDestination", "set backup.destinationClaimName, or turn backup off with backup.disabled")
		return client.IgnoreNotFound(r.Delete(ctx, cj))
	default:
		if err := r.apply(ctx, in, BackupCronJob(in), specChanged); err != nil {
			return err
		}
		r.setCondition(in, v1alpha1.ConditionBackupConfigured, metav1.ConditionTrue, "Scheduled", "pg_dump runs on the backup schedule")
		return nil
	}
}

// migrate runs (or finds) the migration Job for the target image and reports whether it has succeeded.
func (r *Reconciler) migrate(ctx context.Context, in *v1alpha1.RegulaitInstallation) (bool, error) {
	job := MigrateJob(in)
	live := &batchv1.Job{}
	err := r.Get(ctx, client.ObjectKeyFromObject(job), live)
	if apierrors.IsNotFound(err) {
		if err := controllerutil.SetControllerReference(in, job, r.Scheme); err != nil {
			return false, err
		}
		if err := r.Create(ctx, job); err != nil && !apierrors.IsAlreadyExists(err) {
			return false, err
		}
		r.normal(in, "MigrationStarted", "Migrate", fmt.Sprintf("job %s migrates to %s", job.Name, in.Spec.Version))
		r.setCondition(in, v1alpha1.ConditionMigrated, metav1.ConditionFalse, "MigrationRunning", "job "+job.Name+" is running")
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, c := range live.Status.Conditions {
		if c.Status != corev1.ConditionTrue {
			continue
		}
		switch c.Type {
		case batchv1.JobComplete:
			r.setCondition(in, v1alpha1.ConditionMigrated, metav1.ConditionTrue, "Migrated", "job "+live.Name+" succeeded")
			return true, nil
		case batchv1.JobFailed:
			msg := fmt.Sprintf("job %s failed; the installed version keeps running. Delete the Job to retry.", live.Name)
			r.setCondition(in, v1alpha1.ConditionMigrated, metav1.ConditionFalse, "MigrationFailed", msg)
			r.warn(in, "MigrationFailed", "Migrate", msg)
			return false, nil
		}
	}
	r.setCondition(in, v1alpha1.ConditionMigrated, metav1.ConditionFalse, "MigrationRunning", "job "+live.Name+" is running")
	return false, nil
}

// SetupWithManager registers the controller. A change to a referenced ConfigMap re-verifies the installations
// that point at it.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.RegulaitInstallation{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{}).
		Owns(&corev1.ServiceAccount{}).
		Owns(&networkingv1.NetworkPolicy{}).
		Owns(&batchv1.Job{}).
		Owns(&batchv1.CronJob{}).
		Watches(&corev1.ConfigMap{}, handler.EnqueueRequestsFromMapFunc(r.forConfigMap)).
		Named("regulaitinstallation").
		Complete(r)
}

func (r *Reconciler) forConfigMap(ctx context.Context, obj client.Object) []reconcile.Request {
	list := &v1alpha1.RegulaitInstallationList{}
	if err := r.List(ctx, list, client.InNamespace(obj.GetNamespace())); err != nil {
		return nil
	}
	var out []reconcile.Request
	for _, in := range list.Items {
		b := in.Spec.UpdateBundle
		if b.ManifestConfigMapRef.Name == obj.GetName() || (b.ExtraKeyringConfigMapRef != nil && b.ExtraKeyringConfigMapRef.Name == obj.GetName()) {
			out = append(out, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(&in)})
		}
	}
	return out
}
