package controller

import (
	"strings"
	"testing"
	"unicode/utf8"

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
		"gateway":   Deployment(in, imageRef(in.Spec.Image)).Spec.Template.Spec,
		"migrate":   MigrateJob(in).Spec.Template.Spec,
		"backup":    BackupCronJob(in).Spec.JobTemplate.Spec.Template.Spec,
		"backup-s3": BackupCronJob(withS3(sample())).Spec.JobTemplate.Spec.Template.Spec,
	}
	for name, p := range pods {
		if p.SecurityContext == nil || p.SecurityContext.RunAsNonRoot == nil || !*p.SecurityContext.RunAsNonRoot {
			t.Errorf("%s: pod is not runAsNonRoot", name)
		}
		if p.AutomountServiceAccountToken == nil || *p.AutomountServiceAccountToken {
			t.Errorf("%s: service account token is mounted", name)
		}
		for _, c := range append(append([]corev1.Container{}, p.InitContainers...), p.Containers...) {
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
	if len(nps) != 4 {
		t.Fatalf("want baseline, gateway, database-clients and backup-object-store policies, got %d", len(nps))
	}
	if obj := nps[3]; len(obj.Spec.Egress) != 0 || len(obj.Spec.Ingress) != 0 {
		t.Fatalf("without backup.s3 the backup-object-store policy must open nothing: %+v", obj.Spec)
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
			in.Spec.Egress.AllowedCIDRs = []string{"203.0.113.0/24"}
		}, "PublicEgressRefused"},
		// ADR-0180 (#813 review): no list reaches the cloud metadata endpoints or a link-local range, in any mode.
		{"metadata host in air_gapped", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Mode = v1alpha1.ModeAirGapped
			in.Spec.Image.AllowedRegistries = []string{"registry.example.internal"}
			in.Spec.Egress.AllowedCIDRs = []string{"169.254.169.254/32"}
		}, "MetadataEgressRefused"},
		{"everything in byoc", func(in *v1alpha1.RegulaitInstallation) { in.Spec.Egress.AllowedCIDRs = []string{"0.0.0.0/0"} }, "MetadataEgressRefused"},
		{"all of IPv6 in byoc", func(in *v1alpha1.RegulaitInstallation) { in.Spec.Egress.AllowedCIDRs = []string{"::/0"} }, "MetadataEgressRefused"},
		{"link-local range in byoc", func(in *v1alpha1.RegulaitInstallation) { in.Spec.Egress.AllowedCIDRs = []string{"169.254.0.0/16"} }, "MetadataEgressRefused"},
		{"IPv6 link-local in byoc", func(in *v1alpha1.RegulaitInstallation) { in.Spec.Egress.DatabaseCIDRs = []string{"fe80::/10"} }, "MetadataEgressRefused"},
		{"AWS IPv6 metadata inside fc00::/7", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Egress.AllowedCIDRs = []string{"fd00:ec2::/64"}
		}, "MetadataEgressRefused"},
		{"dns to everything", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Egress.DNS = &v1alpha1.DNSEgress{CIDRs: []string{"0.0.0.0/0"}}
		}, "MetadataEgressRefused"},
		{"dns to a public resolver in byoc", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Egress.DNS = &v1alpha1.DNSEgress{CIDRs: []string{"8.8.8.8/32"}}
		}, "PublicEgressRefused"},
		{"dns to the link-local range", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Egress.DNS = &v1alpha1.DNSEgress{CIDRs: []string{"169.254.0.0/16"}}
		}, "MetadataEgressRefused"},
		{"dns to the metadata host", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Egress.DNS = &v1alpha1.DNSEgress{CIDRs: []string{"169.254.169.254/32"}}
		}, "MetadataEgressRefused"},
		{"dns to NodeLocal DNSCache", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Egress.DNS = &v1alpha1.DNSEgress{CIDRs: []string{"169.254.20.10/32"}}
		}, ""},
		{"public cidr in byoc is valid (and reported)", func(in *v1alpha1.RegulaitInstallation) { in.Spec.Egress.AllowedCIDRs = []string{"203.0.113.0/24"} }, ""},
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
		{"s3 backup", func(in *v1alpha1.RegulaitInstallation) { withS3(in) }, ""},
		{"s3 and claim together", func(in *v1alpha1.RegulaitInstallation) { withS3(in).Spec.Backup.DestinationClaimName = "b" }, "BackupDestinationConflict"},
		{"s3 without pg_dump image", func(in *v1alpha1.RegulaitInstallation) { withS3(in).Spec.Backup.Image = nil }, "BackupImageMissing"},
		{"s3 without egress", func(in *v1alpha1.RegulaitInstallation) { withS3(in).Spec.Backup.S3.EgressCIDRs = nil }, "BackupEgressMissing"},
		{"s3 egress to metadata", func(in *v1alpha1.RegulaitInstallation) {
			withS3(in).Spec.Backup.S3.EgressCIDRs = []string{"169.254.170.23/32"}
		}, "MetadataEgressRefused"},
		{"s3 public egress in air_gapped", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Mode = v1alpha1.ModeAirGapped
			in.Spec.Image.AllowedRegistries = []string{"registry.example.internal"}
			withS3(in).Spec.Backup.S3.EgressCIDRs = []string{"52.92.0.0/17"}
		}, "PublicEgressRefused"},
		{"uploader image outside allowed registries", func(in *v1alpha1.RegulaitInstallation) {
			in.Spec.Image.AllowedRegistries = []string{"registry.example.internal"}
			withS3(in).Spec.Backup.S3.UploaderImage.Repository = "public.ecr.aws/aws-cli/aws-cli"
		}, "RegistryNotAllowed"},
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

