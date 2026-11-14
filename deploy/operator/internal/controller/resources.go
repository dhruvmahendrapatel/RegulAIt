package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/ptr"

	v1alpha1 "github.com/dhruvmahendrapatel/regulait/deploy/operator/api/v1alpha1"
)

// Fixed facts about the gateway image (Dockerfile): it runs as `node` (uid 1000) from /app on port 3000.
const (
	GatewayPort        = 3000
	GatewayUID         = int64(1000)
	InstallSecretsPath = "/app/install-secrets"
	AuditAnchorsPath   = "/app/audit-anchors"
	MigrateEntrypoint  = "apps/gateway/dist/migrate-job.js"
	// The official postgres image runs pg_dump as uid 999.
	BackupUID = int64(999)
)

// privateRanges are the address ranges a byoc install's public-egress rule excludes, and the only ranges an
// air_gapped install may open.
var privateRanges = []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "fc00::/7", "fe80::/10"}

func labels(in *v1alpha1.RegulaitInstallation, component string) map[string]string {
	l := map[string]string{
		"app.kubernetes.io/name":       "regulait",
		"app.kubernetes.io/instance":   in.Name,
		"app.kubernetes.io/managed-by": "regulait-operator",
	}
	if component != "" {
		l["app.kubernetes.io/component"] = component
	}
	return l
}

func instanceSelector(in *v1alpha1.RegulaitInstallation) map[string]string {
	return map[string]string{"app.kubernetes.io/name": "regulait", "app.kubernetes.io/instance": in.Name}
}

func imageRef(img v1alpha1.ImageSpec) string { return img.Repository + "@" + img.Digest }

func gatewayName(in *v1alpha1.RegulaitInstallation) string { return in.Name + "-gateway" }

func installSecretsClaim(in *v1alpha1.RegulaitInstallation) string {
	if in.Spec.InstallSecretsClaimName != "" {
		return in.Spec.InstallSecretsClaimName
	}
	return in.Name + "-install-secrets"
}

// migrateJobName is unique per target image, so a new digest always migrates, and a re-run of the same digest
// finds the finished Job.
func migrateJobName(in *v1alpha1.RegulaitInstallation) string {
	sum := sha256.Sum256([]byte(in.Spec.Version + "|" + imageRef(in.Spec.Image)))
	v := strings.NewReplacer(".", "-", "+", "-").Replace(strings.ToLower(in.Spec.Version))
	name := fmt.Sprintf("%s-migrate-%s-%s", in.Name, v, hex.EncodeToString(sum[:])[:8])
	if len(name) > 63 {
		name = fmt.Sprintf("%s-migrate-%s", truncate(in.Name, 40), hex.EncodeToString(sum[:])[:12])
	}
	return name
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.TrimRight(s[:n], "-.")
}

// restrictedContainer is the security context every container gets (ADR-0180, ADR-0304 §3).
func restrictedContainer() *corev1.SecurityContext {
	return &corev1.SecurityContext{
		RunAsNonRoot:             ptr.To(true),
		ReadOnlyRootFilesystem:   ptr.To(true),
		AllowPrivilegeEscalation: ptr.To(false),
		Privileged:               ptr.To(false),
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
	}
}

func restrictedPod(uid int64) *corev1.PodSecurityContext {
	return &corev1.PodSecurityContext{
		RunAsNonRoot:   ptr.To(true),
		RunAsUser:      ptr.To(uid),
		RunAsGroup:     ptr.To(uid),
		FSGroup:        ptr.To(uid),
		SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
	}
}

func secretEnv(name string, ref v1alpha1.SecretKeyRef) corev1.EnvVar {
	return corev1.EnvVar{Name: name, ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
		LocalObjectReference: corev1.LocalObjectReference{Name: ref.Name}, Key: ref.Key,
	}}}
}

func tmpVolume() (corev1.Volume, corev1.VolumeMount) {
	return corev1.Volume{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: ptr.To(resource.MustParse("256Mi"))}}},
		corev1.VolumeMount{Name: "tmp", MountPath: "/tmp"}
}

func typeMeta(kind, apiVersion string) metav1.TypeMeta {
	return metav1.TypeMeta{Kind: kind, APIVersion: apiVersion}
}

func objectMeta(in *v1alpha1.RegulaitInstallation, name, component string) metav1.ObjectMeta {
	return metav1.ObjectMeta{Name: name, Namespace: in.Namespace, Labels: labels(in, component)}
}

