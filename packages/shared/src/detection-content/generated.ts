// Generated offline by scripts/vendor/convert-detection-content.mjs; do not edit.
export const GENERATED_SPACE_RUN_SAFE_IDS = [
  "pipelock.secrets.anthropic_api_key",
  "pipelock.secrets.openai_api_key",
  "pipelock.secrets.openai_service_key",
  "pipelock.secrets.fireworks_api_key",
  "pipelock.secrets.llm_router_api_key",
  "pipelock.secrets.answer_engine_api_key",
  "pipelock.secrets.web_research_api_key",
  "pipelock.secrets.google_api_key",
  "pipelock.secrets.google_oauth_client_secret",
  "pipelock.secrets.stripe_key",
  "pipelock.secrets.stripe_webhook_secret",
  "pipelock.secrets.github_token",
  "pipelock.secrets.github_fine_grained_pat",
  "pipelock.secrets.gitlab_pat",
  "pipelock.secrets.gitlab_deploy_token",
  "pipelock.secrets.gitlab_runner_token",
  "pipelock.secrets.gitlab_ci_job_token",
  "pipelock.secrets.gitlab_pipeline_trigger_token",
  "pipelock.secrets.gitlab_oauth_application_secret",
  "pipelock.secrets.gitlab_scim_token",
  "pipelock.secrets.gitlab_service_token",
  "pipelock.secrets.postgresql_connection_string",
  "pipelock.secrets.mysql_connection_string",
  "pipelock.secrets.mongodb_connection_string",
  "pipelock.secrets.redis_connection_string",
  "pipelock.secrets.google_oauth_token",
  "pipelock.secrets.gcp_service_account_private_key_id",
  "pipelock.secrets.azure_storage_account_key",
  "pipelock.secrets.azure_sas_token",
  "pipelock.secrets.slack_token",
  "pipelock.secrets.slack_app_token",
  "pipelock.secrets.discord_bot_token",
  "pipelock.secrets.twilio_api_key",
  "pipelock.secrets.sendgrid_api_key",
  "pipelock.secrets.mailgun_api_key",
  "pipelock.secrets.new_relic_api_key",
  "pipelock.secrets.hugging_face_token",
  "pipelock.secrets.databricks_token",
  "pipelock.secrets.replicate_api_token",
  "pipelock.secrets.together_ai_key",
  "pipelock.secrets.pinecone_api_key",
  "pipelock.secrets.groq_api_key",
  "pipelock.secrets.xai_api_key",
  "pipelock.secrets.digitalocean_token",
  "pipelock.secrets.hashicorp_vault_token",
  "pipelock.secrets.vercel_token",
  "pipelock.secrets.supabase_service_key",
  "pipelock.secrets.npm_token",
  "pipelock.secrets.pypi_token",
  "pipelock.secrets.linear_api_key",
  "pipelock.secrets.notion_api_key",
  "pipelock.secrets.sentry_auth_token",
  "pipelock.secrets.private_key_header",
  "pipelock.secrets.jwt_token",
  "pipelock.secrets.extended_private_key",
  "pipelock.secrets.ethereum_private_key",
  "pipelock.secrets.social_security_number",
  "pipelock.secrets.google_oauth_client_id",
  "pipelock.secrets.environment_variable_secret",
  "pipelock.secrets.ethereum_address",
  "pipelock.secrets.gcp_service_account_key"
] as const;