func TestPublicEgressIsReported(t *testing.T) {
	in := sample()
	in.Spec.Egress.AllowPublicEgress = false
	in.Spec.Egress.AllowedCIDRs = []string{"10.40.0.0/16"}
	in.Spec.Egress.DatabaseCIDRs = []string{"10.0.5.0/24"}
	if got := PublicEgress(in); len(got) != 0 {
		t.Fatalf("private-only spec reported as public: %v", got)
	}
	in.Spec.Egress.AllowPublicEgress = true
	in.Spec.Egress.AllowedCIDRs = []string{"10.40.0.0/16", "203.0.113.0/24"}
	got := strings.Join(PublicEgress(in), "; ")
	if !strings.Contains(got, "allowPublicEgress") || !strings.Contains(got, "egress.allowedCIDRs 203.0.113.0/24") || strings.Contains(got, "10.40.0.0/16") {
		t.Fatalf("public egress report: %q", got)
	}
}

func TestConditionMessagesAreBounded(t *testing.T) {
	long := strings.Repeat("é", 4000)
	if got := truncateMessage(long); len(got) > maxMessage+len("…") || !utf8.ValidString(got) {
		t.Fatalf("truncated message is %d bytes or not valid UTF-8", len(got))
	}
	if truncateMessage("short") != "short" {
		t.Fatal("a short message must be unchanged")
	}
}

// withS3 turns the sample's claim destination into an S3 destination in a VPC endpoint range.
func withS3(in *v1alpha1.RegulaitInstallation) *v1alpha1.RegulaitInstallation {
	in.Spec.Backup.DestinationClaimName = ""
	in.Spec.Backup.S3 = &v1alpha1.S3BackupDestination{
		Bucket:              "customer-regulait-backups",
		Region:              "eu-west-1",
		Prefix:              "regulait/",
		KMSKeyARN:           "arn:aws:kms:eu-west-1:111122223333:key/00000000-0000-0000-0000-000000000000",
		ExpectedBucketOwner: "111122223333",
		UploaderImage:       v1alpha1.ImageSpec{Repository: "registry.example.internal/aws-cli", Digest: digest('c')},
		EgressCIDRs:         []string{"10.20.30.0/24"},
	}
	return in
}

