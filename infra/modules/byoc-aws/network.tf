# Network: a new VPC across az_count zones.
#
#   private   EKS nodes and pods. Default route -> the Network Firewall
#             endpoint in the same zone (allow_list) or none at all (none).
#   database  RDS only. No route out of the VPC.
#   firewall  (allow_list) the Network Firewall endpoints. Default route -> NAT.
#   public    (allow_list) the NAT gateways. Return traffic to private subnets
#             goes back through the firewall endpoint of the same zone, so the
#             path is symmetric.
#
# AWS APIs (ECR, STS, EKS Pod Identity, EC2, Logs, KMS, Secrets Manager, Bedrock) are reached
# through VPC endpoints, and S3 through a gateway endpoint, so that traffic never
# crosses the firewall and never leaves the AWS network.

data "aws_availability_zones" "available" {
  state = "available"
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs        = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  allow_list = var.egress_mode == "allow_list"

  # /20s for nodes and pods (VPC CNI uses one IP per pod), /24s for the rest.
  private_subnets  = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  database_subnets = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, 160 + i)]
  firewall_subnets = local.allow_list ? [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, 170 + i)] : []
  public_subnets   = local.allow_list ? [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, 180 + i)] : []
  endpoint_subnets = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, 190 + i)]

  cluster_name = "${var.name_prefix}-eks"
}

resource "aws_cloudwatch_log_group" "flow" {
  name              = "/${var.name_prefix}/vpc-flow"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
  tags              = var.tags
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "6.7.3"

  name = "${var.name_prefix}-vpc"
  cidr = var.vpc_cidr
  azs  = local.azs

  private_subnets  = concat(local.private_subnets, local.endpoint_subnets)
  database_subnets = local.database_subnets
  intra_subnets    = local.firewall_subnets
  public_subnets   = local.public_subnets

  # Routes out are added below, through the firewall; the module adds none.
  enable_nat_gateway     = false
  one_nat_gateway_per_az = true
  create_igw             = local.allow_list

  create_database_subnet_group           = true
  database_subnet_group_name             = "${var.name_prefix}-db"
  create_database_subnet_route_table     = true
  create_database_internet_gateway_route = false
  create_database_nat_gateway_route      = false

  create_multiple_intra_route_tables = true
  map_public_ip_on_launch            = false

  enable_dns_hostnames = true
  enable_dns_support   = true

  # The default security group and NACL deny everything (nothing should use them).
  manage_default_security_group  = true
  default_security_group_ingress = []
  default_security_group_egress  = []

  enable_flow_log                       = true
  flow_log_destination_type             = "cloud-watch-logs"
  flow_log_destination_arn              = aws_cloudwatch_log_group.flow.arn
  create_flow_log_cloudwatch_log_group  = false
  create_flow_log_cloudwatch_iam_role   = true
  vpc_flow_log_iam_role_name            = "${var.name_prefix}-vpc-flow"
  vpc_flow_log_iam_role_use_name_prefix = true
  vpc_flow_log_iam_policy_name          = "${var.name_prefix}-vpc-flow"
  vpc_flow_log_permissions_boundary     = var.iam_permissions_boundary_arn
  flow_log_traffic_type                 = "ALL"
  flow_log_max_aggregation_interval     = 60

  private_subnet_tags = { "kubernetes.io/role/internal-elb" = "1" }
  tags                = var.tags
}

locals {
  node_subnet_ids     = slice(module.vpc.private_subnets, 0, var.az_count)
  endpoint_subnet_ids = slice(module.vpc.private_subnets, var.az_count, 2 * var.az_count)
  # One private route table per zone (one_nat_gateway_per_az), shared by the
  # node and endpoint subnets of that zone, in the order of local.azs.
  node_route_table_ids = module.vpc.private_route_table_ids
}

### VPC endpoints ###

resource "aws_security_group" "endpoints" {
  name_prefix = "${var.name_prefix}-endpoints-"
  description = "Interface VPC endpoints: HTTPS from inside the VPC only."
  vpc_id      = module.vpc.vpc_id
  tags        = var.tags

  ingress {
    description = "HTTPS from the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  lifecycle {
    create_before_destroy = true
  }
}

module "endpoints" {
  source  = "terraform-aws-modules/vpc/aws//modules/vpc-endpoints"
  version = "6.7.3"

  vpc_id             = module.vpc.vpc_id
  security_group_ids = [aws_security_group.endpoints.id]
  subnet_ids         = local.endpoint_subnet_ids

  endpoints = merge(
    {
      s3 = {
        service         = "s3"
        service_type    = "Gateway"
        route_table_ids = concat(module.vpc.private_route_table_ids, module.vpc.database_route_table_ids)
      }
    },
    { for svc in [
      "sts", "ecr.api", "ecr.dkr", "ec2", "eks-auth", "logs", "kms", "secretsmanager", "bedrock-runtime",
      ] : replace(svc, ".", "_") => {
      service             = svc
      private_dns_enabled = true
    } }
  )