export const GENERATED_SECRET_RULES = [
  {
    "id": "pipelock.secrets.anthropic_api_key",
    "pack": "pipelock-secrets",
    "pattern": "sk-ant-[a-zA-Z0-9\\-_]{20,}",
    "caseInsensitive": true,
    "leftBoundary": "ascii_identifier",
    "audienceHosts": [
      "*.anthropic.com"
    ]
  },
  {
    "id": "pipelock.secrets.openai_api_key",
    "pack": "pipelock-secrets",
    "pattern": "sk-proj-[a-zA-Z0-9\\-_]{20,}",
    "caseInsensitive": true,
    "leftBoundary": "ascii_identifier",
    "audienceHosts": [
      "*.openai.com"
    ]
  },
  {
    "id": "pipelock.secrets.openai_service_key",
    "pack": "pipelock-secrets",
    "pattern": "sk-svcacct-[a-zA-Z0-9\\-_]{20,}",
    "caseInsensitive": true,
    "leftBoundary": "ascii_identifier",
    "audienceHosts": [
      "*.openai.com"
    ]
  },
  {
    "id": "pipelock.secrets.fireworks_api_key",
    "pack": "pipelock-secrets",
    "pattern": "fw_[A-Za-z0-9]{22}\\b",
    "caseInsensitive": true,
    "audienceHosts": [
      "*.fireworks.ai"
    ]
  },
  {
    "id": "pipelock.secrets.llm_router_api_key",
    "pack": "pipelock-secrets",
    "pattern": "sk-or-v1-[A-Fa-f0-9]{20,}\\b",
    "caseInsensitive": true,
    "audienceHosts": [
      "*.openrouter.ai"
    ]
  },
  {
    "id": "pipelock.secrets.answer_engine_api_key",
    "pack": "pipelock-secrets",
    "pattern": "pplx-[A-Za-z0-9]{20,}\\b",
    "caseInsensitive": true,
    "audienceHosts": [
      "*.perplexity.ai"
    ]
  },
  {
    "id": "pipelock.secrets.web_research_api_key",
    "pack": "pipelock-secrets",
    "pattern": "tvly-[A-Za-z0-9]{20,}\\b",
    "caseInsensitive": true,
    "audienceHosts": [
      "*.tavily.com"
    ]
  },
  {
    "id": "pipelock.secrets.google_api_key",
    "pack": "pipelock-secrets",
    "pattern": "AIza[0-9A-Za-z\\-_]{35}\\b",
    "caseInsensitive": true,
    "audienceHosts": [
      "*.googleapis.com"
    ]
  },
  {
    "id": "pipelock.secrets.google_oauth_client_secret",
    "pack": "pipelock-secrets",
    "pattern": "GOCSPX-[A-Za-z0-9_\\-]{28,}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.stripe_key",
    "pack": "pipelock-secrets",
    "pattern": "[sr]k[-_](live|test)[-_][a-zA-Z0-9]{20,}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.stripe_webhook_secret",
    "pack": "pipelock-secrets",
    "pattern": "whsec_[a-zA-Z0-9_\\-]{20,}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.github_token",
    "pack": "pipelock-secrets",
    "pattern": "(?:gh[pour]_[A-Za-z0-9_]{36,}|ghs_[A-Za-z0-9.\\-_]{36,})",
    "caseInsensitive": true,
    "audienceHosts": []
  },
  {
    "id": "pipelock.secrets.github_fine_grained_pat",
    "pack": "pipelock-secrets",
    "pattern": "github_pat_[a-zA-Z0-9_]{36,}",
    "caseInsensitive": true,
    "audienceHosts": []
  },
  {
    "id": "pipelock.secrets.gitlab_pat",
    "pack": "pipelock-secrets",
    "pattern": "glpat-[a-zA-Z0-9\\-_]{20,}",
    "caseInsensitive": true,
    "audienceHosts": []
  },
  {
    "id": "pipelock.secrets.gitlab_deploy_token",
    "pack": "pipelock-secrets",
    "pattern": "gldt-[a-zA-Z0-9\\-_]{20,}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.gitlab_runner_token",
    "pack": "pipelock-secrets",
    "pattern": "glrt(?:r)?-[a-zA-Z0-9\\-_]{20,}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.gitlab_ci_job_token",
    "pack": "pipelock-secrets",
    "pattern": "glcbt-[a-zA-Z0-9\\-_]{20,}",
    "caseInsensitive": true,
    "audienceHosts": []
  },
  {
    "id": "pipelock.secrets.gitlab_pipeline_trigger_token",
    "pack": "pipelock-secrets",
    "pattern": "glptt-[a-zA-Z0-9\\-_]{20,}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.gitlab_oauth_application_secret",
    "pack": "pipelock-secrets",
    "pattern": "gloas-[a-zA-Z0-9\\-_]{20,}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.gitlab_scim_token",
    "pack": "pipelock-secrets",
    "pattern": "glsoat-[a-zA-Z0-9\\-_]{20,}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.gitlab_service_token",
    "pack": "pipelock-secrets",
    "pattern": "gl(?:ft|imt|agent|wt|ffct)-[a-zA-Z0-9\\-_]{20,}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.postgresql_connection_string",
    "pack": "pipelock-secrets",
    "pattern": "postgres(?:ql)?://[^:/?#\\s]*:[^@/?#\\s]+@",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.mysql_connection_string",
    "pack": "pipelock-secrets",
    "pattern": "mysql://[^:/?#\\s]*:[^@/?#\\s]+@",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.mongodb_connection_string",
    "pack": "pipelock-secrets",
    "pattern": "mongodb(?:\\+srv)?://[^:/?#\\s]*:[^@/?#\\s]+@",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.redis_connection_string",
    "pack": "pipelock-secrets",
    "pattern": "redis(?:s)?://[^:/?#\\s]*:[^@/?#\\s]+@",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.aws_secret_key",
    "pack": "pipelock-secrets",
    "pattern": "(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|secret.?access.?key|SecretAccessKey)\\s*[\"'=:\\s]{1,5}\\s*[A-Za-z0-9/+=]{40}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.google_oauth_token",
    "pack": "pipelock-secrets",
    "pattern": "ya29\\.[a-zA-Z0-9_-]{20,}",
    "caseInsensitive": true,
    "audienceHosts": []
  },
  {
    "id": "pipelock.secrets.gcp_service_account_private_key_id",
    "pack": "pipelock-secrets",
    "pattern": "\"private_key_id\"\\s*:\\s*\"[a-f0-9]{40}\"",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.azure_storage_account_key",
    "pack": "pipelock-secrets",
    "pattern": "AccountKey=[A-Za-z0-9+/]{86}==",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.azure_sas_token",
    "pack": "pipelock-secrets",
    "pattern": "\\bsig=(?:[A-Za-z0-9%]{43,}%3d\\b|[A-Za-z0-9+/]{43}=)",
    "caseInsensitive": true,
    "audienceHosts": []
  },
  {
    "id": "pipelock.secrets.slack_token",
    "pack": "pipelock-secrets",
    "pattern": "xox[bpras]-[0-9a-zA-Z-]{15,}",
    "caseInsensitive": true,
    "audienceHosts": [
      "slack.com",
      "mcp.slack.com"
    ]
  },
  {
    "id": "pipelock.secrets.slack_app_token",
    "pack": "pipelock-secrets",
    "pattern": "xapp-[0-9]+-[A-Za-z0-9_]+-[0-9]+-[a-f0-9]+",
    "caseInsensitive": true,
    "audienceHosts": [
      "slack.com"
    ]
  },
  {
    "id": "pipelock.secrets.discord_bot_token",
    "pack": "pipelock-secrets",
    "pattern": "(?:(?-i:[MN])[A-Za-z0-9]{23,}\\.[A-Za-z0-9\\-_]{6}\\.[A-Za-z0-9\\-_]{27,}|(?-i:mfa\\.)[A-Za-z0-9\\-_]{84,})",
    "caseInsensitive": true,
    "audienceHosts": [
      "discord.com",
      "gateway.discord.gg"
    ]
  },
  {
    "id": "pipelock.secrets.twilio_api_key",
    "pack": "pipelock-secrets",
    "pattern": "\\bSK[a-f0-9]{32}\\b",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.sendgrid_api_key",
    "pack": "pipelock-secrets",
    "pattern": "(?-i:SG\\.)[a-zA-Z0-9_-]{22}\\.[a-zA-Z0-9_-]{43}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.mailgun_api_key",
    "pack": "pipelock-secrets",
    "pattern": "\\bkey-[a-zA-Z0-9]{32}\\b",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.new_relic_api_key",
    "pack": "pipelock-secrets",
    "pattern": "NRAK-[A-Z0-9]{27,}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.hugging_face_token",
    "pack": "pipelock-secrets",
    "pattern": "hf_[A-Za-z0-9]{34,37}\\b",
    "caseInsensitive": true,
    "audienceHosts": [
      "*.huggingface.co"
    ]
  },
  {
    "id": "pipelock.secrets.databricks_token",
    "pack": "pipelock-secrets",
    "pattern": "dapi[0-9a-f]{32,}\\b",
    "caseInsensitive": true,
    "audienceHosts": [
      "*.databricks.com"
    ]
  },
  {
    "id": "pipelock.secrets.replicate_api_token",
    "pack": "pipelock-secrets",
    "pattern": "r8_[a-f0-9]{40}\\b",
    "caseInsensitive": true,
    "audienceHosts": [
      "*.replicate.com"
    ]
  },
  {
    "id": "pipelock.secrets.together_ai_key",
    "pack": "pipelock-secrets",
    "pattern": "tok_[a-z0-9]{40,}\\b",
    "caseInsensitive": true,
    "audienceHosts": [
      "*.together.ai"
    ]
  },
  {
    "id": "pipelock.secrets.pinecone_api_key",
    "pack": "pipelock-secrets",
    "pattern": "pcsk_[a-zA-Z0-9]{36,}\\b",
    "caseInsensitive": true,
    "audienceHosts": [
      "*.pinecone.io"
    ]
  },
  {
    "id": "pipelock.secrets.groq_api_key",
    "pack": "pipelock-secrets",
    "pattern": "gsk_[a-zA-Z0-9]{48,}\\b",
    "caseInsensitive": true,
    "audienceHosts": [
      "*.groq.com"
    ]
  },
  {
    "id": "pipelock.secrets.xai_api_key",
    "pack": "pipelock-secrets",
    "pattern": "xai-[a-zA-Z0-9\\-_]{80,}\\b",
    "caseInsensitive": true,
    "audienceHosts": [
      "*.x.ai"
    ]
  },
  {
    "id": "pipelock.secrets.digitalocean_token",
    "pack": "pipelock-secrets",
    "pattern": "dop_v1_[a-f0-9]{64}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.hashicorp_vault_token",
    "pack": "pipelock-secrets",
    "pattern": "hvs\\.[A-Za-z0-9]{24,}\\b",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.vercel_token",
    "pack": "pipelock-secrets",
    "pattern": "(?:vercel|vc[piark])_[a-zA-Z0-9]{24,}\\b",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.supabase_service_key",
    "pack": "pipelock-secrets",
    "pattern": "sb_secret_[A-Za-z0-9_-]{22}_(?:[A-Za-z0-9_-]{7}[A-Za-z0-9_]\\b|[A-Za-z0-9_-]{7}-\\B)",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.npm_token",
    "pack": "pipelock-secrets",
    "pattern": "npm_[A-Za-z0-9]{36,}\\b",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.pypi_token",
    "pack": "pipelock-secrets",
    "pattern": "pypi-AgE[A-Za-z0-9_-]{90,}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.linear_api_key",
    "pack": "pipelock-secrets",
    "pattern": "lin_api_[A-Za-z0-9]{40,}\\b",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.notion_api_key",
    "pack": "pipelock-secrets",
    "pattern": "ntn_[a-zA-Z0-9]{40,}\\b",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.sentry_auth_token",
    "pack": "pipelock-secrets",
    "pattern": "sntrys_[A-Za-z0-9]{40,}\\b",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.private_key_header",
    "pack": "pipelock-secrets",
    "pattern": "-----BEGIN\\s+(RSA\\s+|EC\\s+|DSA\\s+|OPENSSH\\s+|PGP\\s+)?PRIVATE\\s+KEY(\\s+BLOCK)?-----",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.jwt_token",
    "pack": "pipelock-secrets",
    "pattern": "(?:(?-i:ey[JA])[a-zA-Z0-9_\\-=]{7,}|(?-i:ew[ok0])[a-zA-Z0-9_\\-=]{7,})\\.(?:(?-i:ey[JA])[a-zA-Z0-9_\\-=]{7,}|(?-i:ew[ok0])[a-zA-Z0-9_\\-=]{7,}|(?-i:e30=?))\\.[a-zA-Z0-9_\\-=]{10,}",
    "caseInsensitive": true,
    "audienceHosts": []
  },
  {
    "id": "pipelock.secrets.extended_private_key",
    "pack": "pipelock-secrets",
    "pattern": "[xyzt]prv[1-9A-HJ-NP-Za-km-z]{107,108}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.ethereum_private_key",
    "pack": "pipelock-secrets",
    "pattern": "0x[0-9a-f]{64}\\b",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.social_security_number",
    "pack": "pipelock-secrets",
    "pattern": "\\b\\d{3}-\\d{2}-\\d{4}\\b",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.google_oauth_client_id",
    "pack": "pipelock-secrets",
    "pattern": "[0-9]{6,}-[0-9A-Za-z_]{32}\\.apps\\.googleusercontent\\.com",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.environment_variable_secret",
    "pack": "pipelock-secrets",
    "pattern": "(?-i:[A-Z][A-Z0-9]*[_-](?:SECRET(?:[_-]ACCESS)?[_-]?KEY|SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY))\\b\\s*=\\s*[A-Za-z0-9_+/=~.-]\\S{7,}",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.ethereum_address",
    "pack": "pipelock-secrets",
    "pattern": "0x[0-9a-fA-F]{40}\\b",
    "caseInsensitive": true
  },
  {
    "id": "pipelock.secrets.gcp_service_account_key",
    "pack": "pipelock-secrets",
    "pattern": "\"type\"\\s*:\\s*\"service_account\"",
    "caseInsensitive": true
  }
] as const;

