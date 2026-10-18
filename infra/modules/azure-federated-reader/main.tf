# azure-federated-reader: an Entra app registration whose only credential is a
# federated identity credential for one external OIDC issuer and one exact
# subject (no client secret, no certificate), with read-only role assignments.
#
# - Reader on each of var.reader_scopes (e.g. one resource group).
# - Optionally, a custom role holding only `Microsoft.Insights/eventtypes/values/read`
#   on each of var.activity_log_scopes: the activity log is read at subscription
#   scope, which a resource-group Reader assignment does not cover.
#
# Creating these needs, in the tenant, the right to register applications, and
# on each scope, Owner or User Access Administrator. The person applying grants
# themselves that access; this module grants nothing to itself.

data "azuread_client_config" "current" {}

resource "azuread_application" "this" {
  display_name     = var.display_name
  sign_in_audience = "AzureADMyOrg"
  owners           = length(var.owners) > 0 ? var.owners : [data.azuread_client_config.current.object_id]
}

resource "azuread_service_principal" "this" {
  client_id = azuread_application.this.client_id
  owners    = length(var.owners) > 0 ? var.owners : [data.azuread_client_config.current.object_id]
}

resource "azuread_application_federated_identity_credential" "this" {
  application_id = azuread_application.this.id
  display_name   = var.credential_name
  description    = "Tokens from ${var.issuer_url} for subject ${var.subject} only."
  issuer         = var.issuer_url
  subject        = var.subject
  audiences      = var.audiences
}

resource "azurerm_role_assignment" "reader" {
  for_each             = toset(var.reader_scopes)
  scope                = each.value
  role_definition_name = "Reader"
  principal_id         = azuread_service_principal.this.object_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_definition" "activity_log" {
  for_each    = toset(var.activity_log_scopes)
  name        = "${var.display_name} activity log reader (${substr(sha256(each.value), 0, 8)})"
  scope       = each.value
  description = "Reads the activity log only."
  permissions {
    actions     = ["Microsoft.Insights/eventtypes/values/read"]
    not_actions = []
  }
  assignable_scopes = [each.value]
}

resource "azurerm_role_assignment" "activity_log" {
  for_each           = toset(var.activity_log_scopes)
  scope              = each.value
  role_definition_id = azurerm_role_definition.activity_log[each.value].role_definition_resource_id
  principal_id       = azuread_service_principal.this.object_id
  principal_type     = "ServicePrincipal"
}
