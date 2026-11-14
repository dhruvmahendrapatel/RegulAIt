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
      (and (regexMatch "^169\\.254\\." $a) (ge $bits 16))
      (and (regexMatch "^(?i)f[cd][0-9a-f]{2}:" $a) (ge $bits 7)) -}}
true
{{- end -}}
{{- end -}}

{{- define "regulait.validate" -}}
{{- $v := .Values -}}
{{- if and (eq $v.mode "air_gapped") (empty $v.image.allowedRegistries) -}}
{{- fail "air_gapped requires image.allowedRegistries" -}}
{{- end -}}
{{- if $v.image.allowedRegistries -}}
{{- $host := include "regulait.registry" $v.image.repository -}}
{{- if not (has $host $v.image.allowedRegistries) -}}
{{- fail (printf "image registry %q is not in image.allowedRegistries" $host) -}}
{{- end -}}
{{- end -}}
{{- if eq $v.mode "air_gapped" -}}
{{- if $v.egress.allowPublicEgress -}}
{{- fail "air_gapped refuses egress.allowPublicEgress" -}}
{{- end -}}
{{- range concat $v.egress.allowedCIDRs $v.egress.databaseCIDRs ($v.egress.dns.cidrs | default list) -}}
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