export const GENERATED_INJECTION_RULES = [] as const;

export const GENERATED_MCP_HEURISTICS = [
  {
    "id": "agt.mcp.invisible_unicode.1",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "[\\x{200b}\\x{200c}\\x{200d}\\x{feff}]",
    "caseInsensitive": false
  },
  {
    "id": "agt.mcp.invisible_unicode.2",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "[\\x{202a}-\\x{202e}]",
    "caseInsensitive": false
  },
  {
    "id": "agt.mcp.invisible_unicode.3",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "[\\x{2066}-\\x{2069}]",
    "caseInsensitive": false
  },
  {
    "id": "agt.mcp.invisible_unicode.4",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "[\\x{00ad}]",
    "caseInsensitive": false
  },
  {
    "id": "agt.mcp.invisible_unicode.5",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "[\\x{2060}\\x{180e}]",
    "caseInsensitive": false
  },
  {
    "id": "agt.mcp.hidden_comment.1",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "(?s:<!--.*?-->)",
    "caseInsensitive": false
  },
  {
    "id": "agt.mcp.hidden_comment.2",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "(?s:\\[//\\]:\\s*#\\s*\\(.*?\\))",
    "caseInsensitive": false
  },
  {
    "id": "agt.mcp.hidden_comment.3",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "(?s:\\[comment\\]:\\s*<>\\s*\\(.*?\\))",
    "caseInsensitive": false
  },
  {
    "id": "agt.mcp.hidden_instruction.1",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "ignore\\s+(all\\s+)?previous",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.hidden_instruction.2",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "override\\s+(the\\s+)?(previous|above|original)",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.hidden_instruction.3",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "instead\\s+of\\s+(the\\s+)?(above|previous|described)",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.hidden_instruction.4",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "actually\\s+do",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.hidden_instruction.5",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "\\bsystem\\s*:",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.hidden_instruction.6",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "\\bassistant\\s*:",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.hidden_instruction.7",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "do\\s+not\\s+follow",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.hidden_instruction.8",
    "pack": "agt-mcp-heuristics",
    "severity": "critical",
    "where": [
      "description"
    ],
    "pattern": "disregard\\s+(all\\s+)?(above|prior|previous)",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.role_override.1",
    "pack": "agt-mcp-heuristics",
    "severity": "medium",
    "where": [
      "description"
    ],
    "pattern": "you\\s+are\\b",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.role_override.2",
    "pack": "agt-mcp-heuristics",
    "severity": "medium",
    "where": [
      "description"
    ],
    "pattern": "your\\s+task\\s+is\\b",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.role_override.3",
    "pack": "agt-mcp-heuristics",
    "severity": "medium",
    "where": [
      "description"
    ],
    "pattern": "respond\\s+with\\b",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.role_override.4",
    "pack": "agt-mcp-heuristics",
    "severity": "medium",
    "where": [
      "description"
    ],
    "pattern": "always\\s+return\\b",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.role_override.5",
    "pack": "agt-mcp-heuristics",
    "severity": "medium",
    "where": [
      "description"
    ],
    "pattern": "you\\s+must\\b",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.role_override.6",
    "pack": "agt-mcp-heuristics",
    "severity": "medium",
    "where": [
      "description"
    ],
    "pattern": "\\bmust\\s+be\\s+called\\b",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.role_override.7",
    "pack": "agt-mcp-heuristics",
    "severity": "medium",
    "where": [
      "description"
    ],
    "pattern": "\\balways\\s+call\\b",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.role_override.8",
    "pack": "agt-mcp-heuristics",
    "severity": "medium",
    "where": [
      "description"
    ],
    "pattern": "\\bmandatory\\b",
    "caseInsensitive": true
  },
  {
    "id": "agt.mcp.role_override.9",
    "pack": "agt-mcp-heuristics",
    "severity": "medium",
    "where": [
      "description"
    ],
    "pattern": "your\\s+role\\s+is\\b",
    "caseInsensitive": true
  }
] as const;

