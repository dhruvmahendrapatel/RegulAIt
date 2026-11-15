{{/* ADR-0304: names, labels, and the checks the values schema cannot express. */}}

{{- define "regulait.name" -}}
{{- printf "%s-gateway" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "regulait.selector" -}}
app.kubernetes.io/name: regulait
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "regulait.labels" -}}
{{ include "regulait.selector" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Values.version | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "regulait.image" -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- end -}}

{{- define "regulait.claim" -}}
{{- default (printf "%s-install-secrets" .Release.Name) .Values.installSecrets.existingClaim -}}
{{- end -}}

{{/* The registry host: the first path segment when it has a dot or a port, or is localhost; else Docker Hub. */}}
{{- define "regulait.registry" -}}
{{- $first := index (splitList "/" .) 0 -}}
{{- if or (contains "." $first) (contains ":" $first) (eq $first "localhost") -}}{{ $first }}{{- else -}}docker.io{{- end -}}
{{- end -}}

{{/* A CIDR inside a private range, with a prefix at least as long as the range's. */}}
{{- define "regulait.privateCIDR" -}}
{{- $parts := splitList "/" . -}}
{{- $bits := 0 -}}
{{- if eq (len $parts) 2 -}}{{- $bits = atoi (index $parts 1) -}}{{- end -}}
{{- $a := index $parts 0 -}}
{{- if or
      (and (regexMatch "^10\\." $a) (ge $bits 8))
      (and (regexMatch "^172\\.(1[6-9]|2[0-9]|3[01])\\." $a) (ge $bits 12))
      (and (regexMatch "^192\\.168\\." $a) (ge $bits 16))
      (and (regexMatch "^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\." $a) (ge $bits 10))
      (and (regexMatch "^(?i)f[cd][0-9a-f]{2}:" $a) (ge $bits 7)) -}}
true
{{- end -}}
{{- end -}}

{{/* "true" when an IPv4 CIDR overlaps 169.254.0.0/16 (link-local: the cloud instance metadata endpoints). */}}
{{- define "regulait.v4LinkLocal" -}}
{{- $parts := splitList "/" . -}}
{{- $o := splitList "." (index $parts 0) -}}
{{- $bits := 32 -}}
{{- if eq (len $parts) 2 -}}{{- $bits = atoi (index $parts 1) -}}{{- end -}}
{{- if ge $bits 16 -}}
{{- if and (eq (index $o 0) "169") (eq (index $o 1) "254") -}}true{{- end -}}
{{- else -}}
{{- $d := 1 -}}
{{- range until (int (sub 16 $bits)) -}}{{- $d = mul $d 2 -}}{{- end -}}
{{- $hi := add (mul (atoi (index $o 0)) 256) (atoi (index $o 1)) -}}
{{- if eq (div $hi $d) (div (add (mul 169 256) 254) $d) -}}true{{- end -}}
{{- end -}}
{{- end -}}

