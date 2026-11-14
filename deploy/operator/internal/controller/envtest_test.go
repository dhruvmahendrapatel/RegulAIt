package controller

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/util/retry"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	v1alpha1 "github.com/dhruvmahendrapatel/regulait/deploy/operator/api/v1alpha1"
)

// The envtest suite runs a real kube-apiserver and etcd (no kubelet, no built-in controllers), so Job and
// Deployment status is written by the test where a cluster would write it. It never contacts a real cluster.

const testNS = "regulait-system"

var (
	k8s     client.Client
	signKey ed25519.PrivateKey
	pubPEM  string
)

func TestMain(m *testing.M) {
	if os.Getenv("KUBEBUILDER_ASSETS") == "" {
		fmt.Println("KUBEBUILDER_ASSETS unset: skipping the envtest suite (run `make test`)")
		os.Exit(m.Run())
	}
	env := &envtest.Environment{CRDDirectoryPaths: []string{filepath.Join("..", "..", "config", "crd")}, ErrorIfCRDPathMissing: true}
	cfg, err := env.Start()
	if err != nil {
		panic(err)
	}
	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(v1alpha1.AddToScheme(scheme))

	k8s, err = client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		panic(err)
	}
	if err := k8s.Create(context.Background(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: testNS}}); err != nil {
		panic(err)
	}

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	signKey = priv
	der, _ := x509.MarshalPKIXPublicKey(pub)
	pubPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))

	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme:  scheme,
		Cache:   cache.Options{DefaultNamespaces: map[string]cache.Config{testNS: {}}},
		Metrics: metricsserver.Options{BindAddress: "0"},
	})
	if err != nil {
		panic(err)
	}
	if err := (&Reconciler{Client: mgr.GetClient(), Scheme: scheme, Recorder: mgr.GetEventRecorder("regulait-operator"), Keyring: map[string]string{"rel-test.pub": pubPEM}}).SetupWithManager(mgr); err != nil {
		panic(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		if err := mgr.Start(ctx); err != nil {
			panic(err)
		}
	}()

	code := m.Run()
	cancel()
	_ = env.Stop()
	os.Exit(code)
}

func needEnv(t *testing.T) {
	t.Helper()
	if k8s == nil {
		t.Skip("envtest not available")
	}
}

func eventually(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func digest(c byte) string { return "sha256:" + strings.Repeat(string(c), 64) }

func bundleManifest(version string) string {
	return fmt.Sprintf("{\n  \"schema\": \"regulait.update-bundle/1\",\n  \"product\": \"regulait\",\n  \"version\": \"%s\",\n  \"minInstalledVersion\": \"\",\n  \"signingKeyId\": \"rel-test\",\n  \"files\": []\n}\n", version)
}

// putBundle writes the manifest and keyring ConfigMaps for name, signed with key (or tampered after signing).
func putBundle(t *testing.T, name, version string, tamper bool) {
	t.Helper()
	ctx := context.Background()
	m := bundleManifest(version)
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(signKey, []byte(m)))
	if tamper {
		m = strings.Replace(m, "\"files\": []", "\"files\": [ ]", 1)
	}
	for _, cm := range []*corev1.ConfigMap{
		{ObjectMeta: metav1.ObjectMeta{Name: name + "-manifest", Namespace: testNS}, Data: map[string]string{"manifest.json": m, "manifest.json.sig": sig}},
		{ObjectMeta: metav1.ObjectMeta{Name: name + "-keyring", Namespace: testNS}, Data: map[string]string{"rel-test.pub": pubPEM}},
	} {
		existing := &corev1.ConfigMap{}
		if err := k8s.Get(ctx, client.ObjectKeyFromObject(cm), existing); err == nil {
			existing.Data = cm.Data
			if err := k8s.Update(ctx, existing); err != nil {
				t.Fatal(err)
			}
		} else if err := k8s.Create(ctx, cm); err != nil {
			t.Fatal(err)
		}
	}
}

func newInstallation(name, version string, d byte) *v1alpha1.RegulaitInstallation {
	return &v1alpha1.RegulaitInstallation{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNS},
		Spec: v1alpha1.RegulaitInstallationSpec{
			Version: version,
			Mode:    v1alpha1.ModeBYOC,
			Image:   v1alpha1.ImageSpec{Repository: "registry.example.internal/regulait/gateway", Digest: digest(d)},
			UpdateBundle: v1alpha1.UpdateBundleSpec{
				ManifestConfigMapRef: v1alpha1.LocalObjectRef{Name: name + "-manifest"},
			},
			DataKeySecretRef:        v1alpha1.SecretKeyRef{Name: "regulait", Key: "data-key"},
			DatabaseURLSecretRef:    v1alpha1.SecretKeyRef{Name: "regulait", Key: "database-url"},
			BootstrapTokenSecretRef: v1alpha1.SecretKeyRef{Name: "regulait", Key: "bootstrap-token"},
			Egress:                  v1alpha1.EgressSpec{DatabaseCIDRs: []string{"10.20.0.0/16"}},
		},
	}
}

