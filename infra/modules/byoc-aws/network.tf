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

  # ACM has no VPC endpoint; the load balancer controller reads certificates
  # from it, so its regional API host joins the allow-list when ingress is on.
  firewall_domains = distinct(concat(var.egress_allowed_domains, var.ingress_controller ? ["acm.${local.region}.amazonaws.com"] : []))
}

resource "aws_cloudwatch_log_group" "flow" {
  name              = "/${var.name_prefix}/vpc-flow"
  retention_in_days = var.log_retention_days
  kms_key_id        = module.kms.key_arn
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
    { for svc in concat([
      "sts", "ecr.api", "ecr.dkr", "ec2", "eks-auth", "logs", "kms", "secretsmanager", "bedrock-runtime",
      ], var.ingress_controller ? ["elasticloadbalancing"] : []) : replace(svc, ".", "_") => {
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

# The firewall, its policy and the domain rule group come from
# terraform-aws-modules/network-firewall (ADR-0176). Only the NAT gateways and
# the routes around the firewall are written here: the vpc module's NAT routes
# private subnets straight to the NAT, and the allow-list needs the symmetric
# path node -> firewall endpoint -> NAT and back, per zone.

module "egress_domains" {
  source  = "terraform-aws-modules/network-firewall/aws//modules/rule-group"
  version = "2.3.0"
  create  = local.allow_list

  name     = "${var.name_prefix}-egress-domains"
  type     = "STATEFUL"
  capacity = 100

  encryption_configuration = {
    type   = "CUSTOMER_KMS"
    key_id = module.kms.key_arn
  }

  rule_group = {
    stateful_rule_options = {
      rule_order = "STRICT_ORDER"
    }
    rule_variables = {
      ip_sets = [{
        key    = "HOME_NET"
        ip_set = { definition = [var.vpc_cidr] }
      }]
    }
    rules_source = {
      rules_source_list = {
        generated_rules_type = "ALLOWLIST"
        target_types         = ["TLS_SNI"]
        targets              = local.firewall_domains
      }
    }
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "firewall" {
  for_each          = local.allow_list ? toset(["alert", "flow"]) : toset([])
  name              = "/${var.name_prefix}/network-firewall/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = module.kms.key_arn
  tags              = var.tags
}

module "network_firewall" {
  source  = "terraform-aws-modules/network-firewall/aws"
  version = "2.3.0"
  create  = local.allow_list

  name              = "${var.name_prefix}-egress"
  description       = "${var.name_prefix}: egress allow-list (TLS SNI), everything else dropped and logged."
  vpc_id            = module.vpc.vpc_id
  delete_protection = var.firewall_delete_protection
  subnet_mapping = {
    for i, id in module.vpc.intra_subnets : local.azs[i] => { subnet_id = id }
  }
  encryption_configuration = {
    type   = "CUSTOMER_KMS"
    key_id = module.kms.key_arn
  }

  create_logging_configuration = true
  logging_configuration_destination_config = [
    for k, g in aws_cloudwatch_log_group.firewall : {
      log_destination      = { logGroup = g.name }
      log_destination_type = "CloudWatchLogs"
      log_type             = upper(k)
    }
  ]

  # Policy: strict rule order. Anything the allow-list does not pass is
  # dropped once established (so the TLS ClientHello can be inspected first)
  # and alerted on.
  policy_name = "${var.name_prefix}-egress"
  policy_encryption_configuration = {
    type   = "CUSTOMER_KMS"
    key_id = module.kms.key_arn
  }
  policy_stateless_default_actions          = ["aws:forward_to_sfe"]
  policy_stateless_fragment_default_actions = ["aws:forward_to_sfe"]
  policy_stateful_engine_options            = { rule_order = "STRICT_ORDER" }
  policy_stateful_default_actions           = ["aws:drop_established", "aws:alert_established"]
  policy_stateful_rule_group_reference = {
    egress_domains = {
      priority     = 100
      resource_arn = module.egress_domains.arn
    }
  }

  tags = var.tags
}

locals {
  # Firewall endpoint id per zone.
  firewall_endpoint_by_az = local.allow_list ? {
    for s in module.network_firewall.status[0].sync_states :
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
