variable "name" {
  description = "Name prefix for every resource this module creates."
  type        = string
}

variable "vpc_id" {
  description = "VPC to deploy into. Empty string means the account's default VPC."
  type        = string
  default     = ""
}

variable "instance_type" {
  description = "EC2 instance type. The docker-compose build happens on-instance, so anything below 2 GB RAM needs swap_gb > 0."
  type        = string
  default     = "t3.small"
}

variable "app_port" {
  description = "TCP port the app listens on. Used as the sole ingress port when ingress_ports is empty; otherwise informational (the app sits behind an on-box reverse proxy and is not reachable directly)."
  type        = number
}

variable "ingress_ports" {
  description = "TCP ports opened to ingress_cidrs. Empty (the default) means [app_port], preserving the pre-TLS behaviour. Set to [80, 443] when a reverse proxy on the instance terminates TLS — 443/udp is added automatically for HTTP/3 whenever 443 is present."
  type        = list(number)
  default     = []
}

variable "ingress_cidrs" {
  description = "CIDRs allowed to reach the ingress ports. Default is open — override for anything beyond throwaway dev stacks."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "source_bucket_name" {
  description = "Name of the S3 bucket this module creates for the source bundle."
  type        = string
}

variable "source_object_key" {
  description = "Object key of the source tarball the instance downloads on boot."
  type        = string
  default     = "source.tar.gz"
}

variable "enable_onbox_tls" {
  description = "When true, boot the compose stack with the `tls` profile and point its Caddy TLS terminator at an sslip.io hostname derived from this instance's public IPv4 (ADR-0029). Requires ingress_ports to include 80 and 443. Costs nothing — no ALB, no ACM."
  type        = bool
  default     = false
}

variable "assign_elastic_ip" {
  description = <<-EOT
    Allocate an Elastic IP and associate it with the instance, giving it a
    public IPv4 that SURVIVES a stop/start. Default false keeps the pre-existing
    behaviour (EC2's auto-assigned address, which changes on every power cycle).

    Turn this on for any stack that is scheduled off and on (see
    infra/modules/scheduled-power), or whose hostname/certificate is derived
    from its IP — with `enable_onbox_tls` both are true at once, because the
    sslip.io name literally encodes the address.

    Billing: AWS charges ~$0.005/hr for every public IPv4 whether idle or in
    use, so an EIP costs nothing extra while the instance runs; the only added
    charge is the hours it sits allocated to a STOPPED instance.

    One-time cutover cost: an instance that already has an auto-assigned address
    CANNOT keep it — AWS has no convert-to-EIP operation. Enabling this changes
    the public IP once, on the apply that adds it.
  EOT
  type        = bool
  default     = false
}

variable "swap_gb" {
  description = "Swapfile size in GB added before the build (0 disables)."
  type        = number
  default     = 4
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "ami_id" {
  description = <<-EOT
    PIN THE AMI. Leave null and the module resolves
    /aws/service/ami-amazon-linux-latest/... from SSM — which AWS re-points at
    every new Amazon Linux release, so `terraform plan` silently starts
    proposing "aws_instance.app must be replaced" with no change on our side.

    On this stack Postgres lives in a container volume ON the instance, so that
    replacement is TOTAL DATA LOSS. It is not a hypothetical: a plan on
    2026-08-01 proposed exactly that (ami-0b8dddb... -> ami-0006118...) purely
    because the upstream parameter had moved.

    So: pin it to the AMI the instance is actually running. Upgrading the image
    is then a DELIBERATE act — change this value only together with a data
    migration plan, never as a side effect of someone running plan.
  EOT
  type        = string
  default     = null
}
