# RegulAIt cloud AI discovery: read-only access to one GCP project (ADR-0195 decisions 16-17).
# You apply this in YOUR project; RegulAIt never creates IAM.
#
# STATUS: pending execution (M-041). Not yet run through `terraform validate` or applied to a real project.
#
# Workload identity federation: a pool provider trusts RegulAIt's cloud federation issuer (<REGULAIT_PUBLIC_URL>/federation), restricted to this discovery
# source's subject. RegulAIt then impersonates a dedicated service account that holds only the custom role below.
# For an organisation-wide Asset Inventory scope, grant the same permissions at organization or folder level.

variable "project_id" {
  type = string
}

variable "regulait_issuer_url" {
  description = "RegulAIt cloud federation issuer URL, <REGULAIT_PUBLIC_URL>/federation (https://...), shown on the Cloud federation card"
  type        = string
}

variable "regulait_source_id" {
  description = "The discovery source id; the token subject is regulait:discovery-source:<id>"
  type        = string
}

variable "read_data_access_logs" {
  description = "Also grant Data Access audit log read (where Vertex prediction calls appear)"
  type        = bool
  default     = false
}

resource "google_project_iam_custom_role" "regulait_discovery" {
  project     = var.project_id
  role_id     = "regulaitAiDiscovery"
  title       = "RegulAIt AI discovery (read-only)"
  description = "Lists AI services and reads their audit logs. Read-only."
  permissions = concat(
    [
      "serviceusage.services.get",
      "cloudasset.assets.searchAllResources",
      "resourcemanager.projects.getIamPolicy",
      "logging.logEntries.list",
    ],
    var.read_data_access_logs ? ["logging.privateLogEntries.list"] : [],
  )
}

resource "google_service_account" "regulait_discovery" {
  project      = var.project_id
  account_id   = "regulait-ai-discovery"
  display_name = "RegulAIt AI discovery (read-only)"
}

resource "google_project_iam_member" "regulait_discovery" {
  project = var.project_id
  role    = google_project_iam_custom_role.regulait_discovery.id
  member  = "serviceAccount:${google_service_account.regulait_discovery.email}"
}

resource "google_iam_workload_identity_pool" "regulait" {
  project                   = var.project_id
  workload_identity_pool_id = "regulait"
  display_name              = "RegulAIt"
}

resource "google_iam_workload_identity_pool_provider" "regulait" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.regulait.workload_identity_pool_id
  workload_identity_pool_provider_id = "regulait-oidc"
  attribute_mapping = {
    "google.subject" = "assertion.sub"
  }
  attribute_condition = "assertion.sub == \"regulait:discovery-source:${var.regulait_source_id}\""
  oidc {
    issuer_uri = var.regulait_issuer_url
  }
}

resource "google_service_account_iam_member" "regulait_impersonation" {
  service_account_id = google_service_account.regulait_discovery.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.regulait.name}/subject/regulait:discovery-source:${var.regulait_source_id}"
}

output "workload_identity_audience" {
  description = "Paste into the RegulAIt discovery source (audience)"
  value       = "//iam.googleapis.com/${google_iam_workload_identity_pool_provider.regulait.name}"
}

output "service_account_email" {
  value = google_service_account.regulait_discovery.email
}