// ServiceAccount for every pod of the installation. The token is never mounted.
func ServiceAccount(in *v1alpha1.RegulaitInstallation) *corev1.ServiceAccount {
	return &corev1.ServiceAccount{
		TypeMeta:                     typeMeta("ServiceAccount", "v1"),
		ObjectMeta:                   objectMeta(in, gatewayName(in), ""),
		AutomountServiceAccountToken: ptr.To(false),
	}
}

// Service in front of the gateway.
func Service(in *v1alpha1.RegulaitInstallation) *corev1.Service {
	sel := instanceSelector(in)
	sel["app.kubernetes.io/component"] = "gateway"
	return &corev1.Service{
		TypeMeta:   typeMeta("Service", "v1"),
		ObjectMeta: objectMeta(in, gatewayName(in), "gateway"),
		Spec: corev1.ServiceSpec{
			Type:     corev1.ServiceTypeClusterIP,
			Selector: sel,
			Ports:    []corev1.ServicePort{{Name: "http", Port: GatewayPort, TargetPort: intstr.FromInt32(GatewayPort), Protocol: corev1.ProtocolTCP}},
		},
	}
}

// NetworkPolicy is default-deny in both directions for every pod of the installation; the spec only opens holes.
func NetworkPolicy(in *v1alpha1.RegulaitInstallation) *networkingv1.NetworkPolicy {
	tcp, udp := corev1.ProtocolTCP, corev1.ProtocolUDP
	port := func(p corev1.Protocol, n int32) networkingv1.NetworkPolicyPort {
		return networkingv1.NetworkPolicyPort{Protocol: &p, Port: ptr.To(intstr.FromInt32(n))}
	}

	ingress := []networkingv1.NetworkPolicyIngressRule{}
	if len(in.Spec.IngressFrom) > 0 {
		peers := make([]networkingv1.NetworkPolicyPeer, 0, len(in.Spec.IngressFrom))
		for _, p := range in.Spec.IngressFrom {
			peers = append(peers, networkingv1.NetworkPolicyPeer{NamespaceSelector: p.NamespaceSelector, PodSelector: p.PodSelector})
		}
		ingress = append(ingress, networkingv1.NetworkPolicyIngressRule{From: peers, Ports: []networkingv1.NetworkPolicyPort{port(tcp, GatewayPort)}})
	}

	egress := []networkingv1.NetworkPolicyEgressRule{{
		// DNS to kube-system only.
		To: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: &metav1.LabelSelector{
			MatchLabels: map[string]string{"kubernetes.io/metadata.name": "kube-system"},
		}}},
		Ports: []networkingv1.NetworkPolicyPort{port(udp, 53), port(tcp, 53)},
	}}
	if cidrs := in.Spec.Egress.DatabaseCIDRs; len(cidrs) > 0 {
		egress = append(egress, networkingv1.NetworkPolicyEgressRule{To: ipBlocks(cidrs), Ports: []networkingv1.NetworkPolicyPort{port(tcp, 5432)}})
	}
	if cidrs := in.Spec.Egress.AllowedCIDRs; len(cidrs) > 0 {
		egress = append(egress, networkingv1.NetworkPolicyEgressRule{To: ipBlocks(cidrs)})
	}
	if in.Spec.Egress.AllowPublicEgress && in.Spec.Mode != v1alpha1.ModeAirGapped {
		egress = append(egress, networkingv1.NetworkPolicyEgressRule{
			To: []networkingv1.NetworkPolicyPeer{
				{IPBlock: &networkingv1.IPBlock{CIDR: "0.0.0.0/0", Except: v4(privateRanges)}},
				{IPBlock: &networkingv1.IPBlock{CIDR: "::/0", Except: v6(privateRanges)}},
			},
			Ports: []networkingv1.NetworkPolicyPort{port(tcp, 443)},
		})
	}

	return &networkingv1.NetworkPolicy{
		TypeMeta:   typeMeta("NetworkPolicy", "networking.k8s.io/v1"),
		ObjectMeta: objectMeta(in, in.Name+"-default-deny", ""),
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: instanceSelector(in)},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress},
			Ingress:     ingress,
			Egress:      egress,
		},
	}
}

func ipBlocks(cidrs []string) []networkingv1.NetworkPolicyPeer {
	out := make([]networkingv1.NetworkPolicyPeer, 0, len(cidrs))
	for _, c := range cidrs {
		out = append(out, networkingv1.NetworkPolicyPeer{IPBlock: &networkingv1.IPBlock{CIDR: c}})
	}
	return out
}

func v4(cs []string) []string {
	var out []string
	for _, c := range cs {
		if !strings.Contains(c, ":") {
			out = append(out, c)
		}
	}
	return out
}

func v6(cs []string) []string {
	var out []string
	for _, c := range cs {
		if strings.Contains(c, ":") {
			out = append(out, c)
		}
	}
	return out
}