  tags = var.tags
}

### Egress through AWS Network Firewall (allow_list only) ###

resource "aws_eip" "nat" {
  count  = local.allow_list ? var.az_count : 0
  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name_prefix}-nat-${local.azs[count.index]}" })
}

resource "aws_nat_gateway" "this" {
  count         = local.allow_list ? var.az_count : 0
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = module.vpc.public_subnets[count.index]
  tags          = merge(var.tags, { Name = "${var.name_prefix}-nat-${local.azs[count.index]}" })
}

resource "aws_networkfirewall_rule_group" "egress_domains" {
  count    = local.allow_list ? 1 : 0
  name     = "${var.name_prefix}-egress-domains"
  type     = "STATEFUL"
  capacity = 100
  tags     = var.tags

  rule_group {
    stateful_rule_options {
      rule_order = "STRICT_ORDER"
    }
    rule_variables {
      ip_sets {
        key = "HOME_NET"
        ip_set {
          definition = [var.vpc_cidr]
        }
      }
    }
    rules_source {
      rules_source_list {
        generated_rules_type = "ALLOWLIST"
        target_types         = ["TLS_SNI"]
        targets              = var.egress_allowed_domains
      }
    }
  }
}

resource "aws_networkfirewall_firewall_policy" "egress" {
  count = local.allow_list ? 1 : 0
  name  = "${var.name_prefix}-egress"
  tags  = var.tags

  firewall_policy {
    stateless_default_actions          = ["aws:forward_to_sfe"]
    stateless_fragment_default_actions = ["aws:forward_to_sfe"]

    stateful_engine_options {
      rule_order = "STRICT_ORDER"
    }
    # Anything the allow-list does not pass is dropped once established (so the
    # TLS ClientHello can be inspected first) and alerted on.
    stateful_default_actions = ["aws:drop_established", "aws:alert_established"]

    stateful_rule_group_reference {
      priority     = 100
      resource_arn = aws_networkfirewall_rule_group.egress_domains[0].arn
    }
  }
}

resource "aws_networkfirewall_firewall" "egress" {
  count               = local.allow_list ? 1 : 0
  name                = "${var.name_prefix}-egress"
  firewall_policy_arn = aws_networkfirewall_firewall_policy.egress[0].arn
  vpc_id              = module.vpc.vpc_id
  delete_protection   = false
  tags                = var.tags

  encryption_configuration {
    type   = "CUSTOMER_KMS"
    key_id = aws_kms_key.data.arn
  }

  dynamic "subnet_mapping" {
    for_each = module.vpc.intra_subnets
    content {
      subnet_id = subnet_mapping.value
    }
  }
}

resource "aws_cloudwatch_log_group" "firewall" {
  for_each          = local.allow_list ? toset(["alert", "flow"]) : toset([])
  name              = "/${var.name_prefix}/network-firewall/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
  tags              = var.tags
}

resource "aws_networkfirewall_logging_configuration" "egress" {
  count        = local.allow_list ? 1 : 0
  firewall_arn = aws_networkfirewall_firewall.egress[0].arn

  logging_configuration {
    dynamic "log_destination_config" {
      for_each = aws_cloudwatch_log_group.firewall
      content {
        log_type             = upper(log_destination_config.key)
        log_destination_type = "CloudWatchLogs"
        log_destination = {
          logGroup = log_destination_config.value.name
        }
      }
    }
  }
}

locals {
  # Firewall endpoint id per zone.
  firewall_endpoint_by_az = local.allow_list ? {
    for s in aws_networkfirewall_firewall.egress[0].firewall_status[0].sync_states :
    s.availability_zone => s.attachment[0].endpoint_id
  } : {}
}

# Private (nodes) -> firewall endpoint in the same zone.
resource "aws_route" "private_to_firewall" {
  count                  = local.allow_list ? var.az_count : 0
  route_table_id         = local.node_route_table_ids[count.index]
  destination_cidr_block = "0.0.0.0/0"
  vpc_endpoint_id        = local.firewall_endpoint_by_az[local.azs[count.index]]
}

# Firewall subnet -> NAT in the same zone.
resource "aws_route" "firewall_to_nat" {
  count                  = local.allow_list ? var.az_count : 0
  route_table_id         = module.vpc.intra_route_table_ids[count.index]
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[count.index].id
}

# Public subnet: return traffic for each node subnet goes back through the
# firewall endpoint of that subnet's zone (the NAT sits in the same zone).
resource "aws_route" "public_return_via_firewall" {
  count                  = local.allow_list ? var.az_count : 0
  route_table_id         = module.vpc.public_route_table_ids[0]
  destination_cidr_block = local.private_subnets[count.index]
  vpc_endpoint_id        = local.firewall_endpoint_by_az[local.azs[count.index]]
}
