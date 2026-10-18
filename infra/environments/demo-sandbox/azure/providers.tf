# Authenticates as the person applying (`az login`); no client secret is used
# or stored. The tenant and subscription are variables, never committed values.
provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
  tenant_id       = var.tenant_id
}

provider "azuread" {
  tenant_id = var.tenant_id
}
