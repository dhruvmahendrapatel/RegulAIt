# RegulAIt cloud AI discovery: read-only access to one Azure subscription (ADR-0195 decisions 16-17).
# You apply this in YOUR tenant; RegulAIt never creates IAM.
#
# STATUS: pending execution (M-041). Not yet run through `terraform validate` or applied to a real tenant.
#
# Federated credential: an app registration trusts RegulAIt's cloud federation issuer (<REGULAIT_PUBLIC_URL>/federation) for this one discovery source's
# subject. The service principal holds only the custom role below. `listKeys` is deliberately absent.

variable "subscription_id" {
  type = string
}

variable "regulait_issuer_url" {
  description = "RegulAIt cloud federation issuer URL, <REGULAIT_PUBLIC_URL>/federation (https://...), exactly as shown on the Cloud federation card"
  type        = string
}

variable "regulait_source_id" {
  description = "The discovery source id; the token subject is regulait:discovery-source:<id>"
  type        = string
}

variable "log_analytics_workspace_id" {
  description = "Optional: resource id of a Log Analytics workspace that receives Cognitive Services diagnostics"
  type        = string
  default     = ""
}

resource "azuread_application" "regulait_discovery" {
  display_name = "regulait-ai-discovery"
}

resource "azuread_service_principal" "regulait_discovery" {
  client_id = azuread_application.regulait_discovery.client_id
}

resource "azuread_application_federated_identity_credential" "regulait" {
  application_id = azuread_application.regulait_discovery.id
  display_name   = "regulait-discovery-source"
  issuer         = var.regulait_issuer_url
  subject        = "regulait:discovery-source:${var.regulait_source_id}"
  audiences      = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_definition" "regulait_discovery" {
  name        = "RegulAIt AI discovery (read-only)"
  scope       = "/subscriptions/${var.subscription_id}"
  description = "Lists AI services and reads the activity log. Read-only; no listKeys."
  permissions {
    actions = [
      "Microsoft.CognitiveServices/accounts/read",
      "Microsoft.CognitiveServices/accounts/deployments/read",
      "Microsoft.MachineLearningServices/workspaces/read",
      "Microsoft.Insights/eventtypes/values/read",
    ]
    not_actions = []
  }
  assignable_scopes = ["/subscriptions/${var.subscription_id}"]
}

resource "azurerm_role_assignment" "regulait_discovery" {
  scope              = "/subscriptions/${var.subscription_id}"
  role_definition_id = azurerm_role_definition.regulait_discovery.role_definition_resource_id
  principal_id       = azuread_service_principal.regulait_discovery.object_id
}

resource "azurerm_role_definition" "regulait_diagnostics" {
  count       = var.log_analytics_workspace_id == "" ? 0 : 1
  name        = "RegulAIt AI discovery diagnostics (read-only)"
  scope       = var.log_analytics_workspace_id
  description = "Queries Cognitive Services diagnostic logs routed to this workspace."
  permissions {
    actions = [
      "Microsoft.OperationalInsights/workspaces/read",
      "Microsoft.OperationalInsights/workspaces/query/read",
    ]
    not_actions = []
  }
  assignable_scopes = [var.log_analytics_workspace_id]
}

resource "azurerm_role_assignment" "regulait_diagnostics" {
  count              = var.log_analytics_workspace_id == "" ? 0 : 1
  scope              = var.log_analytics_workspace_id
  role_definition_id = azurerm_role_definition.regulait_diagnostics[0].role_definition_resource_id
  principal_id       = azuread_service_principal.regulait_discovery.object_id
}

output "tenant_and_client" {
  description = "Paste into the RegulAIt discovery source"
  value       = { client_id = azuread_application.regulait_discovery.client_id }
}
