# demo-sandbox / aws: what lives INSIDE the sandbox account (ADR-0197 decisions
# 2-4 and 8). Applied after ../account. Runbook:
# docs/deployment/DEMO_REAL_ACCOUNTS.md.
#
# 1. A CloudTrail trail (management events) to a private, expiring bucket.
# 2. The discovery role RegulAIt assumes by web identity: it trusts RegulAIt's
#    federation issuer (ADR-0195 SD2b) for audience sts.amazonaws.com and the
#    one subject `regulait:discovery-source:<source id>`, and may only make the
#    read calls packages/cloud-discovery/src/aws.ts makes.
# 3. Planted AI activity: two scheduled generators making short Bedrock
#    Converse calls under their own roles (two distinct callers to discover),
#    and one Bedrock guardrail (inventory). Fictional demo-company names.
#
# EXPECTED COST (planted activity, per month, defaults below):
#   generator 1: weekdays, hourly 09:00-17:00 -> about 200 runs x 1 call
#   generator 2: daily at 10:43 and 14:43     -> about  60 runs x 2 calls
#   = about 320 calls x (about 40 input + at most 48 output tokens) = about 30K tokens.
#   At an on-demand price of at most USD 3 / USD 15 per million input / output
#   tokens that is under USD 0.30; a small model costs a few cents. Lambda,
#   EventBridge Scheduler, CloudWatch Logs (7-day retention) and the trail's S3
#   storage add well under USD 0.50. The guardrail costs nothing while unused.
#   Expected total: under USD 1 per month, against the USD 50 budget, whose
#   80% alert and 100% spend-cap SCP come from ../account.
#
# Not here, deliberately: Organizations permissions (the sandbox is scanned as
# a single account, so the role has no organizations:ListAccounts) and Bedrock
# model-invocation logging (left off, so a scan reports it as not enabled).

data "aws_region" "current" {}

locals {
  slug = var.demo_company_slug
  tags = {
    Project     = "RegulAIt"
    Environment = "sandbox"
    Purpose     = "demo"
    ManagedBy   = "terraform"
    Stack       = "demo-sandbox-aws"
    Teardown    = var.teardown_after
  }
}

# --- 1. CloudTrail ----------------------------------------------------------------

module "trail" {
  source = "../../../modules/aws-cloudtrail-trail"

  trail_name         = "${local.slug}-management-events"
  bucket_name        = "${local.slug}-demo-trail-${var.sandbox_account_id}"
  log_retention_days = 30
  tags               = local.tags
}

# --- 2. The discovery role ----------------------------------------------------------

data "aws_iam_policy_document" "discovery_read" {
  statement {
    sid = "AiInventoryAndAuditReads"
    # Exactly the calls packages/cloud-discovery/src/aws.ts makes for a single
    # account. sts:GetCallerIdentity is also called and needs no permission.
    actions = [
      "account:ListRegions",
      "bedrock:ListCustomModels",
      "bedrock:ListImportedModels",
      "bedrock:ListProvisionedModelThroughputs",
      "bedrock:ListGuardrails",
      "bedrock:GetModelInvocationLoggingConfiguration",
      "bedrock:ListAgents",
      "bedrock:ListKnowledgeBases",
      "sagemaker:ListEndpoints",
      "sagemaker:ListModels",
      "cloudtrail:LookupEvents",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "TrailBucketList"
    actions   = ["s3:ListBucket"]
    resources = [module.trail.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["AWSLogs/${var.sandbox_account_id}/CloudTrail/*"]
    }
  }

  statement {
    sid       = "TrailBucketRead"
    actions   = ["s3:GetObject"]
    resources = ["${module.trail.bucket_arn}/AWSLogs/${var.sandbox_account_id}/CloudTrail/*"]
  }
}

module "discovery_role" {
  source = "../../../modules/aws-oidc-federated-role"

  issuer_url       = var.regulait_federation_issuer_url
  audience         = "sts.amazonaws.com"
  subjects         = ["regulait:discovery-source:${var.aws_discovery_source_id}"]
  role_name        = "regulait-ai-discovery"
  role_description = "RegulAIt Shadow AI discovery (read-only), assumed by web identity from the demo instance's federation issuer."
  policy_json      = data.aws_iam_policy_document.discovery_read.json
  tags             = local.tags
}

# --- 3. Planted AI activity ----------------------------------------------------------

module "generator_support" {
  source = "../../../modules/aws-bedrock-activity-generator"

  name             = "${local.slug}-support-reply-bot"
  role_description = "Planted demo activity: drafts support replies (fictional)."
  model_id         = var.bedrock_model_id
  prompts = [
    "In one sentence, thank a customer for reporting that a tent pole arrived bent.",
    "In one sentence, tell a customer their hiking boots ship on Monday.",
    "In one sentence, explain how to return an unused sleeping bag.",
  ]
  max_tokens          = 48
  calls_per_run       = 1
  schedule_expression = "cron(17 9-17 ? * MON-FRI *)"
  schedule_timezone   = var.schedule_timezone
  end_date            = var.activity_end_date
  enabled             = var.activity_enabled
  tags                = local.tags
}

module "generator_invoices" {
  source = "../../../modules/aws-bedrock-activity-generator"

  name             = "${local.slug}-invoice-summariser"
  role_description = "Planted demo activity: summarises supplier invoices (fictional)."
  model_id         = var.bedrock_model_id
  prompts = [
    "Summarise in one line: invoice 4471, 120 rain jackets, net 30 days.",
    "Summarise in one line: invoice 4489, 40 camping stoves, paid on receipt.",
  ]
  max_tokens          = 48
  calls_per_run       = 2
  schedule_expression = "cron(43 10,14 * * ? *)"
  schedule_timezone   = var.schedule_timezone
  end_date            = var.activity_end_date
  enabled             = var.activity_enabled
  tags                = local.tags
}

resource "aws_bedrock_guardrail" "planted" {
  name                      = "${local.slug}-support-guardrail"
  description               = "Planted demo resource (fictional): a guardrail for the support bot."
  blocked_input_messaging   = "This request was blocked."
  blocked_outputs_messaging = "This response was blocked."

  word_policy_config {
    managed_word_lists_config {
      type = "PROFANITY"
    }
  }
}
