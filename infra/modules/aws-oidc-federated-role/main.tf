# aws-oidc-federated-role: an IAM OIDC identity provider for an external issuer
# and one role that trusts it for exact audience and subject values only
# (AssumeRoleWithWebIdentity). The caller passes the role's permissions as a
# policy document, so the module holds no opinion on what the role may read.
#
# No thumbprint is set: IAM verifies the issuer's TLS certificate against its
# own trusted CAs for publicly trusted certificates. IAM fetches the issuer's
# discovery document when the provider is created and when a token is
# exchanged, so the issuer must be reachable over public HTTPS at both times.

locals {
  # IAM condition keys are named after the issuer URL without its scheme
  # (`host/path:sub`), and IAM stores the provider URL the same way.
  issuer_key = trimsuffix(trimprefix(var.issuer_url, "https://"), "/")
}

resource "aws_iam_openid_connect_provider" "this" {
  count          = var.existing_provider_arn == null ? 1 : 0
  url            = var.issuer_url
  client_id_list = [var.audience]
  tags           = var.tags
}

locals {
  provider_arn = var.existing_provider_arn != null ? var.existing_provider_arn : aws_iam_openid_connect_provider.this[0].arn
}

data "aws_iam_policy_document" "trust" {
  statement {
    sid     = "ExactAudienceAndSubjectOnly"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.issuer_key}:aud"
      values   = [var.audience]
    }
    # StringEquals, never StringLike: a token for any other subject is refused.
    condition {
      test     = "StringEquals"
      variable = "${local.issuer_key}:sub"
      values   = var.subjects
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = var.role_name
  description          = var.role_description
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = var.max_session_duration
  tags                 = var.tags
}

resource "aws_iam_role_policy" "this" {
  name   = "${var.role_name}-permissions"
  role   = aws_iam_role.this.id
  policy = var.policy_json
}
