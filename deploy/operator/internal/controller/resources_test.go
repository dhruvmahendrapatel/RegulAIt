package controller

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	v1alpha1 "github.com/dhruvmahendrapatel/regulait/deploy/operator/api/v1alpha1"
)

func sample() *v1alpha1.RegulaitInstallation {
	in := newInstallation("unit", "1.0.0", 'a')
	in.Spec.Backup.DestinationClaimName = "b"
	in.Spec.Backup.Image = &v1alpha1.ImageSpec{Repository: "registry.example.internal/postgres", Digest: digest('f')}
	return in
}

// Every pod the operator creates carries the ADR-0304 §3 security context, mounts no token and holds no secret
// value in its spec.
func TestEveryPodIsRestricted(t *testing.T) {
	in := sample()
	pods := map[string]corev1.PodSpec{
		"gateway": Deployment(in, imageRef(in.Spec.Image)).Spec.Template.Spec,
		"migrate": MigrateJob(in).Spec.Template.Spec,
		"backup":  BackupCronJob(in).Spec.JobTemplate.Spec.Template.Spec,
	}
	for name, p := range pods {
		if p.SecurityContext == nil || p.SecurityContext.RunAsNonRoot == nil || !*p.SecurityContext.RunAsNonRoot {
			t.Errorf("%s: pod is not runAsNonRoot", name)
		}
		if p.AutomountServiceAccountToken == nil || *p.AutomountServiceAccountToken {
			t.Errorf("%s: service account token is mounted", name)
		}
		for _, c := range p.Containers {
			sc := c.SecurityContext
			if sc == nil || !*sc.ReadOnlyRootFilesystem || *sc.AllowPrivilegeEscalation || *sc.Privileged || len(sc.Capabilities.Drop) != 1 || sc.Capabilities.Drop[0] != "ALL" || sc.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
				t.Errorf("%s/%s: container security context is not restricted: %+v", name, c.Name, sc)
			}
			if !strings.Contains(c.Image, "@sha256:") {
				t.Errorf("%s/%s: image %q is not pinned by digest", name, c.Name, c.Image)
			}
			if c.Resources.Limits.Memory().IsZero() {
				t.Errorf("%s/%s: no memory limit", name, c.Name)
			}
			for _, e := range c.Env {
				if strings.Contains(e.Name, "KEY") || strings.Contains(e.Name, "TOKEN") || e.Name == "DATABASE_URL" {
					if e.ValueFrom == nil || e.ValueFrom.SecretKeyRef == nil || e.Value != "" {
						t.Errorf("%s/%s: %s is not read from a Secret", name, c.Name, e.Name)
					}
				}
			}
		}
	}
}

func TestNetworkPoliciesPerWorkload(t *testing.T) {
	in := sample()
	nps := NetworkPolicies(in)
	if len(nps) != 3 {
		t.Fatalf("want baseline, gateway and database-clients policies, got %d", len(nps))
	}
	base, gw, db := nps[0], nps[1], nps[2]
	if len(base.Spec.PodSelector.MatchLabels) != 0 || len(base.Spec.PodSelector.MatchExpressions) != 0 || len(base.Spec.Ingress) != 0 || len(base.Spec.Egress) != 0 || len(base.Spec.PolicyTypes) != 2 {
		t.Fatalf("baseline must select every pod and allow nothing: %+v", base.Spec)
	}
	dns := gw.Spec.Egress[0].To[0]
	if dns.PodSelector == nil || dns.PodSelector.MatchLabels["k8s-app"] != "kube-dns" || dns.NamespaceSelector == nil {
		t.Fatalf("DNS egress must target the cluster DNS pods only: %+v", dns)
	}
	if n := len(gw.Spec.Egress); n != 2 { // DNS + database
		t.Fatalf("byoc without allowPublicEgress: %d gateway egress rules", n)
	}

	// The database clients (migration Job, backup) never get allowedCIDRs or public egress, and accept no ingress.
	in.Spec.Egress.AllowPublicEgress = true
	in.Spec.Egress.AllowedCIDRs = []string{"10.40.0.0/16"}
	in.Spec.IngressFrom = []v1alpha1.IngressPeer{{NamespaceSelector: &metav1.LabelSelector{}}}
	db = DatabaseClientsPolicy(in)
	if len(db.Spec.Egress) != 2 || len(db.Spec.Ingress) != 0 || db.Spec.Egress[1].Ports[0].Port.IntValue() != 5432 {
		t.Fatalf("database clients policy opened more than DNS and the database: %+v", db.Spec)
	}
	if got := db.Spec.PodSelector.MatchExpressions[0].Values; len(got) != 2 || got[0] != "migrate" || got[1] != "backup" {
		t.Fatalf("database clients selector: %+v", db.Spec.PodSelector)
	}
	if MigrateJob(in).Spec.Template.Labels["app.kubernetes.io/component"] != "migrate" || BackupCronJob(in).Spec.JobTemplate.Spec.Template.Labels["app.kubernetes.io/component"] != "backup" {
		t.Fatal("the Job and backup pods must carry the labels the database-clients policy selects")
	}

	rules := GatewayPolicy(in).Spec.Egress
	last := rules[len(rules)-1]
	if last.To[0].IPBlock.CIDR != "0.0.0.0/0" || !strings.Contains(strings.Join(last.To[0].IPBlock.Except, ","), "169.254.0.0/16") || last.Ports[0].Port.IntValue() != 443 {
		t.Fatalf("public egress rule: %+v", last)
	}
	in.Spec.Mode = v1alpha1.ModeAirGapped
	for _, r := range GatewayPolicy(in).Spec.Egress {
		for _, p := range r.To {
			if p.IPBlock != nil && p.IPBlock.CIDR == "0.0.0.0/0" {
				t.Fatal("air_gapped opened public egress")
			}
		}
	}

	// DNS override (NodeLocal DNSCache).
	in.Spec.Egress.DNS = &v1alpha1.DNSEgress{CIDRs: []string{"169.254.20.10/32"}}
	d := GatewayPolicy(in).Spec.Egress[0]
	if len(d.To) != 1 || d.To[0].IPBlock == nil || d.To[0].IPBlock.CIDR != "169.254.20.10/32" || d.Ports[0].Port.IntValue() != 53 {
		t.Fatalf("DNS override: %+v", d)
	}
}

