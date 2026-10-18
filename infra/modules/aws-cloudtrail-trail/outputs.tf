output "trail_arn" {
  value = aws_cloudtrail.this.arn
}

output "bucket_name" {
  value = aws_s3_bucket.logs.id
}

output "bucket_arn" {
  value = aws_s3_bucket.logs.arn
}

output "bucket_region" {
  value = aws_s3_bucket.logs.region
}
