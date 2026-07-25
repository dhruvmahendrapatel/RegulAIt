output "app_url" {
  value = "http://${module.app.public_ip}:3000"
}

output "instance_id" {
  value = module.app.instance_id
}

output "source_bucket" {
  value = module.app.source_bucket
}
