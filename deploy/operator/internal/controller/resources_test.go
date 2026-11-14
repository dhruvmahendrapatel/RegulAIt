package controller

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"

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

func TestNetworkPolicyPublicEgress(t *testing.T) {
	in := sample()
	dns := NetworkPolicy(in).Spec.Egress[0].To[0]
	if dns.PodSelector == nil || dns.PodSelector.MatchLabels["k8s-app"] != "kube-dns" || dns.NamespaceSelector == nil {
		t.Fatalf("DNS egress must target the cluster DNS pods only: %+v", dns)
	}
	if n := len(NetworkPolicy(in).Spec.Egress); n != 2 { // DNS + database
		t.Fatalf("byoc without allowPublicEgress: %d egress rules", n)
	}
	in.Spec.Egress.AllowPublicEgress = true
	rules := NetworkPolicy(in).Spec.Egress
	last := rules[len(rules)-1]
	if last.To[0].IPBlock.CIDR != "0.0.0.0/0" || !strings.Contains(strings.Join(last.To[0].IPBlock.Except, ","), "169.254.0.0/16") || last.Ports[0].Port.IntValue() != 443 {
		t.Fatalf("public egress rule: %+v", last)
	}
	in.Spec.Mode = v1alpha1.ModeAirGapped
	if n := len(NetworkPolicy(in).Spec.Egress); n != 2 {
		t.Fatalf("air_gapped opened public egress: %d rules", n)
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