// InstallSecretsClaim is created once and never owned, so deleting the installation keeps the signing keys.
func InstallSecretsClaim(in *v1alpha1.RegulaitInstallation) *corev1.PersistentVolumeClaim {
	return &corev1.PersistentVolumeClaim{
		TypeMeta:   typeMeta("PersistentVolumeClaim", "v1"),
		ObjectMeta: objectMeta(in, installSecretsClaim(in), "gateway"),
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources:   corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("1Gi")}},
		},
	}
}

func gatewayEnv(in *v1alpha1.RegulaitInstallation) []corev1.EnvVar {
	return []corev1.EnvVar{
		{Name: "REGULAIT_DEPLOY_MODE", Value: string(in.Spec.Mode)},
		{Name: "REGULAIT_VERSION", Value: in.Spec.Version},
		{Name: "SEED_DEMO", Value: "0"},
		{Name: "NODE_ENV", Value: "production"},
		{Name: "REGULAIT_INSTALL_SECRETS_DIR", Value: InstallSecretsPath},
		secretEnv("DATABASE_URL", in.Spec.DatabaseURLSecretRef),
		secretEnv("REGULAIT_DATA_KEY", in.Spec.DataKeySecretRef),
		secretEnv("REGULAIT_BOOTSTRAP_TOKEN", in.Spec.BootstrapTokenSecretRef),
	}
}

func resources(cpuReq, memReq, cpuLim, memLim string) corev1.ResourceRequirements {
	return corev1.ResourceRequirements{
		Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse(cpuReq), corev1.ResourceMemory: resource.MustParse(memReq)},
		Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse(cpuLim), corev1.ResourceMemory: resource.MustParse(memLim)},
	}
}

// Deployment runs the gateway from image. The image is passed in because during an upgrade the Deployment keeps
// the installed image until the new version's migration Job has succeeded.
func Deployment(in *v1alpha1.RegulaitInstallation, image string) *appsv1.Deployment {
	tmpV, tmpM := tmpVolume()
	podLabels := labels(in, "gateway")
	sel := instanceSelector(in)
	sel["app.kubernetes.io/component"] = "gateway"
	replicas := int32(1)
	if in.Spec.Replicas != nil {
		replicas = *in.Spec.Replicas
	}
	return &appsv1.Deployment{
		TypeMeta:   typeMeta("Deployment", "apps/v1"),
		ObjectMeta: objectMeta(in, gatewayName(in), "gateway"),
		Spec: appsv1.DeploymentSpec{
			Replicas: ptr.To(replicas),
			Selector: &metav1.LabelSelector{MatchLabels: sel},
			// One replica that migrates at boot: never two at once (ADR-0304 §4).
			Strategy: appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: podLabels},
				Spec: corev1.PodSpec{
					ServiceAccountName:           gatewayName(in),
					AutomountServiceAccountToken: ptr.To(false),
					EnableServiceLinks:           ptr.To(false),
					SecurityContext:              restrictedPod(GatewayUID),
					Containers: []corev1.Container{{
						Name:            "gateway",
						Image:           image,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Ports:           []corev1.ContainerPort{{Name: "http", ContainerPort: GatewayPort, Protocol: corev1.ProtocolTCP}},
						Env:             gatewayEnv(in),
						SecurityContext: restrictedContainer(),
						Resources:       resources("250m", "512Mi", "2", "2Gi"),
						VolumeMounts: []corev1.VolumeMount{
							tmpM,
							{Name: "install-secrets", MountPath: InstallSecretsPath, SubPath: "install-secrets"},
							{Name: "install-secrets", MountPath: AuditAnchorsPath, SubPath: "audit-anchors"},
						},
						// /health checks the database, so it gates traffic, not restarts.
						ReadinessProbe: &corev1.Probe{
							ProbeHandler:  corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/health", Port: intstr.FromInt32(GatewayPort)}},
							PeriodSeconds: 10, TimeoutSeconds: 5, FailureThreshold: 3,
						},
						LivenessProbe: &corev1.Probe{
							ProbeHandler:  corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromInt32(GatewayPort)}},
							PeriodSeconds: 20, TimeoutSeconds: 5, FailureThreshold: 3,
						},
						StartupProbe: &corev1.Probe{
							ProbeHandler:  corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromInt32(GatewayPort)}},
							PeriodSeconds: 10, TimeoutSeconds: 5, FailureThreshold: 60,
						},
					}},
					Volumes: []corev1.Volume{
						tmpV,
						{Name: "install-secrets", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: installSecretsClaim(in)}}},
					},
				},
			},
		},
	}
}

