# demo-sandbox / azure: the Azure side of real-account discovery (ADR-0197
# decisions 3, 4 and 8). Runbook: docs/deployment/DEMO_REAL_ACCOUNTS.md.
#
# 1. A demo resource group holding one small Azure OpenAI deployment (keys
#    disabled), planted activity from a keyless Logic App on a recurrence,
#    diagnostic logs to a capped Log Analytics workspace, and a budget.
# 2. An Entra app registration whose only credential is a federated identity
#    credential for RegulAIt's federation issuer and the one subject
#    `regulait:discovery-source:<source id>`, holding Reader on the resource
#    group and (optionally) an activity-log-only role on the subscription.
#
# EXPECTED COST (per month, defaults below): one call every 3 hours is about
# 240 calls x (about 30 input + at most 32 output tokens), about 15K tokens:
# cents at any pay-per-token price. About 480 Logic App action executions and a
# few MB of log ingestion add cents more. Expected total: under USD 1 per month.
# The resource-group budget alerts at 80% of budget_amount.
#
# What the person applying needs (owner action): in the tenant, the right to
# create app registrations and service principals; on the subscription, Owner
# (or Contributor plus User Access Administrator) to create the resource group,
# the custom role and the role assignments; and the subscription's quota for
# the chosen model and deployment type in the chosen region.

locals {
  slug = var.demo_company_slug
  tags = {
    Project     = "RegulAIt"
    Environment = "sandbox"
    Purpose     = "demo"
    ManagedBy   = "terraform"
    Stack       = "demo-sandbox-azure"
    Teardown    = var.teardown_after
  }
}

resource "azurerm_resource_group" "demo" {
  name     = "rg-${local.slug}-ai-demo"
  location = var.location
  tags     = local.tags
}

resource "random_id" "subdomain" {
  byte_length = 3
}

module "openai_activity" {
  source = "../../../modules/azure-openai-activity"

  name_prefix           = "${local.slug}-ai"
  resource_group_name   = azurerm_resource_group.demo.name
  resource_group_id     = azurerm_resource_group.demo.id
  location              = azurerm_resource_group.demo.location
  custom_subdomain_name = "${local.slug}-ai-${random_id.subdomain.hex}"

  deployment_name     = "store-assistant"
  model_name          = var.openai_model_name
  model_version       = var.openai_model_version
  deployment_sku      = var.openai_deployment_sku
  deployment_capacity = 1

  prompt                    = "In one sentence, suggest a name for a waterproof day pack."
  max_tokens                = 32
  token_limit_field         = var.openai_token_limit_field
  recurrence_interval_hours = 3
  generator_enabled         = var.activity_enabled

  budget_amount         = var.budget_amount
  budget_start_date     = var.budget_start_date
  budget_contact_emails = var.budget_contact_emails

  tags = local.tags
}

module "discovery_reader" {
  source = "../../../modules/azure-federated-reader"

  display_name        = "regulait-ai-discovery-demo"
  issuer_url          = var.regulait_federation_issuer_url
  subject             = "regulait:discovery-source:${var.azure_discovery_source_id}"
  reader_scopes       = [azurerm_resource_group.demo.id]
  activity_log_scopes = var.grant_activity_log_read ? ["/subscriptions/${var.subscription_id}"] : []
}