func getInst(t *testing.T, name string) *v1alpha1.RegulaitInstallation {
	t.Helper()
	in := &v1alpha1.RegulaitInstallation{}
	if err := k8s.Get(context.Background(), client.ObjectKey{Namespace: testNS, Name: name}, in); err != nil {
		t.Fatal(err)
	}
	return in
}

// updateInst applies mut to the latest copy, retrying on a conflict with the operator's status writes.
func updateInst(t *testing.T, name string, mut func(*v1alpha1.RegulaitInstallation)) {
	t.Helper()
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		in := getInst(t, name)
		mut(in)
		return k8s.Update(context.Background(), in)
	}); err != nil {
		t.Fatal(err)
	}
}

func cond(in *v1alpha1.RegulaitInstallation, typ string) *metav1.Condition {
	return meta.FindStatusCondition(in.Status.Conditions, typ)
}

func completeJob(t *testing.T, name string, failed bool) {
	t.Helper()
	ctx := context.Background()
	j := &batchv1.Job{}
	if err := k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: name}, j); err != nil {
		t.Fatal(err)
	}
	now := metav1.Now()
	j.Status.StartTime = &now
	if failed {
		j.Status.Failed = 3
		j.Status.Conditions = []batchv1.JobCondition{
			{Type: batchv1.JobFailureTarget, Status: corev1.ConditionTrue, LastTransitionTime: now, Reason: "BackoffLimitExceeded"},
			{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, LastTransitionTime: now, Reason: "BackoffLimitExceeded"},
		}
	} else {
		j.Status.Succeeded = 1
		j.Status.CompletionTime = &now
		j.Status.Conditions = []batchv1.JobCondition{
			{Type: batchv1.JobSuccessCriteriaMet, Status: corev1.ConditionTrue, LastTransitionTime: now},
			{Type: batchv1.JobComplete, Status: corev1.ConditionTrue, LastTransitionTime: now},
		}
	}
	if err := k8s.Status().Update(ctx, j); err != nil {
		t.Fatal(err)
	}
}

func markAvailable(t *testing.T, name string) {
	t.Helper()
	ctx := context.Background()
	d := &appsv1.Deployment{}
	if err := k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: name + "-gateway"}, d); err != nil {
		t.Fatal(err)
	}
	d.Status.ObservedGeneration = d.Generation
	d.Status.Replicas, d.Status.UpdatedReplicas, d.Status.ReadyReplicas, d.Status.AvailableReplicas = 1, 1, 1, 1
	if err := k8s.Status().Update(ctx, d); err != nil {
		t.Fatal(err)
	}
}

func gatewayImage(t *testing.T, name string) string {
	t.Helper()
	d := &appsv1.Deployment{}
	if err := k8s.Get(context.Background(), client.ObjectKey{Namespace: testNS, Name: name + "-gateway"}, d); err != nil {
		if apierrors.IsNotFound(err) {
			return ""
		}
		t.Fatal(err)
	}
	return d.Spec.Template.Spec.Containers[0].Image
}

func TestSchemaRefusesInsecureSpecs(t *testing.T) {
	needEnv(t)
	ctx := context.Background()
	cases := map[string]func(*v1alpha1.RegulaitInstallation){
		"hosted mode":                 func(in *v1alpha1.RegulaitInstallation) { in.Spec.Mode = "hosted" },
		"image by tag":                func(in *v1alpha1.RegulaitInstallation) { in.Spec.Image.Digest = "latest" },
		"two replicas":                func(in *v1alpha1.RegulaitInstallation) { in.Spec.Replicas = ptr.To(int32(2)) },
		"short version":               func(in *v1alpha1.RegulaitInstallation) { in.Spec.Version = "1.2" },
		"air_gapped without registry": func(in *v1alpha1.RegulaitInstallation) { in.Spec.Mode = v1alpha1.ModeAirGapped },
		"air_gapped with public egress": func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Mode = v1alpha1.ModeAirGapped
			in.Spec.Image.AllowedRegistries = []string{"registry.example.internal"}
			in.Spec.Egress.AllowPublicEgress = true
		},
	}
	i := 0
	for name, mut := range cases {
		i++
		in := newInstallation(fmt.Sprintf("schema-%d", i), "1.0.0", 'a')
		mut(in)
		if err := k8s.Create(ctx, in); err == nil || !apierrors.IsInvalid(err) {
			t.Errorf("%s: want Invalid, got %v", name, err)
		}
	}
}