// MigrateJob runs the target image's migrations once, before the Deployment moves to it.
func MigrateJob(in *v1alpha1.RegulaitInstallation) *batchv1.Job {
	tmpV, tmpM := tmpVolume()
	return &batchv1.Job{
		TypeMeta:   typeMeta("Job", "batch/v1"),
		ObjectMeta: objectMeta(in, migrateJobName(in), "migrate"),
		Spec: batchv1.JobSpec{
			BackoffLimit:          ptr.To(int32(2)),
			ActiveDeadlineSeconds: ptr.To(int64(1800)),
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels(in, "migrate")},
				Spec: corev1.PodSpec{
					RestartPolicy:                corev1.RestartPolicyNever,
					ServiceAccountName:           gatewayName(in),
					AutomountServiceAccountToken: ptr.To(false),
					EnableServiceLinks:           ptr.To(false),
					SecurityContext:              restrictedPod(GatewayUID),
					Containers: []corev1.Container{{
						Name:            "migrate",
						Image:           imageRef(in.Spec.Image),
						ImagePullPolicy: corev1.PullIfNotPresent,
						Command:         []string{"node", MigrateEntrypoint},
						Env: []corev1.EnvVar{
							{Name: "REGULAIT_DEPLOY_MODE", Value: string(in.Spec.Mode)},
							{Name: "NODE_ENV", Value: "production"},
							secretEnv("DATABASE_URL", in.Spec.DatabaseURLSecretRef),
						},
						SecurityContext: restrictedContainer(),
						Resources:       resources("100m", "256Mi", "1", "1Gi"),
						VolumeMounts:    []corev1.VolumeMount{tmpM},
					}},
					Volumes: []corev1.Volume{tmpV},
				},
			},
		},
	}
}

// BackupCronJob dumps the database to the destination claim and prunes dumps older than the retention.
func BackupCronJob(in *v1alpha1.RegulaitInstallation) *batchv1.CronJob {
	tmpV, tmpM := tmpVolume()
	b := in.Spec.Backup
	schedule := b.Schedule
	if schedule == "" {
		schedule = "17 2 * * *"
	}
	retention := b.RetentionDays
	if retention == 0 {
		retention = 14
	}
	script := `set -eu
f="/backup/regulait-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --file="$f.partial" "$DATABASE_URL"
mv "$f.partial" "$f"
find /backup -maxdepth 1 -name 'regulait-*.dump' -mtime "+$RETENTION_DAYS" -delete`
	image := ""
	if b.Image != nil {
		image = imageRef(*b.Image)
	}
	return &batchv1.CronJob{
		TypeMeta:   typeMeta("CronJob", "batch/v1"),
		ObjectMeta: objectMeta(in, in.Name+"-backup", "backup"),
		Spec: batchv1.CronJobSpec{
			Schedule:                   schedule,
			ConcurrencyPolicy:          batchv1.ForbidConcurrent,
			SuccessfulJobsHistoryLimit: ptr.To(int32(3)),
			FailedJobsHistoryLimit:     ptr.To(int32(3)),
			JobTemplate: batchv1.JobTemplateSpec{Spec: batchv1.JobSpec{
				BackoffLimit:          ptr.To(int32(1)),
				ActiveDeadlineSeconds: ptr.To(int64(6 * 3600)),
				Template: corev1.PodTemplateSpec{
					ObjectMeta: metav1.ObjectMeta{Labels: labels(in, "backup")},
					Spec: corev1.PodSpec{
						RestartPolicy:                corev1.RestartPolicyNever,
						ServiceAccountName:           gatewayName(in),
						AutomountServiceAccountToken: ptr.To(false),
						EnableServiceLinks:           ptr.To(false),
						SecurityContext:              restrictedPod(BackupUID),
						Containers: []corev1.Container{{
							Name:            "pg-dump",
							Image:           image,
							ImagePullPolicy: corev1.PullIfNotPresent,
							Command:         []string{"/bin/sh", "-c", script},
							Env: []corev1.EnvVar{
								{Name: "RETENTION_DAYS", Value: fmt.Sprint(retention)},
								secretEnv("DATABASE_URL", in.Spec.DatabaseURLSecretRef),
							},
							SecurityContext: restrictedContainer(),
							Resources:       resources("100m", "256Mi", "1", "1Gi"),
							VolumeMounts:    []corev1.VolumeMount{tmpM, {Name: "backup", MountPath: "/backup"}},
						}},
						Volumes: []corev1.Volume{
							tmpV,
							{Name: "backup", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: b.DestinationClaimName}}},
						},
					},
				},
			}},
		},
	}
}