{{/*
ADR-0180, as in the operator's validate.go: no egress entry may reach a link-local range or a cloud metadata address,
in any mode. Templates cannot do IPv6 containment, so an IPv6 entry must be a unique-local range of /48 or longer
outside fd00:ec2::/32 (the AWS IPv6 metadata block); public IPv6 is opened with allowPublicEgress only. The DNS list
also takes one link-local IPv4 address (NodeLocal DNSCache), never a metadata one. Prints the refusal, or nothing.
*/}}
{{- define "regulait.egressRefusal" -}}
{{- $field := index . 0 -}}{{- $c := index . 1 -}}
{{- $parts := splitList "/" $c -}}
{{- $bits := -1 -}}
{{- if eq (len $parts) 2 -}}{{- $bits = atoi (index $parts 1) -}}{{- end -}}
{{- $addr := index $parts 0 -}}
{{- if contains ":" $addr -}}
{{- if not (and (regexMatch "^(?i)f[cd][0-9a-f]{2}:" $addr) (ge $bits 48) (le $bits 128)) -}}
{{ $field }} entry {{ $c | quote }}: an IPv6 entry must be a unique-local range of /48 or longer
{{- else if regexMatch "^(?i)fd00:0*ec2:" $addr -}}
{{ $field }} entry {{ $c | quote }} reaches a cloud instance metadata address
{{- end -}}
{{- else if not (regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}$" $addr) -}}
{{ $field }} entry {{ $c | quote }} is not a CIDR
{{- else if or (lt $bits 0) (gt $bits 32) -}}
{{ $field }} entry {{ $c | quote }} is not a CIDR
{{- else if has $addr (list "169.254.169.254" "169.254.170.2" "169.254.170.23") -}}
{{ $field }} entry {{ $c | quote }} reaches a cloud instance metadata address
{{- else if eq (include "regulait.v4LinkLocal" $c) "true" -}}
{{- if not (and (eq $field "egress.dns.cidrs") (eq $bits 32)) -}}
{{ $field }} entry {{ $c | quote }} overlaps 169.254.0.0/16, where the cloud metadata endpoints are
{{- end -}}
{{- else if and (eq $field "egress.dns.cidrs") (ne (include "regulait.privateCIDR" $c) "true") -}}
{{ $field }} entry {{ $c | quote }} must be a private range or one link-local address
{{- end -}}
{{- end -}}

{{/* What the values open beyond private ranges, one line each (reported in NOTES.txt). */}}
{{- define "regulait.publicEgress" -}}
{{- if .Values.egress.allowPublicEgress }}
- egress.allowPublicEgress (public addresses on 443)
{{- end }}
{{- range concat .Values.egress.allowedCIDRs .Values.egress.databaseCIDRs }}
{{- if and (not (contains ":" .)) (ne (include "regulait.privateCIDR" .) "true") }}
- {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "regulait.validate" -}}
{{- $v := .Values -}}
{{- /* ADR-0180: the claim holds signing keys unencrypted, and the cluster's default class is often unencrypted (EKS gp2/gp3
without encrypted: "true"). The chart cannot check a class, so it requires an explicit choice. */ -}}
{{- if and (not $v.installSecrets.existingClaim) (not $v.installSecrets.storageClassName) -}}
{{- fail "set installSecrets.storageClassName to an encrypted StorageClass, or installSecrets.existingClaim to a claim on encrypted storage: the claim holds signing keys unencrypted" -}}
{{- end -}}
{{- if and (eq $v.mode "air_gapped") (empty $v.image.allowedRegistries) -}}
{{- fail "air_gapped requires image.allowedRegistries" -}}
{{- end -}}
{{- if $v.image.allowedRegistries -}}
{{- $host := include "regulait.registry" $v.image.repository -}}
{{- if not (has $host $v.image.allowedRegistries) -}}
{{- fail (printf "image registry %q is not in image.allowedRegistries" $host) -}}
{{- end -}}
{{- end -}}
{{- range $f := list (list "egress.allowedCIDRs" $v.egress.allowedCIDRs) (list "egress.databaseCIDRs" $v.egress.databaseCIDRs) (list "egress.dns.cidrs" ($v.egress.dns.cidrs | default list)) -}}
{{- range (index $f 1) -}}
{{- $why := include "regulait.egressRefusal" (list (index $f 0) .) | trim -}}
{{- if $why -}}{{- fail $why -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if eq $v.mode "air_gapped" -}}
{{- if $v.egress.allowPublicEgress -}}
{{- fail "air_gapped refuses egress.allowPublicEgress" -}}
{{- end -}}
{{- /* egress.dns.cidrs is checked above: private ranges or one link-local address, in every mode. */ -}}
{{- range concat $v.egress.allowedCIDRs $v.egress.databaseCIDRs -}}
{{- if ne (include "regulait.privateCIDR" .) "true" -}}
{{- fail (printf "air_gapped allows only private ranges; %q is not one" .) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $v.operator.image.digest) -}}
{{- fail "operator.image (repository and sha256 digest) is required: the migration hook verifies the signed bundle with it" -}}
{{- end -}}
{{- if $v.image.allowedRegistries -}}
{{- $ohost := include "regulait.registry" $v.operator.image.repository -}}
{{- if not (has $ohost $v.image.allowedRegistries) -}}
{{- fail (printf "operator image registry %q is not in image.allowedRegistries" $ohost) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "regulait.podSecurity" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "regulait.containerSecurity" -}}
runAsNonRoot: true
readOnlyRootFilesystem: true
allowPrivilegeEscalation: false
privileged: false
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "regulait.secretEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef: { name: {{ .Values.secrets.name | quote }}, key: {{ .Values.secrets.databaseUrlKey | quote }} }
{{- end -}}