export const GENERATED_PACK_MANIFESTS = [
  {
    "id": "pipelock-secrets",
    "source": "pipelock",
    "repo": "https://github.com/luckyPipewrench/pipelock",
    "commit": "7014542ea14fec82dfbc2ad38caf77bd63e7ad69",
    "sha256": "9268c1f7a91567c0c509f61d1e1aaa1c5ff0258a261c38e353b91a14fec4a0dd",
    "licence": "Apache-2.0",
    "rules": 62,
    "notImported": [
      {
        "id": "pipelock.secrets.github_token.audience_exemption",
        "reason": "Carrier/path/cryptographic audience exemption is not representable in the host-only seam; no exemption granted"
      },
      {
        "id": "pipelock.secrets.github_fine_grained_pat.audience_exemption",
        "reason": "Carrier/path/cryptographic audience exemption is not representable in the host-only seam; no exemption granted"
      },
      {
        "id": "pipelock.secrets.gitlab_pat.audience_exemption",
        "reason": "Carrier/path/cryptographic audience exemption is not representable in the host-only seam; no exemption granted"
      },
      {
        "id": "pipelock.secrets.gitlab_ci_job_token.audience_exemption",
        "reason": "Carrier/path/cryptographic audience exemption is not representable in the host-only seam; no exemption granted"
      },
      {
        "id": "pipelock.secrets.aws_access_id",
        "reason": "Unresolved Go constant"
      },
      {
        "id": "pipelock.secrets.google_oauth_token.audience_exemption",
        "reason": "Carrier/path/cryptographic audience exemption is not representable in the host-only seam; no exemption granted"
      },
      {
        "id": "pipelock.secrets.azure_sas_token.audience_exemption",
        "reason": "Carrier/path/cryptographic audience exemption is not representable in the host-only seam; no exemption granted"
      },
      {
        "id": "pipelock.secrets.jwt_token.audience_exemption",
        "reason": "Carrier/path/cryptographic audience exemption is not representable in the host-only seam; no exemption granted"
      },
      {
        "id": "pipelock.secrets.bitcoin_wif_private_key",
        "reason": "Requires upstream checksum validator outside the regex-only seam"
      },
      {
        "id": "pipelock.secrets.credential_in_url",
        "reason": "Unresolved Go constant"
      },
      {
        "id": "pipelock.secrets.credit_card_number",
        "reason": "Requires upstream checksum validator outside the regex-only seam"
      },
      {
        "id": "pipelock.secrets.iban",
        "reason": "Requires upstream checksum validator outside the regex-only seam"
      }
    ],
    "retrievedAt": "2026-10-07T21:28:48.561070Z"
  },
  {
    "id": "pipelock-normalise",
    "source": "pipelock",
    "repo": "https://github.com/luckyPipewrench/pipelock",
    "commit": "7014542ea14fec82dfbc2ad38caf77bd63e7ad69",
    "sha256": "9268c1f7a91567c0c509f61d1e1aaa1c5ff0258a261c38e353b91a14fec4a0dd",
    "licence": "Apache-2.0",
    "rules": 6,
    "notImported": [],
    "retrievedAt": "2026-10-07T21:28:48.561070Z"
  },
  {
    "id": "nemo-yara-injection",
    "source": "nemo",
    "repo": "https://github.com/NVIDIA-NeMo/Guardrails",
    "commit": "9f793de53e432c4c9c765975f5dd54df175fcb6e",
    "sha256": "ad42dc443380ada5362a5cfb153ce267239f7d73ede2244d8f5e9ec0a60ca843",
    "licence": "Apache-2.0",
    "rules": 0,
    "notImported": [
      {
        "id": "nemo.yara.injection.import_shells",
        "reason": "Condition requires grouping, order, offsets or loops; ADR-0186 permits only any/N of them"
      },
      {
        "id": "nemo.yara.injection.import_networking",
        "reason": "Condition requires grouping, order, offsets or loops; ADR-0186 permits only any/N of them"
      },
      {
        "id": "nemo.yara.injection.sql_injection",
        "reason": "Condition requires grouping, order, offsets or loops; ADR-0186 permits only any/N of them"
      },
      {
        "id": "nemo.yara.injection.jinja_injection",
        "reason": "Condition requires grouping, order, offsets or loops; ADR-0186 permits only any/N of them"
      },
      {
        "id": "nemo.yara.injection.markdown_xss",
        "reason": "Condition requires grouping, order, offsets or loops; ADR-0186 permits only any/N of them"
      }
    ],
    "retrievedAt": "2026-10-07T21:28:48.563341Z"
  },
  {
    "id": "agt-mcp-heuristics",
    "source": "agt",
    "repo": "https://github.com/microsoft/agent-governance-toolkit",
    "commit": "f68f2cf312c7e1366d6fd5654c51d8380c815222",
    "sha256": "fab12a37fcf4e1fbf92c2460c2f753a5753bda10c09c574f0e5a486d7a0d9a20",
    "licence": "MIT",
    "rules": 25,
    "notImported": [
      {
        "id": "agt.mcp.encoded_payload",
        "reason": "Needs decode and suspicious-keyword checks, not a literal shape match"
      },
      {
        "id": "agt.mcp.exfiltration",
        "reason": "Broad sample URLs/transfer words require local policy review before admission blocking"
      },
      {
        "id": "agt.mcp.privilege_escalation",
        "reason": "Broad sample admin/code words require local policy review before admission blocking"
      },
      {
        "id": "agt.mcp.typosquatting",
        "reason": "Requires approved reference-name/history context outside the stateless pattern seam"
      },
      {
        "id": "agt.mcp.rug_pull",
        "reason": "Requires prior fingerprints outside the stateless pattern seam"
      },
      {
        "id": "agt.mcp.cross_server",
        "reason": "Requires cross-server identity context outside the stateless pattern seam"
      }
    ],
    "retrievedAt": "2026-10-07T21:28:48.565775Z"
  }
] as const;

