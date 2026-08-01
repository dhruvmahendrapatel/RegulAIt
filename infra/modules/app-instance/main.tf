# app-instance — a single EC2 box that boots, pulls a source tarball from S3,
# and runs it with `docker compose up -d --build`. Dev-grade by design: one
# instance, no ALB/ASG. Access for operators is SSM Session Manager only —
# no SSH keypair exists.
#
# TLS terminates INSIDE the box (ADR-0029): the compose stack runs a Caddy
# reverse proxy on 80/443 in front of the app, so this module opens the ports
# the caller asks for and stays agnostic about what listens on them. There is
# still no ALB and no ACM certificate — nothing here costs money.

data "aws_vpc" "default" {
  count   = var.vpc_id == "" ? 1 : 0
  default = true
}

locals {
  vpc_id = var.vpc_id != "" ? var.vpc_id : data.aws_vpc.default[0].id

  # Backwards-compatible: callers that never set ingress_ports keep the old
  # single-port behaviour (open app_port). Callers that terminate TLS on-box
  # pass [80, 443] and app_port stops being an ingress port at all.
  ingress_ports = length(var.ingress_ports) > 0 ? var.ingress_ports : [var.app_port]
}

data "aws_subnets" "in_vpc" {
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# --- source bundle bucket -----------------------------------------------------

resource "aws_s3_bucket" "source" {
  bucket        = var.source_bucket_name
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "source" {
  bucket                  = aws_s3_bucket.source.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- instance role: SSM + read-only on the bundle -----------------------------

resource "aws_iam_role" "instance" {
  name = "${var.name}-instance"
  tags = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "read_source" {
  name = "read-source-bundle"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "${aws_s3_bucket.source.arn}/*"
      }, {
      Effect   = "Allow"
      Action   = ["s3:ListBucket"]
      Resource = aws_s3_bucket.source.arn
    }]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
  tags = var.tags
}

# --- network ------------------------------------------------------------------

resource "aws_security_group" "app" {
  name        = "${var.name}-app"
  description = "Declared ingress ports in, everything out"
  vpc_id      = local.vpc_id
  tags        = var.tags

  dynamic "ingress" {
    for_each = toset(local.ingress_ports)
    content {
      description = "app-${ingress.value}"
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = var.ingress_cidrs
    }
  }

  # HTTP/3 (QUIC) on 443/udp, only when 443 is one of the TCP ingress ports.
  # Caddy advertises h3 via Alt-Svc; without this the browser silently falls
  # back to TCP, so it is an optimisation, not a requirement.
  dynamic "ingress" {
    for_each = contains(local.ingress_ports, 443) ? [443] : []
    content {
      description = "http3-quic"
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "udp"
      cidr_blocks = var.ingress_cidrs
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- instance -----------------------------------------------------------------

resource "aws_instance" "app" {
  ami                    = nonsensitive(data.aws_ssm_parameter.al2023_ami.value)
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.in_vpc.ids[0]
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  tags                   = merge(var.tags, { Name = var.name })

  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    bucket           = aws_s3_bucket.source.bucket
    object_key       = var.source_object_key
    swap_gb          = var.swap_gb
    enable_onbox_tls = var.enable_onbox_tls
  })

  # The bundle is uploaded out-of-band after apply; user-data waits for it.
  depends_on = [aws_iam_role_policy.read_source]
}
