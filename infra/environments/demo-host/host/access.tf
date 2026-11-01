# --- Session Manager: the only way in (ADR-0228) ---------------------------------
#
# The account's Session Manager preferences document. Every session is streamed
# to a KMS-encrypted log group, session data is encrypted with the stack's key,
# and an idle session ends after var.ssm_idle_timeout_minutes. No run-as, no S3
# transcript. In a fresh account this document does not exist yet; if someone
# opened Session Manager preferences in the console it does, and the runbook's
# import command adopts it (DEMO_RUNBOOK.md §8.4).
#
# The transcript records what is typed and shown. Secrets are read at hidden
# prompts or into variables and never printed, so they do not reach it.

resource "aws_cloudwatch_log_group" "sessions" {
  name              = var.session_log_group_name
  retention_in_days = var.session_log_retention_days
  kms_key_id        = aws_kms_key.host.arn
}

# Run Command (`aws ssm send-command`, the runbook's Invoke-DemoHost) is the second
# operator channel. Session preferences do not cover it, so every command's output
# goes to this KMS-encrypted log group instead (the runbook passes
# --cloud-watch-output-config on every send-command; DEMO_RUNBOOK.md §8.4).
resource "aws_cloudwatch_log_group" "run_command" {
  name              = var.run_command_log_group_name
  retention_in_days = var.session_log_retention_days
  kms_key_id        = aws_kms_key.host.arn
}

resource "aws_ssm_document" "session_preferences" {
  name            = "SSM-SessionManagerRunShell"
  document_type   = "Session"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "1.0"
    description   = "RegulAIt demo host: encrypted, logged sessions with an idle timeout (ADR-0228)"
    sessionType   = "Standard_Stream"
    inputs = {
      s3BucketName                = ""
      s3EncryptionEnabled         = true
      cloudWatchLogGroupName      = aws_cloudwatch_log_group.sessions.name
      cloudWatchEncryptionEnabled = true
      cloudWatchStreamingEnabled  = true
      kmsKeyId                    = aws_kms_key.host.key_id
      idleSessionTimeout          = tostring(var.ssm_idle_timeout_minutes)
      maxSessionDuration          = tostring(var.ssm_max_session_minutes)
      runAsEnabled                = false
      runAsDefaultUser            = ""
      shellProfile = {
        linux   = "umask 077"
        windows = ""
      }
    }
  })
}