// The S3 path: pg_dump (with the database URL) runs as an init container into a pod-local volume; the uploader has no
// database URL, encrypts with the customer's key and pins the bucket owner; the pod runs as its own ServiceAccount.
func TestBackupToS3(t *testing.T) {
	in := withS3(sample())
	in.Spec.Backup.S3.RoleARN = "arn:aws:iam::111122223333:role/regulait-backup"
	p := BackupCronJob(in).Spec.JobTemplate.Spec.Template.Spec
	if p.ServiceAccountName != "unit-backup" || len(p.InitContainers) != 1 || len(p.Containers) != 1 {
		t.Fatalf("pod shape: sa=%q init=%d containers=%d", p.ServiceAccountName, len(p.InitContainers), len(p.Containers))
	}
	up := p.Containers[0]
	cmd := strings.Join(up.Command, " ")
	for _, want := range []string{"--sse aws:kms", "--sse-kms-key-id \"$SSE_KMS_ARN\"", "--expected-bucket-owner \"$EXPECTED_BUCKET_OWNER\""} {
		if !strings.Contains(cmd, want) {
			t.Errorf("uploader command lacks %s: %s", want, cmd)
		}
	}
	env := map[string]string{}
	for _, e := range up.Env {
		if e.ValueFrom != nil {
			t.Errorf("uploader reads %s from a Secret; it must hold no secret", e.Name)
		}
		env[e.Name] = e.Value
	}
	if env["SSE_KMS_ARN"] != in.Spec.Backup.S3.KMSKeyARN || env["EXPECTED_BUCKET_OWNER"] != "111122223333" || env["HOME"] != "/tmp" || env["AWS_EC2_METADATA_DISABLED"] != "true" {
		t.Errorf("uploader env: %v", env)
	}
	for _, v := range p.Volumes {
		if v.Name == "backup" && (v.EmptyDir == nil || v.PersistentVolumeClaim != nil || v.EmptyDir.SizeLimit == nil || v.EmptyDir.SizeLimit.String() != "20Gi") {
			t.Errorf("the S3 path stages the dump in a size-limited emptyDir: %+v", v)
		}
	}
	if sa := BackupServiceAccount(in); sa.Annotations[IRSARoleAnnotation] != in.Spec.Backup.S3.RoleARN || *sa.AutomountServiceAccountToken {
		t.Errorf("backup ServiceAccount: %+v", sa)
	}
	if sa := BackupServiceAccount(sample()); len(sa.Annotations) != 0 {
		t.Errorf("no S3, no role annotation: %v", sa.Annotations)
	}

	np := BackupObjectStorePolicy(in)
	if np.Spec.PodSelector.MatchLabels["app.kubernetes.io/component"] != "backup" || len(np.Spec.Egress) != 1 || np.Spec.Egress[0].To[0].IPBlock.CIDR != "10.20.30.0/24" || np.Spec.Egress[0].Ports[0].Port.IntValue() != 443 {
		t.Fatalf("object-store policy: %+v", np.Spec)
	}
	if got := PublicEgress(in); len(got) != 0 {
		t.Fatalf("a private VPC endpoint is not public egress: %v", got)
	}
	in.Spec.Backup.S3.PodIdentity = true
	np = BackupObjectStorePolicy(in)
	if len(np.Spec.Egress) != 2 || np.Spec.Egress[1].To[0].IPBlock.CIDR != "169.254.170.23/32" || np.Spec.Egress[1].Ports[0].Port.IntValue() != 80 {
		t.Fatalf("pod identity rule: %+v", np.Spec.Egress)
	}
	if got := strings.Join(PublicEgress(in), "; "); !strings.Contains(got, "backup.s3.podIdentity") {
		t.Fatalf("pod identity must be reported: %q", got)
	}
	in.Spec.Backup.Disabled = true
	if np := BackupObjectStorePolicy(in); len(np.Spec.Egress) != 0 {
		t.Fatalf("disabled backup must open nothing: %+v", np.Spec.Egress)
	}
}

// The public 443 rule never reaches private, link-local or reserved IPv4 ranges (#817 review).
func TestPublicEgressExceptsReservedRanges(t *testing.T) {
	in := sample()
	in.Spec.Egress.AllowPublicEgress = true
	rules := GatewayPolicy(in).Spec.Egress
	except := strings.Join(rules[len(rules)-1].To[0].IPBlock.Except, ",")
	for _, want := range []string{"169.254.0.0/16", "0.0.0.0/8", "127.0.0.0/8", "224.0.0.0/4", "240.0.0.0/4", "10.0.0.0/8"} {
		if !strings.Contains(except, want) {
			t.Errorf("public rule does not except %s: %s", want, except)
		}
	}
}
