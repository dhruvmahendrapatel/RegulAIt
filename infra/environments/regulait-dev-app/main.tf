# regulait-dev-app — the RegulAIt gateway itself, running as a dev/demo stack
# in the workload account. Deliberately separate state from regulait-dev (the
# org/security baseline) so an app deploy can never re-plan the foundation.
#
# NOT production. Single instance, HTTP only, demo seed data. Standing
# guardrail applies: any production designation needs explicit user sign-off.

module "app" {
  source = "../../modules/app-instance"

  name               = "regulait-dev-app"
  app_port           = 3000
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
