# regulait-dev-app — the RegulAIt gateway itself, running as a dev/demo stack
# in the workload account. Deliberately separate state from regulait-dev (the
# org/security baseline) so an app deploy can never re-plan the foundation.
#
# NOT production. Single instance, demo seed data. Standing guardrail applies:
# any production designation needs explicit user sign-off.
#
# TLS (ADR-0029): an in-compose Caddy reverse proxy terminates HTTPS with a real
# Let's Encrypt certificate for `<dashed-public-ip>.sslip.io`. Only 80 and 443
# are open; the app's own 3000 is bound to host loopback and is no longer an
# ingress port at all. Zero added AWS cost — no ALB, no ACM, no Route53.

module "app" {
  source = "../../modules/app-instance"

  name          = "regulait-dev-app"
  app_port      = 3000 # loopback-only now; Caddy proxies to it over the compose network
  ingress_ports = [80, 443]
  # 80 is not optional: Let's Encrypt's HTTP-01 challenge and every subsequent
  # renewal are served there. Closing it breaks issuance ~60 days later, quietly.
  enable_onbox_tls   = true
  instance_type      = var.instance_type
  ingress_cidrs      = var.ingress_cidrs
  source_bucket_name = "regulait-dev-app-source-517506432475"

  tags = {
    Project     = "RegulAIt"
    Environment = "dev"
    ManagedBy   = "terraform"
    Stack       = "regulait-dev-app"
  }
}