func TestInstallUpgradeDriftAndRefusals(t *testing.T) {
	needEnv(t)
	ctx := context.Background()
	name := "acme"
	putBundle(t, name, "1.0.0", false)
	in := newInstallation(name, "1.0.0", 'a')
	if err := k8s.Create(ctx, in); err != nil {
		t.Fatal(err)
	}
	firstJob := migrateJobName(in)

	// First install: the migration Job runs before any Deployment exists.
	eventually(t, "the migration job", func() bool {
		return k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: firstJob}, &batchv1.Job{}) == nil
	})
	if img := gatewayImage(t, name); img != "" {
		t.Fatalf("a Deployment exists before the migration finished: %s", img)
	}

	// Default-deny NetworkPolicy, the unowned install-secrets claim, a token-less ServiceAccount.
	for _, suffix := range []string{"-baseline", "-gateway", "-database-clients"} {
		np := &networkingv1.NetworkPolicy{}
		if err := k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: name + suffix}, np); err != nil {
			t.Fatalf("network policy %s: %v", suffix, err)
		}
		if len(np.Spec.PolicyTypes) != 2 || len(np.Spec.Ingress) != 0 {
			t.Fatalf("network policy %s is not default-deny for ingress: %+v", suffix, np.Spec)
		}
	}
	pvc := &corev1.PersistentVolumeClaim{}
	if err := k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: name + "-install-secrets"}, pvc); err != nil {
		t.Fatal(err)
	}
	if len(pvc.OwnerReferences) != 0 {
		t.Fatal("the install-secrets claim must not be owned: deleting the CR would delete the signing keys")
	}
	sa := &corev1.ServiceAccount{}
	if err := k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: name + "-gateway"}, sa); err != nil || sa.AutomountServiceAccountToken == nil || *sa.AutomountServiceAccountToken {
		t.Fatalf("service account must not automount a token: %v", err)
	}

	completeJob(t, firstJob, false)
	want := "registry.example.internal/regulait/gateway@" + digest('a')
	eventually(t, "the deployment at the migrated image", func() bool { return gatewayImage(t, name) == want })
	markAvailable(t, name)
	eventually(t, "installedVersion", func() bool { return getInst(t, name).Status.InstalledVersion == "1.0.0" })

	// No backup destination: not Ready. Turning backup off makes it Ready and is reported.
	got := getInst(t, name)
	if c := cond(got, v1alpha1.ConditionBackupConfigured); c == nil || c.Reason != "NoDestination" {
		t.Fatalf("backup condition: %+v", c)
	}
	if c := cond(got, v1alpha1.ConditionReady); c == nil || c.Status != metav1.ConditionFalse {
		t.Fatalf("ready without a backup destination: %+v", c)
	}
	updateInst(t, name, func(in *v1alpha1.RegulaitInstallation) { in.Spec.Backup.Disabled = true })
	eventually(t, "Ready", func() bool {
		c := cond(getInst(t, name), v1alpha1.ConditionReady)
		return c != nil && c.Status == metav1.ConditionTrue
	})
	if c := cond(getInst(t, name), v1alpha1.ConditionBackupConfigured); c.Reason != "BackupDisabled" {
		t.Fatalf("disabled backup is not reported: %+v", c)
	}
	// The sample names no StorageClass: reported on every reconcile, but not a reason to hold Ready.
	if c := cond(getInst(t, name), v1alpha1.ConditionStorageClassNamed); c == nil || c.Status != metav1.ConditionFalse || c.Reason != "DefaultStorageClass" {
		t.Fatalf("default StorageClass is not reported: %+v", c)
	}
	updateInst(t, name, func(in *v1alpha1.RegulaitInstallation) { in.Spec.InstallSecretsStorageClassName = "encrypted-gp3" })
	// The claim already exists on the default class and a claim's class is immutable: the mismatch is reported.
	eventually(t, "ClaimClassDiffers", func() bool {
		c := cond(getInst(t, name), v1alpha1.ConditionStorageClassNamed)
		return c != nil && c.Status == metav1.ConditionFalse && c.Reason == "ClaimClassDiffers"
	})

	// Drift: someone swaps the image and adds a privileged flag; the operator puts both back and counts it.
	d := &appsv1.Deployment{}
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		if err := k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: name + "-gateway"}, d); err != nil {
			return err
		}
		d.Spec.Template.Spec.Containers[0].Image = "docker.io/evil/gateway:latest"
		d.Spec.Template.Spec.Containers[0].SecurityContext.ReadOnlyRootFilesystem = ptr.To(false)
		return k8s.Update(ctx, d)
	}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "drift corrected", func() bool {
		return gatewayImage(t, name) == want && getInst(t, name).Status.DriftCorrections > 0
	})
	if err := k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: name + "-gateway"}, d); err != nil {
		t.Fatal(err)
	}
	if !*d.Spec.Template.Spec.Containers[0].SecurityContext.ReadOnlyRootFilesystem {
		t.Fatal("readOnlyRootFilesystem was not put back")
	}

	// Upgrade with a tampered manifest: refused, nothing moves.
	putBundle(t, name, "1.1.0", true)
	updateInst(t, name, func(in *v1alpha1.RegulaitInstallation) {
		in.Spec.Version = "1.1.0"
		in.Spec.Image.Digest = digest('b')
	})
	eventually(t, "BundleVerified=False", func() bool {
		c := cond(getInst(t, name), v1alpha1.ConditionBundleVerified)
		return c != nil && c.Status == metav1.ConditionFalse && c.Reason == "SignatureInvalid"
	})
	upgraded := getInst(t, name)
	if err := k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: migrateJobName(upgraded)}, &batchv1.Job{}); !apierrors.IsNotFound(err) {
		t.Fatalf("a migration ran for an unverified version: %v", err)
	}

	// The genuine manifest: the Job runs, the old image keeps serving until it succeeds.
	putBundle(t, name, "1.1.0", false)
	upJob := migrateJobName(upgraded)
	eventually(t, "the upgrade migration job", func() bool {
		return k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: upJob}, &batchv1.Job{}) == nil
	})
	if gatewayImage(t, name) != want {
		t.Fatal("the image moved before the migration finished")
	}
	completeJob(t, upJob, false)
	want2 := "registry.example.internal/regulait/gateway@" + digest('b')
	eventually(t, "the upgraded image", func() bool { return gatewayImage(t, name) == want2 })
	markAvailable(t, name)
	eventually(t, "installedVersion 1.1.0", func() bool { return getInst(t, name).Status.InstalledVersion == "1.1.0" })

	// A correctly signed downgrade is refused.
	putBundle(t, name, "1.0.0", false)
	updateInst(t, name, func(in *v1alpha1.RegulaitInstallation) {
		in.Spec.Version = "1.0.0"
		in.Spec.Image.Digest = digest('a')
	})
	eventually(t, "downgrade refused", func() bool {
		c := cond(getInst(t, name), v1alpha1.ConditionBundleVerified)
		return c != nil && c.Reason == "Downgrade"
	})
	if gatewayImage(t, name) != want2 {
		t.Fatal("a downgrade changed the running image")
	}
}