export const NORMALISE_CONFUSABLES = [
  [
    1040,
    "A"
  ],
  [
    1042,
    "B"
  ],
  [
    1057,
    "C"
  ],
  [
    1045,
    "E"
  ],
  [
    1053,
    "H"
  ],
  [
    1030,
    "I"
  ],
  [
    1032,
    "J"
  ],
  [
    1050,
    "K"
  ],
  [
    1052,
    "M"
  ],
  [
    1054,
    "O"
  ],
  [
    1056,
    "P"
  ],
  [
    1029,
    "S"
  ],
  [
    1058,
    "T"
  ],
  [
    1061,
    "X"
  ],
  [
    1072,
    "a"
  ],
  [
    1074,
    "v"
  ],
  [
    1077,
    "e"
  ],
  [
    1085,
    "h"
  ],
  [
    1110,
    "i"
  ],
  [
    1082,
    "k"
  ],
  [
    1084,
    "m"
  ],
  [
    1086,
    "o"
  ],
  [
    1088,
    "p"
  ],
  [
    1089,
    "c"
  ],
  [
    1090,
    "t"
  ],
  [
    1091,
    "y"
  ],
  [
    1093,
    "x"
  ],
  [
    1112,
    "j"
  ],
  [
    1109,
    "s"
  ],
  [
    913,
    "A"
  ],
  [
    914,
    "B"
  ],
  [
    917,
    "E"
  ],
  [
    918,
    "Z"
  ],
  [
    919,
    "H"
  ],
  [
    921,
    "I"
  ],
  [
    922,
    "K"
  ],
  [
    924,
    "M"
  ],
  [
    925,
    "N"
  ],
  [
    927,
    "O"
  ],
  [
    929,
    "P"
  ],
  [
    932,
    "T"
  ],
  [
    933,
    "Y"
  ],
  [
    935,
    "X"
  ],
  [
    945,
    "a"
  ],
  [
    949,
    "e"
  ],
  [
    953,
    "i"
  ],
  [
    954,
    "k"
  ],
  [
    957,
    "v"
  ],
  [
    959,
    "o"
  ],
  [
    1365,
    "O"
  ],
  [
    1413,
    "o"
  ],
  [
    1357,
    "S"
  ],
  [
    1405,
    "s"
  ],
  [
    1356,
    "L"
  ],
  [
    1392,
    "h"
  ],
  [
    1400,
    "n"
  ],
  [
    1404,
    "n"
  ],
  [
    1377,
    "a"
  ],
  [
    5034,
    "A"
  ],
  [
    5026,
    "I"
  ],
  [
    5074,
    "P"
  ],
  [
    5082,
    "S"
  ],
  [
    5025,
    "E"
  ],
  [
    5043,
    "W"
  ],
  [
    5076,
    "T"
  ],
  [
    216,
    "O"
  ],
  [
    248,
    "o"
  ],
  [
    272,
    "D"
  ],
  [
    273,
    "d"
  ],
  [
    321,
    "L"
  ],
  [
    322,
    "l"
  ],
  [
    294,
    "H"
  ],
  [
    295,
    "h"
  ],
  [
    358,
    "T"
  ],
  [
    359,
    "t"
  ],
  [
    7424,
    "A"
  ],
  [
    665,
    "B"
  ],
  [
    7428,
    "C"
  ],
  [
    7429,
    "D"
  ],
  [
    7431,
    "E"
  ],
  [
    42800,
    "F"
  ],
  [
    610,
    "G"
  ],
  [
    668,
    "H"
  ],
  [
    618,
    "I"
  ],
  [
    7434,
    "J"
  ],
  [
    7435,
    "K"
  ],
  [
    671,
    "L"
  ],
  [
    7437,
    "M"
  ],
  [
    628,
    "N"
  ],
  [
    7439,
    "O"
  ],
  [
    7448,
    "P"
  ],
  [
    640,
    "R"
  ],
  [
    42801,
    "S"
  ],
  [
    7451,
    "T"
  ],
  [
    7452,
    "U"
  ],
  [
    7456,
    "V"
  ],
  [
    7457,
    "W"
  ],
  [
    655,
    "Y"
  ],
  [
    7458,
    "Z"
  ]
] as const;

export const NORMALISE_INVISIBLE_RANGES = [
  [
    173,
    173
  ],
  [
    4447,
    4448
  ],
  [
    8203,
    8207
  ],
  [
    8234,
    8238
  ],
  [
    8288,
    8292
  ],
  [
    8294,
    8297
  ],
  [
    12644,
    12644
  ],
  [
    65024,
    65039
  ],
  [
    65279,
    65279
  ],
  [
    65529,
    65531
  ],
  [
    917504,
    917631
  ],
  [
    917760,
    917999
  ]
] as const;

export const NORMALISE_WHITESPACE = [
  160,
  5760,
  6158,
  8192,
  8193,
  8194,
  8195,
  8196,
  8197,
  8198,
  8199,
  8200,
  8201,
  8202,
  8232,
  8233,
  8239,
  8287,
  12288
] as const;