func TestInstallSecretsStorageClass(t *testing.T) {
	in := sample()
	if InstallSecretsClaim(in).Spec.StorageClassName != nil {
		t.Fatal("empty storage class must use the cluster default")
	}
	in.Spec.InstallSecretsStorageClassName = "encrypted-gp3"
	if sc := InstallSecretsClaim(in).Spec.StorageClassName; sc == nil || *sc != "encrypted-gp3" {
		t.Fatalf("storage class: %v", sc)
	}
}

func TestValidate(t *testing.T) {
	cases := []struct {
		name   string
		mut    func(*v1alpha1.RegulaitInstallation)
		reason string
	}{
		{"byoc default", func(*v1alpha1.RegulaitInstallation) {}, ""},
		{"registry not allowed", func(in *v1alpha1.RegulaitInstallation) { in.Spec.Image.AllowedRegistries = []string{"other.example"} }, "RegistryNotAllowed"},
		{"docker hub in air_gapped", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Mode = v1alpha1.ModeAirGapped
			in.Spec.Image.Repository = "library/gateway"
			in.Spec.Image.AllowedRegistries = []string{"registry.example.internal"}
		}, "RegistryNotAllowed"},
		{"public cidr in air_gapped", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Mode = v1alpha1.ModeAirGapped
			in.Spec.Image.AllowedRegistries = []string{"registry.example.internal"}
			in.Spec.Egress.AllowedCIDRs = []string{"0.0.0.0/0"}
		}, "PublicEgressRefused"},
		{"private supernet trick in air_gapped", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Mode = v1alpha1.ModeAirGapped
			in.Spec.Image.AllowedRegistries = []string{"registry.example.internal"}
			in.Spec.Egress.DatabaseCIDRs = []string{"8.0.0.0/5"}
		}, "PublicEgressRefused"},
		{"public dns cidr in air_gapped", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Mode = v1alpha1.ModeAirGapped
			in.Spec.Image.AllowedRegistries = []string{"registry.example.internal"}
			in.Spec.Egress.DNS = &v1alpha1.DNSEgress{CIDRs: []string{"8.8.8.8/32"}}
		}, "PublicEgressRefused"},
		{"non-canonical cidr", func(in *v1alpha1.RegulaitInstallation) { in.Spec.Egress.AllowedCIDRs = []string{"10.1.2.3/8"} }, "InvalidCIDR"},
		{"backup without image", func(in *v1alpha1.RegulaitInstallation) { in.Spec.Backup.Image = nil }, "BackupImageMissing"},
		{"backup image outside allowed registries", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Image.AllowedRegistries = []string{"registry.example.internal"}
			in.Spec.Backup.Image.Repository = "docker.io/library/postgres"
		}, "RegistryNotAllowed"},
	}
	for _, c := range cases {
		in := sample()
		c.mut(in)
		reason, _, ok := Validate(in)
		if ok != (c.reason == "") || reason != c.reason {
			t.Errorf("%s: got %q ok=%v, want %q", c.name, reason, ok, c.reason)
		}
	}
}

func TestMigrateJobNameFitsAndChangesWithDigest(t *testing.T) {
	in := sample()
	in.Name = strings.Repeat("x", 60)
	a := migrateJobName(in)
	in.Spec.Image.Digest = digest('b')
	b := migrateJobName(in)
	if len(a) > 63 || len(b) > 63 || a == b {
		t.Fatalf("job names %q %q", a, b)
	}
}