func TestFailedMigrationKeepsTheInstalledVersion(t *testing.T) {
	needEnv(t)
	ctx := context.Background()
	name := "failmig"
	putBundle(t, name, "2.0.0", false)
	in := newInstallation(name, "2.0.0", 'c')
	if err := k8s.Create(ctx, in); err != nil {
		t.Fatal(err)
	}
	job := migrateJobName(in)
	eventually(t, "job", func() bool {
		return k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: job}, &batchv1.Job{}) == nil
	})
	completeJob(t, job, true)
	eventually(t, "MigrationFailed", func() bool {
		c := cond(getInst(t, name), v1alpha1.ConditionMigrated)
		return c != nil && c.Reason == "MigrationFailed"
	})
	if gatewayImage(t, name) != "" {
		t.Fatal("a Deployment was created although the first migration failed")
	}
}

func TestBackupCronJobAndAirGappedValidation(t *testing.T) {
	needEnv(t)
	ctx := context.Background()
	name := "airgap"
	putBundle(t, name, "1.0.0", false)
	in := newInstallation(name, "1.0.0", 'd')
	in.Spec.Mode = v1alpha1.ModeAirGapped
	in.Spec.Image.AllowedRegistries = []string{"registry.example.internal"}
	in.Spec.Egress.AllowedCIDRs = []string{"8.8.8.0/24"}
	if err := k8s.Create(ctx, in); err != nil {
		t.Fatal(err)
	}
	eventually(t, "SpecValid=False", func() bool {
		c := cond(getInst(t, name), v1alpha1.ConditionSpecValid)
		return c != nil && c.Reason == "PublicEgressRefused"
	})
	if err := k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: migrateJobName(in)}, &batchv1.Job{}); !apierrors.IsNotFound(err) {
		t.Fatal("an invalid spec started a migration")
	}

	updateInst(t, name, func(in *v1alpha1.RegulaitInstallation) {
		in.Spec.Egress.AllowedCIDRs = []string{"10.30.0.0/16"}
		in.Spec.Backup.DestinationClaimName = "regulait-backups"
		in.Spec.Backup.Image = &v1alpha1.ImageSpec{Repository: "registry.example.internal/postgres", Digest: digest('e')}
	})
	eventually(t, "backup cronjob", func() bool {
		return k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: name + "-backup"}, &batchv1.CronJob{}) == nil
	})
	cj := &batchv1.CronJob{}
	_ = k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: name + "-backup"}, cj)
	if cj.Spec.Schedule != "17 2 * * *" || cj.Spec.ConcurrencyPolicy != batchv1.ForbidConcurrent {
		t.Fatalf("backup cronjob: %+v", cj.Spec)
	}
}

