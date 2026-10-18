# azure-openai-activity: one small Azure OpenAI deployment with planted,
# attributable activity and the logging a discovery scan reads.
#
# - The account has local (key) authentication disabled: only Entra tokens work,
#   so there is no API key to leak.
# - A Logic App (Consumption) on a recurrence calls the deployment with its own
#   system-assigned managed identity (role "Cognitive Services OpenAI User" on
#   this account only). Keyless end to end.
# - The account's RequestResponse diagnostic logs go to a Log Analytics
#   workspace with a daily ingestion cap, so per-call counts are queryable.
# - A resource-group budget alerts at budget_alert_threshold_percent.
#
# Cost is per token (Standard / GlobalStandard deployments have no hourly
# charge) plus a few Logic App action executions and a few KB of log ingestion.

resource "azurerm_cognitive_account" "this" {
  name                  = "${var.name_prefix}-openai"
  resource_group_name   = var.resource_group_name
  location              = var.location
  kind                  = "OpenAI"
  sku_name              = "S0"
  custom_subdomain_name = var.custom_subdomain_name
  local_auth_enabled    = false
  tags                  = var.tags
}

resource "azurerm_cognitive_deployment" "this" {
  name                 = var.deployment_name
  cognitive_account_id = azurerm_cognitive_account.this.id

  model {
    format  = "OpenAI"
    name    = var.model_name
    version = var.model_version
  }

  sku {
    name     = var.deployment_sku
    capacity = var.deployment_capacity
  }
}

# --- logs ------------------------------------------------------------------------

resource "azurerm_log_analytics_workspace" "this" {
  name                = "${var.name_prefix}-logs"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  daily_quota_gb      = var.log_daily_quota_gb
  tags                = var.tags
}

resource "azurerm_monitor_diagnostic_setting" "openai" {
  name                       = "${var.name_prefix}-openai-requests"
  target_resource_id         = azurerm_cognitive_account.this.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id

  enabled_log {
    category = "RequestResponse"
  }

  enabled_log {
    category = "Audit"
  }
}

# --- planted activity ------------------------------------------------------------

resource "azurerm_logic_app_workflow" "generator" {
  name                = "${var.name_prefix}-activity"
  resource_group_name = var.resource_group_name
  location            = var.location
  enabled             = var.generator_enabled
  tags                = var.tags

  identity {
    type = "SystemAssigned"
  }
}

resource "azurerm_role_assignment" "generator" {
  scope                = azurerm_cognitive_account.this.id
  role_definition_name = "Cognitive Services OpenAI User"
  principal_id         = azurerm_logic_app_workflow.generator.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_logic_app_trigger_recurrence" "generator" {
  name         = "every-${var.recurrence_interval_hours}h"
  logic_app_id = azurerm_logic_app_workflow.generator.id
  frequency    = "Hour"
  interval     = var.recurrence_interval_hours
}

resource "azurerm_logic_app_action_custom" "call" {
  name         = "chat-completion"
  logic_app_id = azurerm_logic_app_workflow.generator.id

  body = jsonencode({
    type = "Http"
    inputs = {
      method = "POST"
      uri    = "${trimsuffix(azurerm_cognitive_account.this.endpoint, "/")}/openai/deployments/${azurerm_cognitive_deployment.this.name}/chat/completions?api-version=${var.api_version}"
      headers = {
        "Content-Type" = "application/json"
      }
      body = merge(
        {
          messages    = [{ role = "user", content = var.prompt }]
          temperature = 0.2
        },
        { (var.token_limit_field) = var.max_tokens },
      )
      authentication = {
        type     = "ManagedServiceIdentity"
        audience = "https://cognitiveservices.azure.com"
      }
      retryPolicy = {
        type = "none"
      }
    }
    runAfter = {}
  })

  depends_on = [azurerm_role_assignment.generator]
}

# --- budget ----------------------------------------------------------------------

resource "azurerm_consumption_budget_resource_group" "this" {
  name              = "${var.name_prefix}-budget"
  resource_group_id = var.resource_group_id
  amount            = var.budget_amount
  time_grain        = "Annually"

  time_period {
    start_date = var.budget_start_date
  }

  notification {
    enabled        = true
    threshold      = var.budget_alert_threshold_percent
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = var.budget_contact_emails
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThan"
    threshold_type = "Forecasted"
    contact_emails = var.budget_contact_emails
  }
}