// TestKeyringConfigMapIsNotTheTrustAnchor: a key placed in a namespace ConfigMap is not trusted unless the spec opts in
// to an extra keyring; the opt-in is reported; and it can never replace a compiled-in key id.
func TestKeyringConfigMapIsNotTheTrustAnchor(t *testing.T) {
	needEnv(t)
	ctx := context.Background()
	name := "rogue"
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	roguePEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	sign := func(keyID string) {
		m := strings.Replace(bundleManifest("3.0.0"), "rel-test", keyID, 1)
		sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(m)))
		cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: name + "-manifest", Namespace: testNS}}
		_ = k8s.Delete(ctx, cm)
		eventually(t, "manifest cm gone", func() bool {
			return apierrors.IsNotFound(k8s.Get(ctx, client.ObjectKeyFromObject(cm), &corev1.ConfigMap{}))
		})
		cm.Data = map[string]string{"manifest.json": m, "manifest.json.sig": sig}
		if err := k8s.Create(ctx, cm); err != nil {
			t.Fatal(err)
		}
	}
	keyring := func(data map[string]string) {
		cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: name + "-extra", Namespace: testNS}}
		_ = k8s.Delete(ctx, cm)
		eventually(t, "keyring cm gone", func() bool {
			return apierrors.IsNotFound(k8s.Get(ctx, client.ObjectKeyFromObject(cm), &corev1.ConfigMap{}))
		})
		cm.Data = data
		if err := k8s.Create(ctx, cm); err != nil {
			t.Fatal(err)
		}
	}

	// A rogue key in a ConfigMap the spec does not name: refused.
	keyring(map[string]string{"rogue.pub": roguePEM})
	sign("rogue")
	in := newInstallation(name, "3.0.0", '9')
	if err := k8s.Create(ctx, in); err != nil {
		t.Fatal(err)
	}
	eventually(t, "UnknownSigningKey", func() bool {
		c := cond(getInst(t, name), v1alpha1.ConditionBundleVerified)
		return c != nil && c.Reason == "UnknownSigningKey"
	})

	// A ConfigMap entry that reuses the pinned id with another key: refused, even with the opt-in.
	keyring(map[string]string{"rel-test.pub": roguePEM})
	sign("rel-test")
	updateInst(t, name, func(in *v1alpha1.RegulaitInstallation) {
		in.Spec.UpdateBundle.ExtraKeyringConfigMapRef = &v1alpha1.LocalObjectRef{Name: name + "-extra"}
	})
	eventually(t, "KeyIDShadowsPinned", func() bool {
		c := cond(getInst(t, name), v1alpha1.ConditionBundleVerified)
		return c != nil && c.Reason == "KeyIDShadowsPinned"
	})
	if err := k8s.Get(ctx, client.ObjectKey{Namespace: testNS, Name: migrateJobName(in)}, &batchv1.Job{}); !apierrors.IsNotFound(err) {
		t.Fatal("a manifest signed by a shadowing key started a migration")
	}

	// The explicit opt-in with a new key id verifies, and says so.
	keyring(map[string]string{"customer.pub": roguePEM})
	sign("customer")
	eventually(t, "ExtraKeyringInUse", func() bool {
		c := cond(getInst(t, name), v1alpha1.ConditionBundleVerified)
		return c != nil && c.Status == metav1.ConditionTrue && c.Reason == "ExtraKeyringInUse"
	})
}
